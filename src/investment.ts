import type {GameState} from "./types.ts";
import type {HistoricalMetrics} from "./history.ts";
import type {FarmPlan} from "./farm-plan.ts";
import type {SprinklerProject} from "./sprinklers.ts";
import {cropEstimate} from "./farm-plan.ts";

export type CropInvestment={
  seedId:string;grossRevenue:number;seedCost:number|null;
  margin:number|null;dailyMargin:number|null;
  remainingSeasonDays:number;waterEnergy:number;
  uncertainty:string[];
};
const daysUntilEnd=(s:GameState)=>Math.max(0,29-s.day);
const energyPerWater=(history:HistoricalMetrics)=>history.verifiedWaterActions>0?
  history.meanWaterEnergy:2;
/** Evaluates only observable base-price cashflows; actual margin needs known shop price. */
export function cropInvestments(s:GameState,history:HistoricalMetrics):CropInvestment[]{
  const prices=new Map(s.economy?.shop?.offers.map(o=>[o.id,o.price])??[]);
  return (s.cropCatalog??[]).filter(c=>c.seasons.includes(s.season.toLowerCase())&&
    !c.raised&&c.growthDays>0&&c.growthDays<=daysUntilEnd(s))
    .map(c=>{
      const p=prices.get(c.seedId)??null;
      const outcome=cropEstimate(s,c,p);
      const days=daysUntilEnd(s);
      const wateredDays=c.needsWatering?days:0;
      return {seedId:c.seedId,grossRevenue:outcome.baseRevenue,
        seedCost:p,margin:outcome.estimatedMargin,
        dailyMargin:p===null?null:Math.round(100*outcome.estimatedMargin!/Math.max(1,days))/100,
        remainingSeasonDays:days,
        waterEnergy:Math.round(wateredDays*energyPerWater(history)*100)/100,
        uncertainty:[
          ...(p===null?["Unknown current purchase price"]:[]),
          "Baseline sale value ignores quality, fertilizer, luck and market modifiers",
          "Energy forecast omits tool upgrades, rain and sprinkler coverage"
        ]};
    }).sort((a,b)=>{
      if(a.dailyMargin!==null&&b.dailyMargin!==null)
        return b.dailyMargin-a.dailyMargin||a.waterEnergy-b.waterEnergy;
      if(a.dailyMargin!==null)return -1;
      if(b.dailyMargin!==null)return 1;
      return b.grossRevenue-a.grossRevenue;
    }).slice(0,20);
}
export type IrrigationInvestment={
  site:{x:number;y:number};estimatedEnergySavedPerDryDay:number;
  buildCostGold:null;paybackDays:null;ready:boolean;
  note:string;
};
/** No invented gold ROI when bar prices/production labor are unobserved. */
export function irrigationInvestment(s:GameState,history:HistoricalMetrics,
  plan?:FarmPlan,project?:SprinklerProject):IrrigationInvestment|undefined{
  if(!plan?.sprinklerIdeas?.length&&!project)return;
  const candidate=project?.site??plan?.sprinklerIdeas?.[0];
  if(!candidate)return;
  const covered=project?.expectedCoverage??plan!.sprinklerIdeas![0].coveredPlots;
  return {site:{x:candidate.x,y:candidate.y},
    estimatedEnergySavedPerDryDay:Math.round(covered*energyPerWater(history)*100)/100,
    buildCostGold:null,paybackDays:null,
    ready:project?.status==="ready_to_craft"||project?.status==="ready_to_place"||
      project?.status==="installed"||project?.status==="watering_verified",
    note:"Energy benefit uses measured or fallback watering energy. Gold payback unknown until native input acquisition costs are observed."};
}
