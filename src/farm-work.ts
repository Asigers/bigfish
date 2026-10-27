import type { GameState } from "./types.ts";

export type MaterialId="(O)388" | "(O)390" | "(O)771";
export type TaskStatus="ready"|"blocked"|"done";
export type WorkTask={
  id:"wood"|"stone"|"fiber"|"seed_budget"|"craft_chest"|"place_chest";
  status:TaskStatus; dependsOn:string[]; progress:number; required:number;
  reason:string;
};
export type FarmWorkProject={
  saveId:string; objective:"prepare_storage_and_expand";
  startedOn:string; evaluatedOn:string; cashReserve:number;
  materialTargets:Record<MaterialId,number>;
  tasks:WorkTask[];
};
const materialIds:MaterialId[]=["(O)388","(O)390","(O)771"];
const defaultMaterialTargets:Record<MaterialId,number>={
  "(O)388":50,"(O)390":30,"(O)771":15
};
const day=(s:GameState)=>s.season+":"+s.day;
export function stock(s:GameState,id:MaterialId):number{
  const e=s.economy;
  if(!e)return 0;
  return e.bag.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0)+
    e.chests.reduce((n,chest)=>n+
      chest.items.filter(i=>i.id===id).reduce((k,i)=>k+i.count,0),0);
}
export function validWorkProject(input:unknown):input is FarmWorkProject{
  if(!input||typeof input!=="object")return false;
  const p=input as FarmWorkProject;
  if(typeof p.saveId!=="string"||p.saveId.length>160||!p.saveId ||
    p.objective!=="prepare_storage_and_expand"||
    typeof p.startedOn!=="string"||p.startedOn.length>32||
    typeof p.evaluatedOn!=="string"||p.evaluatedOn.length>32||
    !Number.isInteger(p.cashReserve)||p.cashReserve<0||p.cashReserve>100000 ||
    !p.materialTargets || !Array.isArray(p.tasks) || p.tasks.length!==6)return false;
  if(!materialIds.every(id=>Number.isInteger(p.materialTargets[id])&&
    p.materialTargets[id]>=0&&p.materialTargets[id]<=1000))return false;
  const names=["wood","stone","fiber","seed_budget","craft_chest","place_chest"];
  if(new Set(p.tasks.map(t=>t.id)).size!==6 || !names.every(n=>p.tasks.some(t=>t.id===n)))return false;
  const chest=p.tasks.find(t=>t.id==="craft_chest");
  const place=p.tasks.find(t=>t.id==="place_chest");
  if(chest?.dependsOn.length!==1||chest.dependsOn[0]!=="wood"||
    place?.dependsOn.length!==1||place.dependsOn[0]!=="craft_chest")return false;
  return p.tasks.every(t=>names.includes(t.id)&&["ready","blocked","done"].includes(t.status)&&
    Array.isArray(t.dependsOn)&&t.dependsOn.length<=4 &&
    t.dependsOn.every(d=>names.includes(d)&&d!==t.id)&&
    Number.isInteger(t.progress)&&t.progress>=0&&t.progress<=1000000000 &&
    Number.isInteger(t.required)&&t.required>=0&&t.required<=1000000 &&
    typeof t.reason==="string"&&t.reason.length<=200);
}
/** No imaginary construction: crafting stays blocked until a real craft skill exists. */
export function updateWorkProject(s:GameState,previous?:FarmWorkProject,
  controls?:{cashReserve:number;collectWood:boolean}):FarmWorkProject|undefined{
  // Only the farm snapshot includes the owned chests. Shop maps under-report inventory.
  if(s.location!=="Farm"||!s.economy)return previous?.saveId===s.saveId?previous:undefined;
  const old=previous?.saveId===s.saveId&&validWorkProject(previous)?previous:undefined;
  const materialTargets=controls ? {...defaultMaterialTargets,
    "(O)388":controls.collectWood?50:0,
    "(O)390":0,"(O)771":0} : old?.materialTargets??{...defaultMaterialTargets};
  const cashReserve=controls?Math.max(100,Math.min(5000,controls.cashReserve)):old?.cashReserve??100;
  const count=(id:MaterialId)=>stock(s,id);
  const chestAlreadyPlaced=s.economy.chests.length>0;
  const kitReady=(s.chestKits??0)>0;
  const woodPrepared=count("(O)388")>=materialTargets["(O)388"]||kitReady||chestAlreadyPlaced;
  const canCraft=!chestAlreadyPlaced&&!kitReady && s.canCraftChest===true &&
    s.economy.bag.some(i=>i.id==="(O)388"&&i.count>=50) && s.inventoryFree>0;
  const canPlace=!chestAlreadyPlaced && kitReady && (s.placementSites?.length??0)>0;
  const tasks:WorkTask[]=[
    {id:"wood",dependsOn:[],status:woodPrepared?"done":"ready",
      progress:count("(O)388"),required:materialTargets["(O)388"],reason:"Reserve wood for a future chest"},
    {id:"stone",dependsOn:[],status:count("(O)390")>=materialTargets["(O)390"]?"done":"ready",
      progress:count("(O)390"),required:materialTargets["(O)390"],reason:"Reserve stone for later farm equipment"},
    {id:"fiber",dependsOn:[],status:count("(O)771")>=materialTargets["(O)771"]?"done":"ready",
      progress:count("(O)771"),required:materialTargets["(O)771"],reason:"Reserve fiber for future crafting"},
    {id:"seed_budget",dependsOn:[],status:s.economy.gold>=cashReserve?"done":"ready",
      progress:s.economy.gold,required:cashReserve,reason:"Keep an emergency cash reserve for seeds"},
    {id:"craft_chest",dependsOn:["wood"],
      status:chestAlreadyPlaced||kitReady?"done":canCraft?"ready":"blocked",
      progress:chestAlreadyPlaced||kitReady?1:0,required:1,
      reason:canCraft?"Learned chest recipe and enough backpack materials":
        "Need wood in backpack, free slot and a learned chest recipe"},
    {id:"place_chest",dependsOn:["craft_chest"],
      status:chestAlreadyPlaced?"done":canPlace?"ready":"blocked",
      progress:chestAlreadyPlaced?1:0,required:1,
      reason:canPlace?"Native game validated nearby placement cells":
        "Requires a crafted chest kit and a surveyed placeable farm site"}
  ];
  return {saveId:s.saveId,objective:"prepare_storage_and_expand",
    startedOn:old?.startedOn??day(s),evaluatedOn:day(s),
    cashReserve,materialTargets:{...materialTargets},tasks};
}
export function readyMaterialTargets(project:FarmWorkProject|undefined):
  Record<MaterialId,number>|undefined {
  if(!project || !validWorkProject(project))return;
  return {...project.materialTargets};
}
export function nextWorkTask(project:FarmWorkProject):WorkTask|undefined{
  return project.tasks.find(t=>t.status==="ready" &&
    t.dependsOn.every(id=>project.tasks.some(dep=>dep.id===id&&dep.status==="done")));
}
