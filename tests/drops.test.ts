import assert from "node:assert/strict";
import test from "node:test";
import { DropPlanner } from "../src/drops.ts";
import { actionObserved } from "../src/action-confirmation.ts";
import { parseDecision,validateAgainstWorld } from "../src/decision.ts";
import type { Action,GameState } from "../src/types.ts";

const item="(O)388";
const base:GameState={
  saveId:"drop-save",location:"Farm",day:3,season:"spring",time:1000,
  energy:150,x:4,y:4,paused:false,crops:[],emptyPlots:[],tillable:[],seeds:[],
  drops:[{x:9,y:9,itemId:item}],exits:[],worldLinks:[],
  bed:null,inventoryFree:5,
  economy:{gold:200,bag:[],chests:[],shippingBin:null,shop:null,
    tools:{hoe:true,wateringCan:true,equipped:"axe",waterLeft:40}}
};
test("drop pickup requires an authoritative resource debris observation",()=>{
  const action:Action={type:"pickup_drop",x:9,y:9,itemId:item};
  assert.deepEqual(new DropPlanner().propose(base)?.action,action);
  assert.deepEqual(parseDecision('{"action":{"type":"pickup_drop","x":9,"y":9,"itemId":"(O)388"}}').action,action);
  assert.equal(validateAgainstWorld(action,base),true);
  assert.equal(validateAgainstWorld(action,{...base,drops:[]}),false);
  assert.equal(validateAgainstWorld(action,{...base,inventoryFree:0}),false);
  assert.equal(validateAgainstWorld(action,{...base,drops:undefined}),false);
});
test("drop disappearing is not the same as bag acquisition",()=>{
  const action:Action={type:"pickup_drop",x:9,y:9,itemId:item};
  assert.equal(actionObserved(action,base,{...base,drops:[]}),false);
  assert.equal(actionObserved(action,base,{
    ...base,economy:{...base.economy!,bag:[{id:item,count:1,category:-16,sellable:false}]}
  }),true);
  assert.equal(actionObserved(action,base,{
    ...base,saveId:"different",
    economy:{...base.economy!,bag:[{id:item,count:1,category:-16,sellable:false}]}
  }),false);
});
test("failed drop recovery is bounded and retries only after day change",()=>{
  const planner=new DropPlanner();
  const action=planner.propose(base)?.action;
  assert.ok(action);
  planner.observe(base,action,{id:"a",ok:false,message:"path blocked"});
  planner.observe(base,action,{id:"b",ok:false,message:"path blocked"});
  assert.equal(planner.propose(base),undefined);
  assert.equal(planner.propose({...base,day:4})?.action.type,"pickup_drop");
});
test("drop recovery skips absent inventory slots, bedtime and pause state",()=>{
  const planner=new DropPlanner();
  assert.equal(planner.propose({...base,inventoryFree:0}),undefined);
  assert.equal(planner.propose({...base,time:2300}),undefined);
  assert.equal(planner.propose({...base,paused:true}),undefined);
  assert.equal(planner.propose({...base,economy:undefined}),undefined);
  assert.equal(planner.propose({...base,drops:undefined}),undefined);
});
