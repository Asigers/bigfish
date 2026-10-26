import type { ActionResult, Command, GameState, CropTile, PlotTile } from "./types.ts";
export function startSimulator(port:number,token:string):()=>void {
  const state:GameState={
    saveId:"demo-save",location:"Farm",day:1,season:"spring",time:610,energy:200,x:4,y:4,paused:false,
    crops:[{x:5,y:4,watered:false,ready:false}],emptyPlots:[{x:6,y:5,watered:false}],
    tillable:[{x:6,y:6}],seeds:[{id:"(O)472",count:2}],exits:[{x:6,y:2,target:"FarmHouse"}],
    worldLinks:[{from:"Farm",to:"FarmHouse"},{from:"FarmHouse",to:"Farm"}],bed:null,inventoryFree:10
  };
  const seen=new Set<string>();
  const url="http://127.0.0.1:"+port,headers={"content-type":"application/json","x-bigfish-token":token};
  let busy=false;
  const interval=setInterval(async()=>{
    if(busy)return;busy=true;
    try {
      await fetch(url+"/state",{method:"POST",headers,body:JSON.stringify(state)});
      const r=await fetch(url+"/next",{headers});
      const {command:c}=await r.json() as {command:Command|null};
      if(!c||seen.has(c.id))return;
      seen.add(c.id);
      let result:ActionResult={id:c.id,ok:true,message:"simulated "+c.type};
      if(c.saveId!==state.saveId||c.day!==state.day||c.location!==state.location)result.ok=false;
      else if(c.type==="move_to"){state.x=c.x;state.y=c.y;}
      else if(c.type==="travel_to"){
        if(!state.exits.some(e=>e.target===c.target))result.ok=false;
        else {
          state.location=c.target;state.x=3;state.y=3;
          state.exits=c.target==="FarmHouse"?[{x:3,y:11,target:"Farm"}]:[{x:6,y:2,target:"FarmHouse"}];
          state.bed=c.target==="FarmHouse"?{x:5,y:5}:null;
        }
      } else if(c.type==="sleep"){
        if(state.location!=="FarmHouse")result.ok=false;
        else {
          state.day++;state.time=610;state.energy=200;state.location="FarmHouse";
          state.crops=state.crops.map(c=>({...c,watered:false,ready:true}));
        }
      } else {
        const near=Math.max(Math.abs(state.x-c.x),Math.abs(state.y-c.y))<=1;
        const crop=state.crops.find(t=>t.x===c.x&&t.y===c.y);
        const plot=state.emptyPlots.find(t=>t.x===c.x&&t.y===c.y);
        if(!near||state.location!=="Farm")result.ok=false;
        else if(c.type==="water_tile"&&crop&&!crop.watered){crop.watered=true;state.energy-=2;}
        else if(c.type==="harvest_crop"&&crop&&crop.ready){
          state.crops=state.crops.filter(t=>t!==crop);state.emptyPlots.push({x:c.x,y:c.y,watered:true});state.inventoryFree--;
        } else if(c.type==="plant_seed"&&plot&&state.seeds.some(s=>s.id===c.seedId&&s.count>0)){
          state.emptyPlots=state.emptyPlots.filter(t=>t!==plot);
          state.crops.push({x:c.x,y:c.y,watered:plot.watered,ready:false});
          const seed=state.seeds.find(s=>s.id===c.seedId)!;seed.count--;state.seeds=state.seeds.filter(s=>s.count>0);
        } else if(c.type==="till_tile"&&state.tillable.some(t=>t.x===c.x&&t.y===c.y)){
          state.tillable=state.tillable.filter(t=>t.x!==c.x||t.y!==c.y);
          state.emptyPlots.push({x:c.x,y:c.y,watered:false});state.energy-=2;
        } else result.ok=false;
      }
      if(state.location==="Farm")state.time=Math.min(state.time+10,2300);
      await fetch(url+"/result",{method:"POST",headers,body:JSON.stringify(result)});
    }catch(e){console.error("[simulator]",e);}
    finally{busy=false;}
  },200);
  return()=>clearInterval(interval);
}
