import type { ActionResult, Command, GameState, BagItem, Tile } from "./types.ts";
type Room="Farm"|"FarmHouse"|"BusStop"|"Town"|"SeedShop";
const exits:Record<Room,{x:number;y:number;target:Room}[]>={
  Farm:[{x:6,y:2,target:"FarmHouse"},{x:8,y:6,target:"BusStop"}],
  FarmHouse:[{x:3,y:11,target:"Farm"}],
  BusStop:[{x:3,y:3,target:"Farm"},{x:8,y:5,target:"Town"}],
  Town:[{x:2,y:5,target:"BusStop"},{x:5,y:5,target:"SeedShop"}],
  SeedShop:[{x:3,y:11,target:"Town"}]
};
const allLinks=Object.entries(exits).flatMap(([from,list])=>list.map(to=>({from,to:to.target})));
export function startSimulator(port:number,token:string):()=>void{
  const economy={
    gold:220,
    bag:[{id:"(O)472",count:2,category:-74,sellable:false}] as BagItem[],
    chests:[{x:6,y:3,items:[] as BagItem[]}],
    shippingBin:{x:7,y:4} as Tile|null,
    shop:null as GameState["economy"] extends {shop:infer T}?T:never,
    tools:{hoe:true,wateringCan:true,equipped:"hoe",waterLeft:40}
  };
  const state:GameState={
    saveId:"demo-save",location:"Farm",day:1,season:"spring",time:610,energy:200,x:4,y:4,paused:false,
    crops:[{x:5,y:4,watered:false,ready:false}],emptyPlots:[{x:6,y:5,watered:false}],
    tillable:[{x:6,y:6}],seeds:[{id:"(O)472",count:2}],exits:exits.Farm,
    worldLinks:allLinks,bed:null,inventoryFree:10,waterSources:[{x:4,y:6}],economy
  };
  const seen=new Set<string>();
  const url="http://127.0.0.1:"+port,headers={"content-type":"application/json","x-bigfish-token":token};
  let busy=false,shippingIncome=0;
  function sync():void {
    state.seeds=economy.bag.filter(i=>i.category===-74).map(i=>({id:i.id,count:i.count}));
    state.inventoryFree=Math.max(0,10-economy.bag.length);
    const room=state.location as Room;
    state.exits=exits[room]??[];
    state.bed=room==="FarmHouse"?{x:5,y:5}:null;
    economy.shippingBin=room==="Farm"?{x:7,y:4}:null;
    economy.chests=room==="Farm"?economy.chests:[];
    economy.shop=room==="SeedShop"?{keeper:{x:5,y:4},open:state.time>=900&&state.time<1700,
      offers:[{id:"(O)472",price:20,stock:-1}]}:null;
  }
  function remove(id:string,count:number):boolean {
    const bag=economy.bag.find(i=>i.id===id&&i.count>=count);
    if(!bag)return false;
    bag.count-=count;
    economy.bag=economy.bag.filter(i=>i.count>0);return true;
  }
  function add(id:string,count:number,category:number,sellable:boolean):void{
    let bag=economy.bag.find(i=>i.id===id);
    if(bag)bag.count+=count;
    else economy.bag.push({id,count,category,sellable});
  }
  const interval=setInterval(async()=>{
    if(busy)return;busy=true;
    try{
      sync();
      await fetch(url+"/state",{method:"POST",headers,body:JSON.stringify(state)});
      const response=await fetch(url+"/next",{headers});
      const {command:c}=await response.json() as {command:Command|null};
      if(!c||seen.has(c.id))return;
      seen.add(c.id);
      let ok=true;
      if(c.saveId!==state.saveId||c.day!==state.day||c.location!==state.location)ok=false;
      else if(c.type==="move_to"){state.x=c.x;state.y=c.y;}
      else if(c.type==="travel_to"){
        if(!state.exits.some(e=>e.target===c.target))ok=false;
        else {state.location=c.target;state.x=4;state.y=4;state.time=Math.max(state.time,900);}
      }
      else if(c.type==="sleep"){
        if(state.location!=="FarmHouse")ok=false;
        else{
          state.day++;state.time=610;state.energy=200;state.location="FarmHouse";
          economy.gold+=shippingIncome;shippingIncome=0;
          state.crops=state.crops.map(c=>({...c,watered:false,ready:true}));
          economy.tools.waterLeft=40;
        }
      }
      else if(c.type==="equip_tool"){
        if(c.tool==="hoe"&&!economy.tools.hoe||c.tool==="watering_can"&&!economy.tools.wateringCan)ok=false;
        else economy.tools.equipped=c.tool;
      }
      else if(c.type==="buy_seed"){
        if(state.location!=="SeedShop"||!economy.shop?.open||c.count<1||c.count>12||economy.gold<20*c.count)ok=false;
        else{economy.gold-=20*c.count;add(c.itemId,c.count,-74,false);}
      }
      else if(c.type==="ship_item"){
        const bag=economy.bag.find(i=>i.id===c.itemId&&i.sellable);
        if(state.location!=="Farm"||!bag)ok=false;
        else{shippingIncome+=bag.count*35;remove(bag.id,bag.count);}
      }
      else if(c.type==="store_item"||c.type==="withdraw_item"){
        const chest=economy.chests.find(t=>t.x===c.x&&t.y===c.y);
        const source=c.type==="store_item"?economy.bag:chest?.items;
        const target=c.type==="store_item"?chest?.items:economy.bag;
        const item=source?.find(t=>t.id===c.itemId&&t.count>=c.count);
        if(!chest||!target||!item||Math.max(Math.abs(state.x-c.x),Math.abs(state.y-c.y))>1)ok=false;
        else{
          item.count-=c.count;
          if(item.count===0)source!.splice(source!.indexOf(item),1);
          const old=target.find(i=>i.id===c.itemId);
          if(old)old.count+=c.count;else target.push({...item,count:c.count});
        }
      }
      else if("x" in c && "y" in c){
        const near=Math.max(Math.abs(state.x-c.x),Math.abs(state.y-c.y))<=1;
        const crop=state.crops.find(t=>t.x===c.x&&t.y===c.y);
        const plot=state.emptyPlots.find(t=>t.x===c.x&&t.y===c.y);
        if(!near||state.location!=="Farm")ok=false;
        else if(c.type==="refill_watering_can"){
          if(state.waterSources?.some(t=>t.x===c.x&&t.y===c.y))economy.tools.waterLeft=40;else ok=false;
        }
        else if(c.type==="water_tile"&&crop&&!crop.watered&&economy.tools.equipped==="watering_can"&&economy.tools.waterLeft>0){
          crop.watered=true;state.energy-=2;economy.tools.waterLeft--;
        }
        else if(c.type==="harvest_crop"&&crop&&crop.ready){
          state.crops=state.crops.filter(t=>t!==crop);
          state.emptyPlots.push({x:c.x,y:c.y,watered:true});
          add("(O)24",1,-75,true);
        }
        else if(c.type==="plant_seed"&&plot&&remove(c.seedId,1)){
          state.emptyPlots=state.emptyPlots.filter(t=>t!==plot);
          state.crops.push({x:c.x,y:c.y,watered:plot.watered,ready:false});
        }
        else if(c.type==="till_tile"&&economy.tools.equipped==="hoe"&&state.tillable.some(t=>t.x===c.x&&t.y===c.y)){
          state.tillable=state.tillable.filter(t=>t.x!==c.x||t.y!==c.y);
          state.emptyPlots.push({x:c.x,y:c.y,watered:false});state.energy-=2;
        }
        else ok=false;
      } else ok=false;
      if(state.location==="Farm")state.time=Math.min(state.time+10,2300);
      // Commit the resulting snapshot BEFORE acknowledging result to the controller.
      sync();
      await fetch(url+"/state",{method:"POST",headers,body:JSON.stringify(state)});
      await fetch(url+"/result",{method:"POST",headers,body:JSON.stringify({id:c.id,ok,message:"simulated "+c.type} satisfies ActionResult)});
    }catch(error){console.error("[simulator]",error);}
    finally{busy=false;}
  },180);
  return()=>clearInterval(interval);
}
