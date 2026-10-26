import { spawn } from "node:child_process";
import type { Action, GameState } from "./types.ts";
export type Emotion = "idle"|"happy"|"excited"|"thinking"|"tired"|"sad"|"surprised";
export type AvatarEvent = { type:"speech";text:string;emotion:Emotion;goal:string;at:number };
const events:AvatarEvent[]=[];
let lastTalk=0;
let activeVoice=false;
export function avatarEvents():AvatarEvent[]{return events.slice(-10);}
export function emotionFor(action:Action,ok=true):Emotion{
  if(!ok)return "sad";
  if(action.type==="sleep")return "tired";
  if(action.type==="harvest_crop"||action.type==="buy_seed"||action.type==="ship_item")return "excited";
  if(action.type==="water_tile"||action.type==="plant_seed"||action.type==="till_tile")return "happy";
  if(action.type==="travel_to")return "thinking";
  return "idle";
}
export function canSpeak(now=Date.now()):boolean{return now-lastTalk>9000;}
export function recordSpeech(text:string,action:Action,goal:string,ok=true):AvatarEvent|undefined{
  const cleaned=text.replace(/[\r\n]+/g," ").slice(0,100).trim();
  if(!cleaned||!canSpeak())return;
  lastTalk=Date.now();
  const event:AvatarEvent={type:"speech",text:cleaned,emotion:emotionFor(action,ok),goal:goal.slice(0,70),at:lastTalk};
  events.push(event);if(events.length>10)events.shift();
  if(process.platform==="darwin"&&process.env.BIGFISH_TTS==="say"&&!activeVoice){
    activeVoice=true;
    const child=spawn("say",["-r","185",cleaned],{stdio:"ignore"});
    child.on("error",()=>{activeVoice=false;});
    child.on("exit",()=>{activeVoice=false;});
  }
  return event;
}
