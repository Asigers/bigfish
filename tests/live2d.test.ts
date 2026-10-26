import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { GameBridge } from "../src/bridge.ts";
import { allowedAsset, resolvedAsset, hasInstalledModel } from "../src/overlay-assets.ts";

const mockTree=[
  {type:"blob",path:"assets/model/c_0120.model3.json",sha:"a".repeat(40),size:10},
  {type:"blob",path:"assets/model/c_0120.moc3",sha:"b".repeat(40),size:11},
  {type:"blob",path:"assets/model/manifest.json",sha:"c".repeat(40),size:12},
  {type:"blob",path:"assets/vendor/pixi.min.js",sha:"d".repeat(40),size:13},
  {type:"blob",path:"assets/vendor/cubism4.min.js",sha:"e".repeat(40),size:14},
  {type:"blob",path:"assets/vendor/live2dcubismcore.min.js",sha:"f".repeat(40),size:15},
  {type:"blob",path:"assets/model/expressions/开心兴奋.exp3.json",sha:"b".repeat(40),size:16},
  {type:"blob",path:"assets/README.md",sha:"a".repeat(40),size:10},
  {type:"blob",path:"assets/vendor/extraneous.js",sha:"a".repeat(40),size:10},
];
test("asset installer selects only supported model and pinned runtimes",async()=>{
  // @ts-ignore: installer deliberately ships as raw Node ESM, not TypeScript.
  const { selectAssets,blobSha,safeAssetPath } = await import("../scripts/install-live2d.mjs");
  const selected=selectAssets(mockTree);
  assert.equal(selected.length,7);
  assert.ok(selected.some(x=>x.path==="model/expressions/开心兴奋.exp3.json"));
  assert.equal(safeAssetPath("model/../secrets.json"),false);
  assert.equal(safeAssetPath("vendor/other.js"),false);
  assert.equal(blobSha(Buffer.from("test")),"30d74d258442c7c65512eafab474568dd706c430c");
});
test("public overlay asset routing denies traversal and arbitrary files",async()=>{
  assert.equal(allowedAsset("model/expressions/开心兴奋.exp3.json"),true);
  assert.equal(allowedAsset("vendor/live2dcubismcore.min.js"),true);
  for(const p of ["../.env","model/../.env","model/%2e%2e/private.json","vendor/evil.js","SOURCE.json","model/../../src/brain.ts"])
    assert.equal(allowedAsset(p),false,p);
  assert.equal(resolvedAsset("../.env"),undefined);
});
test("OBS serves Live2D scripts, status and preserves SSE without credentials",async()=>{
  const token=randomBytes(24).toString("hex");
  const bridge=new GameBridge(token,0);
  await bridge.start();
  const controller=new AbortController();
  try{
    const base="http://127.0.0.1:"+bridge.listeningPort();
    const html=await(await fetch(base+"/overlay")).text();
    assert.match(html,/鲸鱼娘 Live2D/);
    assert.match(html,/\/overlay\/live2d\.js/);
    assert.ok(!html.includes(token));
    assert.ok(!html.includes('viewBox="0 0 300 240"'),"old SVG should not be present");
    const loader=await fetch(base+"/overlay/live2d.js");
    assert.equal(loader.status,200);
    const script=await loader.text();
    assert.match(script,/Live2DModel\.from/);
    assert.match(script,/expressionByEmotion/);
    const response=await fetch(base+"/overlay/assets/status");
    assert.equal(response.status,200);
    const status=await response.json() as {installed:boolean};
    assert.equal(status.installed,await hasInstalledModel());
    const invalid=await fetch(base+"/overlay/assets/model/%2e%2e/%2e%2e/.env");
    assert.notEqual(invalid.status,200);
    const stream=await fetch(base+"/overlay/events",{signal:controller.signal});
    assert.equal(stream.status,200);
    const reader=stream.body!.getReader();
    bridge.publishAvatar({type:"speech",emotion:"happy",goal:"种田",text:"今天收获不错",at:Date.now()});
    const decoder=new TextDecoder();let buffer="";
    for(let i=0;i<3&&!buffer.includes("今天收获不错");i++){
      const read=await reader.read();buffer+=decoder.decode(read.value);
    }
    assert.match(buffer,/event: speech/);
    assert.match(buffer,/今天收获不错/);
  } finally {
    controller.abort();
    await bridge.stop();
  }
});
