import { randomBytes } from "node:crypto";
import { GameBridge } from "./bridge.ts";
import { Autopilot, validateAgainstWorld } from "./decision.ts";
import { PiBrain } from "./brain.ts";
import { startSimulator } from "./simulator.ts";
import type { Action, ActionResult, Decision } from "./types.ts";

const demo=process.argv.includes("--demo");
const mock=demo||process.argv.includes("--mock");
const token=process.env.BIGFISH_TOKEN||(demo?randomBytes(24).toString("hex"):"");
const port=Number(process.env.BIGFISH_PORT||"45931");
const bridge=new GameBridge(token,port);
const brain=mock?undefined:new PiBrain();
const planner=new Autopilot();
const recent:ActionResult[]=[];
let stopping=false;
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
let stopDemo:(()=>void)|undefined;

async function run():Promise<void> {
  await bridge.start();
  console.log("[bigfish] listening 127.0.0.1:"+port+" mode="+(demo?"demo":mock?"mock":"pi"));
  if(demo)stopDemo=startSimulator(port,token);
  if(brain)await brain.start();
  process.on("SIGINT",()=>{stopping=true;});
  process.on("SIGTERM",()=>{stopping=true;});
  while(!stopping){
    const state=bridge.getState();
    if(!state){await sleep(300);continue;}
    const events=bridge.drainEvents();
    let action:Action|undefined;
    let result:ActionResult|undefined;
    try {
      let d:Decision=planner.decide(state);
      // The rule-driven baseline guarantees the farm-day cycle even if model output is malformed.
      // Pi retains voice/personality and may propose an alternative WORLD-VALID action.
      if(brain){
        try{
          const proposed=await brain.decide(state,recent,events);
          // Do not let free-form model output override the farm-day phase with endless waits or detours.
          if(validateAgainstWorld(proposed.action,state) && proposed.action.type===d.action.type)d=proposed;
          else d={...d,speech:proposed.speech || d.speech};
        }catch(error){
          console.warn("[bigfish] Pi response rejected, using deterministic planner",error instanceof Error?error.message:error);
        }
      }
      if(!validateAgainstWorld(d.action,state)){
        d=planner.decide(state);
        if(!validateAgainstWorld(d.action,state))throw Error("Planner returned invalid action");
      }
      action=d.action;
      console.log("[bigfish]",d.speech,"|",d.reason,JSON.stringify(action));
      if(action.type==="wait")await sleep(action.seconds*1000);
      else{
        const timeout=action.type==="sleep"?95000:action.type==="travel_to"?25000:15000;
        result=await bridge.send(action,timeout);
        recent.push(result);
        if(recent.length>8)recent.shift();
        console.log("[game]",result.ok?"ok":"failed",result.message);
        await sleep(result.ok?300:1800);
      }
    }catch(error){
      result={id:"local-failure",ok:false,message:error instanceof Error?error.message:String(error)};
      console.error("[bigfish]",result.message);
      await sleep(2500);
    }finally{
      if(result&&action)planner.observe(state,[result],action);
    }
  }
}
try{await run();}
catch(error){console.error("[bigfish] startup failed:",error);process.exitCode=1;}
finally{stopDemo?.();brain?.stop();await bridge.stop();}
