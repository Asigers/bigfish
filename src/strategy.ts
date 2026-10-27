import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Action, ActionResult, GameState } from "./types.ts";
import type { FarmPlan, FarmDayOutcome } from "./farm-plan.ts";
import { DEFAULT_STRATEGY, type Strategy } from "./economy.ts";
export type Journal = { saveId:string; dayKey:string; strategy:Strategy; entries:string[]; completed:string[];
  farmPlan?:FarmPlan; farmOutcomes?:FarmDayOutcome[]; dailyProgress?:FarmDayOutcome };
const path=join(process.cwd(),"data","bigfish-memory.json");
function validStrategy(x:unknown):x is Strategy{
  if(!x||typeof x!=="object")return false;
  const s=x as Strategy;
  return ["profit","expand","save"].includes(s.goal)
    && Number.isInteger(s.targetGold)&&s.targetGold>=0&&s.targetGold<=1_000_000
    && Number.isInteger(s.seedReserve)&&s.seedReserve>=1&&s.seedReserve<=20
    && typeof s.notes==="string"&&s.notes.length<=300;
}
export function parseStrategy(raw:string):Strategy{
  const trimmed=raw.trim().replace(/^`{3}(?:json)?\s*/i,"").replace(/\s*`{3}$/,"");
  const o:unknown=JSON.parse(trimmed);
  if(!validStrategy(o))throw Error("Invalid strategic goal");
  return o;
}
export class GoalMemory{
  private journal:Journal|undefined;
  readonly storagePath:string;
  constructor(storagePath=path){this.storagePath=storagePath;}
  async load():Promise<void>{
    try{
      const value:unknown=JSON.parse(await readFile(this.storagePath,"utf8"));
      if(value&&typeof value==="object"){
        const x=value as Journal;
        if(typeof x.saveId==="string"&&typeof x.dayKey==="string"&&validStrategy(x.strategy)&&Array.isArray(x.entries)&&Array.isArray(x.completed))
          this.journal={...x,entries:x.entries.filter(e=>typeof e==="string").slice(-40),
            completed:x.completed.filter(e=>typeof e==="string").slice(-30),
            farmPlan:this.validPlan(x.farmPlan,x.saveId,x.dayKey)?x.farmPlan:undefined,
            farmOutcomes:Array.isArray(x.farmOutcomes)?
              x.farmOutcomes.filter(o=>this.validOutcome(o)).slice(-14):[],
            dailyProgress:this.validOutcome(x.dailyProgress) && x.dailyProgress.dayKey===x.dayKey?
              x.dailyProgress:undefined};
      }
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=="ENOENT")console.warn("[memory] ignored unreadable journal",error);
    }
  }
  private validPlan(p:unknown,save:string,day:string):p is FarmPlan{
    if(!p||typeof p!=="object")return false;
    const plan=p as FarmPlan;
    return plan.saveId===save && plan.dayKey===day &&
      Number.isInteger(plan.targetPlots)&&plan.targetPlots>=0&&plan.targetPlots<=20 &&
      Array.isArray(plan.fieldTiles)&&plan.fieldTiles.length<=20 &&
      plan.fieldTiles.every(t=>Number.isInteger(t.x)&&Number.isInteger(t.y)&&
        t.x>=0&&t.y>=0&&t.x<150&&t.y<150) &&
      (plan.preferredSeedId===null||
        (typeof plan.preferredSeedId==="string"&&/^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(plan.preferredSeedId))) &&
      Array.isArray(plan.crops)&&plan.crops.length<=20 &&
      typeof plan.reason==="string"&&plan.reason.length<=300 &&
      typeof plan.revision==="string"&&plan.revision.length<=300;
  }
  private validOutcome(v:unknown):v is FarmDayOutcome{
    if(!v||typeof v!=="object")return false;
    const o=v as FarmDayOutcome;
    return typeof o.dayKey==="string"&&o.dayKey.length<=32 &&
      ["targetPlots","openingGold","closingGold","planted","watered","harvested","failed"]
        .every(k=>Number.isSafeInteger(o[k as keyof FarmDayOutcome])&&
          Number(o[k as keyof FarmDayOutcome])>=0&&Number(o[k as keyof FarmDayOutcome])<=100000000);
  }
  get():Journal|undefined{return this.journal;}
  needsPlanning(s:GameState):boolean{return !this.journal||this.journal.saveId!==s.saveId||this.journal.dayKey!==s.season+":"+s.day;}
  async startDay(s:GameState,strategy?:Strategy):Promise<void>{
    const old=this.journal?.saveId===s.saveId?this.journal:undefined;
    const newKey=s.season+":"+s.day;
    const completedDays=[...(old?.farmOutcomes??[])];
    if(old?.dailyProgress && old.dayKey!==newKey)
      completedDays.push({...old.dailyProgress,
        // Shipping income is settled by the game the next morning.
        closingGold:s.economy?.gold??old.dailyProgress.closingGold});
    this.journal={
      saveId:s.saveId,dayKey:newKey,
      strategy:strategy??old?.strategy??DEFAULT_STRATEGY,
      entries:old?.entries??[],completed:old?.completed??[],
      farmOutcomes:completedDays.slice(-14),
      farmPlan:old?.dayKey===newKey?old.farmPlan:undefined,
      dailyProgress:old?.dayKey===newKey?old.dailyProgress:undefined
    };
    await this.persist();
  }
  async setFarmPlan(s:GameState,plan:FarmPlan):Promise<void>{
    if(!this.journal||this.journal.saveId!==s.saveId||
      this.journal.dayKey!==s.season+":"+s.day||
      !this.validPlan(plan,s.saveId,this.journal.dayKey))
      throw Error("Farm plan belongs to another save or day");
    this.journal.farmPlan=plan;
    this.journal.dailyProgress??={dayKey:this.journal.dayKey,
      targetPlots:plan.targetPlots,openingGold:s.economy?.gold??0,
      closingGold:s.economy?.gold??0,planted:0,watered:0,harvested:0,failed:0};
    await this.persist();
  }
  async recordFarmResult(s:GameState,action:Action,result:ActionResult):Promise<void>{
    const j=this.journal,progress=j?.dailyProgress;
    if(!j||!progress||j.saveId!==s.saveId||j.dayKey!==s.season+":"+s.day)return;
    if(!["plant_seed","water_tile","harvest_crop","till_tile"].includes(action.type))return;
    if(result.ok){
      if(action.type==="plant_seed")progress.planted++;
      if(action.type==="water_tile")progress.watered++;
      if(action.type==="harvest_crop")progress.harvested++;
    }else progress.failed++;
    progress.closingGold=s.economy?.gold??progress.closingGold;
    await this.persist();
  }
  async note(text:string,completed=false):Promise<void>{
    if(!this.journal)return;
    const entry=new Date().toISOString()+" "+text.slice(0,200);
    this.journal.entries.push(entry);
    this.journal.entries=this.journal.entries.slice(-40);
    if(completed){this.journal.completed.push(entry);this.journal.completed=this.journal.completed.slice(-30);}
    await this.persist();
  }
  private async persist():Promise<void>{
    if(!this.journal)return;
    await mkdir(join(this.storagePath,".."),{recursive:true});
    const temp=this.storagePath+".tmp";
    await writeFile(temp,JSON.stringify(this.journal,null,2),"utf8");
    await rename(temp,this.storagePath);
  }
}
