import assert from "node:assert/strict";
import test from "node:test";
import { Autopilot,parseDecision,validateAgainstWorld } from "../src/decision.ts";
import { validState,type GameState } from "../src/types.ts";
const base:GameState={
  saveId:"save",location:"Farm",day:1,season:"spring",time:610,energy:200,x:4,y:4,paused:false,
  crops:[],emptyPlots:[],tillable:[],seeds:[],exits:[{x:6,y:2,target:"FarmHouse"}],
  worldLinks:[{from:"Farm",to:"FarmHouse"},{from:"FarmHouse",to:"Farm"}],
  bed:null,inventoryFree:10
};
test("empty farm starts finite exploration instead of streaming idle waits",()=>{
  const p=new Autopilot();
  const farm:GameState={...base,worldLinks:[
    ...base.worldLinks,
    {from:"Farm",to:"BusStop"},{from:"BusStop",to:"Town"},
    {from:"Town",to:"BusStop"},{from:"BusStop",to:"Farm"}
  ],exits:[...base.exits,{x:8,y:6,target:"BusStop"}]};
  assert.deepEqual(p.decide(farm).action,{type:"travel_to",target:"BusStop"});
  const bus:GameState={...farm,location:"BusStop",exits:[
    {x:3,y:3,target:"Farm"},{x:8,y:5,target:"Town"}
  ]};
  assert.deepEqual(p.decide(bus).action,{type:"travel_to",target:"Town"});
  const town:GameState={...farm,location:"Town",exits:[{x:2,y:5,target:"BusStop"}]};
  assert.deepEqual(p.decide(town).action,{type:"travel_to",target:"BusStop"});
  // The itinerary is finite: after visiting the known places, return home.
  assert.deepEqual(p.decide(bus).action,{type:"travel_to",target:"Farm"});
  assert.deepEqual(p.decide(farm).action,{type:"travel_to",target:"FarmHouse"});
  const home:GameState={...farm,location:"FarmHouse",bed:{x:5,y:5},
    exits:[{x:3,y:11,target:"Farm"}],time:1000};
  assert.deepEqual(p.decide(home).action,{type:"sleep"});
});
test("at home in the morning, farmer returns to work before touring",()=>{
  const p=new Autopilot();
  const home:GameState={...base,location:"FarmHouse",bed:{x:5,y:5},
    exits:[{x:3,y:11,target:"Farm"}],time:1000};
  assert.deepEqual(p.decide(home).action,{type:"travel_to",target:"Farm"});
});
test("late evening or critically low energy still triggers return and sleep",()=>{
  const late:GameState={...base,time:2300};
  const tired:GameState={...base,time:1000,energy:10};
  const home:GameState={...base,location:"FarmHouse",bed:{x:5,y:5},
    exits:[{x:3,y:11,target:"Farm"}]};
  for(const state of [late,tired]){
    const planner=new Autopilot();
    assert.deepEqual(planner.decide(state).action,{type:"travel_to",target:"FarmHouse"});
    const atHome={...home,time:state.time,energy:state.energy};
    assert.deepEqual(planner.decide(atHome).action,{type:"sleep"});
  }
});
test("plant vacant soil; till soil if none available",()=>{
  const p=new Autopilot();
  assert.deepEqual(p.decide({...base,emptyPlots:[{x:5,y:4,watered:false}],seeds:[{id:"(O)472",count:4}]}).action,
    {type:"plant_seed",x:5,y:4,seedId:"(O)472"});
  assert.deepEqual(p.decide({...base,tillable:[{x:5,y:4}],seeds:[{id:"(O)472",count:4}]}).action,
    {type:"till_tile",x:5,y:4});
});
test("harvest mature before watering others",()=>{
  const s={...base,crops:[{x:5,y:4,watered:true,ready:true},{x:3,y:4,watered:false,ready:false}]};
  assert.deepEqual(new Autopilot().decide(s).action,{type:"harvest_crop",x:5,y:4});
});
test("sleep at home and return to farm next morning",()=>{
  const p=new Autopilot();
  const home={...base,location:"FarmHouse",bed:{x:5,y:5},time:2300,exits:[{x:3,y:11,target:"Farm"}]};
  assert.deepEqual(p.decide(home).action,{type:"sleep"});
  assert.deepEqual(p.decide({...home,day:2,time:610}).action,{type:"travel_to",target:"Farm"});
});
test("multi-hop route through Farm to FarmHouse",()=>{
  const state={...base,location:"BusStop",exits:[{x:1,y:1,target:"Farm"}],
    worldLinks:[...base.worldLinks,{from:"BusStop",to:"Farm"}],time:2300};
  assert.deepEqual(new Autopilot().decide(state).action,{type:"travel_to",target:"Farm"});
});
test("repeated failed action excluded from next decision",()=>{
  const p=new Autopilot();
  const s={...base,crops:[{x:5,y:4,watered:false,ready:false}]};
  const a=p.decide(s).action;
  p.observe(s,[{id:"x",ok:false,message:"blocked"}],a);
  p.observe(s,[{id:"y",ok:false,message:"blocked"}],a);
  assert.notDeepEqual(p.decide(s).action,a);
});
test("reject unsupported model tools, invalid seed id, and invalid state",()=>{
  assert.throws(()=>parseDecision('{"action":{"type":"shell","cmd":"ls"}}'));
  assert.throws(()=>parseDecision('{"action":{"type":"plant_seed","x":2,"y":3,"seedId":"../../p"}}'));
  assert.equal(validState(base),true);
  assert.equal(validState({...base,emptyPlots:[{x:"bad",y:3,watered:false}]}),false);
  assert.equal(validateAgainstWorld({type:"plant_seed",x:2,y:2,seedId:"(O)472"},base),false);
});
test("accept supported structured actions",()=>{
  assert.deepEqual(parseDecision('{"action":{"type":"sleep"},"speech":"睡觉","reason":"late"}').action,{type:"sleep"});
  assert.deepEqual(parseDecision('{"action":{"type":"travel_to","target":"FarmHouse"}}').action,{type:"travel_to",target:"FarmHouse"});
});


test("manual movement unlocks same-day route retry after two failures",()=>{
  const p=new Autopilot();
  const home={...base,location:"FarmHouse",bed:{x:5,y:5},time:610,
    exits:[{x:3,y:11,target:"Farm"}],x:4,y:5};
  const commute={type:"travel_to" as const,target:"Farm"};
  assert.deepEqual(p.decide(home).action,commute);
  p.observe(home,[{id:"fail1",ok:false,message:"path blocked"}],commute);
  p.observe(home,[{id:"fail2",ok:false,message:"path blocked"}],commute);
  assert.deepEqual(p.decide(home).action,{type:"wait",seconds:5});
  assert.deepEqual(p.decide({...home,x:5}).action,commute);
});
