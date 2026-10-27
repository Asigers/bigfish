import type { Action, ActionResult, Decision, GameState, ResourceKind, ResourceNode, Tile } from "./types.ts";
import { actionKey } from "./types.ts";

const resourceTool:Record<ResourceKind,"axe"|"pickaxe"|"scythe">={
  tree:"axe",stone:"pickaxe",twig:"axe",weed:"scythe"
};
const resourceItem:Record<ResourceKind,string>={
  tree:"(O)388",twig:"(O)388",stone:"(O)390",weed:"(O)771"
};
const goalCount:Record<ResourceKind,number>={
  tree:50,twig:50,stone:30,weed:15
};
const near=(a:Tile,b:Tile)=>Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y))<=1;
const distance=(a:Tile,b:Tile)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);

/** Short, safe farm-clearing plan; never attack objects outside authoritative Farm observations. */
export class FarmResourcePlanner {
  private day="";
  private strikes=0;
  private treeStrikes=0;
  private failures=new Map<string,number>();
  private lastPosition="";
  private maxDailyStrikes=14;
  private maxTreeStrikes=8;
  private reset(s:GameState):void{
    const key=s.saveId+":"+s.season+":"+s.day;
    if(key!==this.day){
      this.day=key;this.strikes=0;this.treeStrikes=0;
      this.failures.clear();this.lastPosition="";
    }
    const pos=s.location+":"+s.x+":"+s.y;
    if(this.lastPosition&&this.lastPosition!==pos)this.failures.clear();
    this.lastPosition=pos;
  }
  observe(s:GameState,action?:Action,result?:ActionResult):void{
    this.reset(s);
    if(!action||!result)return;
    if(action.type==="clear_resource"){
      this.strikes++;
      if(action.kind==="tree")this.treeStrikes++;
    }
    if(!result.ok){
      const key=s.location+":"+actionKey(action);
      this.failures.set(key,(this.failures.get(key)??0)+1);
    }
  }
  private allowed(s:GameState,a:Action):boolean{
    return (this.failures.get(s.location+":"+actionKey(a))??0)<2;
  }
  private approach(s:GameState,target:ResourceNode):Action|undefined{
    if(near(s,target)){
      const a:Action={type:"clear_resource",kind:target.kind,x:target.x,y:target.y};
      return this.allowed(s,a)?a:undefined;
    }
    const options:Tile[]=[];
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
      if(!dx&&!dy)continue;
      const t={x:target.x+dx,y:target.y+dy};
      if(t.x>=0&&t.y>=0&&t.x<150&&t.y<150)options.push(t);
    }
    options.sort((a,b)=>distance(a,s)-distance(b,s));
    for(const t of options){
      const a:Action={type:"move_to",...t};
      if(this.allowed(s,a))return a;
    }
  }
  propose(s:GameState,canStart:boolean):Decision|undefined {
    this.reset(s);
    if(!canStart||s.paused||s.location!=="Farm"||
      s.time>=1800||s.energy<65||s.inventoryFree<=0||!s.economy||
      !s.resources||this.strikes>=this.maxDailyStrikes)return;
    const bag=s.economy.bag;
    // Stored stock belongs to the farm as much as backpack stock does.
    // Otherwise, putting 50 wood in a chest makes the agent farm 50 more every day.
    const count=(id:string)=>bag.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0) +
      s.economy!.chests.reduce((n,chest)=>n+
        chest.items.filter(i=>i.id===id).reduce((k,i)=>k+i.count,0),0);
    const missing=(kind:ResourceKind)=>count(resourceItem[kind])<goalCount[kind];
    const available=(kind:ResourceKind)=>{
      const tool=resourceTool[kind];
      return s.economy?.tools[tool]===true &&
        (this.failures.get(s.location+":"+actionKey({type:"equip_tool",tool}))??0)<2;
    };
    const priority:Record<ResourceKind,number>={twig:0,weed:1,stone:2,tree:3};
    const choices=s.resources.filter(n=>missing(n.kind)&&available(n.kind)&&
      !(n.kind==="tree"&&this.treeStrikes>=this.maxTreeStrikes))
      .sort((a,b)=>priority[a.kind]-priority[b.kind]||distance(a,s)-distance(b,s));
    for(const target of choices){
      const action=this.approach(s,target);
      if(!action)continue;
      return {action,reason:"Gather "+target.kind+
        " for farm construction (bounded daily energy/time budget)",
        speech:target.kind==="tree"?"需要木材，选棵没装树液采集器的树。":"收集建设农场要用的材料。"};
    }
  }
}
