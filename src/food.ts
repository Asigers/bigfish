import type { Action, ActionResult, Decision, FoodItem, GameState } from "./types.ts";
import { actionKey } from "./types.ts";

/** Consume real edible inventory only when there is a measurable energy need. */
export class FoodPlanner {
  private day="";
  private failed=new Map<string,number>();
  private eatenToday=0;
  private readonly dailyLimit=4;

  private reset(s:GameState):void {
    const key=s.saveId+":"+s.season+":"+s.day;
    if(key!==this.day){this.day=key;this.failed.clear();this.eatenToday=0;}
  }
  observe(s:GameState,action?:Action,result?:ActionResult):void {
    this.reset(s);
    if(action?.type!=="eat_food"||!result)return;
    if(result.ok)this.eatenToday++;
    else this.failed.set(actionKey(action),(this.failed.get(actionKey(action))??0)+1);
  }
  propose(s:GameState):Decision|undefined {
    this.reset(s);
    if(s.paused||s.time>=2200||s.energy>80||this.eatenToday>=this.dailyLimit||
       !s.food?.length||!s.economy)return;
    const options=s.food.filter(i=>i.restoreEnergy>=10&&i.count>0 &&
       (this.failed.get(actionKey({type:"eat_food",itemId:i.id}))??0)<2);
    if(!options.length)return;
    // Preserve valuable large meals if a smaller edible can restore the needed energy.
    const need=Math.max(20,140-s.energy);
    const ranking=(item:FoodItem)=>{
      const excess=Math.max(0,item.restoreEnergy-need);
      const shortfall=Math.max(0,need-item.restoreEnergy);
      return excess+shortfall*2;
    };
    options.sort((a,b)=>ranking(a)-ranking(b)||a.restoreEnergy-b.restoreEnergy);
    const food=options[0];
    return {action:{type:"eat_food",itemId:food.id},
      reason:"Recover stamina with observed edible item (+"+food.restoreEnergy+" estimated energy)",
      speech:"体力不够了，吃点东西恢复一下，再继续干活。"};
  }
}
