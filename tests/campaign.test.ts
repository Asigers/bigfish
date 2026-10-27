import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {campaignComplete,campaignNeedsRenewal,defaultCampaign,gameOrdinal,
  nextCampaignTask,parseCampaign,reconcileCampaign,validCampaign} from "../src/campaign.ts";
import {GoalMemory} from "../src/strategy.ts";
import {DEFAULT_STRATEGY} from "../src/economy.ts";
import {updateWorkProject} from "../src/farm-work.ts";
import type {GameState} from "../src/types.ts";
const farm:GameState={
  saveId:"campaign-save",year:1,season:"spring",day:9,time:800,
  location:"Farm",x:4,y:4,paused:false,energy:165,inventoryFree:8,
  crops:[{x:5,y:4,watered:true,ready:false}],
  emptyPlots:[{x:5,y:5,watered:false}],
  tillable:[{x:6,y:4},{x:6,y:5}],seeds:[{id:"(O)472",count:3}],
  exits:[],worldLinks:[],bed:null,
  economy:{gold:240,bag:[{id:"(O)472",count:3,category:-74,sellable:false}],
    chests:[],shop:null,shippingBin:{x:7,y:4},
    tools:{hoe:true,wateringCan:true,equipped:"hoe",waterLeft:35}}
};
test("parse and validate a bounded multi-day model goal (not arbitrary commands)",()=>{
  const raw='{"goals":["build_storage","expand_fields"],"horizonDays":5,"targetPlots":7,"cashFloor":150,"rationale":"Storage before growth"}';
  assert.deepEqual(parseCampaign(raw).goals,["build_storage","expand_fields"]);
  assert.throws(()=>parseCampaign('{"goals":["transfer_gold"],"horizonDays":5,"targetPlots":7,"cashFloor":150,"rationale":"x"}'));
  assert.throws(()=>parseCampaign('{"goals":["expand_fields","expand_fields"],"horizonDays":5,"targetPlots":7,"cashFloor":150,"rationale":"x"}'));
  assert.throws(()=>parseCampaign('{"goals":["expand_fields"],"horizonDays":30,"targetPlots":7,"cashFloor":150,"rationale":"x"}'));
  assert.throws(()=>parseCampaign('{"goals":["save_gold"],"horizonDays":3,"targetPlots":1000,"cashFloor":150,"rationale":"x"}'));
});
test("compile goal-specific executable/blocked DAG and enforce dependencies",()=>{
  const proposal=parseCampaign('{"goals":["build_storage","expand_fields","save_gold"],"horizonDays":5,"targetPlots":4,"cashFloor":300,"rationale":"Work with reserves"}');
  const campaign=reconcileCampaign(farm,proposal);
  assert.ok(validCampaign(campaign));
  assert.equal(campaign.tasks.find(t=>t.id==="gather_chest_wood")?.status,"blocked");
  assert.equal(campaign.tasks.find(t=>t.id==="craft_storage")?.status,"blocked");
  assert.equal(campaign.tasks.find(t=>t.id==="place_storage")?.status,"blocked");
  assert.equal(campaign.tasks.find(t=>t.id==="cash_reserve")?.status,"ready");
  assert.equal(campaign.tasks.find(t=>t.id==="prepare_fields")?.status,"ready");
  assert.equal(campaignComplete(campaign),false);
  const wood:GameState={...farm,economy:{...farm.economy!,bag:[
    ...farm.economy!.bag,{id:"(O)388",count:50,category:-16,sellable:false}]},
    canCraftChest:true,resources:[{x:6,y:6,kind:"twig",health:1}]};
  const progressed=reconcileCampaign(wood,proposal,campaign);
  assert.equal(progressed.tasks.find(t=>t.id==="gather_chest_wood")?.status,"done");
  assert.equal(progressed.tasks.find(t=>t.id==="craft_storage")?.status,"ready");
  assert.equal(nextCampaignTask(progressed)?.id,"craft_storage");
  const existing={...wood,economy:{...wood.economy!,chests:[{x:3,y:3,items:[]}]}};
  const finished=reconcileCampaign(existing,proposal,progressed);
  assert.equal(finished.tasks.find(t=>t.id==="place_storage")?.status,"done");
  const forged={...campaign,tasks:campaign.tasks.map(t=>t.id==="craft_storage"?
    {...t,dependsOn:["place_storage"]}:t)};
  assert.equal(validCampaign(forged),false); // cyclic graph
});
test("three-to-seven-day campaign resumes across season boundaries and renews correctly",()=>{
  const proposal=defaultCampaign(farm);
  const a=reconcileCampaign(farm,proposal);
  assert.equal(a.endsOrdinal-a.startedOrdinal,4);
  const later={...farm,day:12};
  assert.equal(campaignNeedsRenewal(later,a),false);
  assert.equal(campaignNeedsRenewal({...farm,day:14},a),true);
  assert.equal(campaignNeedsRenewal({...farm,saveId:"changed"},a),true);
  const fall={...farm,season:"fall",day:28,year:1};
  const winter={...farm,season:"winter",day:1,year:1};
  assert.equal(gameOrdinal(winter)-gameOrdinal(fall),1);
  const endYear={...farm,season:"winter",day:28,year:1};
  const newYear={...farm,season:"spring",day:1,year:2};
  assert.equal(gameOrdinal(newYear)-gameOrdinal(endYear),1);
});
test("goal supplies spending/gathering controls instead of fixed permanent quotas",()=>{
  const proposal=parseCampaign('{"goals":["expand_fields","save_gold"],"horizonDays":4,"targetPlots":6,"cashFloor":380,"rationale":"Grow conservatively"}');
  const g=reconcileCampaign(farm,proposal);
  const work=updateWorkProject(farm,undefined,{
    cashReserve:g.proposal.cashFloor,
    collectWood:g.proposal.goals.includes("build_storage")})!;
  assert.equal(work.cashReserve,380);
  assert.equal(work.materialTargets["(O)388"],0);
  assert.equal(work.materialTargets["(O)390"],0);
});
test("campaign memory persists within a save and discards cross-save state",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"bigfish-campaign-"));
  try{
    const file=join(dir,"memory.json"),m=new GoalMemory(file);
    await m.startDay(farm,DEFAULT_STRATEGY);
    const proposal=defaultCampaign(farm);
    await m.setCampaign(farm,reconcileCampaign(farm,proposal));
    const loaded=new GoalMemory(file);await loaded.load();
    assert.ok(loaded.get()?.campaign);
    await loaded.startDay({...farm,day:10},DEFAULT_STRATEGY);
    assert.equal(loaded.get()?.campaign?.proposal.horizonDays,5);
    await loaded.startDay({...farm,saveId:"new"},DEFAULT_STRATEGY);
    assert.equal(loaded.get()?.campaign,undefined);
    await assert.rejects(loaded.setCampaign({...farm,saveId:"new"},
      reconcileCampaign(farm,proposal)),/Invalid or cross-save/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
