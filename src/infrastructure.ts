import type {Action,ActionResult,Decision,GameState,Tile} from "./types.ts";
import {actionKey} from "./types.ts";
import type {FarmPlan} from "./farm-plan.ts";
import type {FarmWorkProject} from "./farm-work.ts";

const dist=(a:Tile,b:Tile)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const near=(a:Tile,b:Tile)=>Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y))<=1;
const coord=(t:Tile)=>t.x+":"+t.y;
export class InfrastructurePlanner {
  private day="";
  private failed=new Map<string,number>();
  private reset(s:GameState):void{
    const key=s.saveId+":"+s.season+":"+s.day;
    if(key!==this.day){this.day=key;this.failed.clear();}
  }
  observe(s:GameState,action?:Action,result?:ActionResult):void{
    this.reset(s);
    if(!action||!result||result.ok)return;
    const key=s.location+":"+actionKey(action);
    this.failed.set(key,(this.failed.get(key)??0)+1);
  }
  private allowed(s:GameState,action:Action):boolean{
    return (this.failed.get(s.location+":"+actionKey(action))??0)<2;
  }
  private approach(s:GameState,t:Tile):Action|undefined{
    if(near(s,t))return;
    const options:Tile[]=[];
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
      if(!dx&&!dy)continue;
      const p={x:t.x+dx,y:t.y+dy};
      if(p.x>=0&&p.y>=0&&p.x<150&&p.y<150)options.push(p);
    }
    options.sort((a,b)=>dist(s,a)-dist(s,b));
    return options.map(t=>({type:"move_to" as const,...t}))
      .find(a=>this.allowed(s,a));
  }
  propose(s:GameState,project?:FarmWorkProject,plan?:FarmPlan):Decision|undefined{
    this.reset(s);
    if(s.location!=="Farm"||s.paused||s.time>=1900||s.energy<=20||
      !s.economy||!project||project.saveId!==s.saveId)return;
    if(s.economy.chests.length>0)return; // Existing storage satisfies the first chest goal.
    const kits=s.chestKits??0;
    if(kits>0){
      const protectedTiles=new Set([...(plan?.fieldTiles??[]),...(plan?.protectedTiles??[])].map(coord));
      const sites=[...(s.placementSites??[])].filter(t=>!protectedTiles.has(coord(t)))
        .sort((a,b)=>dist(s,a)-dist(s,b)||a.y-b.y||a.x-b.x);
      for(const site of sites){
        const action=near(s,site)?
          ({type:"place_chest" as const,...site}):this.approach(s,site);
        if(action&&this.allowed(s,action))
          return {action,reason:"Place legitimately crafted chest on an observed valid site",
            speech:"箱子做好了，我给它找个不挡路的位置。"};
      }
      return;
    }
    const wood=s.economy.bag.filter(i=>i.id==="(O)388").reduce((a,i)=>a+i.count,0);
    if(wood<50){
      for(const chest of s.economy.chests){
        const inChest=chest.items.find(i=>i.id==="(O)388"&&i.count>0);
        if(!inChest)continue;
        const action=near(s,chest)?
          ({type:"withdraw_item" as const,itemId:"(O)388",count:Math.min(50-wood,inChest.count),x:chest.x,y:chest.y}):
          this.approach(s,chest);
        if(action&&this.allowed(s,action))
          return {action,reason:"Retrieve wood prerequisite before crafting a chest",speech:"先从箱子里取够制作材料。"};
      }
    }
    if(wood>=50&&s.canCraftChest===true&&s.inventoryFree>0){
      const action:Action={type:"craft_chest"};
      if(this.allowed(s,action))
        return {action,reason:"Native learned chest recipe with verified material inventory",
          speech:"木头备齐了，做一个新的储物箱！"};
    }
  }
}
