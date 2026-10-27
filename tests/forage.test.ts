import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { ForagePlanner } from "../src/forage.ts";
import { validateAgainstWorld, parseDecision } from "../src/decision.ts";
import { actionObserved } from "../src/action-confirmation.ts";
import { GameBridge } from "../src/bridge.ts";
import { startSimulator } from "../src/simulator.ts";
import type { GameState, Action } from "../src/types.ts";

const base:GameState={
  saveId:"forage",location:"Farm",day:2,season:"spring",time:1000,
  energy:160,x:4,y:4,paused:false,crops:[],emptyPlots:[],tillable:[],seeds:[],
  forage:[{x:5,y:5,itemId:"(O)16"}],
  exits:[{x:8,y:6,target:"BusStop"},{x:6,y:2,target:"FarmHouse"}],
  worldLinks:[{from:"Farm",to:"BusStop"},{from:"BusStop",to:"Farm"},
    {from:"BusStop",to:"Town"},{from:"Town",to:"BusStop"}],
  bed:null,inventoryFree:8
};
test("foraging requires a real observed item and a reachable adjacent location",()=>{
  const p=new ForagePlanner();
  const action=p.propose(base,true)?.action;
  assert.deepEqual(action,{type:"collect_forage",x:5,y:5});
  assert.equal(validateAgainstWorld(action!,base),true);
  assert.equal(validateAgainstWorld(action!,{...base,forage:[]}),false);
  assert.equal(validateAgainstWorld(action!,{...base,inventoryFree:0}),false);
  assert.equal(validateAgainstWorld(action!,{...base,location:"Town"}),true);
  assert.deepEqual(parseDecision('{"action":{"type":"collect_forage","x":5,"y":5}}').action,action);
});
test("forage pickup postcondition requires visible object to disappear",()=>{
  const action:Action={type:"collect_forage",x:5,y:5};
  assert.equal(actionObserved(action,base,base),false);
  assert.equal(actionObserved(action,base,{...base,forage:[]}),true);
  assert.equal(actionObserved(action,base,{...base,forage:[],saveId:"other"}),false);
  const economy={gold:100,bag:[{id:"(O)16",count:1,category:-79,sellable:true}],
    chests:[],shippingBin:null,shop:null,
    tools:{hoe:true,wateringCan:true,equipped:"other",waterLeft:40}};
  assert.equal(actionObserved(action,{...base,economy},{...base,economy,forage:[]}),false);
  assert.equal(actionObserved(action,{...base,economy},{...base,forage:[],
    economy:{...economy,bag:[{...economy.bag[0],count:2}]}}),true);
});
test("forage trip is finite, recovers alternate approach tiles, and avoids endless map ping-pong",()=>{
  const p=new ForagePlanner();
  const far={...base,forage:[{x:7,y:7,itemId:"(O)16"}]};
  const first=p.propose(far,true)?.action;
  assert.equal(first?.type,"move_to");
  p.observe(far,first,{id:"1",ok:false,message:"blocked"});
  p.observe(far,first,{id:"2",ok:false,message:"blocked"});
  assert.notDeepEqual(p.propose(far,false)?.action,first);
  const cleared={...base,forage:[]};
  assert.deepEqual(p.propose(cleared,false)?.action,{type:"travel_to",target:"BusStop"});
  const bus:GameState={...cleared,location:"BusStop",exits:[
    {x:3,y:3,target:"Farm"},{x:8,y:5,target:"Town"}]};
  assert.deepEqual(p.propose(bus,false)?.action,{type:"travel_to",target:"Town"});
  const town:GameState={...cleared,location:"Town",exits:[{x:2,y:5,target:"BusStop"}]};
  assert.equal(p.propose(town,false),undefined);
  assert.equal(p.isActive,false);
  assert.equal(p.propose(cleared,true),undefined);
  assert.equal(p.propose({...cleared,day:3},true)?.action.type,"travel_to");
});
test("foraging does not start with insufficient energy or missing game observation",()=>{
  const p=new ForagePlanner();
  assert.equal(p.propose({...base,energy:20},true),undefined);
  assert.equal(p.propose({...base,forage:undefined},true),undefined);
  assert.equal(p.propose({...base,inventoryFree:0},true),undefined);
  assert.equal(p.propose({...base,paused:true},true),undefined);
});
test("mock bridge collects world forage and verifies authoritative item change",{
  timeout:12000
},async()=>{
  const token=randomBytes(24).toString("hex");
  const bridge=new GameBridge(token,0);
  await bridge.start();
  const stop=startSimulator(bridge.listeningPort(),token);
  try{
    let before:GameState|undefined;
    const deadline=Date.now()+4000;
    while(!before && Date.now()<deadline){
      const state=bridge.getState();
      if(state?.forage?.length)before=state;
      else await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(before?.forage?.some(f=>f.x===3&&f.y===5));
    const seq=bridge.getStateSequence();
    const action:Action={type:"collect_forage",x:3,y:5};
    const ack=await bridge.send(action,4000);
    assert.equal(ack.ok,true,ack.message);
    const after=await bridge.waitForNextState(seq,4000,s=>actionObserved(action,before!,s));
    assert.equal(after.forage?.length,0);
    assert.ok(after.economy?.bag.some(i=>i.id==="(O)16"));
  }finally{stop();await bridge.stop();}
});
