import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EconomyPlanner, DEFAULT_STRATEGY } from "../src/economy.ts";
import { GoalMemory, parseStrategy } from "../src/strategy.ts";
import { validState, type GameState } from "../src/types.ts";
const base:GameState={
  saveId:"test",location:"Farm",day:1,season:"spring",time:1000,energy:210,x:5,y:5,paused:false,
  crops:[],emptyPlots:[],tillable:[],seeds:[],exits:[{x:6,y:2,target:"BusStop"}],
  worldLinks:[{from:"Farm",to:"BusStop"},{from:"BusStop",to:"Town"},{from:"Town",to:"SeedShop"},{from:"SeedShop",to:"Town"},{from:"Town",to:"BusStop"},{from:"BusStop",to:"Farm"}],
  bed:null,inventoryFree:6,waterSources:[{x:4,y:6}],
  economy:{gold:500,bag:[],chests:[],shippingBin:{x:6,y:5},shop:null,
    tools:{hoe:true,wateringCan:true,equipped:"hoe",waterLeft:40}}
};
test("economic snapshot must be validated and safe to serialize",()=>{
  assert.equal(validState(base),true);
  assert.equal(validState({...base,economy:{...base.economy!,gold:-20}}),false);
  assert.equal(validState({...base,economy:{...base.economy!,bag:[{id:"../../etc",count:1,category:-1,sellable:true}]}}),false);
});
test("ship produce before purchasing; never ship seeds",()=>{
  const planner=new EconomyPlanner();
  const s:GameState={...base,economy:{...base.economy!,bag:[{id:"(O)24",count:3,category:-75,sellable:true},{id:"(O)472",count:2,category:-74,sellable:false}]}};
  assert.deepEqual(planner.propose(s)?.action,{type:"ship_item",itemId:"(O)24"});
});
test("seed shopping is multi-map and respects actual price and current funds",()=>{
  const planner=new EconomyPlanner();
  assert.deepEqual(planner.propose(base)?.action,{type:"travel_to",target:"BusStop"});
  const way:GameState={...base,location:"BusStop",exits:[{x:4,y:4,target:"Town"}],economy:{...base.economy!,shippingBin:null}};
  assert.deepEqual(planner.propose(way)?.action,{type:"travel_to",target:"Town"});
  const shop:GameState={...base,location:"SeedShop",economy:{...base.economy!,shippingBin:null,
    shop:{keeper:{x:5,y:4},open:true,offers:[{id:"(O)472",price:20,stock:12}]}}};
  assert.deepEqual(planner.propose(shop)?.action,{type:"buy_seed",itemId:"(O)472",count:6});
});
test("shop restock trip starts in early morning once chores finish",()=>{
  const early={...base,time:610};
  assert.deepEqual(new EconomyPlanner().propose(early)?.action,
    {type:"travel_to",target:"BusStop"});
});

test("store materials if backpack full, and recover stored seeds",()=>{
  const planner=new EconomyPlanner();
  const material={id:"(O)388",count:5,category:-16,sellable:false};
  const e=base.economy!;
  const s:GameState={...base,inventoryFree:0,economy:{...e,bag:[material],chests:[{x:5,y:4,items:[]}]}};
  assert.deepEqual(planner.propose(s)?.action,{type:"store_item",itemId:material.id,count:5,x:5,y:4});
  const rec:GameState={...base,economy:{...e,chests:[{x:5,y:4,items:[{id:"(O)472",count:4,category:-74,sellable:false}]}]}};
  assert.deepEqual(new EconomyPlanner().propose(rec)?.action,{type:"withdraw_item",itemId:"(O)472",count:4,x:5,y:4});
});
test("persistent strategy survives restart; invalid LLM plans are rejected",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"bigfish-"));
  const file=join(dir,"brain.json");
  try{
    const memory=new GoalMemory(file);await memory.load();assert.equal(memory.needsPlanning(base),true);
    const strategy=parseStrategy('{"goal":"expand","targetGold":3500,"seedReserve":9,"notes":"春天多开地"}');
    await memory.startDay(base,strategy);await memory.note("Bought nine seeds",true);
    const reload=new GoalMemory(file);await reload.load();
    assert.equal(reload.needsPlanning(base),false);
    assert.equal(reload.get()?.strategy.seedReserve,9);
    assert.equal(reload.get()?.completed.length,1);
    assert.deepEqual(DEFAULT_STRATEGY.goal,"profit");
    assert.throws(()=>parseStrategy('{"goal":"cheat","targetGold":500,"seedReserve":100,"notes":"bad"}'));
    assert.ok((await readFile(file,"utf8")).includes("expand"));
  }finally{await rm(dir,{recursive:true,force:true});}
});
