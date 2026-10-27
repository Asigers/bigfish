import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AvatarEvent } from "./avatar.ts";
import type { Action, ActionResult, Command, GameState, ViewerEvent } from "./types.ts";
import { validState, stateValidationIssues, sanitizeStateExits } from "./types.ts";
import { allowedAsset, resolvedAsset, assetContentType, hasInstalledModel } from "./overlay-assets.ts";
type Pending={cmd:Command;before:GameState;resolve:(r:ActionResult)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout;startedAt:number};
type Uncertain={cmd:Command;before:GameState;startedAt:number;lateResult?:ActionResult};
export class CommandOutcomeUnknownError extends Error {
  readonly commandId:string;
  readonly commandType:Command["type"];
  constructor(commandId:string,commandType:Command["type"]){
    super("Command outcome unknown: "+commandType+" ("+commandId+"); waiting for reconciliation");
    this.name="CommandOutcomeUnknownError";
    this.commandId=commandId;
    this.commandType=commandType;
  }
}
export class GameBridge {
  private server:Server|undefined;
  private state:GameState|undefined;
  private stateAt=0;
  private stateSequence=0;
  private lastInvalidExitLogAt=0;
  private pending:Pending|undefined;
  private uncertain:Uncertain|undefined;
  private recentResults=new Map<string,ActionResult>();
  private events:ViewerEvent[]=[];
  private watchers=new Set<ServerResponse>();
  readonly token:string;
  readonly port:number;
  readonly host:string;
  readonly journalPath?:string;
  constructor(token:string,port=45931,host="127.0.0.1",journalPath?:string){
    this.token=token;this.port=port;this.host=host;this.journalPath=journalPath;
    if(token.length<16||token==="replace-with-a-random-secret")throw Error("Set random BIGFISH_TOKEN >=16 chars");
    if(host!=="127.0.0.1")throw Error("Bridge must use loopback");
  }
  private persistJournal():void{
    if(!this.journalPath)return;
    const outstanding=this.uncertain??this.pending;
    const record={version:1,unresolved:outstanding?{
      cmd:outstanding.cmd,before:outstanding.before,
      startedAt:outstanding.startedAt,
      lateResult:this.uncertain?.lateResult??null
    }:null,recentResults:[...this.recentResults.values()]};
    mkdirSync(dirname(this.journalPath),{recursive:true});
    const staging=this.journalPath+".tmp";
    writeFileSync(staging,JSON.stringify(record),{encoding:"utf8",mode:0o600});
    renameSync(staging,this.journalPath);
  }
  private restoreJournal():void{
    if(!this.journalPath)return;
    let doc:unknown;
    try{doc=JSON.parse(readFileSync(this.journalPath,"utf8"));}
    catch(error){
      if((error as NodeJS.ErrnoException).code==="ENOENT")return;
      throw Error("Cannot read command journal; refusing unsafe restart", {cause:error});
    }
    if(!doc||typeof doc!=="object")throw Error("Invalid command journal");
    const stored=doc as Record<string,unknown>;
    if(stored.version!==1 || !Array.isArray(stored.recentResults))
      throw Error("Unsupported/corrupted command journal; refusing unsafe restart");
    for(const item of stored.recentResults.slice(-128)){
      if(!item||typeof item!=="object")continue;
      const r=item as Partial<ActionResult>;
      if(typeof r.id==="string" && typeof r.ok==="boolean" && typeof r.message==="string")
        this.recentResults.set(r.id,{id:r.id,ok:r.ok,message:r.message});
    }
    if(stored.unresolved!==null && stored.unresolved!==undefined){
      const entry=stored.unresolved as Partial<Uncertain>;
      if(!entry||typeof entry!=="object"||
        !entry.cmd||typeof entry.cmd.id!=="string"||
        typeof entry.cmd.type!=="string"||
        !validState(entry.before)||typeof entry.startedAt!=="number")
        throw Error("Corrupted unresolved command; refusing unsafe restart");
      this.uncertain={cmd:entry.cmd,before:entry.before,
        startedAt:entry.startedAt,
        ...(entry.lateResult&&typeof entry.lateResult.id==="string"?
          {lateResult:entry.lateResult}:{})};
      console.warn("[bridge] restored unresolved game command",entry.cmd.type,
        "id="+entry.cmd.id,"; will reconcile before doing anything else");
    }
  }
  private authorized(req:IncomingMessage):boolean{
    const supplied=req.headers["x-bigfish-token"];
    if(typeof supplied!=="string")return false;
    const a=Buffer.from(supplied),b=Buffer.from(this.token);
    return a.length===b.length&&timingSafeEqual(a,b);
  }
  private reply(res:ServerResponse,status:number,data:unknown){
    res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
    res.end(JSON.stringify(data));
  }
  private async body(req:IncomingMessage):Promise<unknown>{
    let value="";
    for await(const chunk of req){
      value+=chunk.toString("utf8");
      if(value.length>64_000)throw Error("Request too large");
    }
    return JSON.parse(value);
  }
  publishAvatar(e:AvatarEvent):void{
    const packet="event: speech\ndata: "+JSON.stringify(e)+"\n\n";
    for(const watcher of this.watchers) {
      if(watcher.destroyed){this.watchers.delete(watcher);continue;}
      watcher.write(packet);
    }
  }
  async start():Promise<void>{
    this.restoreJournal();
    const html=await readFile(new URL("../overlay/index.html",import.meta.url),"utf8");
    const live2d=await readFile(new URL("../overlay/live2d.js",import.meta.url),"utf8");
    this.server=createServer(async(req,res)=>{
      try{
        if(req.url==="/health"&&req.method==="GET"){
          const st=this.getState();
          const command=this.uncertain??this.pending;
          return this.reply(res,200,{ok:true,connected:Boolean(st),
            commandPhase:this.uncertain?"unknown":this.pending?"running":"idle",
            commandAgeMs:command?Date.now()-command.startedAt:0,
            paused:st?.paused??null,pauseReason:st?.pauseReason??null});
        }
        // OBS loads an unprivileged, localhost-only overlay. Never expose the secret to browser source.
        if((req.url==="/overlay" || req.url?.startsWith("/overlay?"))&&req.method==="GET"){
          res.writeHead(200,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"});
          res.end(html);return;
        }
        if(req.url==="/overlay/live2d.js"&&req.method==="GET"){
          res.writeHead(200,{"content-type":"text/javascript; charset=utf-8","cache-control":"no-cache",
            "x-content-type-options":"nosniff"});
          res.end(live2d);return;
        }
        if(req.url==="/overlay/assets/status"&&req.method==="GET")
          return this.reply(res,200,{installed:await hasInstalledModel(),license:"CC BY-NC-SA 4.0",assetSource:"Andersen216/dsh-whale-girl-live2d"});
        if(req.url?.startsWith("/overlay/assets/")&&req.method==="GET"){
          let file:string;
          try{file=decodeURIComponent(req.url.slice("/overlay/assets/".length).split("?")[0]);}
          catch{return this.reply(res,400,{error:"bad asset path"});}
          if(!allowedAsset(file))return this.reply(res,404,{error:"unknown asset"});
          const absolute=resolvedAsset(file);
          if(!absolute)return this.reply(res,404,{error:"unknown asset"});
          try{
            const bytes=await readFile(absolute);
            res.writeHead(200,{"content-type":assetContentType(file),"cache-control":"private, max-age=3600",
              "x-content-type-options":"nosniff"});
            res.end(bytes);
          }catch{return this.reply(res,404,{error:"model resource is not installed"});}
          return;
        }
        if(req.url==="/overlay/events"&&req.method==="GET"){
          res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache","connection":"keep-alive"});
          res.write(": bigfish overlay connected\n\n");
          this.watchers.add(res);
          req.on("close",()=>this.watchers.delete(res));
          return;
        }
        if(!this.authorized(req))return this.reply(res,401,{error:"unauthorized"});
        if(req.url==="/state"&&req.method==="POST"){
          const rawState=await this.body(req);
          const {state,ignoredExits}=sanitizeStateExits(rawState);
          if(ignoredExits>0 && Date.now()-this.lastInvalidExitLogAt>60000){
            this.lastInvalidExitLogAt=Date.now();
            console.warn("[bridge] ignored "+ignoredExits+" invalid/off-map exit(s) in snapshot");
          }
          if(!validState(state))return this.reply(res,400,{error:"invalid state",fields:stateValidationIssues(state)});
          this.state=state;this.stateAt=Date.now();this.stateSequence++;
          return this.reply(res,200,{ok:true});
        }
        if(req.url==="/next"&&req.method==="GET")
          return this.reply(res,200,{command:this.uncertain?null:this.pending?.cmd??null});
        if(req.url==="/command-status"&&req.method==="GET")
          return this.reply(res,200,{phase:this.uncertain?"unknown":this.pending?"running":"idle",
            id:this.uncertain?.cmd.id??this.pending?.cmd.id??null,
            type:this.uncertain?.cmd.type??this.pending?.cmd.type??null,
            lateResult:this.uncertain?.lateResult??null});
        if(req.url==="/result"&&req.method==="POST"){
          const r=await this.body(req) as Partial<ActionResult>;
          if(typeof r?.id!=="string"||typeof r.ok!=="boolean"||typeof r.message!=="string")
            return this.reply(res,400,{error:"invalid result"});
          const receipt:ActionResult={id:r.id,ok:r.ok,message:r.message.slice(0,300)};
          const previous=this.recentResults.get(r.id);
          if(previous){
            if(previous.ok!==receipt.ok || previous.message!==receipt.message)
              return this.reply(res,409,{error:"conflicting result replay"});
            return this.reply(res,200,{ok:true,duplicate:true});
          }
          if(this.pending?.cmd.id===r.id){
            const p=this.pending;this.pending=undefined;clearTimeout(p.timer);
            this.rememberResult(receipt);
            p.resolve(receipt);
            return this.reply(res,200,{ok:true});
          }
          if(this.uncertain?.cmd.id===r.id){
            this.uncertain.lateResult=receipt;
            this.rememberResult(receipt);
            return this.reply(res,200,{ok:true,late:true});
          }
          return this.reply(res,409,{error:"unknown command id"});
        }
        if(req.url==="/event"&&req.method==="POST"){
          const e=await this.body(req) as Partial<ViewerEvent>;
          if(!e||(e.kind!=="chat"&&e.kind!=="gift")||typeof e.user!=="string"||typeof e.text!=="string")
            return this.reply(res,400,{error:"invalid event"});
          this.events.push({kind:e.kind,user:e.user.slice(0,40),text:e.text.slice(0,200)});
          this.events=this.events.slice(-30);
          return this.reply(res,200,{ok:true});
        }
        return this.reply(res,404,{error:"not found"});
      }catch(error){this.reply(res,400,{error:error instanceof Error?error.message:"bad request"});}
    });
    await new Promise<void>((resolve,reject)=>{this.server!.once("error",reject);this.server!.listen(this.port,this.host,resolve);});
  }
  private rememberResult(r:ActionResult):void{
    this.recentResults.set(r.id,r);
    if(this.recentResults.size>128){
      const oldest=this.recentResults.keys().next().value;
      if(oldest!==undefined)this.recentResults.delete(oldest);
    }
    this.persistJournal();
  }
  getUncertain():Readonly<Uncertain>|undefined{return this.uncertain;}
  settleUncertain(id:string,reason:"observed"|"failed-result"):void{
    const u=this.uncertain;
    if(!u||u.cmd.id!==id)throw Error("Uncertain command no longer matches");
    if(reason==="failed-result"&&u.lateResult?.ok!==false)
      throw Error("Cannot settle without an authoritative failed result");
    this.uncertain=undefined;
    this.persistJournal();
    console.log("[bridge] settled uncertain command",u.cmd.type,reason);
  }
  listeningPort():number{
    const address=this.server?.address();
    if(!address||typeof address==="string")throw Error("not listening");
    return address.port;
  }
  getState():GameState|undefined{return Date.now()-this.stateAt<4000?this.state:undefined;}
  getStateSequence():number{return this.stateSequence;}
  async waitForNextState(afterSequence:number,timeoutMs=5000,
    matches:(state:GameState)=>boolean=()=>true):Promise<GameState>{
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      const state=this.getState();
      if(state && this.stateSequence>afterSequence && matches(state))return state;
      await new Promise<void>(resolve=>setTimeout(resolve,50));
    }
    throw Error("No confirmed game state after command completion");
  }
  drainEvents():ViewerEvent[]{return this.events.splice(0);}
  send(action:Exclude<Action,{type:"wait"}>,timeoutMs=15000):Promise<ActionResult>{
    if(this.uncertain)return Promise.reject(Error("Previous command outcome unknown; reconcile before sending"));
    if(this.pending)return Promise.reject(Error("A command is already pending"));
    const s=this.getState();
    if(!s)return Promise.reject(Error("Game state is stale"));
    return new Promise((resolve,reject)=>{
      const cmd:Command={...action,id:randomUUID(),saveId:s.saveId,day:s.day,location:s.location};
      const timer=setTimeout(()=>{
        if(this.pending?.cmd.id===cmd.id){
          this.pending=undefined;
          this.uncertain={cmd,before:s,startedAt:Date.now()};
          this.persistJournal();
          reject(new CommandOutcomeUnknownError(cmd.id,cmd.type));
        }
      },timeoutMs);
      this.pending={cmd,before:s,resolve,reject,timer,startedAt:Date.now()};
      this.persistJournal();
    });
  }
  async stop():Promise<void>{
    const p=this.pending;this.pending=undefined;
    if(p){
      clearTimeout(p.timer);
      this.uncertain={cmd:p.cmd,before:p.before,startedAt:p.startedAt};
      this.persistJournal();
      p.reject(Error("Bridge stopped"));
    }
    for(const watcher of this.watchers)watcher.end();
    this.watchers.clear();
    if(this.server)await new Promise<void>(resolve=>this.server!.close(()=>resolve()));
  }
}
