import assert from "node:assert/strict";
import test from "node:test";
import { GameBridge } from "../src/bridge.ts";
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
    await assert.rejects(bridge.send({type:"sleep"},25),/timed out/);
    const {command}=await (await fetch(base+"/next",{headers})).json() as {command:null};
    assert.equal(command,null);
  }finally{await bridge.stop();}
});
