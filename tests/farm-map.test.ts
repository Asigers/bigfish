import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {dayCells,mergeFarmMap,observationDay,routeCorridors,sprinklerIdeas,
  validFarmMap,type FarmMap} from "../src/farm-map.ts";
import {buildFarmPlan} from "../src/farm-plan.ts";
import {GoalMemory} from "../src/strategy.ts";
import {DEFAULT_STRATEGY} from "../src/economy.ts";
import {validState,type GameState,type SurveyTile} from "../src/types.ts";
import {GameBridge} from "../src/bridge.ts";
import {startSimulator} from "../src/simulator.ts";
import {randomBytes} from "node:crypto";

const sample=(width=9,height=9,blocked:{x:number;y:number}[]=[]):SurveyTile[]=>{
  const off=new Set(blocked.map(t=>t.x+":"+t.y));
  const cells:SurveyTile[]=[];
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const occupied=off.has(x+":"+y);
    cells.push({x,y,occupied,walkable:!occupied,soil:true});
  }
  return cells;
};
const base:GameState={
  saveId:"spatial",year:1,day:4,season:"spring",time:1130,
  location:"Farm",x:1,y:4,paused:false,energy:200,inventoryFree:9,
  crops:[{x:3,y:3,watered:true,ready:false}],
  emptyPlots:[{x:3,y:4,watered:false}],tillable:[
    {x:2,y:4},{x:4,y:4},{x:5,y:4},{x:6,y:4},{x:3,y:5},{x:4,y:5},
    {x:4,y:3},{x:5,y:3},{x:5,y:5},{x:6,y:3}
  ],seeds:[{id:"(O)472",count:8}],
  cropCatalog:[{seedId:"(O)472",harvestId:"(O)24",seasons:["spring"],
    growthDays:4,regrowDays:-1,sellPrice:35,minHarvest:1,
    raised:false,needsWatering:true}],
  surveyTiles:sample(9,9,[{x:4,y:4}]),
  exits:[{x:0,y:4,target:"FarmHouse"},{x:8,y:4,target:"BusStop"}],
  worldLinks:[],bed:null,economy:{gold:200,bag:[
    {id:"(O)472",count:8,category:-74,sellable:false}
  ],chests:[],shippingBin:null,shop:null,
    tools:{hoe:true,wateringCan:true,equipped:"hoe",waterLeft:40}}
};
test("bounded farm survey is valid and merges real patches rather than fabricating unknown",()=>{
  assert.equal(validState(base),true);
  assert.equal(validState({...base,surveyTiles:[{x:2,y:2,soil:true,occupied:false,walkable:"yes"}]}),false);
  const initial=mergeFarmMap(base)!;
  assert.equal(initial.tiles.length,81);
  assert.ok(validFarmMap(initial));
  assert.equal(dayCells(base,initial).has("99:99"),false);
  const one={...base,surveyTiles:[{x:4,y:4,walkable:true,occupied:false,soil:true}]};
  const updated=mergeFarmMap(one,initial)!;
  assert.equal(updated.tiles.length,81);
  assert.equal(updated.tiles.find(t=>t.x===4&&t.y===4)?.walkable,true);
  assert.equal(mergeFarmMap({...base,location:"SeedShop",surveyTiles:[]},updated),updated);
  assert.equal(mergeFarmMap({...base,saveId:"unrelated",surveyTiles:[]},updated),undefined);
  assert.equal(validFarmMap({...initial,tiles:[...initial.tiles,initial.tiles[0]]}),false);
});
test("road planner uses only verified passable cells and routes around obstructions",()=>{
  const map=mergeFarmMap(base)!;
  const roads=routeCorridors(base,map);
  assert.ok(roads.length>0);
  assert.equal(roads.some(t=>t.x===4&&t.y===4),false);
  assert.ok(roads.some(t=>t.x===8&&t.y===4));
  // A fresh day with no observation is NOT a known-safe path.
  const tomorrow={...base,day:5,surveyTiles:[]};
  assert.equal(routeCorridors(tomorrow,map).length,0);
  // An unobserved break in the map cannot be traversed optimistically.
  const seam=sample(9,9,Array.from({length:9},(_,y)=>({x:4,y})));
  const split=mergeFarmMap({...base,surveyTiles:seam})!;
  assert.equal(routeCorridors(base,split).some(t=>t.x===8&&t.y===4),false);
});
test("plans protect verified access corridors while preserving already planted fields",()=>{
  const map=mergeFarmMap(base)!;
  const plan=buildFarmPlan(base,DEFAULT_STRATEGY,undefined,undefined,map)!;
  const roads=new Set(routeCorridors(base,map).map(t=>t.x+":"+t.y));
  const existing=new Set([...base.crops,...base.emptyPlots].map(t=>t.x+":"+t.y));
  assert.ok(plan.protectedTiles.some(t=>roads.has(t.x+":"+t.y)));
  for(const tile of plan.fieldTiles){
    const key=tile.x+":"+tile.y;
    assert.ok(existing.has(key)||!roads.has(key),"new plot cannot block surveyed route");
  }
  assert.ok(plan.sprinklerIdeas);
  assert.ok(plan.sprinklerIdeas!.every(s=>!roads.has(s.x+":"+s.y)||
    !plan.protectedTiles.some(p=>p.x===s.x&&p.y===s.y)));
});
test("sprinkler proposals obey actual geometric coverage and do not place over crop cells",()=>{
  const farm:GameState={...base,exits:[],x:0,y:0,surveyTiles:sample(9,9)};
  const map=mergeFarmMap(farm)!;
  const plots=[] as {x:number;y:number}[];
  for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
    if(!dx&&!dy)continue;
    plots.push({x:4+dx,y:4+dy});
  }
  const ideas=sprinklerIdeas(farm,map,plots,[],10);
  const centered=ideas.find(i=>i.kind==="quality"&&i.x===4&&i.y===4);
  assert.ok(centered);
  assert.equal(centered.coveredPlots,8);
  assert.equal(centered.waterTiles.length,8);
  assert.ok(ideas.every(i=>!plots.some(p=>p.x===i.x&&p.y===i.y)));
  assert.equal(sprinklerIdeas(farm,map,plots,[{x:4,y:4}],10)
    .some(i=>i.x===4&&i.y===4),false);
  // Suggestions are never authoritative crafting/placement commands.
  assert.ok(ideas.every(i=>["basic","quality","iridium"].includes(i.kind)));
});
test("partial farm map persists over in-game days and never crosses save or year",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"bigfish-map-"));
  try{
    const file=join(dir,"memory.json");
    const memory=new GoalMemory(file);
    await memory.startDay(base,DEFAULT_STRATEGY);
    await memory.setFarmMap(base,mergeFarmMap(base)!);
    const reload=new GoalMemory(file);await reload.load();
    assert.equal(reload.get()?.farmMap?.tiles.length,81);
    await reload.startDay({...base,day:5},DEFAULT_STRATEGY);
    assert.equal(reload.get()?.farmMap?.tiles.length,81);
    assert.equal(routeCorridors({...base,day:5},reload.get()?.farmMap).length,0);
    assert.equal(routeCorridors({...base,year:2},reload.get()?.farmMap).length,0);
    await reload.startDay({...base,saveId:"different"},DEFAULT_STRATEGY);
    assert.equal(reload.get()?.farmMap,undefined);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("multiple patches remain bounded and current tiles overwrite outdated visits",()=>{
  let previous:FarmMap|undefined;
  for(let n=0;n<12;n++){
    const shifted={...base,x:10+n*10,year:1,
      surveyTiles:sample(9,9).map(t=>({...t,x:t.x+n*10}))};
    previous=mergeFarmMap(shifted,previous);
  }
  assert.ok(previous && validFarmMap(previous));
  assert.ok(previous.tiles.length<=1500);
  assert.equal(previous.saveId,base.saveId);
});
test("bridge emits a survey alongside farm gameplay and no survey after warping",{
  timeout:12000
},async()=>{
  const token=randomBytes(24).toString("hex"),bridge=new GameBridge(token,0);
  await bridge.start();
  const stop=startSimulator(bridge.listeningPort(),token);
  try{
    let farm:GameState|undefined;
    const end=Date.now()+4000;
    while(!farm&&Date.now()<end){
      const s=bridge.getState();
      if(s?.location==="Farm"&&s.surveyTiles?.length)farm=s;
      else await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(farm);
    assert.ok(farm.surveyTiles?.length);
    assert.equal(validState(farm),true);
    const map=mergeFarmMap(farm)!;
    assert.ok(map.tiles.length>0);
    assert.equal((await bridge.send({type:"travel_to",target:"FarmHouse"},4000)).ok,true);
    const seq=bridge.getStateSequence();
    const end2=Date.now()+4000;
    let house:GameState|undefined;
    while(!house&&Date.now()<end2){
      const s=bridge.getState();
      if(s?.location==="FarmHouse")house=s;
      else await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(house);
    assert.deepEqual(house.surveyTiles,[]);
    assert.deepEqual(mergeFarmMap(house,map),map);
  }finally{stop();await bridge.stop();}
});
