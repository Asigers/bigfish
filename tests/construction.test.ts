import assert from "node:assert/strict";
import test from "node:test";
import {randomBytes} from "node:crypto";
import {InfrastructurePlanner} from "../src/infrastructure.ts";
import {updateWorkProject,validWorkProject} from "../src/farm-work.ts";
import {actionObserved} from "../src/action-confirmation.ts";
import {parseDecision,validateAgainstWorld} from "../src/decision.ts";
import {startSimulator} from "../src/simulator.ts";
import {GameBridge} from "../src/bridge.ts";
import type {Action,GameState} from "../src/types.ts";

const base:GameState={
  saveId:"build-test",day:2,season:"spring",time:1030,energy:180,
  location:"Farm",x:7,y:7,paused:false,inventoryFree:8,
  crops:[],emptyPlots:[],tillable:[],seeds:[],
  placementSites:[{x:8,y:7},{x:9,y:9}],chestKits:0,canCraftChest:true,
  exits:[],worldLinks:[],bed:null,
  economy:{gold:150,bag:[{id:"(O)388",count:50,category:-16,sellable:false}],
    chests:[],shippingBin:null,shop:null,
    tools:{hoe:true,wateringCan:true,equipped:"axe",waterLeft:40}}
};
test("true chest project progresses only on verified recipe output and placed storage",()=>{
  const first=updateWorkProject(base)!;
  assert.equal(first.tasks.find(t=>t.id==="wood")?.status,"done");
  assert.equal(first.tasks.find(t=>t.id==="craft_chest")?.status,"ready");
  assert.equal(first.tasks.find(t=>t.id==="place_chest")?.status,"blocked");
  assert.ok(validWorkProject(first));
  const craft=new InfrastructurePlanner().propose(base,first);
  assert.deepEqual(craft?.action,{type:"craft_chest"});
  assert.equal(validateAgainstWorld(craft!.action,base),true);
  assert.deepEqual(parseDecision('{"action":{"type":"craft_chest"}}').action,craft!.action);
  const crafted:GameState={...base,chestKits:1,canCraftChest:false,
    economy:{...base.economy!,bag:[]}};
  assert.equal(actionObserved(craft!.action,base,crafted),true);
  const second=updateWorkProject(crafted,first)!;
  assert.equal(second.tasks.find(t=>t.id==="wood")?.status,"done");
  assert.equal(second.tasks.find(t=>t.id==="craft_chest")?.status,"done");
  assert.equal(second.tasks.find(t=>t.id==="place_chest")?.status,"ready");
  const placement=new InfrastructurePlanner().propose(crafted,second);
  assert.deepEqual(placement?.action,{type:"place_chest",x:8,y:7});
  assert.equal(validateAgainstWorld(placement!.action,crafted),true);
  assert.deepEqual(parseDecision('{"action":{"type":"place_chest","x":8,"y":7}}').action,placement!.action);
  const installed:GameState={...crafted,chestKits:0,
    economy:{...crafted.economy!,chests:[{x:8,y:7,items:[]}]}};
  assert.equal(actionObserved(placement!.action,crafted,installed),true);
  const last=updateWorkProject(installed,second)!;
  assert.equal(last.tasks.find(t=>t.id==="place_chest")?.status,"done");
  assert.equal(new InfrastructurePlanner().propose(installed,last),undefined);
});
test("chest work cannot invent materials or place on unsurveyed or reserved field cells",()=>{
  const withoutWood:GameState={...base,economy:{...base.economy!,bag:[]},canCraftChest:false};
  const p=updateWorkProject(withoutWood)!;
  assert.equal(p.tasks.find(t=>t.id==="craft_chest")?.status,"blocked");
  assert.equal(new InfrastructurePlanner().propose(withoutWood,p),undefined);
  assert.equal(validateAgainstWorld({type:"craft_chest"},withoutWood),false);
  const crafted={...base,chestKits:1,canCraftChest:false,economy:{...base.economy!,bag:[]}};
  const sitePlanner=new InfrastructurePlanner();
  const bad={type:"place_chest" as const,x:9,y:8};
  assert.equal(validateAgainstWorld(bad,crafted),false);
  const project=updateWorkProject(crafted)!;
  const plan={saveId:base.saveId,dayKey:"spring:2",targetPlots:1,occupiedPlots:0,
    fieldTiles:[{x:8,y:7}],protectedTiles:[],preferredSeedId:null,
    crops:[],reason:"test",revision:"test",costKnown:false};
  assert.deepEqual(sitePlanner.propose(crafted,project,plan)?.action,
    {type:"move_to",x:8,y:8});
});
test("failure handling is bounded per day, and existing chest prevents duplicates",()=>{
  const project=updateWorkProject(base)!;
  const planner=new InfrastructurePlanner();
  const a:Action={type:"craft_chest"};
  planner.observe(base,a,{id:"1",ok:false,message:"recipe locked"});
  planner.observe(base,a,{id:"2",ok:false,message:"recipe locked"});
  assert.equal(planner.propose(base,project),undefined);
  assert.deepEqual(planner.propose({...base,day:3},updateWorkProject({...base,day:3},project))?.action,a);
  const existing={...base,economy:{...base.economy!,chests:[{x:8,y:7,items:[]}]}};
  assert.equal(new InfrastructurePlanner().propose(existing,updateWorkProject(existing)),undefined);
});
test("the simulator crafts a chest using 50 real wood then places it onto the farm",{
  timeout:15000
},async()=>{
  const token=randomBytes(24).toString("hex");
  const bridge=new GameBridge(token,0);await bridge.start();
  const stop=startSimulator(bridge.listeningPort(),token,{initialChests:0,initialWood:50});
  try{
    const deadline=Date.now()+4000;
    let before:GameState|undefined;
    while(!before && Date.now()<deadline){
      const now=bridge.getState();
      if(now?.canCraftChest && now.economy?.chests.length===0)before=now;
      else await new Promise(r=>setTimeout(r,60));
    }
    assert.ok(before);
    const seq=bridge.getStateSequence();
    const craft:Action={type:"craft_chest"};
    assert.equal((await bridge.send(craft,4000)).ok,true);
    const made=await bridge.waitForNextState(seq,4000,
      next=>actionObserved(craft,before!,next));
    assert.equal(made.chestKits,1);
    assert.equal(made.economy?.bag.some(i=>i.id==="(O)388"),false);
    assert.equal(made.economy?.chests.length,0);
    assert.equal((await bridge.send({type:"move_to",x:4,y:6},4000)).ok,true);
    const current=bridge.getState()!;
    const seq2=bridge.getStateSequence();
    const place:Action={type:"place_chest",x:4,y:7};
    assert.equal((await bridge.send(place,4000)).ok,true);
    const installed=await bridge.waitForNextState(seq2,4000,
      next=>actionObserved(place,current,next));
    assert.equal(installed.chestKits,0);
    assert.equal(installed.economy?.chests.some(ch=>ch.x===4&&ch.y===7),true);
  }finally{stop();await bridge.stop();}
});
