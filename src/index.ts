import { randomBytes } from "node:crypto";
import { GameBridge } from "./bridge.ts";
import { Autopilot, validateAgainstWorld } from "./decision.ts";
import { PiBrain } from "./brain.ts";
import { EconomyPlanner, DEFAULT_STRATEGY } from "./economy.ts";
import { GoalMemory } from "./strategy.ts";
import { recordSpeech } from "./avatar.ts";
import { startSimulator } from "./simulator.ts";
import { actionObserved } from "./action-confirmation.ts";
import type { Action, ActionResult, Decision, GameState } from "./types.ts";

const demo=process.argv.includes("--demo");
const mock=demo||process.argv.includes("--mock");
const token=process.env.BIGFISH_TOKEN||(demo?randomBytes(24).toString("hex"):"");
const port=Number(process.env.BIGFISH_PORT||"45931");
const bridge=new GameBridge(token,port);
const brain=mock?undefined:new PiBrain();
const planner=new Autopilot();
const economy=new EconomyPlanner();
const memory=new GoalMemory();
const recent:ActionResult[]=[];
const pendingViewerEvents: import("./types.ts").ViewerEvent[]=[];
let nextDialogueAt=0;
let stopping=false;
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
let stopDemo:(()=>void)|undefined;
type Unconfirmed={action:Action;before:GameState;sequence:number;lastWarningAt:number};
let unconfirmed:Unconfirmed|undefined;
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
  console.log("[bigfish] 127.0.0.1:"+port+" | mode="+(demo?"demo":mock?"mock":"pi")+
    " | OBS avatar: http://127.0.0.1:"+port+"/overlay");
  if(demo)stopDemo=startSimulator(port,token);
  if(brain)await brain.start();
  process.on("SIGINT",()=>{stopping=true;});
  process.on("SIGTERM",()=>{stopping=true;});
  while(!stopping){
    const s=bridge.getState();
    if(!s){await sleep(300);continue;}
    if(unconfirmed){
      const pending=unconfirmed;
      if(bridge.getStateSequence()>pending.sequence &&
        actionObserved(pending.action,pending.before,s)){
        console.log("[game] state confirmed after delayed sync:",pending.action.type,s.location);
        unconfirmed=undefined;
      }else{
        if(Date.now()-pending.lastWarningAt>15000){
          pending.lastWarningAt=Date.now();
          console.warn("[game] waiting for state confirmation before issuing another command:",
            pending.action.type,"observed location="+s.location,"day="+s.day);
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
      let d:Decision=economy.propose(s,goal)??planner.decide(s);
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
          if(!economyTransaction.includes(d.action.type) &&
              proposed.action.type===d.action.type&&validateAgainstWorld(proposed.action,s) &&
              // A same-type LLM suggestion must not replace a planned itinerary hop.
              (d.action.type!=="travel_to" ||
                (proposed.action.type==="travel_to"&&proposed.action.target===d.action.target)))
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
      console.log("[bigfish]",JSON.stringify({day:s.day,time:s.time,energy:Math.round(s.energy),location:s.location,goal:goal.goal,action,reason:d.reason}));
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
          unconfirmed={action,before:s,sequence:before,lastWarningAt:Date.now()};
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
      result={id:"local-failure",ok:false,message:error instanceof Error?error.message:String(error)};
      console.error("[bigfish]",result.message);
      await sleep(2300);
    }finally{
      if(result&&action){
        planner.observe(s,[result],action);
        economy.update(s,action,result.ok);
      }
    }
  }
}
try{await run();}
catch(error){console.error("[bigfish] startup failed:",error);process.exitCode=1;}
finally{stopDemo?.();brain?.stop();await bridge.stop();}
