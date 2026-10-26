import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { GameBridge } from "../src/bridge.ts";
import { emotionFor } from "../src/avatar.ts";
test("OBS overlay is locally served without exposing authentication token and accepts SSE speech",async()=>{
  const token=randomBytes(24).toString("hex");
  const bridge=new GameBridge(token,0);await bridge.start();
  const controller=new AbortController();
  try{
    const base="http://127.0.0.1:"+bridge.listeningPort();
    const html=await(await fetch(base+"/overlay")).text();
    assert.match(html,/data-emotion/);
    assert.match(html,/id="avatar"/);
    assert.ok(!html.includes(token));
    const response=await fetch(base+"/overlay/events",{signal:controller.signal});
    assert.equal(response.headers.get("content-type")?.startsWith("text/event-stream"),true);
    const reader=response.body!.getReader();
    bridge.publishAvatar({type:"speech",emotion:"happy",goal:"种植",text:"本鲸今天大丰收",at:Date.now()});
    const first=await reader.read();
    let received=new TextDecoder().decode(first.value);
    if(!received.includes("大丰收"))received+=new TextDecoder().decode((await reader.read()).value);
    assert.match(received,/event: speech/);
    assert.match(received,/大丰收/);
  }finally{controller.abort();await bridge.stop();}
});
test("game actions have distinct avatar expressions",()=>{
  assert.equal(emotionFor({type:"harvest_crop",x:2,y:3}),"excited");
  assert.equal(emotionFor({type:"sleep"}),"tired");
  assert.equal(emotionFor({type:"wait",seconds:3},false),"sad");
});
