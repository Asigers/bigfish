import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GameState } from "./types.ts";
import { DEFAULT_STRATEGY, type Strategy } from "./economy.ts";
export type Journal = { saveId:string; dayKey:string; strategy:Strategy; entries:string[]; completed:string[] };
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
          this.journal={...x,entries:x.entries.filter(e=>typeof e==="string").slice(-40),completed:x.completed.filter(e=>typeof e==="string").slice(-30)};
      }
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=="ENOENT")console.warn("[memory] ignored unreadable journal",error);
    }
  }
  get():Journal|undefined{return this.journal;}
  needsPlanning(s:GameState):boolean{return !this.journal||this.journal.saveId!==s.saveId||this.journal.dayKey!==s.season+":"+s.day;}
  async startDay(s:GameState,strategy?:Strategy):Promise<void>{
    const old=this.journal?.saveId===s.saveId?this.journal:undefined;
    this.journal={
      saveId:s.saveId,dayKey:s.season+":"+s.day,
      strategy:strategy??old?.strategy??DEFAULT_STRATEGY,
      entries:old?.entries??[],completed:old?.completed??[]
    };
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
