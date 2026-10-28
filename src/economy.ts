import type { Action, Decision, GameState, Tile } from "./types.ts";
import { actionKey } from "./types.ts";
import { bestPurchase, type FarmPlan } from "./farm-plan.ts";
import type { FarmWorkProject } from "./farm-work.ts";
import { validWorkProject } from "./farm-work.ts";
export type Strategy = { goal: "profit" | "expand" | "save"; targetGold: number; seedReserve: number; notes: string };
export const DEFAULT_STRATEGY: Strategy = { goal: "profit", targetGold: 2500, seedReserve: 6, notes: "Grow, ship, reinvest" };
const d=(action:Action,reason:string,speech:string):Decision=>({action,reason,speech});
const dist=(s:Tile,t:Tile)=>Math.max(Math.abs(s.x-t.x),Math.abs(s.y-t.y));
const near=(s:GameState,t:Tile):boolean=>dist(s,t)<=1;
const walk=(s:GameState,t:Tile):Action=>{
  const options:Tile[]=[];
  for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
    if(dx===0&&dy===0)continue;
    const c={x:t.x+dx,y:t.y+dy};
    if(c.x>=0&&c.y>=0&&c.x<150&&c.y<150)options.push(c);
  }
  options.sort((a,b)=>dist(s,a)-dist(s,b));
  return {type:"move_to",...options[0]};
};
export function nextLocation(s:GameState,destination:string):string|undefined{
  if(s.location===destination)return;
  const g=new Map<string,Set<string>>();
  for(const {from,to} of s.worldLinks){
    if(!g.has(from))g.set(from,new Set());
    g.get(from)!.add(to);
  }
  g.set(s.location,new Set([...(g.get(s.location)??[]),...s.exits.map(e=>e.target)]));
  const todo=[{at:s.location,first:""}],seen=new Set([s.location]);
  while(todo.length){
    const {at,first}=todo.shift()!;
    for(const to of g.get(at)??[]){
      if(seen.has(to))continue;
      const hop=first||to;
      if(to===destination)return hop;
      seen.add(to);todo.push({at:to,first:hop});
    }
  }
}
export class EconomyPlanner {
  private failed=new Map<string,number>();
  private dayKey="";
  private lastPosition="";
  private shopAttempted=false;
  private errand: "buy"|null=null;
  private cashAfterShipping=false;
  update(s:GameState,action?:Action,ok=true):void {
    const k=s.saveId+":"+s.season+":"+s.day;
    const position=s.location+":"+s.x+":"+s.y;
    if(this.dayKey!==k){this.failed.clear();this.shopAttempted=false;this.errand=null;this.cashAfterShipping=false;this.dayKey=k;}
    else if(this.lastPosition && this.lastPosition!==position)this.failed.clear();
    this.lastPosition=position;
    if(action&&!ok)this.failed.set(s.location+":"+actionKey(action),(this.failed.get(s.location+":"+actionKey(action))??0)+1);
    if(action?.type==="buy_seed"&&ok)this.shopAttempted=true;
  }
  propose(s:GameState,strategy:Strategy=DEFAULT_STRATEGY,farmPlan?:FarmPlan,project?:FarmWorkProject,policy?:{forbidPurchases?:boolean}):Decision|undefined{
    this.update(s);
    const e=s.economy;
    if(policy?.forbidPurchases)this.errand=null;
    if(!e||s.paused)return;
    const allowed=(a:Action)=>(this.failed.get(s.location+":"+actionKey(a))??0)<2;
    const issue=(a:Action,why:string,speech:string):Decision|undefined=>allowed(a)?d(a,why,speech):undefined;
    const travel=(target:string,why:string,speech:string):Decision|undefined=>{
      const hop=nextLocation(s,target);
      return hop?issue({type:"travel_to",target:hop},why,speech):undefined;
    };
    const interact=(target:Tile,act:Action,why:string,speech:string):Decision|undefined=>{
      return issue(near(s,target)?act:walk(s,target),why,speech);
    };
    const seedCount=e.bag.filter(x=>x.category===-74).reduce((n,x)=>n+x.count,0);
    const validPlan=farmPlan?.saveId===s.saveId&&
      farmPlan.dayKey===s.season+":"+s.day?farmPlan:undefined;
    const desiredSeeds=validPlan?
      Math.max(0,validPlan.targetPlots-
        (s.location==="Farm"?s.crops.length:validPlan.occupiedPlots)):strategy.seedReserve;
    const needSeeds=seedCount<desiredSeeds;
    const emergencyReserve=project?.saveId===s.saveId && validWorkProject(project)?
      project.cashReserve:0;
    const spendableGold=Math.max(0,e.gold-emergencyReserve);
    // Keep edible supplies for stamina recovery. Shipping is all-or-nothing per stack,
    // so selling any food here could remove the last emergency meal.
    const foodIds=new Set(s.food?.map(f=>f.id)??[]);
    // Protect farm construction materials even when the game marks them saleable.
    const reservedMaterials=new Set(["(O)388","(O)390","(O)771","(O)382","(O)92",
      "(O)334","(O)335","(O)336","(O)337","(O)338","(O)787"]);
    const sellable=e.bag.filter(x=>x.sellable&&x.category!==-74&&x.count>0 &&
      !foodIds.has(x.id) && !reservedMaterials.has(x.id));
    if(s.location==="Farm"){
      // Selling has priority when money is blocked in produce, or the backpack is full.
      if(sellable.length&&e.shippingBin){
        const item=sellable[0];
        const a=interact(e.shippingBin,{type:"ship_item",itemId:item.id},"Ship farm produce","今天收成不错，拿去卖！");
        if(a)return a;
      }
      // Recover spare seeds from a nearby owned chest first, before spending money.
      if(seedCount===0){
        for(const chest of e.chests){
          const seed=chest.items.find(x=>x.category===-74&&x.count>0);
          if(seed){
            const a=interact(chest,{type:"withdraw_item",itemId:seed.id,count:Math.min(5,seed.count),x:chest.x,y:chest.y},"Recover stored seed","箱子里还有种子！");
            if(a)return a;
          }
        }
      }
      if(s.crops.some(c=>!c.watered) && e.tools.wateringCan && e.tools.waterLeft===0 && s.waterSources?.length){
        const spring=[...s.waterSources].sort((a,b)=>dist(a,s)-dist(b,s))[0];
        const a=interact(spring,{type:"refill_watering_can",x:spring.x,y:spring.y},"Fill watering can","水壶空了，先去打水！");
        if(a)return a;
      }
      // Free inventory using storage for non-saleable non-tool resources.
      if(s.inventoryFree<=2&&e.chests.length){
        const resources=e.bag.filter(x=>reservedMaterials.has(x.id) ||
          (x.category!==-74&&!x.sellable&&x.category!==-99&&
            x.id.startsWith("(O)")&&!foodIds.has(x.id)));
        if(resources.length){
          const chest=e.chests[0],item=resources[0];
          const a=interact(chest,{type:"store_item",itemId:item.id,count:item.count,x:chest.x,y:chest.y},"Free backpack space","背包太满了，先收拾一下。");
          if(a)return a;
        }
      }
      // Do not leave crops unwatered to buy seeds; farm-day planner handles crops first.
      const workPending=s.crops.some(c=>!c.watered||c.ready) || (seedCount>0&&s.emptyPlots.length>0);
      if(!policy?.forbidPurchases&&!workPending&&needSeeds&&(!validPlan||validPlan.crops.length>0)&&
        spendableGold>=20&&s.time>=830&&s.time<1530&&!this.shopAttempted){
        const step=travel("SeedShop","Buy next batch of seeds","去皮埃尔那儿补货！");
        if(step){this.errand="buy";return step;}
      }
    }
    if(this.errand==="buy"&&s.location!=="Farm"&&s.location!=="SeedShop"){
      return travel("SeedShop","Continue seed-shopping route","去商店的路上。");
    }
    if(s.location==="SeedShop"){
      const shop=e.shop;
      if(!shop||!shop.open){
        if(s.time<900)return issue({type:"wait",seconds:10},"Wait for shop opening","皮埃尔还没开门。");
        this.errand=null;
        return travel("Farm","Shop is closed or keeper absent","商店不开门，先回家。");
      }
      if(policy?.forbidPurchases || !needSeeds || this.shopAttempted || spendableGold<20){
        this.errand=null;
        return travel("Farm","Return with purchased seeds","带着种子回农场！");
      }
      const scored=validPlan?bestPurchase(s,validPlan):undefined;
      const stock=[...shop.offers].filter(x=>x.price>0&&x.price<=spendableGold&&x.stock!==0 &&
          (!validPlan || x.id===scored?.id)).sort((a,b)=>a.price-b.price);
      // Spend at most half of current cash on one buying batch; preserve emergency funds.
      const offer=stock[0];
      if(offer){
        const spendFraction=strategy.goal==="expand"?0.75:strategy.goal==="save"?0.25:0.5;
        const max=Math.floor((spendableGold*spendFraction)/offer.price);
        const count=Math.min(desiredSeeds-seedCount,max,offer.stock<0?99:offer.stock,12);
        if(count>0){
          const a=interact(shop.keeper,{type:"buy_seed",itemId:offer.id,count},"Buy valid seasonal shop stock","补充一些种子，继续赚钱！");
          if(a)return a;
        }
      }
      this.errand=null;
      return travel("Farm","No affordable seed offers","今天种子买不起了。");
    }
  }
}
