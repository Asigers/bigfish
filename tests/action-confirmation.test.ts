import assert from "node:assert/strict";
import test from "node:test";
import { actionObserved } from "../src/action-confirmation.ts";
import type { GameState } from "../src/types.ts";

const home:GameState={
  saveId:"save",location:"FarmHouse",day:2,season:"spring",time:610,energy:200,
  x:4,y:9,paused:false,crops:[],emptyPlots:[],tillable:[],seeds:[],
  exits:[{x:3,y:11,target:"Farm"}],worldLinks:[],bed:{x:5,y:5},inventoryFree:10
};

test("travel requires observing the destination instead of another farmhouse heartbeat",()=>{
  const travel={type:"travel_to" as const,target:"Farm"};
  assert.equal(actionObserved(travel,home,{...home,time:620}),false);
  assert.equal(actionObserved(travel,home,{...home,location:"Farm",x:64,y:16}),true);
  assert.equal(actionObserved(travel,home,{...home,saveId:"other",location:"Farm"}),false);
});
test("move and sleep require explicit state postconditions",()=>{
  assert.equal(actionObserved({type:"move_to",x:4,y:11},home,{...home,time:620}),false);
  assert.equal(actionObserved({type:"move_to",x:4,y:11},home,{...home,y:11}),true);
  assert.equal(actionObserved({type:"sleep"},home,{...home,time:2300}),false);
  assert.equal(actionObserved({type:"sleep"},home,{...home,day:3,time:610}),true);
});
test("failed state progression cannot be mistaken for completed tool actions",()=>{
  const farm:GameState={...home,location:"Farm",crops:[{x:5,y:5,watered:false,ready:false}]};
  assert.equal(actionObserved({type:"water_tile",x:5,y:5},farm,farm),false);
  assert.equal(actionObserved({type:"water_tile",x:5,y:5},farm,
    {...farm,crops:[{x:5,y:5,watered:true,ready:false}]}),true);
});
