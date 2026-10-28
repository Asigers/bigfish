import type {Action,GameState} from "./types.ts";
import type {Emotion} from "./avatar.ts";
import type {ShowEvent} from "./show-director.ts";
export type LiveMomentKind="day_open"|"reflection"|"verified_success"|"verified_failure"|
  "show_start"|"show_progress"|"show_won"|"show_lost";
export type LiveMoment={
  key:string;kind:LiveMomentKind;priority:number;fact:string;fallback:string;
  emotion:Emotion;goal:string;saveId:string;dayKey:string
};
const day=(s:GameState)=>(s.year??1)+":"+s.season+":"+s.day;
const clockLabel=(s:GameState)=>String(Math.floor(s.time/100))+":"+
  String(s.time%100).padStart(2,"0");
const actionLabels:Record<string,string>={
  water_tile:"给作物浇了水",till_tile:"开垦了一块地",
  harvest_crop:"收获了一株成熟作物",plant_seed:"播下了一颗种子",
  buy_seed:"购买了商店里的种子",ship_item:"把物品送进出货箱",
  craft_chest:"真正制作了一个储物箱",place_chest:"在农场安放了储物箱",
  craft_sprinkler:"制作了洒水器",place_sprinkler:"安装了洒水器",
  collect_forage:"捡到了野外物资",pickup_drop:"拾取了掉落材料",
  clear_resource:"清理了一次障碍物",sleep:"进入了新的一天"
};
export class NarrationScheduler{
  private queue:LiveMoment[]=[];
  private seen=new Set<string>();
  private emitted=new Set<string>();
  private recentTexts:string[]=[];
  private lastTalk=-Infinity;
  private inFlight=false;
  private saveId="";
  private dayKey="";
  private generation=0;
  private routine=new Map<string,number>();
  private closed=false;
  constructor(private readonly cooldownMs=12000,private readonly now:()=>number=Date.now){}
  reset(s:GameState):void{
    const key=day(s);
    if(s.saveId===this.saveId&&key===this.dayKey)return;
    this.saveId=s.saveId;this.dayKey=key;this.queue=[];
    this.seen.clear();this.emitted.clear();this.routine.clear();
    this.generation++;
    // Do not copy commentary or pending prompts across saves.
    if(this.saveId!==s.saveId)this.recentTexts=[];
  }
  close():void{this.closed=true;this.generation++;this.queue=[];}
  pending():number{return this.queue.length;}
  enqueue(event:LiveMoment):boolean{
    if(this.closed||event.saveId!==this.saveId||event.dayKey!==this.dayKey||
      this.seen.has(event.key)||event.fact.length>350||event.fallback.length>120)return false;
    this.seen.add(event.key);
    this.queue.push(event);
    this.queue.sort((a,b)=>b.priority-a.priority);
    if(this.queue.length>15)this.queue.length=15;
    return true;
  }
  beginDay(s:GameState,description:string):void{
    this.reset(s);
    const gold=s.economy?.gold;
    const fact=`游戏第${s.year??1}年${s.season}季第${s.day}天，现有${s.crops.length}块作物`+
      (gold===undefined?"":`，金币${gold}`)+
      (description?"；当前经营目标："+description.slice(0,85):"");
    this.enqueue({key:"day:"+day(s),kind:"day_open",priority:8,fact,
      fallback:`新的一天开始了！今天先照顾好农场，再看看能完成什么目标。`,
      emotion:"happy",goal:description,saveId:s.saveId,dayKey:day(s)});
  }
  reflect(s:GameState,goal:string):void{
    if(s.paused)return;
    const segment=s.time>=1600?"afternoon":s.time>=1200?"noon":null;
    if(!segment)return;
    this.enqueue({key:"reflect:"+segment,kind:"reflection",priority:1,
      fact:`现在游戏时间${clockLabel(s)}，地点${s.location}，体力${Math.floor(s.energy)}，观察到作物${s.crops.length}株`,
      fallback:segment==="noon"?"中午了，看看今天的农场进度怎么样。":"下午了，该考虑收尾和回家的时间了。",
      emotion:"thinking",goal,saveId:s.saveId,dayKey:day(s)});
  }
  show(s:GameState,e:ShowEvent):void{
    this.reset(s);
    const {challenge}=e;
    const key="show:"+e.kind+":"+challenge.id+":"+challenge.progress;
    const priority=e.kind==="won"?10:e.kind==="lost"?9:e.kind==="start"?8:6;
    const fallback=e.kind==="won"?`挑战完成！${challenge.title}，目标达成！`:
      e.kind==="lost"?`这次${challenge.title}没完成，下次再挑战。`:
      e.kind==="start"?`今天来挑战${challenge.title}！目标${challenge.target}次。`:
      `${challenge.title}已经完成${challenge.progress}/${challenge.target}，继续努力！`;
    this.enqueue({key,kind:("show_"+e.kind) as LiveMomentKind,
      priority,fact:e.fact,fallback,emotion:e.kind==="lost"?"sad":e.kind==="won"?"excited":"happy",
      goal:challenge.title,saveId:s.saveId,dayKey:day(s)});
  }
  /** Never declare a game success until the controller verified the native outcome. */
  action(s:GameState,a:Action,confirmed:boolean,commandId:string):void{
    if(!commandId||!actionLabels[a.type]||this.saveId!==s.saveId||this.dayKey!==day(s))return;
    const counter=(this.routine.get(a.type)??0)+1;
    this.routine.set(a.type,counter);
    if(confirmed){
      const important=["harvest_crop","buy_seed","ship_item","craft_chest",
        "place_chest","craft_sprinkler","place_sprinkler"].includes(a.type);
      // Routine interactions are consolidated, not voiced at every tile.
      if(!important&&counter%4!==0)return;
      const fact=`已由游戏状态确认：${actionLabels[a.type]}${counter}次（本解说周期），游戏时间${clockLabel(s)}`;
      const fallback=important?`${actionLabels[a.type]}！计划又向前迈进了一步。`:
        `忙活了一阵，${actionLabels[a.type]}，已经做了${counter}次。`;
      this.enqueue({key:"action:"+a.type+":"+Math.floor(counter/4),kind:"verified_success",
        priority:important?6:2,fact,fallback,emotion:important?"excited":"happy",
        goal:"农场经营",saveId:s.saveId,dayKey:day(s)});
    }else{
      // This is only used for authoritative negative receipts, never uncertain ACKs.
      this.enqueue({key:"fail:"+commandId,kind:"verified_failure",priority:7,
        fact:`游戏已明确报告${a.type}执行失败`,fallback:"这一步没成功，换个办法再试。",
        emotion:"sad",goal:"处理失败",saveId:s.saveId,dayKey:day(s)});
    }
  }
  /** Nonblocking producer: slow model responses cannot hold the game command loop. */
  pump(generate:(event:LiveMoment,history:string[])=>Promise<string>,
    emit:(event:LiveMoment,text:string)=>void):void{
    if(this.closed||this.inFlight||!this.queue.length||
      this.now()-this.lastTalk<this.cooldownMs)return;
    const next=this.queue.shift()!;
    const epoch=this.generation;
    this.inFlight=true;
    // Reserve a slot before an async model call; concurrent pump() cannot emit twice.
    this.lastTalk=this.now();
    const prior=this.recentTexts.slice(-5);
    void Promise.resolve().then(()=>generate(next,prior)).catch(()=>next.fallback)
      .then(raw=>{
        if(this.closed||epoch!==this.generation)return;
        const text=typeof raw==="string"&&raw.trim().length>=4&&raw.trim().length<=100?
          raw.trim():next.fallback;
        const safe=this.recentTexts.includes(text)?next.fallback:text;
        if(this.recentTexts.includes(safe))return;
        this.recentTexts.push(safe);this.recentTexts=this.recentTexts.slice(-8);
        this.emitted.add(next.key);
        emit(next,safe);
      }).finally(()=>{this.inFlight=false;});
  }
}
