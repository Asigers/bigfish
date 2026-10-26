import type { ActionResult, Command, GameState } from "./types.ts";

export function startSimulator(port: number, token: string): () => void {
  const state: GameState = {
    saveId: "demo-save", location: "Farm", day: 1, season: "spring", time: 610,
    energy: 270, x: 4, y: 4, paused: false,
    crops: [{x:5,y:4,watered:false},{x:6,y:4,watered:false},{x:5,y:5,watered:false}]
  };
  const processed = new Set<string>();
  const base = "http://127.0.0.1:"+port;
  const headers = { "content-type":"application/json", "x-bigfish-token":token };
  let busy=false;
  const timer = setInterval(async () => {
    if(busy)return; busy=true;
    try {
      await fetch(base+"/state",{method:"POST",headers,body:JSON.stringify(state)});
      const response=await fetch(base+"/next",{headers});
      const data=await response.json() as {command:Command|null};
      const c=data.command;
      if(c && !processed.has(c.id)){
        processed.add(c.id);
        let result: ActionResult={id:c.id,ok:true,message:"simulated"};
        if(c.type==="move_to"){state.x=c.x;state.y=c.y;}
        else if(c.type==="water_tile"){
          const crop=state.crops.find(t=>t.x===c.x&&t.y===c.y);
          if(!crop || Math.max(Math.abs(c.x-state.x),Math.abs(c.y-state.y))>1)
            result={id:c.id,ok:false,message:"crop missing or too far"};
          else {crop.watered=true;state.energy-=2;}
        }
        await fetch(base+"/result",{method:"POST",headers,body:JSON.stringify(result)});
      }
    } catch(error){console.error("[demo]",error);}
    finally {busy=false;}
  },300);
  return ()=>clearInterval(timer);
}
