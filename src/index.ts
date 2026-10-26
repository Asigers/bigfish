import { randomBytes } from "node:crypto";
import { GameBridge } from "./bridge.ts";
import { mockDecision } from "./decision.ts";
import { PiBrain } from "./brain.ts";
import { startSimulator } from "./simulator.ts";
import type { ActionResult } from "./types.ts";

const demo=process.argv.includes("--demo");
const mock=demo || process.argv.includes("--mock");
const token=process.env.BIGFISH_TOKEN || (demo ? randomBytes(24).toString("hex") : "");
const port=Number(process.env.BIGFISH_PORT || "45931");
const bridge=new GameBridge(token,port);
const brain=mock ? undefined : new PiBrain();
const recent:ActionResult[]=[];
let stopping=false;
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
let stopDemo:(()=>void)|undefined;

async function run():Promise<void> {
  await bridge.start();
  console.log("[bigfish] bridge http://127.0.0.1:"+port+"  mode="+(demo?"demo":mock?"mock":"pi"));
  if(demo)stopDemo=startSimulator(port,token);
  if(brain)await brain.start();
  process.on("SIGINT",()=>{stopping=true;});
  process.on("SIGTERM",()=>{stopping=true;});
  while(!stopping) {
    const state=bridge.getState();
    if(!state){await sleep(300);continue;}
    const events=bridge.drainEvents();
    try {
      const decision=brain ? await brain.decide(state,recent,events) : mockDecision(state);
      console.log("[bigfish]",decision.speech,"|",decision.reason,JSON.stringify(decision.action));
      if(decision.action.type==="wait") await sleep(decision.action.seconds*1000);
      else {
        const result=await bridge.send(decision.action);
        recent.push(result);
        if(recent.length>8)recent.shift();
        console.log("[game]",result.ok?"ok":"error",result.message);
        await sleep(result.ok?500:2500);
      }
    } catch(error) {
      console.error("[bigfish] step failed:",error);
      await sleep(3000);
    }
  }
}
try { await run(); }
catch(error){console.error("[bigfish] startup failed",error);process.exitCode=1;}
finally {stopDemo?.();brain?.stop();await bridge.stop();}
