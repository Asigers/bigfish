import assert from "node:assert/strict";
import test from "node:test";
import {randomBytes} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {GameBridge} from "../src/bridge.ts";
import {startSimulator} from "../src/simulator.ts";
import {GoalMemory} from "../src/strategy.ts";
import {FarmHistory} from "../src/history.ts";
import {DEFAULT_STRATEGY} from "../src/economy.ts";
import {campaignNeedsRenewal,defaultCampaign,gameOrdinal,reconcileCampaign} from "../src/campaign.ts";
import type {Action,GameState} from "../src/types.ts";

test("7 simulated Stardew days retain one multi-day campaign, save separate evidence and survive restart",{
  timeout:45000
},async()=>{
  const dir=await mkdtemp(join(tmpdir(),"bigfish-seven-day-"));
  const token=randomBytes(24).toString("hex");
  const bridge=new GameBridge(token,0);
  let stop:(()=>void)|undefined;
  let history:FarmHistory|undefined;
  try{
    await bridge.start();
    stop=startSimulator(bridge.listeningPort(),token);
    const file=join(dir,"goal.json");
    history=new FarmHistory(join(dir,"history.sqlite"));
    const memory=new GoalMemory(file);
    let current:GameState|undefined;
    const init=Date.now()+5000;
    while(!current&&Date.now()<init){
      const s=bridge.getState();
      if(s?.location==="Farm"&&s.day===1)current=s;
      else await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(current);
    await memory.startDay(current,DEFAULT_STRATEGY);
    let goal=reconcileCampaign(current,defaultCampaign(current));
    await memory.setCampaign(current,goal);
    const begin=goal.startedOrdinal;
    const send=async(action:Exclude<Action,{type:"wait"}>,matches:(s:GameState)=>boolean)=>{
      const seq=bridge.getStateSequence();
      const outcome=await bridge.send(action,5000);
      assert.equal(outcome.ok,true,outcome.message);
      return bridge.waitForNextState(seq,5000,matches);
    };
    for(let gameDay=1;gameDay<=7;gameDay++){
      current=bridge.getState()!;
      assert.equal(current.day,gameDay);
      assert.equal(current.location,"Farm");
      // A real, validated bridge crop action on a live farm snapshot.
      if(current.crops.some(c=>!c.watered)){
        if(current.economy?.tools.equipped!=="watering_can")
          current=await send({type:"equip_tool",tool:"watering_can"},
            s=>s.location==="Farm"&&s.economy?.tools.equipped==="watering_can");
        if(current.crops.some(c=>!c.watered)){
          const before=current,crop=current.crops.find(c=>!c.watered)!;
          current=await send({type:"water_tile",x:crop.x,y:crop.y},
            s=>s.crops.some(c=>c.x===crop.x&&c.y===crop.y&&c.watered));
          history.recordVerifiedAction(before,current,
            {type:"water_tile",x:crop.x,y:crop.y},"water-"+gameDay,true);
        }
      }
      current=await send({type:"travel_to",target:"FarmHouse"},
        s=>s.location==="FarmHouse");
      const next=await send({type:"sleep"},s=>s.day===gameDay+1);
      history.recordCompletedDay(next.saveId,gameOrdinal(next)-1,{
        dayKey:"spring:"+gameDay,targetPlots:2,openingGold:220,closingGold:next.economy!.gold,
        planted:0,watered:1,harvested:0,failed:0
      });
      const resumed=new GoalMemory(file);await resumed.load();
      await resumed.startDay(next,DEFAULT_STRATEGY);
      assert.equal(resumed.get()?.campaign?.startedOrdinal,begin);
      await memory.startDay(next,DEFAULT_STRATEGY);
      if(gameDay<7){
        current=await send({type:"travel_to",target:"Farm"},s=>s.location==="Farm");
        // Long-term objective expires exactly after its 3-7 day horizon; renew
        // from the current world state instead of extending an expired old DAG.
        if(campaignNeedsRenewal(current,goal))goal=reconcileCampaign(current,
          defaultCampaign(current));
        else goal=reconcileCampaign(current,goal.proposal,goal);
        await memory.setCampaign(current,goal);
      }
    }
    assert.equal(history.metrics("demo-save",7,7).recordedDays,7);
    const final=history.metrics("demo-save",7,7);
    assert.equal(final.failed,0);
    assert.ok(final.verifiedActions>=1);
    assert.ok(goal.startedOrdinal>=begin);
    history.close();history=undefined;
    const another=new FarmHistory(join(dir,"history.sqlite"));
    assert.equal(another.metrics("demo-save",7,7).recordedDays,7);
    assert.equal(another.metrics("different-save",7,7).recordedDays,0);
    another.close();
  }finally{
    history?.close();stop?.();await bridge.stop();await rm(dir,{recursive:true,force:true});
  }
});
