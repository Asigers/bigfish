import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { GameBridge } from "../src/bridge.ts";
import { Autopilot, validateAgainstWorld } from "../src/decision.ts";
import { startSimulator } from "../src/simulator.ts";

// End-to-end through the exact HTTP protocol used by the C# bridge.
// No real game, Pi credentials, or OS automation required.
test("simulator completes farming, planting, tilling, harvesting and advances to day 3", {timeout: 30000}, async()=>{
  const token=randomBytes(32).toString("hex");
  const bridge=new GameBridge(token,0);
  await bridge.start();
  const stop=startSimulator(bridge.listeningPort(),token);
  const planner=new Autopilot();
  const types=new Set<string>();
  let maxDay=0;
  try{
    const until=Date.now()+23000;
    while(Date.now()<until && maxDay<3){
      const state=bridge.getState();
      if(!state){await new Promise(r=>setTimeout(r,100));continue;}
      maxDay=Math.max(maxDay,state.day);
      if(state.day>=3)break;
      const decision=planner.decide(state);
      if(state.economy && (decision.action.type==="water_tile"||decision.action.type==="till_tile")){
        const tool=decision.action.type==="water_tile"?"watering_can":"hoe";
        if(state.economy.tools.equipped!==tool){
          const seq=bridge.getStateSequence();
          const r=await bridge.send({type:"equip_tool",tool},4000);
          assert.equal(r.ok,true);
          await bridge.waitForNextState(seq,4000);
          continue;
        }
      }
      assert.equal(validateAgainstWorld(decision.action,state),true,JSON.stringify(decision.action));
      if(decision.action.type==="wait"){await new Promise(r=>setTimeout(r,100));continue;}
      types.add(decision.action.type);
      const result=await bridge.send(decision.action,4000);
      await bridge.waitForNextState(bridge.getStateSequence(),4000);
      planner.observe(state,[result],decision.action);
      assert.equal(result.ok,true,result.message+" for "+JSON.stringify(decision.action));
      await new Promise(r=>setTimeout(r,90));
    }
    assert.ok(maxDay>=3,"Game did not advance to third day");
    for(const type of ["plant_seed","till_tile","water_tile","harvest_crop","travel_to","sleep"])
      assert.ok(types.has(type),"Missing executed action "+type);
  }finally{stop();await bridge.stop();}
});
