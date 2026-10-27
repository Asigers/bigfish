import type {Action,ActionResult,Decision,GameState,SprinklerKind,Tile} from "./types.ts";
import type {FarmPlan} from "./farm-plan.ts";
import {actionKey} from "./types.ts";

export const SPRINKLER_ITEM:Record<SprinklerKind,string>={
  basic:"(O)599",quality:"(O)621",iridium:"(O)645"
};
const pos=(t:Tile)=>t.x+":"+t.y;
const near=(a:Tile,b:Tile)=>Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y))<=1;
const dist=(a:Tile,b:Tile)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const today=(s:GameState)=>(s.year??0)+":"+s.season+":"+s.day;
export type SprinklerProject={
  saveId:string; createdDay:string; updatedDay:string;
  kind:SprinklerKind; site:Tile; expectedCoverage:number;
  ingredients:{id:string;count:number}[];
  status:"materials_needed"|"ready_to_craft"|"ready_to_place"|"installed"|"watering_verified";
  installedDay?:string; checkedDay?:string; verifiedWatered?:number;
};
export function validSprinklerProject(v:unknown):v is SprinklerProject{
  if(!v||typeof v!=="object")return false;
  const s=v as SprinklerProject;
  return typeof s.saveId==="string"&&s.saveId.length>0&&s.saveId.length<120&&
    typeof s.createdDay==="string"&&s.createdDay.length<=40&&
    typeof s.updatedDay==="string"&&s.updatedDay.length<=40&&
    ["basic","quality","iridium"].includes(s.kind) &&
    Number.isInteger(s.site?.x)&&Number.isInteger(s.site?.y)&&s.site.x>=0&&s.site.y>=0&&
    s.site.x<150&&s.site.y<150&&Number.isInteger(s.expectedCoverage)&&
    s.expectedCoverage>=2&&s.expectedCoverage<=24&&
    Array.isArray(s.ingredients)&&s.ingredients.length<=8&&s.ingredients.every(i=>
      typeof i.id==="string"&&/^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(i.id)&&
      Number.isInteger(i.count)&&i.count>0&&i.count<=999)&&
    ["materials_needed","ready_to_craft","ready_to_place","installed","watering_verified"].includes(s.status)&&
    (s.installedDay===undefined||(typeof s.installedDay==="string"&&s.installedDay.length<=40))&&
    (s.checkedDay===undefined||(typeof s.checkedDay==="string"&&s.checkedDay.length<=40))&&
    (s.verifiedWatered===undefined||(Number.isInteger(s.verifiedWatered)&&s.verifiedWatered>=0&&s.verifiedWatered<=24));
}
export function wateredBy(kind:SprinklerKind,origin:Tile,tile:Tile):boolean{
  const dx=Math.abs(origin.x-tile.x),dy=Math.abs(origin.y-tile.y);
  if(dx===0&&dy===0)return false;
  if(kind==="basic")return dx+dy===1;
  return Math.max(dx,dy)<=(kind==="quality"?1:2);
}
export function sprinklerBagCount(s:GameState,kind:SprinklerKind):number{
  return s.sprinklerKits?.find(k=>k.kind===kind)?.count??0;
}
/** Reconcile one conservative investment with the actual farm state, not a model claim. */
export function reconcileSprinkler(s:GameState,plan?:FarmPlan,
  prior?:SprinklerProject):SprinklerProject|undefined{
  if(s.location!=="Farm")return prior?.saveId===s.saveId&&validSprinklerProject(prior)?prior:undefined;
  const iday=today(s);
  const validPrior=prior?.saveId===s.saveId&&validSprinklerProject(prior)?prior:undefined;
  let selected=validPrior;
  if(!selected){
    if(!plan||plan.saveId!==s.saveId||plan.dayKey!==s.season+":"+s.day||
       !s.sprinklerRecipes||!s.installedSprinklers||!s.sprinklerSites)return;
    const existing=new Set(s.installedSprinklers.map(pos));
    const ideas=(plan.sprinklerIdeas??[])
      .filter(i=>i.coveredPlots>=2&&!existing.has(pos(i))&&
        s.sprinklerSites?.some(site=>pos(site)===pos(i)))
      .map(i=>({...i,recipe:s.sprinklerRecipes?.find(r=>r.kind===i.kind)}))
      .filter(i=>i.recipe);
    if(!ideas.length)return;
    // Ready craft or owned kits first; otherwise keep a blocked investment
    // proposal with its real unfulfilled material bill.
    ideas.sort((a,b)=>{
      const score=(i:typeof a)=>
        (sprinklerBagCount(s,i.kind)>0?1000:i.recipe!.canCraft?500:0)+
        i.coveredPlots*10-i.recipe!.ingredients.reduce((n,p)=>n+p.count,0);
      return score(b)-score(a)||a.y-b.y||a.x-b.x;
    });
    const picked=ideas[0];
    selected={saveId:s.saveId,createdDay:iday,updatedDay:iday,
      kind:picked.kind,site:{x:picked.x,y:picked.y},
      expectedCoverage:picked.coveredPlots,ingredients:picked.recipe!.ingredients,
      status:"materials_needed"};
  }
  const exists=s.installedSprinklers?.some(i=>i.kind===selected.kind&&
    pos(i)===pos(selected.site))??false;
  let status:SprinklerProject["status"]="materials_needed";
  if(exists)status="installed";
  else if(sprinklerBagCount(s,selected.kind)>0)status="ready_to_place";
  else if(s.sprinklerRecipes?.find(r=>r.kind===selected.kind)?.canCraft===true)
    status="ready_to_craft";
  const result:SprinklerProject={...selected,updatedDay:iday,status,
    ingredients:s.sprinklerRecipes?.find(r=>r.kind===selected.kind)?.ingredients??selected.ingredients};
  if(exists){
    result.installedDay=selected.installedDay??iday;
    // Do not infer functioning from the existence of a machine. A later,
    // dry, early morning must show crops watered inside the exact radius.
    if(iday!==result.installedDay && s.time<=850 && s.isRaining===false){
      result.checkedDay=iday;
      result.verifiedWatered=s.crops.filter(c=>c.watered&&
        wateredBy(result.kind,result.site,c)).length;
      if(result.verifiedWatered>0)result.status="watering_verified";
    }else if(selected.status==="watering_verified"&&selected.verifiedWatered){
      result.status="watering_verified";
      result.checkedDay=selected.checkedDay;
      result.verifiedWatered=selected.verifiedWatered;
    }
  }else{
    delete result.installedDay;delete result.checkedDay;delete result.verifiedWatered;
  }
  return result;
}
export class SprinklerPlanner{
  private day="";private failures=new Map<string,number>();
  private reset(s:GameState):void{
    const key=s.saveId+":"+today(s);
    if(key!==this.day){this.day=key;this.failures.clear();}
  }
  observe(s:GameState,a?:Action,result?:ActionResult):void{
    this.reset(s);
    if(!a||!result||result.ok)return;
    const key=s.location+":"+actionKey(a);
    this.failures.set(key,(this.failures.get(key)??0)+1);
  }
  private allowed(s:GameState,a:Action):boolean{
    return (this.failures.get(s.location+":"+actionKey(a))??0)<2;
  }
  propose(s:GameState,project?:SprinklerProject):Decision|undefined{
    this.reset(s);
    if(s.location!=="Farm"||s.paused||s.time>=1900||s.energy<=25||
      !project||project.saveId!==s.saveId||!s.sprinklerSites||!s.sprinklerRecipes||
      !s.installedSprinklers||!s.economy)return;
    if(project.status==="installed"||project.status==="watering_verified")return;
    if(project.status==="ready_to_craft"){
      const recipe=s.sprinklerRecipes.find(r=>r.kind===project.kind);
      if(recipe?.learned&&recipe.canCraft&&s.inventoryFree>0){
        const action:Action={type:"craft_sprinkler",kind:project.kind};
        if(this.allowed(s,action))
          return {action,reason:"Craft verified sprinkler recipe from real backpack materials",
            speech:"材料备齐了，做个洒水器，省下每天浇水的时间。"};
      }
      return;
    }
    if(project.status!=="ready_to_place"||sprinklerBagCount(s,project.kind)<=0)return;
    if(!s.sprinklerSites.some(t=>pos(t)===pos(project.site)))return;
    if(near(s,project.site)){
      const action:Action={type:"place_sprinkler",kind:project.kind,...project.site};
      if(this.allowed(s,action))
        return {action,reason:"Install owned sprinkler at a measured coverage position",
          speech:"选好了不挡路的位置，安装洒水器。"};
      return;
    }
    const nearTiles:Tile[]=[];
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
      if(dx===0&&dy===0)continue;
      const t={x:project.site.x+dx,y:project.site.y+dy};
      if(t.x>=0&&t.y>=0&&t.x<150&&t.y<150)nearTiles.push(t);
    }
    nearTiles.sort((a,b)=>dist(a,s)-dist(b,s));
    for(const t of nearTiles){
      const action:Action={type:"move_to",...t};
      if(this.allowed(s,action))
        return {action,reason:"Approach the surveyed sprinkler site",speech:"先走近预留位置。"};
    }
  }
}
