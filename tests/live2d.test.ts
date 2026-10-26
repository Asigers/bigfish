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
  assert.ok(selected.some((x:{path:string})=>x.path==="model/expressions/开心兴奋.exp3.json"));
  assert.equal(safeAssetPath("model/../secrets.json"),false);
  assert.equal(safeAssetPath("vendor/other.js"),false);
  assert.equal(blobSha(Buffer.from("test")),"30d74d258442c7c65512eafab474568dd706c430");
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
    const preview=await fetch(base+"/overlay?preview=1&zoom=1.3");
    assert.equal(preview.status,200,"Preview/zoom query URLs must be served");
    assert.match(await preview.text(),/鲸鱼娘 Live2D/);
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

test("installer retries slow/corrupt downloads, then reuses verified cache",async()=>{
  const { mkdtemp,writeFile,rm,readFile }=await import("node:fs/promises");
  const { tmpdir }=await import("node:os");
  const { join }=await import("node:path");
  // @ts-ignore: installer is intentionally plain Node ESM.
  const {downloadVerifiedAsset,blobSha,configFromEnv}=await import("../scripts/install-live2d.mjs");
  const dir=await mkdtemp(join(tmpdir(),"bigfish-live2d-"));
  const data=Buffer.from("valid live2d test asset");
  const asset={path:"model/sample.json",sha:blobSha(data),size:data.length};
  try {
    let calls=0;
    const state=await downloadVerifiedAsset(asset,dir,{
      attempts:3,delayMs:1,timeoutSeconds:30,
      downloader:async (_url:string,destination:string)=>{
        calls++;
        if(calls===1)throw Error("TimeoutError");
        if(calls===2)await writeFile(destination,"corrupt data");
        else await writeFile(destination,data);
      }
    });
    assert.equal(state,"downloaded");
    assert.equal(calls,3);
    assert.deepEqual(await readFile(join(dir,"model","sample.json")),data);
    const reuse=await downloadVerifiedAsset(asset,dir,{
      attempts:1,
      downloader:async()=>{throw Error("Cached asset must not download again");}
    });
    assert.equal(reuse,"cached");
    assert.deepEqual(configFromEnv({
      BIGFISH_DOWNLOAD_TIMEOUT:"180",BIGFISH_DOWNLOAD_RETRIES:"6",BIGFISH_DOWNLOAD_CONCURRENCY:"1"
    }),{timeoutSeconds:180,attempts:6,concurrency:1});
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("successful downloads survive a later batch failure and resume from cache",async()=>{
  const {mkdtemp,mkdir,rm,readFile,writeFile}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");
  const {join}=await import("node:path");
  // @ts-ignore: installer is intentionally plain Node ESM.
  const {prepareAssets,blobSha}=await import("../scripts/install-live2d.mjs");
  const dir=await mkdtemp(join(tmpdir(),"bigfish-resume-"));
  const a=Buffer.from("first asset");
  const b=Buffer.from("second asset");
  const assets=[
    {path:"model/a.json",sha:blobSha(a),size:a.length},
    {path:"model/b.json",sha:blobSha(b),size:b.length},
  ];
  const cacheRoot=join(dir,"cache"),outputRoot=join(dir,"installed");
  const stageRoot=join(dir,"stage");
  const files=new Map<string,Buffer>([["a.json",a],["b.json",b]]);
  try{
    await mkdir(stageRoot);
    await assert.rejects(prepareAssets(assets,{
      cacheRoot,outputRoot,stageRoot,attempts:1,concurrency:1,delayMs:1,
      downloader:async (url:string,dest:string)=>{
        if(url.includes("b.json"))throw Error("simulated network timeout");
        await writeFile(dest,files.get("a.json")!);
      }
    }),/simulated network timeout/);
    assert.deepEqual(await readFile(join(cacheRoot,"model","a.json")),a);
    const retryStage=join(dir,"retryStage");await mkdir(retryStage);
    let requestedFirst=false;
    const result=await prepareAssets(assets,{
      cacheRoot,outputRoot,stageRoot:retryStage,attempts:2,concurrency:1,delayMs:1,
      downloader:async (url:string,dest:string)=>{
        if(url.includes("a.json"))requestedFirst=true;
        await writeFile(dest,files.get(url.includes("a.json")?"a.json":"b.json")!);
      }
    });
    assert.equal(requestedFirst,false,"previously verified asset was downloaded twice");
    assert.equal(result.completed,2);
    assert.equal(result.cached,1);
    assert.deepEqual(await readFile(join(retryStage,"model","b.json")),b);
  }finally{await rm(dir,{recursive:true,force:true});}
});
