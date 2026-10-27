import type {GameState,SurveyTile,Tile} from "./types.ts";

export type SurveyCell=SurveyTile & {seenDay:string};
export type FarmMap={saveId:string; updatedDay:string; tiles:SurveyCell[]};
export type SprinklerIdea={kind:"basic"|"quality"|"iridium";x:number;y:number;
  coveredPlots:number; waterTiles:Tile[]};
const id=(t:Tile)=>t.x+":"+t.y;
const distance=(a:Tile,b:Tile)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
export const observationDay=(s:GameState)=>(s.year??0)+":"+s.season+":"+s.day;
const valid=(t:unknown):t is SurveyCell=>{
  if(!t||typeof t!=="object")return false;
  const a=t as SurveyCell;
  return Number.isInteger(a.x)&&Number.isInteger(a.y)&&a.x>=0&&a.y>=0&&
    a.x<150&&a.y<150&&typeof a.walkable==="boolean"&&
    typeof a.soil==="boolean"&&typeof a.occupied==="boolean"&&
    typeof a.seenDay==="string"&&a.seenDay.length<=40;
};
export function validFarmMap(input:unknown):input is FarmMap{
  if(!input||typeof input!=="object")return false;
  const map=input as FarmMap;
  return typeof map.saveId==="string"&&map.saveId.length>0&&map.saveId.length<120 &&
    typeof map.updatedDay==="string"&&map.updatedDay.length<=40 &&
    Array.isArray(map.tiles)&&map.tiles.length<=1500&&map.tiles.every(valid) &&
    new Set(map.tiles.map(id)).size===map.tiles.length;
}
/** Unknown tiles stay unknown; only game observations may mark cells traversable. */
export function mergeFarmMap(s:GameState,prior?:FarmMap):FarmMap|undefined{
  if(s.location!=="Farm"||!s.surveyTiles?.length)
    return prior?.saveId===s.saveId&&validFarmMap(prior)?prior:undefined;
  const today=observationDay(s);
  const known=new Map<string,SurveyCell>();
  if(prior?.saveId===s.saveId&&validFarmMap(prior))
    for(const tile of prior.tiles)known.set(id(tile),tile);
  for(const tile of s.surveyTiles){
    if(tile.x>=150||tile.y>=150)continue;
    // Moving/chopping/planting changes occupancy; refresh the same tile in place.
    known.delete(id(tile));
    known.set(id(tile),{...tile,seenDay:today});
  }
  // Map grows as the farmer explores, but memory and JSON payload remain bounded.
  const tiles=[...known.values()].slice(-1500);
  return {saveId:s.saveId,updatedDay:today,tiles};
}
export function dayCells(s:GameState,map?:FarmMap):Map<string,SurveyCell>{
  const cells=new Map<string,SurveyCell>();
  if(!map||!validFarmMap(map)||map.saveId!==s.saveId)return cells;
  const today=observationDay(s);
  for(const t of map.tiles)if(t.seenDay===today)cells.set(id(t),t);
  return cells;
}
function path(cells:Map<string,SurveyCell>,from:Tile,to:Tile):Tile[]{
  const start=id(from),end=id(to);
  if(!cells.get(start)?.walkable||!cells.get(end)?.walkable)return [];
  const queue=[from],visited=new Set([start]),parent=new Map<string,string>();
  let head=0;
  while(head<queue.length&&head<1500){
    const cur=queue[head++],k=id(cur);
    if(k===end){
      const result:Tile[]=[];
      let at=k;
      while(true){
        const t=cells.get(at)!;result.push({x:t.x,y:t.y});
        if(at===start)break;
        at=parent.get(at)!;
      }
      return result.reverse();
    }
    for(const d of [{x:1,y:0},{x:0,y:1},{x:-1,y:0},{x:0,y:-1}]){
      const next={x:cur.x+d.x,y:cur.y+d.y},key=id(next);
      if(!visited.has(key)&&cells.get(key)?.walkable){
        parent.set(key,k);visited.add(key);queue.push(next);
      }
    }
  }
  return [];
}
function endpoint(cells:Map<string,SurveyCell>,point:Tile):Tile|undefined{
  return [...cells.values()].filter(t=>t.walkable&&distance(t,point)<=2)
    .sort((a,b)=>distance(a,point)-distance(b,point)||a.y-b.y||a.x-b.x)[0];
}
/** Reserve only corridors proven via a current-day known-cell BFS; no guessed connectivity. */
export function routeCorridors(s:GameState,map?:FarmMap):Tile[]{
  const cells=dayCells(s,map);
  if(!cells.size||s.location!=="Farm")return [];
  const player=endpoint(cells,s);
  if(!player)return [];
  const anchors=[...s.exits,s.economy?.shippingBin??undefined,
    ...(s.economy?.chests??[])].filter((p):p is Tile=>p!==undefined);
  const endpoints=anchors.map(p=>endpoint(cells,p)).filter((p):p is Tile=>p!==undefined);
  const roads=new Map<string,Tile>();
  for(const end of endpoints)for(const t of path(cells,player,end))roads.set(id(t),t);
  // Also keep known transit corridor between existing warps.
  if(s.exits.length>=2){
    const a=endpoint(cells,s.exits[0]),b=endpoint(cells,s.exits[1]);
    if(a&&b)for(const t of path(cells,a,b))roads.set(id(t),t);
  }
  return [...roads.values()].slice(0,80);
}
/** Advisory only: no sprinkler is crafted or placed by this stage. */
export function sprinklerIdeas(s:GameState,map:FarmMap|undefined,plots:Tile[],
  forbidden:Tile[]=[],limit=5):SprinklerIdea[]{
  const cells=dayCells(s,map),targets=new Set(plots.map(id));
  const forbiddenIds=new Set(forbidden.map(id));
  for(const p of plots)forbiddenIds.add(id(p)); // no destruction of planted/planned plots
  const out:SprinklerIdea[]=[];
  if(!cells.size||!targets.size)return out;
  for(const cell of cells.values()){
    if(!cell.walkable||cell.occupied||!cell.soil||forbiddenIds.has(id(cell)))continue;
    if(s.exits.some(e=>distance(e,cell)<=2) ||
      s.economy?.chests.some(e=>distance(e,cell)<=2) ||
      (s.economy?.shippingBin&&distance(s.economy.shippingBin,cell)<=2))continue;
    for(const [kind,radius] of [["basic",1],["quality",1],["iridium",2]] as const){
      const water:Tile[]=[];
      for(let dx=-radius;dx<=radius;dx++)for(let dy=-radius;dy<=radius;dy++){
        if(!dx&&!dy)continue;
        if(kind==="basic"&&Math.abs(dx)+Math.abs(dy)!==1)continue;
        const tile={x:cell.x+dx,y:cell.y+dy};
        if(targets.has(id(tile))&&cells.get(id(tile))?.soil)water.push(tile);
      }
      if(water.length>=2)out.push({kind,x:cell.x,y:cell.y,
        coveredPlots:water.length,waterTiles:water});
    }
  }
  const rank={basic:2,quality:1,iridium:0};
  return out.sort((a,b)=>b.coveredPlots-a.coveredPlots||
    rank[a.kind]-rank[b.kind]||a.y-b.y||a.x-b.x).slice(0,Math.max(0,Math.min(10,limit)));
}
