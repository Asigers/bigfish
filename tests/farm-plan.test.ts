import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFarmPlan,bestPurchase,cropEstimate,plannedSeed,rankedCrops,withinPlan } from "../src/farm-plan.ts";
import { GoalMemory } from "../src/strategy.ts";
import { Autopilot } from "../src/decision.ts";
import { EconomyPlanner,DEFAULT_STRATEGY } from "../src/economy.ts";
import { validState,type CropInfo,type GameState } from "../src/types.ts";

const spring:CropInfo={seedId:"(O)472",harvestId:"(O)24",
  seasons:["spring"],growthDays:4,regrowDays:-1,sellPrice:35,
  minHarvest:1,raised:false,needsWatering:true};
const slow:CropInfo={seedId:"(O)474",harvestId:"(O)188",
  seasons:["spring"],growthDays:13,regrowDays:-1,sellPrice:75,
  minHarvest:1,raised:false,needsWatering:true};
const fall:CropInfo={...spring,seedId:"(O)490",harvestId:"(O)270",seasons:["fall"]};
const tillable=Array.from({length:12},(_,i)=>({x:10+(i%4),y:10+Math.floor(i/4)}));
const state:GameState={
  saveId:"farm-save",day:5,season:"spring",time:1000,energy:200,
  location:"Farm",x:8,y:9,paused:false,inventoryFree:8,
  crops:[{x:8,y:8,watered:true,ready:false,seedId:"(O)472"}],
  emptyPlots:[{x:9,y:9,watered:true}],
  tillable,seeds:[{id:"(O)472",count:2}],
  cropCatalog:[spring,slow,fall],exits:[{x:1,y:1,target:"FarmHouse"}],worldLinks:[],
  bed:null,economy:{gold:200,bag:[{id:"(O)472",count:2,category:-74,sellable:false}],
    shippingBin:{x:3,y:3},chests:[],shop:null,
    tools:{hoe:true,wateringCan:true,equipped:"hoe",waterLeft:40}}
};
test("GameState accepts real crop data and rejects fabricated or malformed rows",()=>{
  assert.equal(validState(state),true);
  assert.equal(validState({...state,crops:[{...state.crops[0],seedId:null}]}),true);
  assert.equal(validState({...state,cropCatalog:[{...spring,growthDays:-5}]}),false);
  assert.equal(validState({...state,cropCatalog:[{...spring,seedId:"../../"}]}),false);
});
test("construct a bounded farm blueprint only from observed real tiles",()=>{
  const plan=buildFarmPlan(state,DEFAULT_STRATEGY);
  assert.ok(plan);
  assert.equal(plan.dayKey,"spring:5");
  assert.equal(plan.occupiedPlots,1);
  assert.equal(plan.targetPlots,6);
  assert.equal(plan.fieldTiles.length,6);
  assert.deepEqual(plan.fieldTiles.slice(0,2),[{x:8,y:8},{x:9,y:9}]);
  assert.ok(plan.fieldTiles.every(t=>[...state.crops,...state.emptyPlots,...state.tillable]
    .some(x=>x.x===t.x&&x.y===t.y)));
  assert.equal(plan.preferredSeedId,"(O)472");
  assert.ok(withinPlan(plan,{x:9,y:9}));
  assert.equal(withinPlan(plan,{x:40,y:40}),false);
  assert.equal(plan.costKnown,false);
  const dayPlanner=new Autopilot();
  assert.deepEqual(dayPlanner.decide(state,plan).action,
    {type:"plant_seed",x:9,y:9,seedId:"(O)472"});
});
test("only observed shop prices allow a net-profit ranking and affordable purchase",()=>{
  const plan=buildFarmPlan(state,DEFAULT_STRATEGY)!;
  const shop:GameState={...state,location:"SeedShop",crops:[],emptyPlots:[],
    tillable:[],economy:{...state.economy!,shippingBin:null,
      shop:{keeper:{x:8,y:8},open:true,offers:[
        {id:"(O)472",price:20,stock:12},
        {id:"(O)474",price:50,stock:12},
        {id:"(O)490",price:1,stock:12}
      ]}}};
  assert.equal(rankedCrops(shop)[0].seedId,"(O)472");
  assert.equal(bestPurchase(shop,plan)?.id,"(O)472");
  const buy=new EconomyPlanner().propose(shop,DEFAULT_STRATEGY,plan)?.action;
  // 6 plots minus 1 crop already planted = 5 total seeds; 2 already owned => 3.
  assert.deepEqual(buy,{type:"buy_seed",itemId:"(O)472",count:3});
  const costs=rankedCrops(state);
  assert.ok(costs.every(c=>c.observedSeedPrice===null&&c.estimatedMargin===null));
  assert.equal(cropEstimate(state,spring,20).estimatedMargin,15);
  assert.equal(bestPurchase({...shop,economy:{...shop.economy!,shop:{
    ...shop.economy!.shop!,offers:[{id:"(O)472",price:100,stock:10}]} }},plan),undefined);
});
test("shop snapshots cannot erase remembered farm occupancy",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"bigfish-farm-plan-"));
  const file=join(dir,"farm.json");
  try{
    const memory=new GoalMemory(file);
    await memory.startDay(state,DEFAULT_STRATEGY);
    const plan=buildFarmPlan(state,DEFAULT_STRATEGY)!;
    await memory.setFarmPlan(state,plan);
    const grown={...state,crops:[...state.crops,{x:9,y:9,watered:true,ready:false,
      seedId:"(O)472"}],emptyPlots:[]};
    await memory.observeFarmOccupancy(grown);
    const reloaded=new GoalMemory(file);await reloaded.load();
    assert.equal(reloaded.get()?.farmPlan?.occupiedPlots,2);
    const shop:GameState={...state,location:"SeedShop",crops:[],emptyPlots:[],tillable:[],
      economy:{...state.economy!,shop:{keeper:{x:8,y:8},open:true,
        offers:[{id:"(O)472",price:20,stock:20}]}}};
    assert.deepEqual(new EconomyPlanner().propose(shop,DEFAULT_STRATEGY,
      reloaded.get()?.farmPlan)?.action,{type:"buy_seed",itemId:"(O)472",count:2});
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("day outcomes survive restart and cause bounded replanning from observed failures",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"bigfish-farm-learning-"));
  const file=join(dir,"memory.json");
  try{
    const memory=new GoalMemory(file);await memory.startDay(state,DEFAULT_STRATEGY);
    const planned=buildFarmPlan(state,DEFAULT_STRATEGY)!;
    await memory.setFarmPlan(state,planned);
    const failedAction={type:"till_tile" as const,x:10,y:10};
    for(let i=0;i<3;i++)
      await memory.recordFarmResult(state,failedAction,{id:String(i),ok:false,message:"no path"});
    const nextDay:GameState={...state,day:6,economy:{...state.economy!,gold:245}};
    await memory.startDay(nextDay,DEFAULT_STRATEGY);
    const reload=new GoalMemory(file);await reload.load();
    const last=reload.get()?.farmOutcomes?.at(-1);
    assert.ok(last);
    assert.equal(last.failed,3);
    assert.equal(last.openingGold,200);
    assert.equal(last.closingGold,245);
    const revised=buildFarmPlan(nextDay,DEFAULT_STRATEGY,last);
    assert.ok(revised);
    assert.equal(revised.targetPlots,4);
    assert.match(revised.revision,/Reduce planting/);
    assert.notEqual(revised.saveId,"other-save");
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("season deadline rejects crops that cannot mature and blocks needless seed trip",()=>{
  const lastDay={...state,day:27,seeds:[],crops:[],emptyPlots:[],
    economy:{...state.economy!,bag:[]}};
  const plan=buildFarmPlan(lastDay,DEFAULT_STRATEGY)!;
  assert.equal(plan.crops.length,0);
  assert.equal(plannedSeed(lastDay,plan),undefined);
  assert.equal(new EconomyPlanner().propose(lastDay,DEFAULT_STRATEGY,plan),undefined);
  const wrongSeason={...state,season:"fall" as string};
  const fallPlan=buildFarmPlan(wrongSeason,DEFAULT_STRATEGY)!;
  assert.equal(fallPlan.preferredSeedId,null);
});
