import type { Action, GameState } from "./types.ts";

function stackCount(items:{id:string;count:number}[]|undefined,id:string):number {
  return items?.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0)??0;
}
export function actionObserved(action:Action,before:GameState,after:GameState):boolean {
  if(after.saveId!==before.saveId)return false;
  switch(action.type){
    case "travel_to":return after.location===action.target;
    case "move_to":return after.location===before.location && after.x===action.x && after.y===action.y;
    case "sleep":return after.day!==before.day || after.season!==before.season;
    case "equip_tool":return after.economy?.tools.equipped===action.tool;
    case "refill_watering_can":return (after.economy?.tools.waterLeft??0)>(before.economy?.tools.waterLeft??0);
    case "till_tile":return after.emptyPlots.some(p=>p.x===action.x&&p.y===action.y) ||
      after.crops.some(p=>p.x===action.x&&p.y===action.y);
    case "plant_seed":return after.crops.some(p=>p.x===action.x&&p.y===action.y);
    case "water_tile":return after.crops.some(p=>p.x===action.x&&p.y===action.y&&p.watered);
    case "harvest_crop":return !after.crops.some(p=>p.x===action.x&&p.y===action.y&&p.ready);
    case "buy_seed":return (after.economy?.gold??0)<(before.economy?.gold??0) ||
      stackCount(after.economy?.bag,action.itemId)>stackCount(before.economy?.bag,action.itemId);
    case "ship_item":return stackCount(after.economy?.bag,action.itemId)<stackCount(before.economy?.bag,action.itemId);
    case "store_item":return stackCount(after.economy?.bag,action.itemId)<stackCount(before.economy?.bag,action.itemId);
    case "withdraw_item":return stackCount(after.economy?.bag,action.itemId)>stackCount(before.economy?.bag,action.itemId);
    case "wait":return true;
  }
}


