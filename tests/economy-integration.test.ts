import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { GameBridge } from "../src/bridge.ts";
import { startSimulator } from "../src/simulator.ts";
import { Autopilot, validateAgainstWorld } from "../src/decision.ts";
import { EconomyPlanner, DEFAULT_STRATEGY } from "../src/economy.ts";

test("autonomous economic cycle buys seeds, ships produce and sleeps via game bridge", {timeout:33000}, async()=>{
  const token=randomBytes(24).toString("hex");
  const bridge=new GameBridge(token,0);await bridge.start();
  const stop=startSimulator(bridge.listeningPort(),token);
  const farm=new Autopilot(),economy=new EconomyPlanner();
  const done=new Set<string>();
  let days=0;
  try{
    const until=Date.now()+26000;
    while(Date.now()<until && !(done.has("buy_seed")&&done.has("ship_item")&&done.has("sleep"))){
      const s=bridge.getState();
      if(!s){await new Promise(r=>setTimeout(r,100));continue;}
      days=Math.max(days,s.day);
      let action=(economy.propose(s,DEFAULT_STRATEGY)??farm.decide(s)).action;
      if(s.economy&&(action.type==="water_tile"||action.type==="till_tile"||action.type==="refill_watering_can")){
        const tool=action.type==="till_tile"?"hoe":"watering_can";
        if(s.economy.tools.equipped!==tool)action={type:"equip_tool",tool};
      }
      assert.equal(validateAgainstWorld(action,s),true,JSON.stringify(action));
      if(action.type==="wait"){await new Promise(r=>setTimeout(r,100));continue;}
      const seq=bridge.getStateSequence();
      const res=await bridge.send(action,4000);
      await bridge.waitForNextState(seq,4500);
      if(!res.ok)console.error("Unexpected simulation action failure",action,res);
      assert.equal(res.ok,true,JSON.stringify(action));
      economy.update(s,action,res.ok);farm.observe(s,[res],action);
      done.add(action.type);
      await new Promise(r=>setTimeout(r,50));
    }
    for(const needed of ["buy_seed","ship_item","sleep"])
      assert.ok(done.has(needed),"Missing economy flow: "+needed+" (day "+days+")");
  }finally{stop();await bridge.stop();}
});
