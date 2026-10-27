import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { GameBridge, CommandOutcomeUnknownError } from "./bridge.ts";
import { Autopilot, validateAgainstWorld } from "./decision.ts";
import { PiBrain } from "./brain.ts";
import { EconomyPlanner, DEFAULT_STRATEGY } from "./economy.ts";
import { ForagePlanner } from "./forage.ts";
import { GoalMemory } from "./strategy.ts";
import { recordSpeech } from "./avatar.ts";
import { startSimulator } from "./simulator.ts";
import { actionObserved } from "./action-confirmation.ts";
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
const memory=new GoalMemory();
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
        recent.push(failedReceipt);if(recent.length>8)recent.shift();
        console.warn("[game] late failure receipt reconciled:",failedReceipt.message);
        unconfirmed=undefined;
      }else if(bridge.getStateSequence()>pending.sequence &&
        actionObserved(pending.action,pending.before,s)){
        if(pending.commandId && uncertain?.cmd.id===pending.commandId)
          bridge.settleUncertain(pending.commandId,"observed");
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
    try {
      if(memory.needsPlanning(s)){
        let plan=memory.get()?.saveId===s.saveId?memory.get()!.strategy:DEFAULT_STRATEGY;
        if(brain) {
          try{plan=await brain.planStrategy(s,memory.get()?.entries??[]);}
          catch(error){console.warn("[strategy] fallback",error instanceof Error?error.message:String(error));}
        }
        await memory.startDay(s,plan);
        await say("新的一天，本鲸的目标是："+plan.notes,{type:"wait",seconds:1},plan.goal);
      }
      const goal=memory.get()?.strategy??DEFAULT_STRATEGY;
      // Deterministic safety/execution policy owns game actions. Pi supplies day-level strategy,
      // optional same-type action candidates and a voiced character.
      const economic=economy.propose(s,goal);
      let d:Decision=economic??planner.decide(s);
      let forageChosen=false;
      // Productive gathering begins only after farming and financial errands have
      // no action; once started, the trip continues across maps until bounded.
      const canBeginForage=!economic && s.location==="Farm" &&
        d.action.type==="travel_to" && d.action.target==="FarmHouse" &&
        s.time<2000 && s.energy>45;
      if(!economic && (forager.isActive || canBeginForage)){
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
          const economyTransaction=["buy_seed","ship_item","store_item","withdraw_item","equip_tool","refill_watering_can"];
          // Valid world action is not enough for money/inventory policy: the deterministic
          // decision also enforces seed budgets and preservation of essential supplies.
          if(!forageChosen && !economyTransaction.includes(d.action.type) &&
              proposed.action.type===d.action.type&&validateAgainstWorld(proposed.action,s))
            d=proposed;
          else if(proposed.speech) d={...d,speech:proposed.speech};
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
      console.log("[bigfish]",JSON.stringify({day:s.day,location:s.location,goal:goal.goal,action,reason:d.reason}));
      await say(d.speech,action,goal.notes);
      if(action.type==="wait"){await sleep(action.seconds*1000);continue;}
      const timeout=action.type==="sleep"?95000:action.type==="travel_to"?25000:15000;
      const before=bridge.getStateSequence();
      result=await bridge.send(action,timeout);
      console.log("[game]",result.ok?"ok":"failed",result.message);
      // An action result is independent of the following state heartbeat.
      // Never re-label a successful game command as failed just because /state is late.
      if(result.ok){
        try{
          await bridge.waitForNextState(before,6000,
            observed=>actionObserved(action!,s,observed));
        }catch{
          unconfirmed={action,before:s,sequence:before,lastWarningAt:Date.now(),since:Date.now()};
          console.warn("[game] command acknowledged, but resulting state is not confirmed;",
            "pausing commands until game state catches up",action.type);
        }
      }
      recent.push(result);if(recent.length>8)recent.shift();
      if(["buy_seed","ship_item","store_item","withdraw_item","sleep","harvest_crop"].includes(action.type))
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
      }
    }
  }
}
try{await run();}
catch(error){console.error("[bigfish] startup failed:",error);process.exitCode=1;}
finally{stopDemo?.();brain?.stop();await bridge.stop();}
