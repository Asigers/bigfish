import type { Action, ActionResult, Decision, GameState, ForageItem, Tile } from "./types.ts";
import { actionKey } from "./types.ts";
import { nextLocation } from "./economy.ts";

// This is a bounded collection route, not a random walk: each location is inspected
// once per game day, each failed interaction is bounded, and all targets are sensed.
export class ForagePlanner {
  private dayKey="";
  private active=false;
  private finished=false;
  private visited=new Set<string>();
  private failed=new Map<string,number>();
  private readonly destinations=["Forest","Beach","Mountain","Town","BusStop"];

  private syncDay(s:GameState):void {
    const key=s.saveId+":"+s.season+":"+s.day;
    if(this.dayKey!==key){
      this.dayKey=key;
      this.active=false;
      this.finished=false;
      this.visited.clear();
      this.failed.clear();
    }
  }
  observe(s:GameState,action?:Action,result?:ActionResult):void {
    this.syncDay(s);
    if(action && result && !result.ok){
      const k=s.location+":"+actionKey(action);
      this.failed.set(k,(this.failed.get(k)??0)+1);
    }
  }
  private allowed(s:GameState,action:Action):boolean {
    return (this.failed.get(s.location+":"+actionKey(action))??0)<2;
  }
  private near(a:Tile,b:Tile):boolean {
    return Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y))<=1;
  }
  private stepTo(s:GameState,item:ForageItem):Action|undefined {
    const origin={x:s.x,y:s.y};
    if(this.near(origin,item)){
      const collect:Action={type:"collect_forage",x:item.x,y:item.y};
      return this.allowed(s,collect)?collect:undefined;
    }
    const neighbors:Tile[]=[];
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
      if(dx===0&&dy===0)continue;
      const tile={x:item.x+dx,y:item.y+dy};
      if(tile.x>=0&&tile.y>=0&&tile.x<150&&tile.y<150)neighbors.push(tile);
    }
    neighbors.sort((a,b)=>Math.abs(a.x-origin.x)+Math.abs(a.y-origin.y)-
      Math.abs(b.x-origin.x)-Math.abs(b.y-origin.y));
    for(const candidate of neighbors){
      const action:Action={type:"move_to",...candidate};
      if(this.allowed(s,action))return action;
    }
  }
  propose(s:GameState,startAllowed:boolean):Decision|undefined {
    this.syncDay(s);
    if(s.paused || s.time>=2000 || s.energy<=45 || s.inventoryFree<=0){
      this.active=false;
      return undefined;
    }
    if(s.forage===undefined)return undefined; // The SMAPI mod hasn't exposed this feature.
    if(!this.active){
      if(!startAllowed || this.finished || s.location!=="Farm")return undefined;
      this.active=true;
    }
    this.visited.add(s.location);
    const items=[...s.forage].sort((a,b)=>
      Math.abs(a.x-s.x)+Math.abs(a.y-s.y)-Math.abs(b.x-s.x)-Math.abs(b.y-s.y));
    for(const item of items){
      const action=this.stepTo(s,item);
      if(action)return {action,reason:"Collect observed wild forage",
        speech:"发现可以采集的东西，去捡起来！"};
    }
    for(const target of this.destinations){
      if(this.visited.has(target))continue;
      const hop=nextLocation(s,target);
      if(!hop || !s.exits.some(e=>e.target===hop))continue;
      const action:Action={type:"travel_to",target:hop};
      if(this.allowed(s,action))return {action,reason:"Search "+target+" for forage",
        speech:"这片地方搜完了，换个地方寻找野外资源。"};
    }
    this.active=false;
    this.finished=true;
    return undefined;
  }
}
