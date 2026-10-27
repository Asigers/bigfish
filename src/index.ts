import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { GameBridge, CommandOutcomeUnknownError } from "./bridge.ts";
import { Autopilot, validateAgainstWorld } from "./decision.ts";
import { PiBrain } from "./brain.ts";
import { EconomyPlanner, DEFAULT_STRATEGY } from "./economy.ts";
import { ForagePlanner } from "./forage.ts";
import { FarmResourcePlanner } from "./resources.ts";
import { FoodPlanner } from "./food.ts";
import { DropPlanner } from "./drops.ts";
import { InfrastructurePlanner } from "./infrastructure.ts";
import {reconcileSprinkler,SprinklerPlanner} from "./sprinklers.ts";
import { GoalMemory } from "./strategy.ts";
import { recordSpeech } from "./avatar.ts";
import { startSimulator } from "./simulator.ts";
import { actionObserved } from "./action-confirmation.ts";
import { buildFarmPlan } from "./farm-plan.ts";
import {mergeFarmMap,routeCorridors} from "./farm-map.ts";
import { updateWorkProject, nextWorkTask } from "./farm-work.ts";
import {FarmHistory} from "./history.ts";
import {cropInvestments,irrigationInvestment} from "./investment.ts";
import {campaignNeedsRenewal,defaultCampaign,gameOrdinal,
  reconcileCampaign,nextCampaignTask,campaignComplete} from "./campaign.ts";
import type { Action, ActionResult, Decision, GameState } from "./types.ts";

const demo=process.argv.includes("--demo");
const mock=demo||process.argv.includes("--mock");
const token=process.env.BIGFISH_TOKEN||(demo?randomBytes(24).toString("hex"):"");
const port=Number(process.env.BIGFISH_PORT||"45931");
const bridge=new GameBridge(token,port,"127.0.0.1",demo?undefined:join(process.cwd(),"data","bridge-commands.json"));
const brain=mock?undefined:new PiBrain();
const planner=new Autopilot();
const economy=new EconomyPlanner();
const forager=new ForagePlanner();
const resourcePlanner=new FarmResourcePlanner();
const foodPlanner=new FoodPlanner();
const dropPlanner=new DropPlanner();
const infrastructure=new InfrastructurePlanner();
const sprinklerPlanner=new SprinklerPlanner();
const memory=new GoalMemory();
// Simulator/mock runs must not contaminate production acceptance evidence.
const history=new FarmHistory(mock?
  join(process.cwd(),"data","bigfish-history.mock.sqlite"):
  join(process.cwd(),"data","bigfish-history.sqlite"));
let brainSessionSave:string|undefined;
let lastInvestmentReport="";
const recent:ActionResult[]=[];
const pendingViewerEvents: import("./types.ts").ViewerEvent[]=[];
let nextDialogueAt=0;
let stopping=false;
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
let stopDemo:(()=>void)|undefined;
type Unconfirmed={
  action:Exclude<Action,{type:"wait"}>;before:GameState;sequence:number;
  lastWarningAt:number;since:number;commandId?:string;
};
let unconfirmed:Unconfirmed|undefined;
let lastDisconnectedWarningAt=0;
function requiredTool(state:GameState,action:Action):Action|undefined{
  const tools=state.economy?.tools;
  if(!tools)return;
  if(action.type==="water_tile"||action.type==="refill_watering_can"){
    if(!tools.wateringCan)return {type:"wait",seconds:8};
    if(tools.equipped!=="watering_can")return {type:"equip_tool",tool:"watering_can"};
    if(action.type==="water_tile"&&tools.waterLeft<=0)return {type:"wait",seconds:5};
  }
  if(action.type==="till_tile"){
    if(!tools.hoe)return {type:"wait",seconds:8};
    if(tools.equipped!=="hoe")return {type:"equip_tool",tool:"hoe"};
  }
  if(action.type==="clear_resource"){
    const tool=action.kind==="stone"?"pickaxe":action.kind==="weed"?"scythe":"axe";
    if(tools[tool]!==true)return {type:"wait",seconds:8};
    if(tools.equipped!==tool)return {type:"equip_tool",tool};
  }
}
async function say(text:string,action:Action,goal:string,ok=true):Promise<void>{
  const spoken=recordSpeech(text,action,goal,ok);
  if(spoken)bridge.publishAvatar(spoken);
}
async function run():Promise<void>{
  await memory.load();
  await bridge.start();
  const restored=bridge.getUncertain();
  if(restored){
    unconfirmed={action:restored.cmd,before:restored.before,
      sequence:bridge.getStateSequence(),lastWarningAt:Date.now(),
      since:Date.now(),commandId:restored.cmd.id};
    console.warn("[bigfish] persisted game command requires reconciliation before new actions");
  }
  console.log("[bigfish] 127.0.0.1:"+port+" | mode="+(demo?"demo":mock?"mock":"pi")+
    " | OBS avatar: http://127.0.0.1:"+port+"/overlay");
  if(demo)stopDemo=startSimulator(port,token);
  if(brain)await brain.start();
  process.on("SIGINT",()=>{stopping=true;});
  process.on("SIGTERM",()=>{stopping=true;});
  while(!stopping){
    const s=bridge.getState();
    if(!s){
      if(Date.now()-lastDisconnectedWarningAt>=15000){
        lastDisconnectedWarningAt=Date.now();
        console.warn("[bigfish] no fresh SMAPI snapshot;",
          "state sync disconnected",unconfirmed?"with unresolved "+unconfirmed.action.type:"");
      }
      await sleep(300);continue;
    }
    // The in-memory Pi conversation also belongs to a save: avoid carrying
    // strategy/context from another player's loaded Stardew farm.
    if(brain){
      if(brainSessionSave && brainSessionSave!==s.saveId){
        brain.stop();await brain.start();
        recent.length=0;pendingViewerEvents.length=0;
        console.log("[bigfish] new save, model conversation reset");
      }
      brainSessionSave=s.saveId;
    }
    if(unconfirmed){
      const pending=unconfirmed;
      const uncertain=bridge.getUncertain();
      const failedReceipt=uncertain && pending.commandId &&
        uncertain.cmd.id===pending.commandId && uncertain.lateResult?.ok===false
        ? uncertain.lateResult : undefined;
      if(failedReceipt && pending.commandId){
        bridge.settleUncertain(pending.commandId,"failed-result");
        planner.observe(pending.before,[failedReceipt],pending.action);
        economy.update(pending.before,pending.action,false);
        forager.observe(pending.before,pending.action,failedReceipt);
        resourcePlanner.observe(pending.before,pending.action,failedReceipt);
        foodPlanner.observe(pending.before,pending.action,failedReceipt);
        dropPlanner.observe(pending.before,pending.action,failedReceipt);
        infrastructure.observe(pending.before,pending.action,failedReceipt);
        sprinklerPlanner.observe(pending.before,pending.action,failedReceipt);
        await memory.recordFarmResult(pending.before,pending.action,failedReceipt);
        history.recordVerifiedAction(pending.before,s,pending.action,failedReceipt.id,false);
        recent.push(failedReceipt);if(recent.length>8)recent.shift();
        console.warn("[game] late failure receipt reconciled:",failedReceipt.message);
        unconfirmed=undefined;
      }else if(bridge.getStateSequence()>pending.sequence &&
        actionObserved(pending.action,pending.before,s)){
        if(pending.commandId && uncertain?.cmd.id===pending.commandId)
          bridge.settleUncertain(pending.commandId,"observed");
        // A command whose result was lost still consumed the day's action budget.
        if(pending.action.type==="clear_resource")
          resourcePlanner.observe(pending.before,pending.action,{
            id:pending.commandId??"state-confirmed",ok:true,message:"state-confirmed"});
        if(pending.action.type==="eat_food")
          foodPlanner.observe(pending.before,pending.action,{
            id:pending.commandId??"state-confirmed",ok:true,message:"state-confirmed"});
        if(pending.action.type==="pickup_drop")
          dropPlanner.observe(pending.before,pending.action,{
            id:pending.commandId??"state-confirmed",ok:true,message:"state-confirmed"});
        if(pending.action.type==="craft_chest"||pending.action.type==="place_chest")
          infrastructure.observe(pending.before,pending.action,{
            id:pending.commandId??"state-confirmed",ok:true,message:"state-confirmed"});
        await memory.recordFarmResult(pending.before,pending.action,{
          id:pending.commandId??"state-confirmed",ok:true,message:"state-confirmed"});
        history.recordVerifiedAction(pending.before,s,pending.action,
          pending.commandId??"state-confirmed",true);
        console.log("[game] state confirmed after delayed sync:",pending.action.type,s.location);
        unconfirmed=undefined;
      }else{
        if(Date.now()-pending.lastWarningAt>=15000){
          pending.lastWarningAt=Date.now();
          const urgent=Date.now()-pending.since>=45000;
          console.warn(urgent?"[game] MANUAL ATTENTION REQUIRED: unresolved action":
            "[game] reconciling action; no new commands:",
            pending.action.type,"at "+s.location,"day="+s.day,
            "receipt="+(uncertain?.lateResult?.ok===true?"success":uncertain?.lateResult?.ok===false?"failure":"pending"));
        }
        await sleep(700);
        continue;
      }
    }
    const events=bridge.drainEvents();
    pendingViewerEvents.push(...events);
    if(pendingViewerEvents.length>30)pendingViewerEvents.splice(0,pendingViewerEvents.length-30);
    let action:Action|undefined;
    let result:ActionResult|undefined;
    let stateConfirmed=false;
    try {
      if(memory.needsPlanning(s)){
        let plan=memory.get()?.saveId===s.saveId?memory.get()!.strategy:DEFAULT_STRATEGY;
        if(brain) {
          try{
            const outcomes=memory.get()?.saveId===s.saveId?
              memory.get()?.farmOutcomes??[]:[];
            plan=await brain.planStrategy(s,[
              ...(memory.get()?.saveId===s.saveId?memory.get()?.entries??[]:[]),
              ...outcomes.slice(-3).map(o=>
                "Observed farm outcome: "+JSON.stringify(o)),
              ...(memory.get()?.saveId===s.saveId && memory.get()?.workProject?
                ["Observed unfinished farm tasks: "+JSON.stringify(
                  memory.get()!.workProject!.tasks.map(t=>({
                    id:t.id,status:t.status,progress:t.progress,required:t.required,
                    dependsOn:t.dependsOn
                  })))] : [])
            ]);
          }
          catch(error){console.warn("[strategy] fallback",error instanceof Error?error.message:String(error));}
        }
        await memory.startDay(s,plan);
        const archived=memory.get()?.farmOutcomes?.at(-1);
        if(archived && archived.dayKey!==s.season+":"+s.day &&
          gameOrdinal(s)>0)
          history.recordCompletedDay(s.saveId,gameOrdinal(s)-1,archived);
        await say("新的一天，本鲸的目标是："+plan.notes,{type:"wait",seconds:1},plan.goal);
      }
      let goal=memory.get()?.strategy??DEFAULT_STRATEGY;
      if(s.location==="Farm"&&s.economy){
        const former=memory.get()?.workProject;
        const project=updateWorkProject(s,former);
        if(project){
          await memory.setWorkProject(s,project);
          if(!former || former.evaluatedOn!==project.evaluatedOn ||
            JSON.stringify(former.tasks)!==JSON.stringify(project.tasks)){
            console.log("[farm-work]",JSON.stringify({
              objective:project.objective,day:project.evaluatedOn,
              cashReserve:project.cashReserve,materials:project.materialTargets,
              nextTask:nextWorkTask(project)?.id??"awaiting supported skills",
              tasks:project.tasks.map(t=>({id:t.id,status:t.status,progress:t.progress,required:t.required}))
            }));
          }
        }
      }
      let project=memory.get()?.workProject;
      // Merge only authoritative patches, scoped to the active save. Unobserved
      // cells are never filled with assumptions or reusable foreign-save terrain.
      if(s.location==="Farm" && s.surveyTiles?.length){
        const previous=memory.get()?.farmMap;
        const surveyed=mergeFarmMap(s,previous);
        if(surveyed){
          await memory.setFarmMap(s,surveyed);
          if(!previous||surveyed.tiles.length>=previous.tiles.length+40)
            console.log("[farm-map]",JSON.stringify({
              observedTiles:surveyed.tiles.length,
              currentPatch:s.surveyTiles.length,
              verifiedRouteTiles:routeCorridors(s,surveyed).length
            }));
        }
      }
      const farmMap=memory.get()?.farmMap;
      if(s.location==="Farm" && campaignNeedsRenewal(s,memory.get()?.campaign)){
        const observed=history.metrics(s.saveId,gameOrdinal(s),14);
        let campaignProposal=defaultCampaign(s,observed);
        if(brain){
          try{
            campaignProposal=await brain.proposeCampaign(s,[
              "Last 14 days of observed work: "+JSON.stringify(observed),
              "Observed economic alternatives (unknown costs stay null): "+
                JSON.stringify(cropInvestments(s,observed).slice(0,3)),
              ...(memory.get()?.farmOutcomes??[]).slice(-3)
                .map(o=>"Prior farm day: "+JSON.stringify(o))
            ]);
          }catch(error){console.warn("[campaign] safe default",
            error instanceof Error?error.message:String(error));}
        }
        const compiled=reconcileCampaign(s,campaignProposal,undefined,
          memory.get()?.farmPlan,memory.get()?.workProject,memory.get()?.sprinklerProject);
        await memory.setCampaign(s,compiled);
        console.log("[campaign] new",JSON.stringify({
          goals:compiled.proposal.goals,horizonDays:compiled.proposal.horizonDays,
          targetPlots:compiled.proposal.targetPlots,cashFloor:compiled.proposal.cashFloor}));
      }
      const activeCampaign=memory.get()?.campaign;
      if(activeCampaign?.saveId===s.saveId){
        const proposal=activeCampaign.proposal;
        goal={...goal,
          seedReserve:proposal.goals.includes("expand_fields")?
            Math.max(goal.seedReserve,proposal.targetPlots):goal.seedReserve,
          goal:proposal.goals.includes("expand_fields")?"expand":goal.goal};
      }
      if(s.location==="Farm" && s.cropCatalog?.length &&
        (!memory.get()?.farmPlan ||
          memory.get()?.farmPlan?.dayKey!==s.season+":"+s.day)){
        const oldOutcomes=memory.get()?.farmOutcomes??[];
        const built=buildFarmPlan(s,goal,oldOutcomes.at(-1),undefined,farmMap);
        if(built){
          await memory.setFarmPlan(s,built);
          console.log("[farm-plan]",JSON.stringify({
            day:built.dayKey,targetPlots:built.targetPlots,preferredSeedId:built.preferredSeedId,
            topCrops:built.crops.slice(0,3),revision:built.revision,
            protectedTiles:built.protectedTiles.length,
            sprinklerIdeas:built.sprinklerIdeas?.slice(0,3).map(i=>({
              kind:i.kind,x:i.x,y:i.y,coveredPlots:i.coveredPlots
            }))??[]
          }));
        }
      }
      await memory.observeFarmOccupancy(s);
      const field=memory.get()?.farmPlan;
      if(s.location==="Farm"){
        const former=memory.get()?.sprinklerProject;
        const goal=reconcileSprinkler(s,field,former);
        if(goal){
          await memory.setSprinklerProject(s,goal);
          if(!former||former.status!==goal.status||former.verifiedWatered!==goal.verifiedWatered)
            console.log("[sprinkler]",JSON.stringify({
              kind:goal.kind,site:goal.site,coverage:goal.expectedCoverage,
              status:goal.status,ingredients:goal.ingredients,
              verifiedWatered:goal.verifiedWatered??0
            }));
        }
      }
      if(s.location==="Farm" && activeCampaign?.saveId===s.saveId){
        const proposal=activeCampaign.proposal;
        const bounded=updateWorkProject(s,project,{
          cashReserve:proposal.cashFloor,
          collectWood:proposal.goals.includes("build_storage")
        });
        if(bounded){await memory.setWorkProject(s,bounded);project=bounded;}
        const reconciled=reconcileCampaign(s,proposal,activeCampaign,field,
          project,memory.get()?.sprinklerProject);
        await memory.setCampaign(s,reconciled);
        if(JSON.stringify(activeCampaign.tasks)!==JSON.stringify(reconciled.tasks))
          console.log("[campaign] progress",JSON.stringify({
            nextTask:nextCampaignTask(reconciled)?.id??"blocked or complete",
            complete:campaignComplete(reconciled),
            tasks:reconciled.tasks.map(t=>({id:t.id,status:t.status,current:t.current,required:t.required}))
          }));
      }
      if(s.location==="Farm" && lastInvestmentReport!==s.saveId+":"+gameOrdinal(s)){
        const measured=history.metrics(s.saveId,gameOrdinal(s),14);
        const irrigationROI=irrigationInvestment(s,measured,field,
          memory.get()?.sprinklerProject);
        console.log("[farm-economy]",JSON.stringify({
          daysObserved:measured.recordedDays,cashChange:measured.netGoldChange,
          verifiedFailureRate:measured.observedFailureRate,
          energyPerWater:measured.meanWaterEnergy,
          cropAlternatives:cropInvestments(s,measured).slice(0,3).map(c=>({
            seedId:c.seedId,seedCost:c.seedCost,estimatedMargin:c.margin,
            waterEnergy:c.waterEnergy
          })),
          irrigationLaborSavings:irrigationROI?.estimatedEnergySavedPerDryDay??null,
          irrigationGoldPayback:irrigationROI?.paybackDays??null
        }));
        lastInvestmentReport=s.saveId+":"+gameOrdinal(s);
      }
      // Deterministic safety/execution policy owns game actions. Pi supplies day-level strategy,
      // optional same-type action candidates and a voiced character.
      const foodNeed=foodPlanner.propose(s);
      const economic=foodNeed?undefined:economy.propose(s,goal,field,project);
      let d:Decision=foodNeed??economic??planner.decide(s,field);
      let forageChosen=Boolean(foodNeed);
      // Productive gathering begins only after farming and financial errands have
      // no action; once started, the trip continues across maps until bounded.
      const canBeginForage=!economic && s.location==="Farm" &&
        d.action.type==="travel_to" && d.action.target==="FarmHouse" &&
        s.time<2000 && s.energy>45;
      // A dependency-complete native chest project takes priority over further
      // material destruction when ordinary farm and economy work is exhausted.
      const construction=canBeginForage && !forager.isActive ?
        infrastructure.propose(s,project,field) : undefined;
      if(construction){d=construction;forageChosen=true;}
      const irrigation=canBeginForage && !forager.isActive && !construction ?
        sprinklerPlanner.propose(s,memory.get()?.sprinklerProject):undefined;
      if(irrigation){d=irrigation;forageChosen=true;}
      // Real drop recovery precedes further resource destruction and map touring.
      const dropDecision=!economic && !construction && !irrigation && (canBeginForage||forager.isActive) ?
        dropPlanner.propose(s) : undefined;
      if(dropDecision){d=dropDecision;forageChosen=true;}
      // Work on immediate, measured materials before setting out for longer foraging.
      const resourceDecision=canBeginForage && !forager.isActive && !dropDecision && !construction && !irrigation ?
        resourcePlanner.propose(s,true,project) : undefined;
      if(resourceDecision){d=resourceDecision;forageChosen=true;}
      if(!economic && !construction && !irrigation && !dropDecision && !resourceDecision && (forager.isActive || canBeginForage)){
        const forageDecision=forager.propose(s,canBeginForage);
        if(forageDecision){d=forageDecision;forageChosen=true;}
      }
      const toolAction=requiredTool(s,d.action);
      if(toolAction)d={action:toolAction,reason:"Prepare correct real game tool",speech:"先拿好工具。"};
      if(brain && (Date.now()>=nextDialogueAt || d.action.type==="sleep" || d.action.type==="buy_seed")){
        nextDialogueAt=Date.now()+18000;
        try{
          const proposed=await brain.decide(s,recent,pendingViewerEvents);
          pendingViewerEvents.length=0;
          // Pi sets the daily strategy and narrates the action; the field planner
          // and world executor own exact tiles, item IDs and route choices.
          // An equally-typed model action may still target the wrong plot or warp.
          if(proposed.speech)d={...d,speech:proposed.speech};
        }catch(error){console.warn("[brain] using safe plan:",error instanceof Error?error.message:String(error));}
      }
      // The model can take many seconds; never issue a decision based on a different
      // day, map, player tile or pause state than the latest snapshot.
      const latest=bridge.getState();
      if(!latest || latest.saveId!==s.saveId || latest.day!==s.day ||
          latest.season!==s.season || latest.location!==s.location ||
          latest.x!==s.x || latest.y!==s.y || latest.paused!==s.paused){
        console.warn("[bigfish] game state changed during decision; re-planning");
        await sleep(250);continue;
      }
      if(!validateAgainstWorld(d.action,latest)){
        // World facts are authoritative; do not issue a command after an invalid model plan.
        console.warn("[bigfish] action rejected by world validator",d.action);
        await sleep(1300);continue;
      }
      action=d.action;
      console.log("[bigfish]",JSON.stringify({day:s.day,time:s.time,energy:s.energy,location:s.location,goal:goal.goal,action,reason:d.reason}));
      await say(d.speech,action,goal.notes);
      if(action.type==="wait"){await sleep(action.seconds*1000);continue;}
      const timeout=action.type==="sleep"?95000:action.type==="travel_to"?25000:action.type==="eat_food"||action.type==="pickup_drop"?25000:15000;
      const before=bridge.getStateSequence();
      result=await bridge.send(action,timeout);
      console.log("[game]",result.ok?"ok":"failed",result.message);
      // An action result is independent of the following state heartbeat.
      // Never re-label a successful game command as failed just because /state is late.
      if(result.ok){
        try{
          await bridge.waitForNextState(before,6000,
            observed=>actionObserved(action!,s,observed));
          stateConfirmed=true;
        }catch{
          unconfirmed={action,before:s,sequence:before,lastWarningAt:Date.now(),since:Date.now()};
          console.warn("[game] command acknowledged, but resulting state is not confirmed;",
            "pausing commands until game state catches up",action.type);
        }
      }
      recent.push(result);if(recent.length>8)recent.shift();
      if(["buy_seed","ship_item","store_item","withdraw_item","sleep","harvest_crop","craft_chest","place_chest","craft_sprinkler","place_sprinkler"].includes(action.type))
        await memory.note(action.type+": "+result.message,result.ok);
      if(!result.ok)await say("哎呀，刚才失败了："+result.message,{type:"wait",seconds:1},goal.notes,false);
      await sleep(result.ok?200:1200);
    }catch(error){
      if(error instanceof CommandOutcomeUnknownError && action && action.type!=="wait"){
        unconfirmed={action,before:s,sequence:bridge.getStateSequence(),
          lastWarningAt:Date.now(),since:Date.now(),commandId:error.commandId};
        console.error("[game] command timeout without reliable result; "+
          "holding further actions until state/result reconciles",error.message);
        action=undefined;result=undefined;
      }else{
        result={id:"local-failure",ok:false,
          message:error instanceof Error?error.message:String(error)};
        console.error("[bigfish]",result.message);
      }
      await sleep(2300);
    }finally{
      if(result&&action){
        planner.observe(s,[result],action);
        economy.update(s,action,result.ok);
        forager.observe(s,action,result);
        resourcePlanner.observe(s,action,result);
        foodPlanner.observe(s,action,result);
        dropPlanner.observe(s,action,result);
        infrastructure.observe(s,action,result);
        sprinklerPlanner.observe(s,action,result);
        if(result.id!=="local-failure" && (!result.ok||stateConfirmed)){
          await memory.recordFarmResult(s,action,result);
          history.recordVerifiedAction(s,bridge.getState()??s,action,result.id,result.ok);
        }
      }
    }
  }
}
try{await run();}
catch(error){console.error("[bigfish] startup failed:",error);process.exitCode=1;}
finally{stopDemo?.();brain?.stop();history.close();await bridge.stop();}
