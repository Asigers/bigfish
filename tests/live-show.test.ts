import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {randomBytes} from "node:crypto";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ShowDirector,eligibleChallenges,chooseChallenge,validShowJournal}
  from "../src/show-director.ts";
import {NarrationScheduler} from "../src/narration.ts";
import {parseLiveSpeech,parseShowPick} from "../src/live-brain.ts";
import {EconomyPlanner,DEFAULT_STRATEGY} from "../src/economy.ts";
import {GameBridge} from "../src/bridge.ts";
import {startSimulator} from "../src/simulator.ts";
import {actionObserved} from "../src/action-confirmation.ts";
import type {GameState,Action} from "../src/types.ts";
const base:GameState={
  saveId:"live-test",year:1,season:"spring",day:6,time:840,
  location:"Farm",x:4,y:4,paused:false,energy:170,inventoryFree:8,
  crops:[{x:4,y:5,ready:false,watered:false},{x:5,y:4,ready:false,watered:false},
    {x:5,y:5,ready:true,watered:false}],
  emptyPlots:[],tillable:[{x:6,y:5},{x:7,y:5},{x:6,y:6}],
  seeds:[],resources:[{x:3,y:3,kind:"twig",health:1},
    {x:3,y:4,kind:"stone",health:1}],
  forage:[{x:2,y:5,itemId:"(O)16"}],
  exits:[{x:7,y:3,target:"BusStop"}],
  worldLinks:[{from:"Farm",to:"BusStop"},{from:"BusStop",to:"Town"},
    {from:"Town",to:"SeedShop"}],
  bed:null,
  economy:{gold:250,bag:[],chests:[],shippingBin:{x:3,y:5},shop:null,
    tools:{hoe:true,wateringCan:true,axe:true,pickaxe:true,scythe:true,
      equipped:"hoe",waterLeft:35}}
};
async function director(){
  const dir=await mkdtemp(join(tmpdir(),"bigfish-live-test-"));
  return {dir,show:new ShowDirector(join(dir,"show.json"))};
}
test("only feasible observed challenges are offered and model can pick only an offered ID",()=>{
  const choices=eligibleChallenges(base);
  assert.ok(choices.some(c=>c.id==="water_sprint"));
  assert.ok(choices.some(c=>c.id==="no_spend_expansion"));
  assert.ok(choices.some(c=>c.id==="forage_find"));
  assert.ok(!choices.some(c=>c.id==="harvest_run"));
  assert.equal(eligibleChallenges({...base,location:"Town"}).length,0);
  assert.equal(eligibleChallenges({...base,time:1500}).length,0);
  assert.equal(chooseChallenge(base,choices,"no_spend_expansion")?.id,"no_spend_expansion");
  assert.equal(chooseChallenge(base,choices,"arbitrary_action"),choices[5%choices.length]);
  assert.equal(parseShowPick('{"challengeId":"no_spend_expansion"}',choices),
    "no_spend_expansion");
  assert.equal(parseShowPick('{"challengeId":"fish_everything"}',choices),undefined);
  assert.throws(()=>parseLiveSpeech('{"speech":"x"}'));
  assert.throws(()=>parseLiveSpeech('{"speech":"<script>unsafe</script>"}'));
  assert.equal(parseLiveSpeech('{"speech":"今天要专心照顾这几株作物。"}'),
    "今天要专心照顾这几株作物。");
});
test("challenge progress requires verified, unique game actions and persists through restart",async()=>{
  const {dir,show}=await director();
  try{
    await show.sync(base);
    const candidate=eligibleChallenges(base).find(c=>c.id==="water_sprint")!;
    const e=await show.start(base,candidate);
    assert.equal(e?.kind,"start");
    assert.ok(validShowJournal(show.get()));
    assert.equal((await show.start(base,candidate)),undefined);
    const reloaded=new ShowDirector(join(dir,"show.json"));await reloaded.load();
    assert.equal(reloaded.get()?.challenge?.progress,0);
    const a:Action={type:"water_tile",x:4,y:5};
    assert.equal((await reloaded.observed(base,a,"cmd-1")).length,1);
    assert.equal(reloaded.get()?.challenge?.progress,1);
    assert.equal((await reloaded.observed(base,a,"cmd-1")).length,0);
    assert.equal((await reloaded.observed(base,a,"cmd-duplicate-tile")).length,0);
    const b:Action={type:"water_tile",x:5,y:4};
    assert.equal((await reloaded.observed(base,b,"cmd-2")).length,0);
    const c:Action={type:"water_tile",x:5,y:5};
    assert.equal((await reloaded.observed(base,c,"cmd-3"))[0]?.kind,"won");
    assert.equal(reloaded.get()?.challenge?.status,"won");
    assert.equal((await reloaded.observed(base,{type:"till_tile",x:6,y:5},"cmd-4")).length,0);
    await reloaded.sync({...base,day:7});
    assert.equal(reloaded.get()?.outcomes[0]?.status,"won");
    assert.equal(reloaded.get()?.challenge,undefined);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("zero-spend show enforces economy policy and fails on observed gold loss",async()=>{
  const {dir,show}=await director();
  try{
    await show.sync(base);
    const choice=eligibleChallenges(base).find(c=>c.id==="no_spend_expansion")!;
    await show.start(base,choice);
    assert.equal(show.allows({type:"buy_seed",itemId:"(O)472",count:2}),false);
    assert.equal(show.allows({type:"till_tile",x:6,y:5}),true);
    // Even a feasible shopping route must not start while the challenge runs.
    const farm={...base,time:920,crops:[],tillable:base.tillable,
      economy:{...base.economy!,gold:500,bag:[]},seeds:[]};
    const economic=new EconomyPlanner().propose(farm,DEFAULT_STRATEGY,undefined,
      undefined,{forbidPurchases:true});
    assert.notEqual(economic?.action.type,"travel_to");
    const failed=await show.tick({...base,economy:{...base.economy!,gold:249}});
    assert.equal(failed[0]?.kind,"lost");
    assert.equal(show.get()?.challenge?.status,"lost");
    assert.equal(show.allows({type:"buy_seed",itemId:"(O)472",count:1}),true);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("late verified actions cannot retroactively win a show",async()=>{
  const {dir,show}=await director();
  try{
    await show.sync(base);
    const option=eligibleChallenges(base).find(c=>c.id==="forage_find")!;
    await show.start(base,option);
    const received=await show.observed({...base,time:2100},
      {type:"collect_forage",x:2,y:5},"late-action");
    assert.equal(received[0]?.kind,"lost");
    assert.equal(show.get()?.challenge?.progress,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("deadline, day rollover and save switching never transfer fake progress",async()=>{
  const {dir,show}=await director();
  try{
    await show.sync(base);
    const choice=eligibleChallenges(base).find(c=>c.id==="no_spend_expansion")!;
    await show.start(base,choice);
    assert.equal((await show.tick({...base,time:2000}))[0]?.kind,"lost");
    assert.equal((await show.tick({...base,time:2100})).length,0);
    await show.sync({...base,day:7});
    assert.equal(show.get()?.outcomes.length,1);
    const fresh=await show.sync({...base,saveId:"second-save"});
    assert.deepEqual(fresh,[]);
    assert.deepEqual(show.get()?.outcomes,[]);
    assert.equal(show.get()?.challenge,undefined);
    assert.equal(validShowJournal({...show.get(),saveId:"",outcomes:[]}),false);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("narration only reports important events or grouped routine operations",()=>{
  let clock=10000;
  const scheduler=new NarrationScheduler(12000,()=>clock);
  scheduler.beginDay(base,"扩大农场");
  assert.equal(scheduler.pending(),1);
  const work:Action={type:"water_tile",x:4,y:5};
  for(let i=0;i<3;i++)scheduler.action(base,work,true,"water-"+i);
  assert.equal(scheduler.pending(),1);
  scheduler.action(base,work,true,"water-4");
  assert.equal(scheduler.pending(),2);
  scheduler.action(base,{type:"harvest_crop",x:5,y:5},true,"harvest");
  assert.equal(scheduler.pending(),3);
  scheduler.reflect({...base,time:1230},"expand");
  scheduler.reflect({...base,time:1340},"expand");
  assert.equal(scheduler.pending(),4);
  scheduler.reflect({...base,time:1730},"expand");
  assert.equal(scheduler.pending(),5);
  scheduler.reset({...base,saveId:"different"});
  assert.equal(scheduler.pending(),0);
  clock=24000;
  scheduler.close();
});
test("narrator prioritizes milestones, is nonblocking, rejects stale save output and falls back",async()=>{
  let clock=100000;
  const narrator=new NarrationScheduler(12000,()=>clock);
  narrator.beginDay(base,"发展");
  narrator.action(base,{type:"craft_chest"},true,"cmd1");
  const shown:string[]=[];
  let resolve!: (s:string)=>void;
  let called=0;
  const delayed=()=>{called++;return new Promise<string>(r=>{resolve=r;});};
  const emit=(_e:unknown,text:string)=>shown.push(text);
  narrator.pump(delayed,emit);
  narrator.pump(delayed,emit);
  await new Promise(r=>setImmediate(r));
  assert.equal(called,1);
  assert.deepEqual(shown,[]);
  resolve("已确认建好储物箱，农场能存更多东西了。");
  await new Promise(r=>setImmediate(r));
  assert.equal(shown.length,1);
  clock+=13000;
  narrator.pump(async()=>{throw Error("model offline");},emit);
  await new Promise(r=>setImmediate(r));
  assert.equal(shown.length,2);
  assert.match(shown[1],/新的一天/);
  narrator.action(base,{type:"buy_seed",itemId:"(O)472",count:1},true,"cmd2");
  clock+=13000;
  narrator.pump(async()=>new Promise<string>(r=>{resolve=r;}),emit);
  await new Promise(r=>setImmediate(r));
  narrator.reset({...base,saveId:"other"});
  resolve("这是旧存档里不该出现的解说内容。");
  await new Promise(r=>setImmediate(r));
  assert.equal(shown.length,2);
});
test("unconfirmed game commands never count as a successful show or speech",async()=>{
  const {dir,show}=await director();
  try{
    await show.sync(base);
    const challenge=eligibleChallenges(base).find(c=>c.id==="water_sprint")!;
    await show.start(base,challenge);
    const narration=new NarrationScheduler(0);
    narration.beginDay(base,"work");
    // No verified callback => neither progress nor a success moment.
    assert.equal(show.get()?.challenge?.progress,0);
    narration.action(base,{type:"water_tile",x:4,y:5},false,"negative-receipt");
    const rendered:string[]=[];
    narration.pump(async e=>e.fallback,(_e,t)=>rendered.push(t));
    await new Promise(r=>setImmediate(r));
    assert.equal(rendered.length,1);
    assert.match(rendered[0],/没成功/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("live bridge event: only a state-confirmed forage action wins and is narrated",{
  timeout:15000
},async()=>{
  const {dir,show}=await director();
  const token=randomBytes(24).toString("hex"),bridge=new GameBridge(token,0);
  await bridge.start();
  const stop=startSimulator(bridge.listeningPort(),token);
  try{
    let initial:GameState|undefined;
    const deadline=Date.now()+4000;
    while(!initial&&Date.now()<deadline){
      const state=bridge.getState();
      if(state?.location==="Farm"&&state.forage?.length)initial=state;
      else await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(initial);
    await show.sync(initial);
    const option=eligibleChallenges(initial).find(c=>c.id==="forage_find");
    assert.ok(option);
    const start=await show.start(initial,option);
    assert.equal(start?.kind,"start");
    const pickup=initial.forage![0],action:Action={type:"collect_forage",
      x:pickup.x,y:pickup.y};
    assert.equal(show.get()?.challenge?.progress,0);
    const seq=bridge.getStateSequence();
    const receipt=await bridge.send(action,4000);
    assert.equal(receipt.ok,true);
    // ACK alone is not evidence and cannot trigger success.
    assert.equal(show.get()?.challenge?.status,"active");
    const after=await bridge.waitForNextState(seq,4000,
      state=>actionObserved(action,initial!,state));
    const finished=await show.observed(after,action,receipt.id);
    assert.equal(finished[0]?.kind,"won");
    const voice=new NarrationScheduler(0);
    voice.show(after,finished[0]);
    const lines:string[]=[];
    voice.pump(async moment=>moment.fallback,(_moment,text)=>lines.push(text));
    await new Promise(r=>setImmediate(r));
    assert.equal(lines.length,1);
    assert.match(lines[0],/挑战完成/);
    assert.equal(show.get()?.challenge?.progress,1);
    assert.equal((await show.observed(after,action,receipt.id)).length,0);
  }finally{stop();await bridge.stop();await rm(dir,{recursive:true,force:true});}
});
