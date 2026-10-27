import type {GameState} from "./types.ts";
import type {FarmPlan} from "./farm-plan.ts";
import type {FarmWorkProject} from "./farm-work.ts";
import type {SprinklerProject} from "./sprinklers.ts";

export type FarmGoal="expand_fields"|"build_storage"|"automate_watering"|"save_gold";
export type CampaignProposal={
  goals:FarmGoal[]; horizonDays:number; targetPlots:number; cashFloor:number; rationale:string;
};
export type TaskStatus="done"|"ready"|"blocked";
export type CampaignTask={
  id:string; goal:FarmGoal; dependsOn:string[]; status:TaskStatus;
  current:number; required:number; evidence:string;
};
export type FarmCampaign={
  saveId:string; startedOrdinal:number; endsOrdinal:number; proposal:CampaignProposal;
  updatedOrdinal:number; tasks:CampaignTask[]; revision:number;
};
const validGoal=(v:unknown):v is FarmGoal=>
  ["expand_fields","build_storage","automate_watering","save_gold"].includes(v as string);
export function validProposal(x:unknown):x is CampaignProposal{
  if(!x||typeof x!=="object")return false;
  const p=x as CampaignProposal;
  return Array.isArray(p.goals)&&p.goals.length>=1&&p.goals.length<=3&&
    p.goals.every(validGoal)&&new Set(p.goals).size===p.goals.length&&
    Number.isInteger(p.horizonDays)&&p.horizonDays>=3&&p.horizonDays<=7&&
    Number.isInteger(p.targetPlots)&&p.targetPlots>=1&&p.targetPlots<=20&&
    Number.isInteger(p.cashFloor)&&p.cashFloor>=100&&p.cashFloor<=5000&&
    typeof p.rationale==="string"&&p.rationale.length>0&&p.rationale.length<=200;
}
export function parseCampaign(raw:string):CampaignProposal{
  const value:unknown=JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,""));
  if(!validProposal(value))throw Error("Invalid bounded multi-day campaign");
  return value;
}
const seasons=["spring","summer","fall","winter"];
export function gameOrdinal(s:Pick<GameState,"year"|"season"|"day">):number{
  const season=seasons.indexOf(s.season.toLowerCase());
  if(season<0||!Number.isInteger(s.day)||s.day<1||s.day>28)throw Error("Unsupported game calendar");
  return ((s.year??1)-1)*112+season*28+s.day-1;
}
export function defaultCampaign(s:GameState):CampaignProposal{
  const available=s.economy?.gold??0;
  const plots=s.crops.length+s.emptyPlots.length;
  return {
    goals:available>=400?["expand_fields","automate_watering"]:["expand_fields","save_gold"],
    horizonDays:5,targetPlots:Math.max(2,Math.min(12,plots+3)),
    cashFloor:available>=400?150:100,
    rationale:"Conservative cash-protected farming with verified materials"
  };
}
function task(id:string,goal:FarmGoal,dependsOn:string[],current:number,required:number,
  executable:boolean,evidence:string):CampaignTask{
  return {id,goal,dependsOn,current:Math.max(0,Math.trunc(current)),
    required:Math.max(0,Math.trunc(required)),
    status:current>=required?"done":executable?"ready":"blocked",evidence};
}
function bagAndChest(s:GameState,id:string):number{
  return (s.economy?.bag??[]).filter(x=>x.id===id).reduce((sum,x)=>sum+x.count,0)+
    (s.economy?.chests??[]).flatMap(c=>c.items).filter(x=>x.id===id)
      .reduce((sum,x)=>sum+x.count,0);
}
export function validCampaign(value:unknown):value is FarmCampaign{
  if(!value||typeof value!=="object")return false;
  const v=value as FarmCampaign;
  if(typeof v.saveId!=="string"||!v.saveId||v.saveId.length>=120||
    !validProposal(v.proposal)||!Number.isInteger(v.startedOrdinal)||
    !Number.isInteger(v.endsOrdinal)||v.endsOrdinal-v.startedOrdinal!==v.proposal.horizonDays-1||
    !Number.isInteger(v.updatedOrdinal)||!Number.isInteger(v.revision)||
    v.revision<0||v.revision>1000||!Array.isArray(v.tasks)||v.tasks.length>12)return false;
  const seen=new Set<string>();
  for(const t of v.tasks){
    if(!t||typeof t.id!=="string"||!t.id||t.id.length>60||seen.has(t.id)||
      !validGoal(t.goal)||!v.proposal.goals.includes(t.goal)||!Array.isArray(t.dependsOn)||
      t.dependsOn.length>4||!t.dependsOn.every(d=>typeof d==="string"&&d!==t.id)||
      !["done","ready","blocked"].includes(t.status)||
      !Number.isInteger(t.current)||!Number.isInteger(t.required)||
      t.current<0||t.current>1e8||t.required<0||t.required>1e8||
      typeof t.evidence!=="string"||t.evidence.length>200)return false;
    seen.add(t.id);
  }
  // No dependency can refer to an unknown node; no cyclic plan can be persisted.
  const visiting=new Set<string>(),visited=new Set<string>();
  const nodes=new Map(v.tasks.map(t=>[t.id,t]));
  const check=(id:string):boolean=>{
    if(visiting.has(id))return false;
    if(visited.has(id))return true;
    const t=nodes.get(id);if(!t)return false;
    visiting.add(id);
    if(!t.dependsOn.every(check))return false;
    visiting.delete(id);visited.add(id);return true;
  };
  return [...nodes.keys()].every(check);
}
export function campaignNeedsRenewal(s:GameState,c?:FarmCampaign):boolean{
  return !c||c.saveId!==s.saveId||!validCampaign(c)||
    gameOrdinal(s)>c.endsOrdinal;
}
export function reconcileCampaign(s:GameState,proposal:CampaignProposal,
  prior?:FarmCampaign,field?:FarmPlan,work?:FarmWorkProject,
  sprinkler?:SprinklerProject):FarmCampaign{
  if(!validProposal(proposal))throw Error("Unapproved campaign proposal");
  const ordinal=gameOrdinal(s);
  if(prior && (!validCampaign(prior)||prior.saveId!==s.saveId))prior=undefined;
  if(prior && JSON.stringify(prior.proposal)!==JSON.stringify(proposal))prior=undefined;
  const tasks:CampaignTask[]=[];
  const append=(t:CampaignTask)=>{tasks.push(t);};
  for(const goal of proposal.goals){
    if(goal==="save_gold"){
      const gold=s.economy?.gold??0;
      append(task("cash_reserve",goal,[],gold,proposal.cashFloor,
        s.location==="Farm"&&Boolean(s.economy?.shippingBin),
        "Cash comes from real sales and morning shipping settlement"));
    }
    if(goal==="expand_fields"){
      const planted=s.location==="Farm"?s.crops.length:
        field?.occupiedPlots??0;
      const fieldCount=s.location==="Farm"?
        s.crops.length+s.emptyPlots.length:field?.fieldTiles.length??0;
      append(task("prepare_fields",goal,[],fieldCount,proposal.targetPlots,
        s.location==="Farm"&&s.tillable.length>0,
        "Only observed tillable soil can be prepared"));
      append(task("plant_fields",goal,["prepare_fields"],planted,proposal.targetPlots,
        s.location==="Farm"&&s.seeds.some(x=>x.count>0),
        "Planted crop count is verified on Farm"));
    }
    if(goal==="build_storage"){
      const existing=(s.location==="Farm"?s.economy?.chests.length:undefined)??0;
      const kit=s.chestKits??0;
      const wood=bagAndChest(s,"(O)388");
      append(task("gather_chest_wood",goal,[],existing||kit?50:wood,50,
        s.location==="Farm" && (s.resources?.some(x=>x.kind==="twig"||x.kind==="tree")??false),
        "50 real wood, player backpack and owned chests"));
      append(task("craft_storage",goal,["gather_chest_wood"],existing||kit?1:0,1,
        s.canCraftChest===true,"Native learned Chest recipe, no synthetic kit"));
      append(task("place_storage",goal,["craft_storage"],existing?1:0,1,
        kit>0&&(s.placementSites?.length??0)>0,"Verified player-owned chest placed on Farm"));
    }
    if(goal==="automate_watering"){
      const needed=sprinkler?.ingredients??[];
      const hasInputs=needed.length>0 && needed.every(i=>bagAndChest(s,i.id)>=i.count);
      const kit=(s.sprinklerKits?.find(k=>k.kind===sprinkler?.kind)?.count??0)>0;
      const installed=sprinkler?.status==="installed"||sprinkler?.status==="watering_verified";
      const planned=!!sprinkler;
      append(task("survey_irrigation",goal,[],planned?1:0,1,
        s.location==="Farm"&&!!field?.sprinklerIdeas?.length,
        "Only observed sprinkler footprints qualify"));
      append(task("reserve_irrigation_inputs",goal,["survey_irrigation"],
        hasInputs||kit||installed?1:0,1,false,
        "Actual recipe ingredients from bag/chests; unsupported mining blocks work"));
      append(task("craft_irrigation",goal,["reserve_irrigation_inputs"],
        kit||installed?1:0,1,sprinkler?.status==="ready_to_craft",
        "Native recipe only when unlocked and affordable"));
      append(task("install_irrigation",goal,["craft_irrigation"],
        installed?1:0,1,sprinkler?.status==="ready_to_place",
        "Native object placed and verified on farm"));
      append(task("verify_irrigation",goal,["install_irrigation"],
        sprinkler?.status==="watering_verified"?1:0,1,false,
        "Dry next morning must observe irrigated crop"));
    }
  }
  // Enforce dependency status even if an action is technically available.
  for(const t of tasks){
    if(t.status==="ready"&&t.dependsOn.some(id=>
      tasks.find(dep=>dep.id===id)?.status!=="done"))t.status="blocked";
  }
  const candidate:FarmCampaign={
    saveId:s.saveId,proposal,startedOrdinal:prior?.startedOrdinal??ordinal,
    endsOrdinal:prior?.endsOrdinal??ordinal+proposal.horizonDays-1,
    updatedOrdinal:ordinal,tasks,revision:prior?.revision??0
  };
  if(!validCampaign(candidate))throw Error("Failed campaign DAG validation");
  return candidate;
}
export function nextCampaignTask(c:FarmCampaign):CampaignTask|undefined{
  return c.tasks.find(t=>t.status==="ready"&&t.dependsOn.every(dep=>
    c.tasks.find(p=>p.id===dep)?.status==="done"));
}
export function campaignComplete(c:FarmCampaign):boolean{
  return c.tasks.length>0&&c.tasks.every(t=>t.status==="done");
}
