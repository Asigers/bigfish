import assert from "node:assert/strict";
import test from "node:test";
import { GameBridge } from "../src/bridge.ts";
import type { GameState } from "../src/types.ts";

const token = "0123456789abcdef0123456789abcdef";
const headers = {"content-type":"application/json","x-bigfish-token":token};
const state:GameState = {
  saveId:"test",location:"Farm",day:1,season:"spring",time:610,
  energy:200,x:2,y:2,paused:false,crops:[{x:4,y:2,watered:false}]
};

test("bridge authenticates, dispatches one command and resolves result",async()=>{
  const bridge = new GameBridge(token,0);
  await bridge.start();
  try{
    const base = "http://127.0.0.1:"+bridge.listeningPort();
    const unauthorized = await fetch(base+"/next");
    assert.equal(unauthorized.status,401);

    const posted = await fetch(base+"/state",{method:"POST",headers,body:JSON.stringify(state)});
    assert.equal(posted.status,200);
    assert.equal(bridge.getState()?.saveId,"test");

    const completion = bridge.send({type:"move_to",x:3,y:2},2000);
    await assert.rejects(bridge.send({type:"move_to",x:4,y:2}),/already pending/);
    const command = await (await fetch(base+"/next",{headers})).json() as {command:{id:string;type:string;x:number;y:number}};
    assert.equal(command.command.type,"move_to");
    assert.equal(command.command.x,3);

    const resultResponse = await fetch(base+"/result",{
      method:"POST",headers,body:JSON.stringify({id:command.command.id,ok:true,message:"arrived"})
    });
    assert.equal(resultResponse.status,200);
    assert.equal((await completion).message,"arrived");

    const repeated = await fetch(base+"/result",{
      method:"POST",headers,body:JSON.stringify({id:command.command.id,ok:true,message:"again"})
    });
    assert.equal(repeated.status,409);
    const next = await (await fetch(base+"/next",{headers})).json() as {command:null};
    assert.equal(next.command,null);

    const eventResponse = await fetch(base+"/event",{
      method:"POST",headers,body:JSON.stringify({kind:"chat",user:"viewer",text:"water crops"})
    });
    assert.equal(eventResponse.status,200);
    assert.equal(bridge.drainEvents()[0]?.text,"water crops");
    assert.equal(bridge.drainEvents().length,0);
  } finally {await bridge.stop();}
});

test("bridge rejects malformed world state and handles timed-out commands",async()=>{
  const bridge=new GameBridge(token,0);
  await bridge.start();
  try{
    const base="http://127.0.0.1:"+bridge.listeningPort();
    const bad=await fetch(base+"/state",{method:"POST",headers,body:JSON.stringify({...state,crops:[{x:"no",y:0,watered:false}]})});
    assert.equal(bad.status,400);
    assert.equal(bridge.getState(),undefined);
    await fetch(base+"/state",{method:"POST",headers,body:JSON.stringify(state)});
    await assert.rejects(bridge.send({type:"move_to",x:3,y:2},30),/timed out/);
    const next=await (await fetch(base+"/next",{headers})).json() as {command:null};
    assert.equal(next.command,null);
  } finally {await bridge.stop();}
});
