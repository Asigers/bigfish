import type { Action, Decision, GameState, Tile, ActionResult } from "./types.ts";
import { actionKey } from "./types.ts";

const wait=(reason:string):Decision=>({action:{type:"wait",seconds:5},reason,speech:"稍微观察一下。"});
const decision=(action:Action,reason:string,speech="本鲸继续干活。"):Decision=>({action,reason,speech});
const close=(a:Tile,b:Tile):boolean=>Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y))<=1;
const distance=(a:Tile,b:Tile)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const walkNear=(s:GameState,t:Tile):Action=>{
  if(close(s,t)) return {type:"wait",seconds:1};
  const candidates:Tile[]=[];
  for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++){
    if(dx===0&&dy===0)continue;
    const c={x:t.x+dx,y:t.y+dy};
    if(c.x>=0&&c.y>=0&&c.x<150&&c.y<150)candidates.push(c);
  }
  candidates.sort((a,b)=>distance(a,s)-distance(b,s));
  // PathFindController verifies actual reachability; other candidate tiles are tried after failures.
  return {type:"move_to",...candidates[0]};
};
function nextHop(s:GameState,destination:string):string|undefined {
  if(s.location===destination)return undefined;
  const graph=new Map<string,string[]>();
  for(const l of s.worldLinks){
    if(!graph.has(l.from))graph.set(l.from,[]);
    graph.get(l.from)!.push(l.to);
  }
  graph.set(s.location,[...new Set([...(graph.get(s.location)??[]),...s.exits.map(e=>e.target)])]);
  const queue=[{name:s.location, first:""}],visited=new Set([s.location]);
  while(queue.length){
    const current=queue.shift()!;
    for(const to of graph.get(current.name)??[]){
      if(visited.has(to))continue;visited.add(to);
      const hop=current.first||to;
      if(to===destination)return hop;
      queue.push({name:to,first:hop});
    }
  }
  return undefined;
}
export function parseDecision(raw:string):Decision {
  const cleaned=raw.trim().replace(/^`{3}(?:json)?\s*/i,"").replace(/\s*`{3}$/,"");
  const obj:unknown=JSON.parse(cleaned);
  if(!obj||typeof obj!=="object"||Array.isArray(obj))throw Error("Decision object required");
  const d=obj as {action?:Record<string,unknown>;speech?:unknown;reason?:unknown};
  const a=d.action;
  if(!a||typeof a!=="object")throw Error("Action required");
  let action:Action;
  if(a.type==="wait"&&Number.isInteger(a.seconds)&&Number(a.seconds)>=1&&Number(a.seconds)<=15)
    action={type:"wait",seconds:Number(a.seconds)};
  else if(["move_to","water_tile","harvest_crop","till_tile","plant_seed","refill_watering_can"].includes(String(a.type)) &&
    Number.isInteger(a.x)&&Number.isInteger(a.y)&&Number(a.x)>=0&&Number(a.y)>=0&&Number(a.x)<256&&Number(a.y)<256){
      if(a.type==="plant_seed"&&typeof a.seedId==="string"&&/^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(a.seedId))
        action={type:"plant_seed",x:Number(a.x),y:Number(a.y),seedId:a.seedId};
      else if(a.type!=="plant_seed")
        action={type:a.type as "move_to"|"water_tile"|"harvest_crop"|"till_tile"|"refill_watering_can",x:Number(a.x),y:Number(a.y)};
      else throw Error("Bad seedId");
    }
  else if(a.type==="travel_to"&&typeof a.target==="string"&&/^[A-Za-z0-9_-]{1,80}$/.test(a.target))
    action={type:"travel_to",target:a.target};
  else if((a.type==="ship_item")&&typeof a.itemId==="string"&&/^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(a.itemId))
    action={type:"ship_item",itemId:a.itemId};
  else if(a.type==="buy_seed"&&typeof a.itemId==="string"&&/^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(a.itemId)&&Number.isInteger(a.count)&&Number(a.count)>0&&Number(a.count)<=12)
    action={type:"buy_seed",itemId:a.itemId,count:Number(a.count)};
  else if(["store_item","withdraw_item"].includes(String(a.type))&&typeof a.itemId==="string"&&/^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(a.itemId)&&Number.isInteger(a.count)&&Number(a.count)>0&&Number(a.count)<=9999&&Number.isInteger(a.x)&&Number.isInteger(a.y))
    action={type:a.type as "store_item"|"withdraw_item",itemId:a.itemId,count:Number(a.count),x:Number(a.x),y:Number(a.y)};
  else if(a.type==="equip_tool"&&(a.tool==="hoe"||a.tool==="watering_can"))
    action={type:"equip_tool",tool:a.tool};
  else if(a.type==="sleep")action={type:"sleep"};
  else throw Error("Unsupported action");
  return {action,speech:typeof d.speech==="string"?d.speech.slice(0,100):"",reason:typeof d.reason==="string"?d.reason.slice(0,120):""};
}
export class Autopilot {
  private failures=new Map<string,number>();
  private prevDay="";
  private lastPosition="";
  private touring=false;
  private tourDone=false;
  private visitedLocations=new Set<string>();
  private syncDay(s:GameState):void {
    const dayKey=s.saveId+":"+s.season+":"+s.day;
    const position=s.location+":"+s.x+":"+s.y;
    if(this.prevDay!==dayKey){
      this.failures.clear();
      this.touring=false;
      this.tourDone=false;
      this.visitedLocations.clear();
      this.prevDay=dayKey;
    }else if(this.lastPosition && this.lastPosition!==position){
      // A manual reposition or recovered warp is a meaningful change in route feasibility.
      this.failures.clear();
    }
    this.lastPosition=position;
    this.visitedLocations.add(s.location);
  }
  observe(s:GameState,recent:ActionResult[],action?:Action):void {
    this.syncDay(s);
    if(action&&recent.length&&!recent.at(-1)!.ok){
      const k=s.location+":"+actionKey(action);
      this.failures.set(k,(this.failures.get(k)??0)+1);
    }
  }
  decide(s:GameState):Decision {
    this.syncDay(s);
    if(s.paused)return wait("Game menu or cutscene active");
    const can=(a:Action)=> (this.failures.get(s.location+":"+actionKey(a))??0)<2;
    const mustSleep=s.time>=2250||s.energy<=12;
    if(s.location==="FarmHouse" && (mustSleep || this.tourDone) && s.bed){
      const action:Action={type:"sleep"};
      return can(action)?decision(action,this.tourDone&&!mustSleep?"Day completed; advance crops":s.energy<=12?"Rest: critically low energy":"End game day: late evening","今天的行程完成啦，休息！"):wait("Sleep repeatedly failed; manual help required");
    }
    if(s.location==="FarmHouse"&&s.time>=610 && s.time<2250 && s.energy>16 && !this.tourDone){
      const action:Action={type:"travel_to",target:"Farm"};
      return can(action)?decision(action,"Return to farming","下地干活啦。"):wait("Farm commute repeatedly failed");
    }
    const goHome=():Decision=>{
      if(s.location==="FarmHouse"&&s.bed){
        const action:Action={type:"sleep"};
        return can(action)?decision(action,s.energy<=12?"Rest: critically low energy":"End game day: late evening","回床上睡一觉！"):wait("Sleep repeatedly failed; manual help required");
      }
      const hop=nextHop(s,"FarmHouse");
      if(!hop)return wait("No home route");
      const action:Action={type:"travel_to",target:hop};
      return can(action)?decision(action,"Return home","天晚了，要回家。"):wait("Travel repeatedly failed; manual help required");
    };
    const tourNext=():Decision|undefined=>{
      // Fixed, finite itinerary: no meaningless bouncing across two adjacent maps.
      // Select only reachable, direct next hops from the actual SMAPI exit snapshot.
      const destinations=["Town","Forest","Beach","Mountain","BusStop","Backwoods"];
      for(const destination of destinations){
        if(this.visitedLocations.has(destination))continue;
        const hop=nextHop(s,destination);
        if(!hop||!s.exits.some(e=>e.target===hop))continue;
        const action:Action={type:"travel_to",target:hop};
        if(can(action))return decision(action,"Visit "+destination+" on the daily exploration route","农活忙完了，出去逛逛。");
      }
      return undefined;
    };
    if(mustSleep)return goHome();
    if(this.touring){
      const step=tourNext();
      if(step)return step;
      this.touring=false;
      this.tourDone=true;
      return goHome();
    }
    if(s.location!=="Farm"){
      const hop=nextHop(s,"Farm");
      if(!hop)return wait("Farm is unreachable");
      const action:Action={type:"travel_to",target:hop};
      return can(action)?decision(action,"Return to farm","回农场看看。"):wait("Farm commute repeatedly failed");
    }
    const pos={x:s.x,y:s.y};
    const nearest=<T extends Tile>(arr:T[]):T[]=>[...arr].sort((a,b)=>distance(a,pos)-distance(b,pos));
    const choose=(tiles:Tile[],make:(t:Tile)=>Action,label:string,speech:string):Decision|undefined=>{
      for(const t of nearest(tiles)){
        const op=close(pos,t)?make(t):walkNear(s,t);
        if(can(op))return decision(op,label,speech);
      }
      return undefined;
    };
    if(s.inventoryFree>0) {
      const harvest=choose(s.crops.filter(c=>c.ready),t=>({type:"harvest_crop",x:t.x,y:t.y}),"Harvest mature crops","收菜收菜！");
      if(harvest)return harvest;
    }
    const water=choose(s.crops.filter(c=>!c.watered),t=>({type:"water_tile",x:t.x,y:t.y}),"Water dry crops","庄稼渴坏了。");
    if(water)return water;
    if(s.seeds.length>0){
      const seed=s.seeds[0];
      const plant=choose(s.emptyPlots,t=>({type:"plant_seed",x:t.x,y:t.y,seedId:seed.id}),"Plant available seeds","来种点东西。");
      if(plant)return plant;
      // Till one tile only after the existing plot pool has been exhausted.
      if(s.emptyPlots.length===0){
        const till=choose(s.tillable,t=>({type:"till_tile",x:t.x,y:t.y}),"Prepare soil","开垦新土地！");
        if(till)return till;
      }
    }
    // A livestream must not spend the day idling in one tile. The economy planner
    // has already had a chance to replenish seeds; tour accessible maps next.
    if(!this.tourDone && s.time<2000 && s.energy>35){
      const step=tourNext();
      if(step){this.touring=true;return step;}
    }
    // No supported productive or touring actions remain. Advance crop growth
    // instead of burning real streaming time on repeated no-op waits.
    this.touring=false;
    this.tourDone=true;
    return goHome();
  }
}
export const mockDecision=(s:GameState)=>new Autopilot().decide(s);
export function validateAgainstWorld(a:Action,s:GameState):boolean {
  const here={x:s.x,y:s.y};
  if(a.type==="wait")return true;
  if(s.paused)return false;
  if(a.type==="sleep")return s.location==="FarmHouse"&&s.bed!==null;
  if(a.type==="travel_to")return s.exits.some(e=>e.target===a.target);
  if(a.type==="move_to")return a.x>=0&&a.y>=0&&a.x<150&&a.y<150;
  if(a.type==="equip_tool")return Boolean(s.economy && (a.tool==="hoe"?s.economy.tools.hoe:s.economy.tools.wateringCan));
  if(a.type==="refill_watering_can")return Boolean(s.economy?.tools.wateringCan && s.waterSources?.some(t=>t.x===a.x&&t.y===a.y) && close(here,a));
  if(a.type==="buy_seed"){
    const shop=s.economy?.shop;
    return s.location==="SeedShop"&&Boolean(shop?.open&&shop.offers.some(o=>o.id===a.itemId&&o.price*a.count<=s.economy!.gold&&(o.stock<0||o.stock>=a.count))&&close(here,shop.keeper));
  }
  if(a.type==="ship_item"){
    const e=s.economy;
    return s.location==="Farm"&&Boolean(e?.shippingBin&&close(here,e.shippingBin)&&e.bag.some(i=>i.id===a.itemId&&i.sellable));
  }
  if(a.type==="store_item"||a.type==="withdraw_item"){
    const e=s.economy; const chest=e?.chests.find(c=>c.x===a.x&&c.y===a.y);
    return Boolean(chest&&close(here,chest)&&(a.type==="store_item"?e!.bag:chest.items).some(i=>i.id===a.itemId&&i.count>=a.count));
  }
  if(s.location!=="Farm"||!close(here,a))return false;
  if(a.type==="water_tile")return s.crops.some(c=>c.x===a.x&&c.y===a.y&&!c.watered);
  if(a.type==="harvest_crop")return s.inventoryFree>0&&s.crops.some(c=>c.x===a.x&&c.y===a.y&&c.ready);
  if(a.type==="plant_seed")return s.seeds.some(seed=>seed.id===a.seedId&&seed.count>0)&&s.emptyPlots.some(c=>c.x===a.x&&c.y===a.y);
  if(a.type==="till_tile")return s.tillable.some(t=>t.x===a.x&&t.y===a.y);
  return false;
}
