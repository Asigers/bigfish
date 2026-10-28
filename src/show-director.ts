import {mkdir,readFile,rename,writeFile} from "node:fs/promises";
import {dirname,join} from "node:path";
import {gameOrdinal} from "./campaign.ts";
import type {Action,GameState} from "./types.ts";

export type ChallengeId="water_sprint"|"harvest_run"|"no_spend_expansion"|"forage_find"|"clear_obstacles";
export type ShowCandidate={id:ChallengeId;title:string;target:number;deadline:number;reason:string};
export type ShowStatus="active"|"won"|"lost";
export type ShowChallenge=ShowCandidate&{
  startedOrdinal:number;status:ShowStatus;progress:number;verifiedKeys:string[];
  openingGold:number;endReason?:string
};
export type ShowOutcome={ordinal:number;id:ChallengeId;status:"won"|"lost";progress:number;target:number};
export type ShowJournal={saveId:string;dayOrdinal:number;challenge?:ShowChallenge;outcomes:ShowOutcome[]};
export type ShowEvent={kind:"start"|"progress"|"won"|"lost";challenge:ShowChallenge;fact:string};
const ids:ChallengeId[]=["water_sprint","harvest_run","no_spend_expansion","forage_find","clear_obstacles"];
const validCandidate=(v:unknown):v is ShowCandidate=>{
  if(!v||typeof v!=="object")return false;
  const x=v as ShowCandidate;
  return ids.includes(x.id)&&typeof x.title==="string"&&x.title.length>0&&x.title.length<=60&&
    Number.isInteger(x.target)&&x.target>=1&&x.target<=8&&
    Number.isInteger(x.deadline)&&x.deadline>=900&&x.deadline<=2400&&
    typeof x.reason==="string"&&x.reason.length<=140;
};
export function validShowJournal(input:unknown):input is ShowJournal{
  if(!input||typeof input!=="object")return false;
  const x=input as ShowJournal;
  if(typeof x.saveId!=="string"||!x.saveId||x.saveId.length>=120||
    !Number.isInteger(x.dayOrdinal)||x.dayOrdinal<0||
    !Array.isArray(x.outcomes)||x.outcomes.length>12||
    !x.outcomes.every(o=>Number.isInteger(o.ordinal)&&o.ordinal>=0&&ids.includes(o.id)&&
      (o.status==="won"||o.status==="lost")&&Number.isInteger(o.progress)&&o.progress>=0&&o.progress<=8&&
      Number.isInteger(o.target)&&o.target>=1&&o.target<=8))return false;
  if(x.challenge===undefined)return true;
  const c=x.challenge;
  return validCandidate(c)&&c.startedOrdinal===x.dayOrdinal&&
    ["active","won","lost"].includes(c.status)&&Number.isInteger(c.progress)&&
    c.progress>=0&&c.progress<=c.target&&
    Array.isArray(c.verifiedKeys)&&c.verifiedKeys.length<=40&&
    c.verifiedKeys.every(k=>typeof k==="string"&&k.length<=110)&&
    new Set(c.verifiedKeys).size===c.verifiedKeys.length&&
    Number.isInteger(c.openingGold)&&c.openingGold>=0&&c.openingGold<=100000000&&
    (c.endReason===undefined||(typeof c.endReason==="string"&&c.endReason.length<=140));
}
/** Only propose challenges that the existing game executor can attempt today. */
export function eligibleChallenges(s:GameState):ShowCandidate[]{
  if(s.location!=="Farm"||s.time>1100||s.paused)return [];
  const out:ShowCandidate[]=[];
  const thirsty=s.crops.filter(c=>!c.watered).length;
  const ripe=s.crops.filter(c=>c.ready).length;
  if(thirsty>=2&&s.economy?.tools.wateringCan&&s.energy>=40)
    out.push({id:"water_sprint",title:"午前浇水冲刺",target:Math.min(thirsty,4),deadline:1200,
      reason:"Observed unwatered crops and a real watering can"});
  if(ripe>=2&&s.inventoryFree>0)
    out.push({id:"harvest_run",title:"今日收获竞速",target:Math.min(ripe,4),deadline:1600,
      reason:"At least two ripe crops are directly observed"});
  if((s.tillable?.length??0)>=2&&s.economy&&s.energy>=65)
    out.push({id:"no_spend_expansion",title:"零消费开垦挑战",target:Math.min(3,s.tillable.length),deadline:1900,
      reason:"Observed farm land can be tilled and spending can be blocked"});
  if((s.forage?.length??0)>=1&&s.inventoryFree>0&&s.energy>=45)
    out.push({id:"forage_find",title:"野外拾荒寻宝",target:1,deadline:2000,
      reason:"Real forage item currently observed"});
  if((s.resources?.length??0)>=2&&s.energy>=80&&s.inventoryFree>0)
    out.push({id:"clear_obstacles",title:"杂物清理挑战",target:2,deadline:1900,
      reason:"Two actionable resource obstacles currently observed"});
  return out;
}
export function chooseChallenge(s:GameState,options:ShowCandidate[],preferred?:string):ShowCandidate|undefined{
  if(!options.length)return;
  const picked=options.find(c=>c.id===preferred);
  if(picked)return picked;
  const previous=gameOrdinal(s);
  return options[previous%options.length];
}
function actionKey(a:Action):string{
  if("x" in a&&"y" in a)return a.type+":"+a.x+":"+a.y;
  return a.type;
}
function applicable(id:ChallengeId,a:Action):boolean{
  return (id==="water_sprint"&&a.type==="water_tile")||
    (id==="harvest_run"&&a.type==="harvest_crop")||
    (id==="no_spend_expansion"&&a.type==="till_tile")||
    (id==="forage_find"&&a.type==="collect_forage")||
    (id==="clear_obstacles"&&a.type==="clear_resource");
}
export class ShowDirector{
  private journal:ShowJournal|undefined;
  readonly storagePath:string;
  constructor(storagePath=join(process.cwd(),"data","bigfish-show.json")){
    this.storagePath=storagePath;
  }
  get():ShowJournal|undefined{return this.journal;}
  async load():Promise<void>{
    try{
      const parsed:unknown=JSON.parse(await readFile(this.storagePath,"utf8"));
      if(validShowJournal(parsed))this.journal=parsed;
    }catch(e){
      if((e as NodeJS.ErrnoException).code!=="ENOENT")
        console.warn("[show] ignored unreadable journal");
    }
  }
  private async save():Promise<void>{
    if(!this.journal)return;
    await mkdir(dirname(this.storagePath),{recursive:true});
    const tmp=this.storagePath+".tmp";
    await writeFile(tmp,JSON.stringify(this.journal,null,2),"utf8");
    await rename(tmp,this.storagePath);
  }
  /** Finalize yesterday before issuing a new challenge; never transfer cross-save stories. */
  async sync(s:GameState):Promise<ShowEvent[]>{
    const ordinal=gameOrdinal(s);
    const prior=this.journal;
    const events:ShowEvent[]=[];
    if(!prior||prior.saveId!==s.saveId){
      this.journal={saveId:s.saveId,dayOrdinal:ordinal,outcomes:[]};
      await this.save();return events;
    }
    if(prior.dayOrdinal!==ordinal){
      const old=prior.challenge;
      if(old){
        if(old.status==="active"){
          old.status="lost";old.endReason="Game day elapsed before verified target completion";
          events.push({kind:"lost",challenge:{...old},fact:`${old.title} 未达标：${old.progress}/${old.target}`});
        }
        prior.outcomes.push({ordinal:old.startedOrdinal,id:old.id,
          status:old.status==="won"?"won":"lost",progress:old.progress,target:old.target});
        prior.outcomes=prior.outcomes.slice(-12);
      }
      prior.dayOrdinal=ordinal;prior.challenge=undefined;
      await this.save();
    }
    return events;
  }
  async start(s:GameState,pick:ShowCandidate):Promise<ShowEvent|undefined>{
    await this.sync(s);
    if(this.journal!.challenge||!eligibleChallenges(s).some(c=>
      c.id===pick.id&&c.target===pick.target&&c.deadline===pick.deadline))return;
    const c:ShowChallenge={...pick,startedOrdinal:gameOrdinal(s),status:"active",progress:0,
      verifiedKeys:[],openingGold:s.economy?.gold??0};
    this.journal!.challenge=c;
    await this.save();
    return {kind:"start",challenge:{...c},fact:`${c.title}：目标${c.target}次；截止${c.deadline}`};
  }
  allows(action:Action):boolean{
    const c=this.journal?.challenge;
    return !(c?.status==="active"&&c.id==="no_spend_expansion"&&action.type==="buy_seed");
  }
  /** Called ONLY when the bridge confirmed the actual game state delta. */
  async observed(s:GameState,action:Action,commandId:string):Promise<ShowEvent[]>{
    const c=this.journal?.challenge;
    if(!c||c.status!=="active"||this.journal?.saveId!==s.saveId||
      gameOrdinal(s)!==c.startedOrdinal||!commandId||!applicable(c.id,action))return [];
    const key=actionKey(action);
    if(c.verifiedKeys.includes(key))return [];
    c.verifiedKeys.push(key);
    c.progress=Math.min(c.target,c.progress+1);
    const done=c.progress>=c.target;
    if(done){c.status="won";c.endReason="Verified game actions reached target";}
    await this.save();
    if(done)return [{kind:"won",challenge:{...c},fact:`${c.title} 已达成：${c.progress}/${c.target}`}];
    if(c.progress===1||c.progress===Math.floor(c.target/2))
      return [{kind:"progress",challenge:{...c},fact:`${c.title} 进度${c.progress}/${c.target}`}];
    return [];
  }
  async tick(s:GameState):Promise<ShowEvent[]>{
    const c=this.journal?.saveId===s.saveId?this.journal.challenge:undefined;
    if(!c||c.status!=="active"||gameOrdinal(s)!==c.startedOrdinal)return [];
    if(c.id==="no_spend_expansion"&&s.location==="Farm"&&s.economy&&
      s.economy.gold<c.openingGold){
      c.status="lost";c.endReason="Actual gold decreased during zero-spend challenge";
    }else if(s.time>c.deadline){
      c.status="lost";c.endReason="Game time deadline passed";
    }else return [];
    await this.save();
    return [{kind:"lost",challenge:{...c},fact:`${c.title} 未达成：${c.progress}/${c.target}`}];
  }
}
