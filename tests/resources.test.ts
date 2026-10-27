import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { FarmResourcePlanner } from "../src/resources.ts";
import { actionObserved } from "../src/action-confirmation.ts";
import { validateAgainstWorld,parseDecision } from "../src/decision.ts";
import { GameBridge } from "../src/bridge.ts";
import { startSimulator } from "../src/simulator.ts";
import type { GameState,Action } from "../src/types.ts";

const tools={hoe:true,wateringCan:true,axe:true,pickaxe:true,scythe:true,
  equipped:"axe",waterLeft:40};
const economy={gold:200,bag:[],chests:[],shippingBin:null,shop:null,tools};
const base:GameState={
  saveId:"materials",location:"Farm",day:2,season:"spring",time:1000,
  energy:180,x:4,y:4,paused:false,crops:[],emptyPlots:[],tillable:[],seeds:[],
  resources:[{x:5,y:5,kind:"twig",health:1},{x:9,y:9,kind:"tree",health:10}],
  exits:[],worldLinks:[],bed:null,inventoryFree:10,economy
};
test("planner chooses observed safe farm material and never destroys unseen targets",()=>{
  const p=new FarmResourcePlanner();
  const d=p.propose(base,true);
  assert.deepEqual(d?.action,{type:"clear_resource",kind:"twig",x:5,y:5});
  assert.equal(validateAgainstWorld(d!.action,base),true);
  assert.equal(validateAgainstWorld(d!.action,{...base,resources:[]}),false);
  assert.equal(validateAgainstWorld(d!.action,{...base,location:"Forest"}),false);
  assert.deepEqual(parseDecision('{"action":{"type":"clear_resource","kind":"twig","x":5,"y":5}}').action,d?.action);
});
test("resource hits require authoritative durability reduction or disappearance",()=>{
  const a:Action={type:"clear_resource",kind:"tree",x:9,y:9};
  const smaller={...base,resources:base.resources?.map(n=>
    n.kind==="tree"?{...n,health:9}:n)};
  assert.equal(actionObserved(a,base,base),false);
  assert.equal(actionObserved(a,base,smaller),true);
  assert.equal(actionObserved(a,base,{...base,resources:base.resources?.filter(n=>n.kind!=="tree")}),true);
  assert.equal(actionObserved(a,base,{...base,resources:undefined}),false);
  assert.equal(actionObserved(a,base,{...smaller,saveId:"another"}),false);
});
test("daily material budget, energy and inventory limits are enforced",()=>{
  const s={...base,resources:[{x:5,y:5,kind:"twig" as const,health:1}]};
  const p=new FarmResourcePlanner();
  assert.equal(p.propose({...s,energy:50},true),undefined);
  assert.equal(p.propose({...s,inventoryFree:0},true),undefined);
  assert.equal(p.propose({...s,time:2000},true),undefined);
  assert.equal(p.propose({...s,resources:undefined},true),undefined);
  assert.equal(p.propose({...s,economy:{...economy,tools:{...tools,axe:false}}},true),undefined);
  for(let i=0;i<14;i++){
    const action:Action={type:"clear_resource",x:5,y:5,kind:"twig"};
    p.observe(s,action,{id:String(i),ok:true,message:"hit"});
  }
  assert.equal(p.propose(s,true),undefined);
  assert.equal(p.propose({...s,day:3},true)?.action.type,"clear_resource");
});
test("resource goals include chest stock, so storage does not trigger redundant clearing",()=>{
  const chest={x:5,y:4,items:[
    {id:"(O)388",count:60,category:-16,sellable:false},
    {id:"(O)390",count:40,category:-300,sellable:false},
    {id:"(O)771",count:20,category:-16,sellable:false}
  ]};
  const stored:GameState={...base,economy:{...base.economy!,chests:[chest]}};
  assert.equal(new FarmResourcePlanner().propose(stored,true),undefined);
});
test("blocked approach candidates and failed tools are not spammed",()=>{
  const target={...base,resources:[{x:9,y:9,kind:"stone" as const,health:2}]};
  const p=new FarmResourcePlanner();
  const first=p.propose(target,true)?.action;
  assert.equal(first?.type,"move_to");
  p.observe(target,first,{id:"1",ok:false,message:"no path"});
  p.observe(target,first,{id:"2",ok:false,message:"no path"});
  assert.notDeepEqual(p.propose(target,true)?.action,first);
  const tool:Action={type:"equip_tool",tool:"pickaxe"};
  p.observe(target,tool,{id:"3",ok:false,message:"tool missing"});
  p.observe(target,tool,{id:"4",ok:false,message:"tool missing"});
  assert.equal(p.propose(target,true),undefined);
});
test("simulated farm resource can be hit with a real tool and material enters bag",{
  timeout:12000
},async()=>{
  const token=randomBytes(24).toString("hex");
  const bridge=new GameBridge(token,0);await bridge.start();
  const stop=startSimulator(bridge.listeningPort(),token);
  try{
    let s:GameState|undefined;
    const deadline=Date.now()+5000;
    while(!s&&Date.now()<deadline){
      const current=bridge.getState();
      if(current?.resources?.some(n=>n.x===7&&n.y===7))s=current;
      else await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(s);
    const equip=await bridge.send({type:"equip_tool",tool:"axe"},4000);
    assert.equal(equip.ok,true);
    const moved=await bridge.send({type:"move_to",x:6,y:6},4000);
    assert.equal(moved.ok,true);
    const before=bridge.getState();
    assert.ok(before);
    assert.equal(before?.resources?.find(n=>n.x===7&&n.y===7)?.health,1);
    const seq=bridge.getStateSequence();
    const action:Action={type:"clear_resource",x:7,y:7,kind:"twig"};
    const result=await bridge.send(action,4000);
    assert.equal(result.ok,true,result.message);
    const after=await bridge.waitForNextState(seq,4000,next=>actionObserved(action,before!,next));
    assert.equal(after.resources?.some(n=>n.x===7&&n.y===7),false);
    assert.ok(after.economy?.bag.some(i=>i.id==="(O)388"&&i.count>0));
  }finally{stop();await bridge.stop();}
});
