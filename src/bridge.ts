import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import type { Action, ActionResult, Command, GameState, ViewerEvent } from "./types.ts";
import { validState } from "./types.ts";
type Pending={cmd:Command;resolve:(r:ActionResult)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout};
export class GameBridge {
  private server:Server|undefined;
  private state:GameState|undefined;
  private stateAt=0;
  private stateSequence=0;
  private pending:Pending|undefined;
  private events:ViewerEvent[]=[];
  readonly token:string;
  readonly port:number;
  readonly host:string;
  constructor(token:string,port=45931,host="127.0.0.1"){
    this.token=token;this.port=port;this.host=host;
    if(token.length<16||token==="replace-with-a-random-secret")throw Error("Set random BIGFISH_TOKEN >=16 chars");
    if(host!=="127.0.0.1")throw Error("Bridge must use loopback");
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
  async start():Promise<void>{
    this.server=createServer(async(req,res)=>{
      try{
        if(req.url==="/health"&&req.method==="GET")return this.reply(res,200,{ok:true,connected:Boolean(this.getState())});
        if(!this.authorized(req))return this.reply(res,401,{error:"unauthorized"});
        if(req.url==="/state"&&req.method==="POST"){
          const state=await this.body(req);
          if(!validState(state))return this.reply(res,400,{error:"invalid state"});
          this.state=state;this.stateAt=Date.now();this.stateSequence++;
          return this.reply(res,200,{ok:true});
        }
        if(req.url==="/next"&&req.method==="GET")
          return this.reply(res,200,{command:this.pending?.cmd??null});
        if(req.url==="/result"&&req.method==="POST"){
          const r=await this.body(req) as Partial<ActionResult>;
          if(typeof r?.id!=="string"||typeof r.ok!=="boolean"||typeof r.message!=="string")
            return this.reply(res,400,{error:"invalid result"});
          if(!this.pending||this.pending.cmd.id!==r.id)return this.reply(res,409,{error:"no pending command"});
          const p=this.pending;this.pending=undefined;clearTimeout(p.timer);
          p.resolve({id:r.id,ok:r.ok,message:r.message.slice(0,300)});
          return this.reply(res,200,{ok:true});
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
  listeningPort():number{
    const address=this.server?.address();
    if(!address||typeof address==="string")throw Error("not listening");
    return address.port;
  }
  getState():GameState|undefined{return Date.now()-this.stateAt<4000?this.state:undefined;}
  getStateSequence():number{return this.stateSequence;}
  async waitForNextState(afterSequence:number,timeoutMs=5000):Promise<GameState>{
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      const state=this.getState();
      if(state && this.stateSequence>afterSequence)return state;
      await new Promise<void>(resolve=>setTimeout(resolve,50));
    }
    throw Error("No fresh game state after command completion");
  }
  drainEvents():ViewerEvent[]{return this.events.splice(0);}
  send(action:Exclude<Action,{type:"wait"}>,timeoutMs=15000):Promise<ActionResult>{
    if(this.pending)return Promise.reject(Error("A command is already pending"));
    const s=this.getState();
    if(!s)return Promise.reject(Error("Game state is stale"));
    return new Promise((resolve,reject)=>{
      const cmd:Command={...action,id:randomUUID(),saveId:s.saveId,day:s.day,location:s.location};
      const timer=setTimeout(()=>{
        if(this.pending?.cmd.id===cmd.id)this.pending=undefined;
        reject(Error("Command timed out "+cmd.type));
      },timeoutMs);
      this.pending={cmd,resolve,reject,timer};
    });
  }
  async stop():Promise<void>{
    const p=this.pending;this.pending=undefined;
    if(p){clearTimeout(p.timer);p.reject(Error("Bridge stopped"));}
    if(this.server)await new Promise<void>(resolve=>this.server!.close(()=>resolve()));
  }
}
