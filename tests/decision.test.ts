import assert from "node:assert/strict";
import test from "node:test";
import { mockDecision, parseDecision } from "../src/decision.ts";
import { validState, type GameState } from "../src/types.ts";

const state: GameState={
  saveId:"test",location:"Farm",day:1,season:"spring",time:610,
  energy:200,x:2,y:2,paused:false,crops:[{x:4,y:2,watered:false}]
};
test("parse valid model response",()=>{
  const d=parseDecision('{"action":{"type":"water_tile","x":5,"y":4},"speech":"hello","reason":"test"}');
  assert.deepEqual(d.action,{type:"water_tile",x:5,y:4});
});
test("reject prompt-injected invalid tools and coordinates",()=>{
  assert.throws(()=>parseDecision('{"action":{"type":"shell","cmd":"rm -rf /"}}'));
  assert.throws(()=>parseDecision('{"action":{"type":"move_to","x":999,"y":4}}'));
  assert.throws(()=>parseDecision('{"action":{"type":"wait","seconds":600}}'));
});
test("mock planner moves toward crop then waters",()=>{
  assert.deepEqual(mockDecision(state).action,{type:"move_to",x:3,y:2});
  assert.deepEqual(mockDecision({...state,x:3}).action,{type:"water_tile",x:4,y:2});
});
test("mock planner does not play during menus",()=>{
  assert.equal(mockDecision({...state,paused:true}).action.type,"wait");
});
test("state validation prevents malformed snapshots",()=>{
  assert.equal(validState(state),true);
  assert.equal(validState({...state,crops:[{x:"bad",y:2,watered:false}]}),false);
});
