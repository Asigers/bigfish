import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {updateWorkProject,nextWorkTask,validWorkProject,stock} from "../src/farm-work.ts";
import {buildFarmPlan} from "../src/farm-plan.ts";
import {GoalMemory} from "../src/strategy.ts";
import {EconomyPlanner,DEFAULT_STRATEGY} from "../src/economy.ts";
import {FarmResourcePlanner} from "../src/resources.ts";
import type {GameState} from "../src/types.ts";

const base:GameState={
  saveId:"farm-project",day:2,season:"spring",time:1000,
  location:"Farm",x:7,y:8,paused:false,energy:190,inventoryFree:8,
  crops:[{x:6,y:6,watered:true,ready:false,seedId:"(O)472"}],
  emptyPlots:[{x:7,y:6,watered:true}],
  tillable:[{x:7,y:7},{x:8,y:7},{x:10,y:10},{x:11,y:10},{x:12,y:10},{x:13,y:10},
    {x:14,y:11},{x:10,y:11},{x:9,y:12},{x:9,y:13},{x:10,y:13},{x:12,y:12}],
  resources:[{x:8,y:8,kind:"twig",health:1}],
  seeds:[{id:"(O)472",count:2}],
  cropCatalog:[{seedId:"(O)472",harvestId:"(O)24",seasons:["spring"],
    growthDays:4,regrowDays:-1,sellPrice:35,minHarvest:1,raised:false,needsWatering:true}],
  exits:[{x:14,y:11,target:"FarmHouse"}],worldLinks:[],bed:null,
  economy:{gold:180,bag:[{id:"(O)472",count:2,category:-74,sellable:false}],
    chests:[{x:8,y:7,items:[]}],shippingBin:{x:11,y:10},shop:null,
    tools:{hoe:true,wateringCan:true,axe:true,pickaxe:true,scythe:true,
      equipped:"hoe",waterLeft:40}}
};
test("construction dependency is explicit and never falsely marked complete",()=>{
  const project=updateWorkProject(base)!;
  assert.ok(validWorkProject(project));
  assert.equal(project.cashReserve,100);
  assert.deepEqual(project.materialTargets,{"(O)388":50,"(O)390":30,"(O)771":15});
  assert.equal(project.tasks.find(t=>t.id==="wood")?.status,"ready");
  assert.equal(nextWorkTask(project)?.id,"wood");
  const crafting=project.tasks.find(t=>t.id==="craft_chest")!;
  assert.equal(crafting.status,"blocked");
  assert.deepEqual(crafting.dependsOn,["wood"]);
  const withWood={...base,economy:{...base.economy!,chests:[{
    x:8,y:7,items:[{id:"(O)388",count:50,category:-16,sellable:false}]
  }]}};
  const done=updateWorkProject(withWood,project)!;
  assert.equal(stock(withWood,"(O)388"),50);
  assert.equal(done.tasks.find(t=>t.id==="wood")?.status,"done");
  assert.equal(done.tasks.find(t=>t.id==="craft_chest")?.status,"blocked");
  assert.equal(nextWorkTask(done)?.id,"stone");
});
test("do not lose farm material progress after travelling to a shop",()=>{
  const first=updateWorkProject(base)!;
  const shop:GameState={...base,location:"SeedShop",crops:[],emptyPlots:[],tillable:[],
    resources:[],economy:{...base.economy!,bag:[],chests:[]}};
  assert.deepEqual(updateWorkProject(shop,first),first);
  assert.equal(updateWorkProject({...shop,saveId:"another-save"},first),undefined);
  assert.equal(validWorkProject({...first,tasks:[...first.tasks,first.tasks[0]]}),false);
  assert.equal(validWorkProject({...first,materialTargets:{"(O)388":-1,"(O)390":30,"(O)771":15}}),false);
  assert.equal(validWorkProject({...first,tasks:first.tasks.map(t=>t.id==="craft_chest"?
    {...t,status:"done" as const}:t)}),false);
});
test("cash reserve is enforced at the shop, not just in the farm plan narrative",()=>{
  const project=updateWorkProject(base)!;
  const field=buildFarmPlan(base,DEFAULT_STRATEGY)!;
  const offer={id:"(O)472",price:20,stock:10};
  const shopFor=(gold:number):GameState=>({
    ...base,location:"SeedShop",crops:[],emptyPlots:[],tillable:[],
    economy:{...base.economy!,gold,shop:{keeper:{x:7,y:7},open:true,offers:[offer]}}
  });
  const low=new EconomyPlanner().propose(shopFor(120),DEFAULT_STRATEGY,field,project);
  assert.notEqual(low?.action.type,"buy_seed");
  const purchase=new EconomyPlanner().propose(shopFor(180),DEFAULT_STRATEGY,field,project);
  assert.deepEqual(purchase?.action,{type:"buy_seed",itemId:"(O)472",count:2});
  assert.ok(180-2*offer.price>=project.cashReserve);
  const withoutReserve=new EconomyPlanner().propose(shopFor(180),DEFAULT_STRATEGY,field);
  assert.deepEqual(withoutReserve?.action,{type:"buy_seed",itemId:"(O)472",count:3});
});
test("farm layout protects observed access around existing chests and shipping bin",()=>{
  const field=buildFarmPlan(base,DEFAULT_STRATEGY)!;
  assert.ok(field.protectedTiles.some(t=>t.x===7&&t.y===7));
  assert.ok(field.protectedTiles.some(t=>t.x===10&&t.y===10));
  assert.ok(field.protectedTiles.every(t=>base.tillable.some(s=>s.x===t.x&&s.y===t.y)));
  assert.ok(field.fieldTiles.every(t=>!field.protectedTiles.some(p=>p.x===t.x&&p.y===t.y)||
    base.crops.some(p=>p.x===t.x&&p.y===t.y)||
    base.emptyPlots.some(p=>p.x===t.x&&p.y===t.y)));
});
test("multi-day work project survives restart but never crosses save IDs",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"bigfish-work-m2-"));
  const file=join(dir,"memory.json");
  try{
    const memory=new GoalMemory(file);
    await memory.startDay(base,DEFAULT_STRATEGY);
    await memory.setWorkProject(base,updateWorkProject(base)!);
    await memory.setFarmPlan(base,buildFarmPlan(base,DEFAULT_STRATEGY)!);
    const nextDay={...base,day:3};
    await memory.startDay(nextDay,DEFAULT_STRATEGY);
    const restored=new GoalMemory(file);
    await restored.load();
    assert.equal(restored.get()?.workProject?.startedOn,"spring:2");
    assert.equal(restored.get()?.workProject?.cashReserve,100);
    assert.equal(restored.get()?.farmPlan,undefined); // per-day field plans do not persist to tomorrow
    const newSave={...base,saveId:"brand-new-save"};
    await restored.startDay(newSave,DEFAULT_STRATEGY);
    assert.equal(restored.get()?.workProject,undefined);
    await assert.rejects(restored.setWorkProject(newSave,updateWorkProject(base)!),
      /Invalid or cross-save/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("resource planner follows multi-day material reservations and stops when fulfilled",()=>{
  const starter=updateWorkProject(base)!;
  const resourcePlanner=new FarmResourcePlanner();
  assert.deepEqual(resourcePlanner.propose(base,true,starter)?.action,
    {type:"clear_resource",kind:"twig",x:8,y:8});
  const supplied={...base,economy:{...base.economy!,
    chests:[{x:8,y:7,items:[
      {id:"(O)388",count:50,category:-16,sellable:false},
      {id:"(O)390",count:30,category:-300,sellable:false},
      {id:"(O)771",count:15,category:-16,sellable:false}
    ]}]
  }};
  const filled=updateWorkProject(supplied,starter)!;
  assert.equal(resourcePlanner.propose(supplied,true,filled),undefined);
});
