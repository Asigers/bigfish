import {existsSync} from "node:fs";
import {join} from "node:path";
import {GoalMemory} from "./strategy.ts";
import {FarmHistory} from "./history.ts";
import {validCampaign} from "./campaign.ts";

const home=process.cwd();
const journalPath=join(home,"data","bigfish-memory.json");
const sqlitePath=join(home,"data","bigfish-history.sqlite");
async function report():Promise<void>{
  if(!existsSync(journalPath)||!existsSync(sqlitePath)){
    console.error("[M2] No production farm history; run the real SMAPI controller first.");
    process.exitCode=2;return;
  }
  const memory=new GoalMemory(journalPath);await memory.load();
  const j=memory.get();
  if(!j?.saveId){console.error("[M2] No matching saved farm journal");process.exitCode=2;return;}
  const db=new FarmHistory(sqlitePath);
  try{
    const measured=db.metrics(j.saveId,undefined,7);
    const campaign=j.campaign&&validCampaign(j.campaign)?j.campaign:undefined;
    const ready=measured.recordedDays>=7&&measured.verifiedActions>=1&&
      campaign!==undefined;
    const data={
      assessment:ready?"controller_evidence_ready":"pending",
      consecutiveRealGameDaysClaimed:false,
      recordedDays:measured.recordedDays,verifiedActions:measured.verifiedActions,
      failureRate:measured.observedFailureRate,
      wateringActions:measured.verifiedWaterActions,
      measuredWaterEnergy:measured.meanWaterEnergy,
      cashChangeNotProfit:measured.netGoldChange,
      currentCampaign:campaign?{
        goals:campaign.proposal.goals,horizonDays:campaign.proposal.horizonDays,
        tasks:campaign.tasks.map(t=>({id:t.id,status:t.status}))
      }:null,
      warning:"Controller history alone cannot prove native C# compilation, continuous real play or every gameplay capability. Signoff requires separate SMAPI test-save checklist."
    };
    console.log(JSON.stringify(data,null,2));
    if(!ready)process.exitCode=2;
  }finally{db.close();}
}
await report();
