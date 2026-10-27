import assert from "node:assert/strict";
import test from "node:test";
import { GameBridge,CommandOutcomeUnknownError } from "../src/bridge.ts";
import type { GameState } from "../src/types.ts";
const token="0123456789abcdef0123456789abcdef";
const headers={"content-type":"application/json","x-bigfish-token":token};
const state:GameState={
  saveId:"save",location:"Farm",day:1,season:"spring",time:610,energy:200,x:4,y:4,paused:false,
  crops:[],emptyPlots:[],tillable:[],seeds:[],exits:[],worldLinks:[],bed:null,inventoryFree:10
};
test("commands include save/day/location identity and resolve ack",async()=>{
  const bridge=new GameBridge(token,0);await bridge.start();
  try{
    const base="http://127.0.0.1:"+bridge.listeningPort();
    assert.equal((await fetch(base+"/next")).status,401);
    assert.equal((await fetch(base+"/state",{method:"POST",headers,body:JSON.stringify(state)})).status,200);
    const done=bridge.send({type:"plant_seed",x:6,y:5,seedId:"(O)472"},2000);
    await assert.rejects(bridge.send({type:"sleep"}),/already pending/);
    const {command}=await (await fetch(base+"/next",{headers})).json() as {command:{id:string;saveId:string;day:number;location:string;type:string}};
    assert.equal(command.type,"plant_seed");
    assert.equal(command.saveId,"save");
    assert.equal(command.day,1);
    assert.equal(command.location,"Farm");
    assert.equal((await fetch(base+"/result",{method:"POST",headers,body:JSON.stringify({id:command.id,ok:true,message:"planted"})})).status,200);
    assert.equal((await done).message,"planted");
    assert.equal((await fetch(base+"/result",{method:"POST",headers,body:JSON.stringify({id:command.id,ok:true,message:"planted"})})).status,200);
    assert.equal((await fetch(base+"/result",{method:"POST",headers,body:JSON.stringify({id:command.id,ok:true,message:"again"})})).status,409);
    const {command:empty}=await (await fetch(base+"/next",{headers})).json() as {command:null};
    assert.equal(empty,null);
  }finally{await bridge.stop();}
});
test("bad snapshots rejected, command expires",async()=>{
  const bridge=new GameBridge(token,0);await bridge.start();
  try{
    const base="http://127.0.0.1:"+bridge.listeningPort();
    assert.equal((await fetch(base+"/state",{method:"POST",headers,body:JSON.stringify({...state,seeds:[{id:"bad",count:1}]})})).status,400);
    assert.equal((await fetch(base+"/state",{method:"POST",headers,body:JSON.stringify(state)})).status,200);
    await assert.rejects(bridge.send({type:"sleep"},25),CommandOutcomeUnknownError);
    const {command}=await (await fetch(base+"/next",{headers})).json() as {command:null};
    assert.equal(command,null);
    await assert.rejects(bridge.send({type:"sleep"}),/outcome unknown/);
  }finally{await bridge.stop();}
});


test("malformed map exits do not reject an otherwise valid snapshot",async()=>{
  const bridge=new GameBridge(token,0);await bridge.start();
  try{
    const base="http://127.0.0.1:"+bridge.listeningPort();
    const stateWithBadExit={...state,exits:[
      {x:5,y:6,target:"FarmHouse"},
      {x:-1,y:0,target:"FarmHouse"},
      {x:10,y:10,target:"invalid target"}
    ]};
    const response=await fetch(base+"/state",{method:"POST",headers,body:JSON.stringify(stateWithBadExit)});
    assert.equal(response.status,200);
    assert.deepEqual(bridge.getState()?.exits,[{x:5,y:6,target:"FarmHouse"}]);
  }finally{await bridge.stop();}
});
test("bad non-exit snapshot fields remain rejected",async()=>{
  const bridge=new GameBridge(token,0);await bridge.start();
  try{
    const base="http://127.0.0.1:"+bridge.listeningPort();
    const response=await fetch(base+"/state",{method:"POST",headers,
      body:JSON.stringify({...state,exits:[{x:-1,y:0,target:"FarmHouse"}],day:99})});
    assert.equal(response.status,400);
    const body=await response.json() as {fields:string[]};
    assert.ok(body.fields.includes("day range"));
  }finally{await bridge.stop();}
});

test("late result replays are idempotent and a timeout blocks conflicting commands",async()=>{
  const bridge=new GameBridge(token,0);await bridge.start();
  try{
    const base="http://127.0.0.1:"+bridge.listeningPort();
    const post=(url:string,body:unknown)=>fetch(base+url,{method:"POST",headers,body:JSON.stringify(body)});
    assert.equal((await post("/state",state)).status,200);
    const command=bridge.send({type:"travel_to",target:"FarmHouse"},40);
    const pulled=await (await fetch(base+"/next",{headers})).json() as {command:{id:string}};
    let timedOut:unknown;
    try{await command;}catch(e){timedOut=e;}
    assert.ok(timedOut instanceof CommandOutcomeUnknownError);
    assert.equal((timedOut as CommandOutcomeUnknownError).commandId,pulled.command.id);
    assert.equal((await (await fetch(base+"/command-status",{headers})).json() as {phase:string}).phase,"unknown");
    assert.equal((await post("/result",{id:pulled.command.id,ok:true,message:"arrived"})).status,200);
    assert.equal((await post("/result",{id:pulled.command.id,ok:true,message:"arrived"})).status,200);
    assert.equal(bridge.getUncertain()?.lateResult?.ok,true);
    await assert.rejects(bridge.send({type:"sleep"}),/outcome unknown/);
    bridge.settleUncertain(pulled.command.id,"observed");
    assert.equal((await (await fetch(base+"/command-status",{headers})).json() as {phase:string}).phase,"idle");
    const next=bridge.send({type:"sleep"},1000);
    const second=await (await fetch(base+"/next",{headers})).json() as {command:{id:string}};
    assert.equal((await post("/result",{id:second.command.id,ok:false,message:"not ready"})).status,200);
    assert.equal((await next).ok,false);
  }finally{await bridge.stop();}
});
test("authoritative late failure can be settled without claiming action success",async()=>{
  const bridge=new GameBridge(token,0);await bridge.start();
  try{
    const base="http://127.0.0.1:"+bridge.listeningPort();
    const post=(url:string,body:unknown)=>fetch(base+url,{method:"POST",headers,body:JSON.stringify(body)});
    await post("/state",{...state,paused:true,pauseReason:"menu"});
    assert.equal((await (await fetch(base+"/health")).json() as {pauseReason:string}).pauseReason,"menu");
    const sending=bridge.send({type:"sleep"},30);
    const id=bridge.getUncertain()?.cmd.id;
    await assert.rejects(sending,CommandOutcomeUnknownError);
    const pending=bridge.getUncertain();
    assert.ok(pending);
    assert.equal(id,undefined);
    await assert.rejects(Promise.resolve().then(()=>bridge.settleUncertain(pending.cmd.id,"failed-result")),
      /authoritative failed result/);
    assert.equal((await post("/result",{id:pending.cmd.id,ok:false,message:"menu active"})).status,200);
    bridge.settleUncertain(pending.cmd.id,"failed-result");
    assert.equal(bridge.getUncertain(),undefined);
  }finally{await bridge.stop();}
});
