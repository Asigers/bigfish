import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { FoodPlanner } from "../src/food.ts";
import { EconomyPlanner } from "../src/economy.ts";
import { validateAgainstWorld,parseDecision } from "../src/decision.ts";
import { actionObserved } from "../src/action-confirmation.ts";
import { GameBridge } from "../src/bridge.ts";
import { startSimulator } from "../src/simulator.ts";
import type { GameState,Action } from "../src/types.ts";

const base:GameState={
  saveId:"food-test",location:"Farm",day:2,season:"spring",time:1110,
  energy:60,x:4,y:4,paused:false,crops:[],emptyPlots:[],tillable:[],seeds:[],
  food:[{id:"(O)16",count:1,restoreEnergy:30},{id:"(O)18",count:2,restoreEnergy:35}],
  exits:[],worldLinks:[],bed:null,inventoryFree:8,
  economy:{gold:100,bag:[{id:"(O)16",count:1,category:-79,sellable:true},
    {id:"(O)18",count:2,category:-79,sellable:true}],
    chests:[],shippingBin:{x:4,y:5},shop:null,
    tools:{hoe:true,wateringCan:true,equipped:"hoe",waterLeft:40}}
};
test("planner only eats safe real food with low energy and preserves bounded daily budget",()=>{
  const p=new FoodPlanner();
  const action=p.propose(base)?.action;
  assert.deepEqual(action,{type:"eat_food",itemId:"(O)18"});
  assert.equal(validateAgainstWorld(action!,base),true);
  assert.deepEqual(parseDecision('{"action":{"type":"eat_food","itemId":"(O)18"}}').action,action);
  assert.equal(validateAgainstWorld(action!,{...base,food:[]}),false);
  assert.equal(p.propose({...base,energy:120}),undefined);
  assert.equal(p.propose({...base,food:undefined}),undefined);
  assert.equal(p.propose({...base,paused:true}),undefined);
  assert.equal(p.propose({...base,time:2300}),undefined);
  for(let i=0;i<4;i++)p.observe(base,action,{id:String(i),ok:true,message:"ate"});
  assert.equal(p.propose(base),undefined);
  assert.equal(p.propose({...base,day:3})?.action.type,"eat_food");
});
test("food completion requires BOTH depleted inventory and real energy restoration",()=>{
  const action:Action={type:"eat_food",itemId:"(O)16"};
  assert.equal(actionObserved(action,base,{...base,energy:85}),false);
  assert.equal(actionObserved(action,base,{
    ...base,economy:{...base.economy!,bag:base.economy!.bag.filter(i=>i.id!=="(O)16")}
  }),false);
  assert.equal(actionObserved(action,base,{...base,energy:90,
    economy:{...base.economy!,bag:base.economy!.bag.filter(i=>i.id!=="(O)16")}
  }),true);
  assert.equal(actionObserved(action,base,{...base,saveId:"other",energy:90,
    economy:{...base.economy!,bag:[]}
  }),false);
});
test("reserve emergency edible items, ship actual produce, and store craft resources when nearly full",()=>{
  const planner=new EconomyPlanner();
  const action=planner.propose(base)?.action;
  assert.equal(action?.type,"wait"===action?.type?"wait":"none"); // no nonfood sellables in inventory
  const withProduce:GameState={...base,economy:{...base.economy!,bag:[
    ...base.economy!.bag,{id:"(O)24",count:2,category:-75,sellable:true}]}};
  assert.deepEqual(new EconomyPlanner().propose(withProduce)?.action,{type:"ship_item",itemId:"(O)24"});
  const withWood:GameState={...base,inventoryFree:1,economy:{
    ...base.economy!,bag:[{id:"(O)388",count:12,category:-16,sellable:false}],
    chests:[{x:4,y:5,items:[]}]}};
  assert.deepEqual(new EconomyPlanner().propose(withWood)?.action,
    {type:"store_item",x:4,y:5,itemId:"(O)388",count:12});
});
test("mock bridge consumes collected forage with item loss and stamina gain",{
  timeout:12000
},async()=>{
  const token=randomBytes(24).toString("hex");
  const bridge=new GameBridge(token,0);await bridge.start();
  const stop=startSimulator(bridge.listeningPort(),token,{initialEnergy:55});
  try{
    let before:GameState|undefined;
    const deadline=Date.now()+4000;
    while(!before&&Date.now()<deadline){
      const s=bridge.getState();
      if(s?.forage?.some(f=>f.x===3&&f.y===5))before=s;
      else await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(before);
    const harvest=await bridge.send({type:"collect_forage",x:3,y:5},4000);
    assert.equal(harvest.ok,true);
    await bridge.waitForNextState(bridge.getStateSequence()-2,4000,
      s=>s.food?.some(i=>i.id==="(O)16")===true);
    const foodBefore=bridge.getState()!;
    const seq=bridge.getStateSequence();
    const eat:Action={type:"eat_food",itemId:"(O)16"};
    assert.equal((await bridge.send(eat,4000)).ok,true);
    const after=await bridge.waitForNextState(seq,4000,s=>actionObserved(eat,foodBefore,s));
    assert.ok(after.energy>foodBefore.energy);
    assert.equal(after.food?.some(f=>f.id==="(O)16"),false);
  }finally{stop();await bridge.stop();}
});
