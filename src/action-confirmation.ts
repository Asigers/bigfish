import type { Action, GameState } from "./types.ts";

function stackCount(items:{id:string;count:number}[]|undefined,id:string):number {
  return items?.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0)??0;
}
export function actionObserved(action:Action,before:GameState,after:GameState):boolean {
  if(after.saveId!==before.saveId)return false;
  switch(action.type){
    case "travel_to":return after.location===action.target;
    case "clear_resource":{
      const beforeNode=before.resources?.find(n=>n.x===action.x&&n.y===action.y&&n.kind===action.kind);
      const afterNode=after.resources?.find(n=>n.x===action.x&&n.y===action.y&&n.kind===action.kind);
      return before.location===after.location && beforeNode!==undefined &&
        after.resources!==undefined && (afterNode===undefined || afterNode.health<beforeNode.health);
    }
    case "pickup_drop":return before.location===after.location &&
      before.drops?.some(d=>d.itemId===action.itemId&&
        Math.abs(d.x-action.x)<=2&&Math.abs(d.y-action.y)<=2)===true &&
      stackCount(after.economy?.bag,action.itemId)>
        stackCount(before.economy?.bag,action.itemId);
    case "collect_forage":{
      const item=before.forage?.find(f=>f.x===action.x&&f.y===action.y);
      return after.location===before.location && item!==undefined &&
        after.forage!==undefined &&
        !after.forage.some(f=>f.x===action.x&&f.y===action.y) &&
        (before.economy===undefined || after.economy===undefined ||
          stackCount(after.economy.bag,item.itemId)>
            stackCount(before.economy.bag,item.itemId));
    }
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
    case "eat_food":return after.location===before.location &&
      after.energy>before.energy &&
      stackCount(after.economy?.bag,action.itemId) <
        stackCount(before.economy?.bag,action.itemId);
    case "ship_item":return stackCount(after.economy?.bag,action.itemId)<stackCount(before.economy?.bag,action.itemId);
    case "store_item":return stackCount(after.economy?.bag,action.itemId)<stackCount(before.economy?.bag,action.itemId);
    case "withdraw_item":return stackCount(after.economy?.bag,action.itemId)>stackCount(before.economy?.bag,action.itemId);
    case "wait":return true;
  }
}


