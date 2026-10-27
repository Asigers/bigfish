import type { Action, ActionResult, Decision, GameState } from "./types.ts";
import { actionKey } from "./types.ts";

/** Reclaim only actual world debris; no direct item grants or fake pickup acknowledgments. */
export class DropPlanner {
  private day="";
  private failures=new Map<string,number>();
  private attempts=0;
  private readonly maxDailyAttempts=12;
  private reset(s:GameState):void{
    const key=s.saveId+":"+s.season+":"+s.day;
    if(key!==this.day){
      this.day=key;
      this.failures.clear();
      this.attempts=0;
    }
  }
  observe(s:GameState,action?:Action,result?:ActionResult):void{
    this.reset(s);
    if(action?.type!=="pickup_drop"||!result)return;
    this.attempts++;
    if(!result.ok){
      const k=s.location+":"+actionKey(action);
      this.failures.set(k,(this.failures.get(k)??0)+1);
    }
  }
  propose(s:GameState):Decision|undefined {
    this.reset(s);
    if(s.paused||s.time>=2030||s.energy<=12||s.inventoryFree<=0||
      !s.economy||!s.drops?.length||this.attempts>=this.maxDailyAttempts)return;
    const ordered=[...s.drops].sort((a,b)=>
      Math.abs(a.x-s.x)+Math.abs(a.y-s.y)-
      Math.abs(b.x-s.x)-Math.abs(b.y-s.y));
    for(const drop of ordered){
      const action:Action={type:"pickup_drop",x:drop.x,y:drop.y,itemId:drop.itemId};
      if((this.failures.get(s.location+":"+actionKey(action))??0)>=2)continue;
      return {action,reason:"Recover native world drop into actual inventory",
        speech:"材料掉在地上了，过去捡起来！"};
    }
  }
}
