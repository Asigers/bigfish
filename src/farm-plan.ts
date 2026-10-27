import type { Action, CropInfo, Decision, GameState, Tile } from "./types.ts";
import type { Strategy } from "./economy.ts";

export type FarmDayOutcome={
  dayKey:string;targetPlots:number; openingGold:number; closingGold:number;
  planted:number;watered:number;harvested:number;failed:number;
};
export type CropEstimate={
  seedId:string; harvestId:string; growthDays:number; harvests:number;
  baseRevenue:number; observedSeedPrice:number|null;
  estimatedMargin:number|null;
};
export type FarmPlan={
  saveId:string; dayKey:string; targetPlots:number; occupiedPlots:number; fieldTiles:Tile[];
  preferredSeedId:string|null; crops:CropEstimate[];
  reason:string; revision:string; costKnown:boolean;
};
const key=(t:Tile)=>t.x+":"+t.y;
const distance=(a:Tile,b:Tile)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
const daysLeft=(s:GameState)=>29-s.day;
const relevantCrop=(s:GameState,c:CropInfo)=>c.seasons.includes(s.season.toLowerCase()) &&
  !c.raised && c.growthDays<=daysLeft(s) && c.sellPrice>0 && c.minHarvest>0;
export function cropEstimate(s:GameState,c:CropInfo,seedPrice:number|null):CropEstimate{
  const subsequent=c.regrowDays>0?Math.floor(Math.max(0,daysLeft(s)-c.growthDays)/c.regrowDays):0;
  const harvests=Math.min(30,1+subsequent);
  const baseRevenue=c.sellPrice*c.minHarvest*harvests;
  return {seedId:c.seedId,harvestId:c.harvestId,growthDays:c.growthDays,
    harvests,baseRevenue,observedSeedPrice:seedPrice,
    estimatedMargin:seedPrice===null?null:baseRevenue-seedPrice};
}
/** Select only seasonal, feasible crops; purchase costs require actual observed shop prices. */
export function rankedCrops(s:GameState):CropEstimate[]{
  const prices=new Map(s.economy?.shop?.offers.map(o=>[o.id,o.price])??[]);
  return (s.cropCatalog??[]).filter(c=>relevantCrop(s,c))
    .map(c=>cropEstimate(s,c,prices.get(c.seedId)??null))
    .sort((a,b)=>{
      const aCost=a.observedSeedPrice,bCost=b.observedSeedPrice;
      if(aCost!==null&&bCost!==null){
        const aRate=(a.estimatedMargin??0)/Math.max(1,a.growthDays);
        const bRate=(b.estimatedMargin??0)/Math.max(1,b.growthDays);
        return bRate-aRate||a.seedId.localeCompare(b.seedId);
      }
      // Never claim a net-profit advantage without observed seed costs.
      if(aCost!==null)return -1;
      if(bCost!==null)return 1;
      return b.baseRevenue/Math.max(1,b.growthDays)-
        a.baseRevenue/Math.max(1,a.growthDays)||a.seedId.localeCompare(b.seedId);
    });
}
const chosenCrop=(s:GameState,estimates:CropEstimate[]):string|null=>{
  const owned=new Set(s.seeds.filter(x=>x.count>0).map(x=>x.id));
  return estimates.find(e=>owned.has(e.seedId))?.seedId??
    estimates.find(e=>e.observedSeedPrice!==null && (e.estimatedMargin??-1)>0)?.seedId??null;
};
/** Build a small, conservative field in real observed terrain; no off-map imagined plots. */
export function buildFarmPlan(s:GameState,strategy:Strategy,
  previous?:FarmDayOutcome,prior?:FarmPlan):FarmPlan|undefined {
  if(s.location!=="Farm"||!s.economy||!s.cropCatalog?.length)return;
  const currentPlots=s.crops.length+s.emptyPlots.length;
  let target=Math.max(currentPlots,Math.min(20,strategy.seedReserve));
  let revision="Set planting target from available capital, observed land and seed reserve";
  if(previous && previous.dayKey!==s.season+":"+s.day && previous.targetPlots>0){
    const failures=previous.failed>=3;
    if(failures){
      target=Math.max(currentPlots,Math.max(1,previous.targetPlots-2));
      revision="Reduce planting target after repeated observed action failures";
    }else if(previous.planted>0 && previous.failed===0){
      target=Math.max(target,Math.min(20,previous.targetPlots+2));
      revision="Expand a little after completed, low-failure field work";
    }
  }
  // Watering 1 plot and maintaining it costs energy daily. Never plan beyond
  // the observed land pool or the energy left after a safety reserve.
  const staminaCapacity=Math.max(currentPlots,Math.floor(Math.max(0,s.energy-45)/5));
  target=Math.min(20,target,Math.max(currentPlots,staminaCapacity),currentPlots+s.tillable.length);
  const existing=[...s.crops,...s.emptyPlots].map(t=>({x:t.x,y:t.y}));
  const reserved=new Set(existing.map(key));
  const blocked=new Set([...(s.resources??[]),...(s.forage??[])].map(key));
  const preserve=[s.economy.shippingBin,...s.exits].filter((t):t is Tile=>t!==null);
  const priorSelection=new Set(prior?.saveId===s.saveId && prior.dayKey===s.season+":"+s.day?
    prior.fieldTiles.map(key):[]);
  const candidates=s.tillable.filter(t=>t.x<150&&t.y<150&&!reserved.has(key(t))&&
      !blocked.has(key(t))&&!preserve.some(p=>distance(t,p)<=1));
  const targetTiles=[...existing];
  while(targetTiles.length<target&&candidates.length){
    candidates.sort((a,b)=>{
      const anchor=targetTiles.length?Math.min(...targetTiles.map(p=>distance(a,p))):distance(a,s);
      const other=targetTiles.length?Math.min(...targetTiles.map(p=>distance(b,p))):distance(b,s);
      const aCost=anchor*3+distance(a,s)+(priorSelection.has(key(a))?-2:0);
      const bCost=other*3+distance(b,s)+(priorSelection.has(key(b))?-2:0);
      return aCost-bCost||a.y-b.y||a.x-b.x;
    });
    const next=candidates.shift()!;
    targetTiles.push(next);reserved.add(key(next));
  }
  const available=[...new Map(targetTiles.map(t=>[key(t),t])).values()].slice(0,20);
  const estimates=rankedCrops(s);
  return {saveId:s.saveId,dayKey:s.season+":"+s.day,targetPlots:available.length,
    occupiedPlots:s.crops.length,
    fieldTiles:available,preferredSeedId:chosenCrop(s,estimates),crops:estimates.slice(0,20),
    reason:strategy.goal+" on "+available.length+" observed plots, "+daysLeft(s)+" season days remain",
    revision,costKnown:estimates.some(e=>e.observedSeedPrice!==null)};
}
export function bestPurchase(s:GameState,plan:FarmPlan):{id:string;price:number}|undefined{
  if(!s.economy?.shop?.open||plan.saveId!==s.saveId||!s.cropCatalog?.length)return;
  const eligible=new Map(rankedCrops(s).filter(c=>c.observedSeedPrice!==null &&
    (c.estimatedMargin??-1)>0).map(c=>[c.seedId,c]));
  const rows=s.economy.shop.offers.filter(o=>o.price>0&&o.stock!==0&&eligible.has(o.id));
  rows.sort((a,b)=>{
    const score=(o:typeof a)=>eligible.get(o.id)!.estimatedMargin!/Math.max(1,eligible.get(o.id)!.growthDays);
    return score(b)-score(a)||a.id.localeCompare(b.id);
  });
  return rows.length?{id:rows[0].id,price:rows[0].price}:undefined;
}
/** Allow sowing only observed, seasonal, genuinely owned seeds on planned plots. */
export function plannedSeed(s:GameState,plan:FarmPlan):string|undefined{
  const eligible=new Set((s.cropCatalog??[]).filter(c=>relevantCrop(s,c)).map(c=>c.seedId));
  if(plan.preferredSeedId && eligible.has(plan.preferredSeedId) &&
      s.seeds.some(stack=>stack.id===plan.preferredSeedId&&stack.count>0))
    return plan.preferredSeedId;
  return s.seeds.find(stack=>stack.count>0&&eligible.has(stack.id))?.id;
}
export function withinPlan(plan:FarmPlan|undefined,t:Tile):boolean{
  return plan?.fieldTiles.some(p=>p.x===t.x&&p.y===t.y)??true;
}
