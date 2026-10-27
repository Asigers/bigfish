import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {FarmHistory} from "../src/history.ts";
import {cropInvestments,irrigationInvestment} from "../src/investment.ts";
import type {GameState} from "../src/types.ts";

const state:GameState={
  saveId:"history-save",year:1,season:"spring",day:6,time:1110,
  location:"Farm",x:2,y:2,paused:false,energy:120,inventoryFree:8,
  crops:[{x:3,y:2,watered:false,ready:false}],emptyPlots:[],tillable:[],
  seeds:[],exits:[],worldLinks:[],bed:null,
  cropCatalog:[{seedId:"(O)472",harvestId:"(O)24",seasons:["spring"],
    growthDays:4,regrowDays:-1,sellPrice:35,minHarvest:1,raised:false,needsWatering:true}],
  economy:{gold:120,bag:[],chests:[],shippingBin:null,shop:null,
    tools:{hoe:true,wateringCan:true,equipped:"watering_can",waterLeft:29}}
};
test("SQLite persists verified actions idempotently and separates farms",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"bigfish-sqlite-"));
  const path=join(dir,"history.sqlite");
  try{
    const h=new FarmHistory(path);
    const watered={...state,energy:117,
      crops:[{...state.crops[0],watered:true}]};
    assert.equal(h.recordVerifiedAction(state,watered,{type:"water_tile",x:3,y:2},"uuid-1",true),true);
    assert.equal(h.recordVerifiedAction(state,watered,{type:"water_tile",x:3,y:2},"uuid-1",true),false);
    assert.equal(h.recordVerifiedAction(state,{...watered,saveId:"wrong"},
      {type:"water_tile",x:3,y:2},"uuid-2",true),false);
    h.recordCompletedDay(state.saveId,5,{
      dayKey:"spring:6",targetPlots:4,openingGold:100,closingGold:180,
      planted:2,watered:3,harvested:1,failed:0
    });
    h.recordCompletedDay(state.saveId,5,{
      dayKey:"spring:6",targetPlots:4,openingGold:100,closingGold:180,
      planted:2,watered:3,harvested:1,failed:0
    });
    let stat=h.metrics(state.saveId,5);
    assert.equal(stat.recordedDays,1);
    assert.equal(stat.netGoldChange,80);
    assert.equal(stat.verifiedActions,1);
    assert.equal(stat.verifiedWaterActions,1);
    assert.equal(stat.meanWaterEnergy,3);
    h.close();
    const reopened=new FarmHistory(path);
    stat=reopened.metrics(state.saveId,5);
    assert.equal(stat.verifiedActions,1);
    assert.equal(reopened.metrics("other",5).recordedDays,0);
    reopened.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("seven separate days are counted once even after replay and controller restarts",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"bigfish-history-days-"));
  const path=join(dir,"history.sqlite");
  try{
    const h=new FarmHistory(path);
    for(let i=1;i<=7;i++){
      h.recordCompletedDay("campaign-save",i,{
        dayKey:"spring:"+(i+1),targetPlots:5,openingGold:100+i*10,
        closingGold:105+i*10,planted:1,watered:3,harvested:i%2,
        failed:0});
      h.recordCompletedDay("campaign-save",i,{
        dayKey:"spring:"+(i+1),targetPlots:5,openingGold:100+i*10,
        closingGold:105+i*10,planted:1,watered:3,harvested:i%2,
        failed:0});
    }
    assert.equal(h.consecutiveDays("campaign-save",7),true);
    assert.equal(h.consecutiveDays("campaign-save",8),false);
    const m=h.metrics("campaign-save",7,7);
    assert.equal(m.recordedDays,7);
    assert.equal(m.netGoldChange,35);
    assert.equal(m.harvested,4);
    assert.equal(m.failed,0);
    assert.equal(h.metrics("campaign-save",7,3).recordedDays,3);
    h.recordCompletedDay("gap",1,{dayKey:"spring:2",targetPlots:1,
      openingGold:0,closingGold:5,planted:0,watered:0,harvested:0,failed:0});
    h.recordCompletedDay("gap",3,{dayKey:"spring:4",targetPlots:1,
      openingGold:5,closingGold:5,planted:0,watered:0,harvested:0,failed:0});
    assert.equal(h.consecutiveDays("gap",2),false);
    h.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("economic forecast distinguishes observed seed costs from unknown cost",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"bigfish-roi-"));
  try{
    const h=new FarmHistory(join(dir,"history.sqlite"));
    const metrics=h.metrics(state.saveId,5);
    const unseen=cropInvestments(state,metrics);
    assert.equal(unseen[0].seedCost,null);
    assert.equal(unseen[0].margin,null);
    assert.ok(unseen[0].uncertainty.length>0);
    const priced={...state,economy:{...state.economy!,shop:{
      keeper:{x:3,y:3},open:true,offers:[{id:"(O)472",price:20,stock:10}]
    }}};
    const known=cropInvestments(priced,metrics);
    assert.equal(known[0].seedCost,20);
    assert.equal(known[0].margin,15);
    assert.ok(known[0].waterEnergy>0);
    const sprinkler=irrigationInvestment(state,metrics,{
      saveId:state.saveId,dayKey:"spring:6",targetPlots:1,occupiedPlots:1,
      fieldTiles:[{x:3,y:2}],protectedTiles:[],preferredSeedId:"(O)472",
      crops:[],reason:"test",revision:"test",costKnown:false,
      sprinklerIdeas:[{kind:"basic",x:3,y:3,coveredPlots:2,waterTiles:[
        {x:3,y:2},{x:4,y:3}]}]
    });
    assert.equal(sprinkler?.buildCostGold,null);
    assert.equal(sprinkler?.paybackDays,null);
    assert.equal(sprinkler?.estimatedEnergySavedPerDryDay,4);
    h.close();
  }finally{await rm(dir,{recursive:true,force:true});}
});
