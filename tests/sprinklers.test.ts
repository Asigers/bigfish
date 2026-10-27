import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import {GoalMemory} from "../src/strategy.ts";
import {SPRINKLER_ITEM,SprinklerPlanner,reconcileSprinkler,wateredBy,
  validSprinklerProject} from "../src/sprinklers.ts";
import {DEFAULT_STRATEGY} from "../src/economy.ts";
import {parseDecision,validateAgainstWorld} from "../src/decision.ts";
import {actionObserved} from "../src/action-confirmation.ts";
import {GameBridge} from "../src/bridge.ts";
import {startSimulator} from "../src/simulator.ts";
import {validState,type GameState,type Action} from "../src/types.ts";
import type {FarmPlan} from "../src/farm-plan.ts";

const copper={id:"(O)334",count:1,category:-15,sellable:false};
const iron={id:"(O)335",count:1,category:-15,sellable:false};
const recipe={kind:"basic" as const,itemId:"(O)599",learned:true,canCraft:true,
  ingredients:[{id:copper.id,count:1},{id:iron.id,count:1}]};
const base:GameState={
  saveId:"sprinkler-save",year:1,season:"spring",day:5,time:1000,energy:160,
  location:"Farm",x:4,y:4,paused:false,inventoryFree:8,
  crops:[{x:5,y:4,watered:false,ready:false,seedId:"(O)472"}],
  emptyPlots:[{x:6,y:5,watered:false}],tillable:[],seeds:[],
  exits:[],worldLinks:[],bed:null,isRaining:false,
  sprinklerRecipes:[recipe],sprinklerKits:[{kind:"basic",count:0}],
  sprinklerSites:[{x:5,y:5}],installedSprinklers:[],
  economy:{gold:500,bag:[copper,iron],chests:[],shippingBin:null,shop:null,
    tools:{hoe:true,wateringCan:true,equipped:"other",waterLeft:30}}
};
const plan:FarmPlan={saveId:base.saveId,dayKey:"spring:5",
  targetPlots:2,occupiedPlots:1,fieldTiles:[{x:5,y:4},{x:6,y:5}],protectedTiles:[],
  crops:[],preferredSeedId:null,reason:"test",revision:"test",costKnown:false,
  sprinklerIdeas:[{kind:"basic",x:5,y:5,coveredPlots:2,
    waterTiles:[{x:5,y:4},{x:6,y:5}]}]};
test("validated game sprinkler data and variant IDs are normal (O) items",()=>{
  assert.equal(SPRINKLER_ITEM.basic,"(O)599");
  assert.equal(SPRINKLER_ITEM.quality,"(O)621");
  assert.equal(SPRINKLER_ITEM.iridium,"(O)645");
  assert.equal(validState(base),true);
  assert.equal(validState({...base,sprinklerRecipes:[{...recipe,itemId:"(BC)599"}]}),false);
  assert.equal(validState({...base,sprinklerKits:[{kind:"basic",count:-1}]}),false);
  assert.equal(validState({...base,installedSprinklers:[{kind:"fake",x:5,y:5}]}),false);
});
test("only observed recipe and site lead to one real native craft and placed item",()=>{
  const goal=reconcileSprinkler(base,plan);
  assert.ok(goal && validSprinklerProject(goal));
  assert.equal(goal.kind,"basic");
  assert.equal(goal.status,"ready_to_craft");
  const planner=new SprinklerPlanner();
  const craft=planner.propose(base,goal)?.action;
  assert.deepEqual(craft,{type:"craft_sprinkler",kind:"basic"});
  assert.deepEqual(parseDecision('{"action":{"type":"craft_sprinkler","kind":"basic"}}').action,craft);
  assert.equal(validateAgainstWorld(craft!,base),true);
  const crafted:GameState={...base,sprinklerRecipes:[{...recipe,canCraft:false}],
    sprinklerKits:[{kind:"basic",count:1}],economy:{...base.economy!,
      bag:[{id:"(O)599",count:1,category:-8,sellable:false}]}};
  assert.equal(actionObserved(craft!,base,crafted),true);
  const prepared=reconcileSprinkler(crafted,plan,goal)!;
  assert.equal(prepared.status,"ready_to_place");
  const place=planner.propose(crafted,prepared)?.action;
  assert.deepEqual(place,{type:"place_sprinkler",kind:"basic",x:5,y:5});
  assert.deepEqual(parseDecision('{"action":{"type":"place_sprinkler","kind":"basic","x":5,"y":5}}').action,place);
  assert.equal(validateAgainstWorld(place!,crafted),true);
  const installed:GameState={...crafted,sprinklerKits:[{kind:"basic",count:0}],
    installedSprinklers:[{kind:"basic",x:5,y:5}],sprinklerSites:[],
    economy:{...crafted.economy!,bag:[]}};
  assert.equal(actionObserved(place!,crafted,installed),true);
  const built=reconcileSprinkler(installed,plan,prepared)!;
  assert.equal(built.status,"installed");
  assert.equal(planner.propose(installed,built),undefined);
});
test("no false crafting/placement on missing inputs, blocked site or unchanged inventory",()=>{
  const empty={...base,economy:{...base.economy!,bag:[]},
    sprinklerRecipes:[{...recipe,canCraft:false}]};
  const goal=reconcileSprinkler(empty,plan)!;
  assert.equal(goal.status,"materials_needed");
  assert.equal(new SprinklerPlanner().propose(empty,goal),undefined);
  assert.equal(validateAgainstWorld({type:"craft_sprinkler",kind:"basic"},empty),false);
  assert.equal(validateAgainstWorld({type:"place_sprinkler",kind:"basic",x:5,y:5},empty),false);
  const a:Action={type:"craft_sprinkler",kind:"basic"};
  assert.equal(actionObserved(a,base,{...base,sprinklerKits:[{kind:"basic",count:1}]}),false);
  const badSite={...base,sprinklerSites:[],sprinklerKits:[{kind:"basic",count:1}]};
  assert.equal(validateAgainstWorld({type:"place_sprinkler",kind:"basic",x:5,y:5},badSite),false);
  assert.equal(reconcileSprinkler({...base,sprinklerRecipes:undefined},plan),undefined);
});
test("retrieve stored sprinkler ingredients without inventing or buying bars",()=>{
  const supplies={...base,economy:{...base.economy!,bag:[],
    chests:[{x:4,y:5,items:[copper,iron]}]},
    sprinklerRecipes:[{...recipe,canCraft:false}]};
  const goal=reconcileSprinkler(supplies,plan)!;
  assert.equal(goal.status,"materials_needed");
  assert.deepEqual(new SprinklerPlanner().propose(supplies,goal)?.action,
    {type:"withdraw_item",x:4,y:5,itemId:"(O)334",count:1});
  const noChest={...supplies,economy:{...supplies.economy!,chests:[]}};
  assert.equal(new SprinklerPlanner().propose(noChest,goal),undefined);
});
test("watering proof requires non-rainy next morning and real wet covered crop",()=>{
  const initial=reconcileSprinkler(base,plan)!;
  const installedState={...base,
    sprinklerKits:[{kind:"basic" as const,count:0}],
    installedSprinklers:[{kind:"basic" as const,x:5,y:5}]};
  const added=reconcileSprinkler(installedState,plan,initial)!;
  assert.equal(added.status,"installed");
  assert.equal(wateredBy("basic",{x:5,y:5},{x:5,y:4}),true);
  assert.equal(wateredBy("basic",{x:5,y:5},{x:6,y:6}),false);
  const next={...installedState,day:6,time:720,
    crops:[{...base.crops[0],watered:true}]};
  const proven=reconcileSprinkler(next,undefined,added)!;
  assert.equal(proven.status,"watering_verified");
  assert.equal(proven.verifiedWatered,1);
  assert.equal(reconcileSprinkler({...next,isRaining:true},undefined,added)?.status,"installed");
  assert.equal(reconcileSprinkler({...next,crops:[{...base.crops[0],watered:false}]},
    undefined,added)?.status,"installed");
  assert.equal(reconcileSprinkler({...next,time:1030},undefined,added)?.status,"installed");
  assert.equal(reconcileSprinkler({...next,installedSprinklers:[]},undefined,added)?.status,
    "ready_to_craft");
});
test("real investment goal survives restart and never leaks to a different save",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"bigfish-irrigation-"));
  try{
    const path=join(dir,"memory.json");
    const memory=new GoalMemory(path);
    await memory.startDay(base,DEFAULT_STRATEGY);
    const goal=reconcileSprinkler(base,plan)!;
    await memory.setSprinklerProject(base,goal);
    const loaded=new GoalMemory(path);await loaded.load();
    assert.deepEqual(loaded.get()?.sprinklerProject,goal);
    await loaded.startDay({...base,day:6},DEFAULT_STRATEGY);
    assert.deepEqual(loaded.get()?.sprinklerProject,goal);
    await loaded.startDay({...base,saveId:"new"},DEFAULT_STRATEGY);
    assert.equal(loaded.get()?.sprinklerProject,undefined);
    await assert.rejects(loaded.setSprinklerProject({...base,saveId:"new"},goal),
      /Invalid or cross-save/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("simulated real craft -> placement -> dry next-day watering",{
  timeout:18000
},async()=>{
  const token=randomBytes(24).toString("hex");
  const bridge=new GameBridge(token,0);await bridge.start();
  const stop=startSimulator(bridge.listeningPort(),token,{initialSprinklerMaterials:true});
  try{
    let before:GameState|undefined;
    const deadline=Date.now()+5000;
    while(!before&&Date.now()<deadline){
      const s=bridge.getState();
      if(s?.sprinklerRecipes?.some(r=>r.kind==="basic"&&r.canCraft))before=s;
      else await new Promise(r=>setTimeout(r,70));
    }
    assert.ok(before);
    const craft:Action={type:"craft_sprinkler",kind:"basic"};
    const seq=bridge.getStateSequence();
    assert.equal((await bridge.send(craft,5000)).ok,true);
    const made=await bridge.waitForNextState(seq,5000,
      next=>actionObserved(craft,before!,next));
    assert.equal(made.sprinklerKits?.find(k=>k.kind==="basic")?.count,1);
    assert.equal(made.economy?.bag.some(i=>i.id==="(O)334"),false);
    const place:Action={type:"place_sprinkler",kind:"basic",x:5,y:5};
    const beforePlace=bridge.getState()!;
    const placeSeq=bridge.getStateSequence();
    assert.equal((await bridge.send(place,5000)).ok,true);
    const installed=await bridge.waitForNextState(placeSeq,5000,
      next=>actionObserved(place,beforePlace,next));
    assert.ok(installed.installedSprinklers?.some(p=>p.kind==="basic"&&p.x===5&&p.y===5));
    assert.equal(installed.sprinklerKits?.find(k=>k.kind==="basic")?.count,0);
    assert.equal((await bridge.send({type:"travel_to",target:"FarmHouse"},5000)).ok,true);
    let house:GameState|undefined;
    const limit=Date.now()+5000;
    while(!house&&Date.now()<limit){
      const s=bridge.getState();if(s?.location==="FarmHouse")house=s;
      else await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(house);
    assert.equal((await bridge.send({type:"sleep"},5000)).ok,true);
    let woke:GameState|undefined;
    const wakeDeadline=Date.now()+5000;
    while(!woke&&Date.now()<wakeDeadline){
      const now=bridge.getState();
      if(now?.day===2&&now.location==="FarmHouse")woke=now;
      else await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(woke);
    assert.equal((await bridge.send({type:"travel_to",target:"Farm"},5000)).ok,true);
    const end=Date.now()+5000;
    let morning:GameState|undefined;
    while(!morning&&Date.now()<end){
      const s=bridge.getState();
      if(s?.day===2&&s.location==="Farm"&&s.installedSprinklers?.length)morning=s;
      else await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(morning);
    assert.equal(morning.crops.find(c=>c.x===5&&c.y===4)?.watered,true);
  }finally{stop();await bridge.stop();}
});
