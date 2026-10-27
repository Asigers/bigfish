export type Tile = { x: number; y: number };
export type CropTile = Tile & { watered: boolean; ready: boolean; seedId?:string|null };
export type PlotTile = Tile & { watered: boolean };
export type BagItem = { id: string; count: number; category: number; sellable: boolean };
export type ChestSnapshot = Tile & { items: BagItem[] };
export type ShopOffer = { id: string; price: number; stock: number };
export type EconomyState = {
  gold: number; bag: BagItem[]; chests: ChestSnapshot[]; shippingBin: Tile | null;
  shop: { keeper: Tile; open: boolean; offers: ShopOffer[] } | null;
  tools: { hoe: boolean; wateringCan: boolean; equipped: string; waterLeft: number;
    axe?:boolean; pickaxe?:boolean; scythe?:boolean };
};
export type SeedStack = { id: string; count: number };
export type ForageItem = Tile & { itemId: string };
export type FoodItem = { id:string; count:number; restoreEnergy:number };
export type CropInfo = { seedId:string; harvestId:string; seasons:string[];
  growthDays:number; regrowDays:number; sellPrice:number; minHarvest:number;
  raised:boolean; needsWatering:boolean };
export type LooseDrop = Tile & { itemId:string };
export type ResourceKind = "tree" | "stone" | "twig" | "weed";
export type ResourceNode = Tile & { kind:ResourceKind; health:number };
export type SurveyTile = Tile & { walkable:boolean; soil:boolean; occupied:boolean };
export type SprinklerKind="basic"|"quality"|"iridium";
export type SprinklerItem = Tile & {kind:SprinklerKind};
export type SprinklerRecipe = {kind:SprinklerKind; itemId:string; learned:boolean;
  canCraft:boolean; ingredients:{id:string;count:number}[]};
export type SprinklerKit = {kind:SprinklerKind;count:number};
export type Exit = Tile & { target: string };
export type WorldLink = { from: string; to: string };
export type GameState = {
  saveId: string; location: string; year?:number; day: number; season: string; time: number;
  energy: number; x: number; y: number; paused: boolean;
  pauseReason?: "none" | "menu" | "event" | "time_stopped";
  crops: CropTile[]; emptyPlots: PlotTile[]; tillable: Tile[];
  seeds: SeedStack[]; sprinklerRecipes?:SprinklerRecipe[];
  sprinklerKits?:SprinklerKit[]; installedSprinklers?:SprinklerItem[];
  sprinklerSites?:Tile[]; isRaining?:boolean; surveyTiles?:SurveyTile[]; chestKits?:number; canCraftChest?:boolean; placementSites?:Tile[]; cropCatalog?:CropInfo[]; food?: FoodItem[]; forage?: ForageItem[]; drops?: LooseDrop[]; resources?: ResourceNode[]; exits: Exit[]; worldLinks: WorldLink[];
  bed: Tile | null; inventoryFree: number;
  economy?: EconomyState; waterSources?: Tile[];
};
export type Action =
  | { type: "move_to" | "water_tile" | "harvest_crop" | "till_tile"; x: number; y: number }
  | { type: "plant_seed"; x: number; y: number; seedId: string }
  | { type: "travel_to"; target: string }
  | { type: "ship_item" | "eat_food"; itemId: string }
  | { type:"pickup_drop"; x:number; y:number; itemId:string }
  | { type: "buy_seed"; itemId: string; count: number }
  | { type: "store_item" | "withdraw_item"; x: number; y: number; itemId: string; count: number }
  | { type: "equip_tool"; tool: "hoe" | "watering_can" | "axe" | "pickaxe" | "scythe" }
  | { type: "refill_watering_can" | "collect_forage"; x: number; y: number }
  | { type:"clear_resource"; x:number; y:number; kind:ResourceKind }
  | { type:"craft_sprinkler"; kind:SprinklerKind }
  | { type:"place_sprinkler"; kind:SprinklerKind; x:number; y:number }
  | { type: "craft_chest" }
  | { type: "place_chest"; x:number; y:number }
  | { type: "sleep" }
  | { type: "wait"; seconds: number };
export type Command = Exclude<Action, { type: "wait" }> & { id: string; saveId: string; day: number; location: string };
export type ActionResult = { id: string; ok: boolean; message: string };
export type ViewerEvent = { kind: "chat" | "gift"; user: string; text: string };
export type Decision = { action: Action; speech: string; reason: string };
const coordinate = (v: unknown): v is Tile => {
  if (!v || typeof v !== "object") return false;
  const t = v as Tile;
  return Number.isInteger(t.x) && Number.isInteger(t.y) && t.x >= 0 && t.y >= 0 && t.x < 256 && t.y < 256;
};
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const locName = (v:unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 80 && /^[A-Za-z0-9_-]+$/.test(v);
const validExit = (v:unknown): v is Exit => record(v) && coordinate(v) && locName((v as Exit).target);

// Ignore malformed map warps while keeping all other state fields strictly validated.
// Some Stardew locations expose off-map/placeholder warps that cannot be navigated to.
export function sanitizeStateExits(input:unknown):{state:unknown;ignoredExits:number} {
  if(!record(input) || !Array.isArray(input.exits) || input.exits.length>50)
    return {state:input,ignoredExits:0};
  const exits=input.exits.filter(validExit);
  return {state:exits.length===input.exits.length?input:{...input,exits},
    ignoredExits:input.exits.length-exits.length};
}

export function validCropInfo(input:unknown):input is CropInfo {
  if(!record(input))return false;
  const c=input as CropInfo;
  const id=(value:unknown)=>typeof value==="string"&&
    /^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(value);
  return id(c.seedId)&&id(c.harvestId)&&
    Array.isArray(c.seasons)&&c.seasons.length>=1&&c.seasons.length<=4 &&
    c.seasons.every(season=>["spring","summer","fall","winter"].includes(season)) &&
    Number.isInteger(c.growthDays)&&c.growthDays>0&&c.growthDays<=100 &&
    Number.isInteger(c.regrowDays)&&c.regrowDays>=-1&&c.regrowDays<=60 &&
    Number.isInteger(c.sellPrice)&&c.sellPrice>=0&&c.sellPrice<=1000000 &&
    Number.isInteger(c.minHarvest)&&c.minHarvest>=1&&c.minHarvest<=100 &&
    typeof c.raised==="boolean"&&typeof c.needsWatering==="boolean";
}
const validSprinklerKind=(x:unknown):x is SprinklerKind=>
  ["basic","quality","iridium"].includes(x as string);
export function validSprinklerRecipe(input:unknown):input is SprinklerRecipe {
  if(!record(input))return false;
  const r=input as SprinklerRecipe;
  const id={"basic":"(O)599","quality":"(O)621","iridium":"(O)645"};
  return validSprinklerKind(r.kind)&&r.itemId===id[r.kind]&&
    typeof r.learned==="boolean"&&typeof r.canCraft==="boolean"&&
    Array.isArray(r.ingredients)&&r.ingredients.length>0&&r.ingredients.length<=8&&
    r.ingredients.every(i=>record(i)&&typeof i.id==="string"&&
      /^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(i.id)&&
      Number.isInteger(i.count)&&i.count>0&&i.count<=999);
}
export function validState(input: unknown): input is GameState {
  if (!record(input)) return false;
  const s=input as Partial<GameState>;
  return typeof s.saveId === "string" && s.saveId.length > 0 && s.saveId.length < 120
    && locName(s.location) && typeof s.season === "string" && typeof s.paused === "boolean"
    && (s.pauseReason === undefined || ["none","menu","event","time_stopped"].includes(s.pauseReason))
    && ["day","time","energy","x","y","inventoryFree"].every(k => Number.isFinite(s[k as keyof GameState]))
    && (s.year===undefined||(Number.isInteger(s.year)&&s.year>=1&&s.year<=1000))
    && coordinate({x:s.x,y:s.y}) && Number(s.day) > 0 && Number(s.day) <= 28
    && Array.isArray(s.crops) && s.crops.length <= 250 && s.crops.every(c=>coordinate(c)&&typeof c.watered==="boolean"&&typeof c.ready==="boolean"&&
      ((c.seedId===undefined||c.seedId===null) || (typeof c.seedId==="string"&&/^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(c.seedId))))
    && Array.isArray(s.emptyPlots) && s.emptyPlots.length <= 250 && s.emptyPlots.every(c=>coordinate(c)&&typeof c.watered==="boolean")
    && Array.isArray(s.tillable) && s.tillable.length <= 250 && s.tillable.every(coordinate)
    && Array.isArray(s.seeds) && s.seeds.length <= 120 && s.seeds.every(c=>record(c)&&typeof c.id==="string"&&/^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(c.id)&&Number.isInteger(c.count)&&c.count>0)
    && (s.surveyTiles===undefined || (Array.isArray(s.surveyTiles) &&
      s.surveyTiles.length<=225 && s.surveyTiles.every(t=>coordinate(t)&&
        typeof t.walkable==="boolean"&&typeof t.soil==="boolean"&&
        typeof t.occupied==="boolean")))
    && (s.isRaining===undefined||typeof s.isRaining==="boolean")
    && (s.sprinklerSites===undefined||(Array.isArray(s.sprinklerSites)&&
      s.sprinklerSites.length<=80&&s.sprinklerSites.every(coordinate)))
    && (s.installedSprinklers===undefined||(Array.isArray(s.installedSprinklers)&&
      s.installedSprinklers.length<=160&&s.installedSprinklers.every(v=>coordinate(v)&&
        ["basic","quality","iridium"].includes(v.kind))))
    && (s.sprinklerKits===undefined||(Array.isArray(s.sprinklerKits)&&
      s.sprinklerKits.length<=3&&s.sprinklerKits.every(v=>record(v)&&
        ["basic","quality","iridium"].includes(v.kind)&&
        Number.isInteger(v.count)&&v.count>=0&&v.count<=9999)))
    && (s.sprinklerRecipes===undefined||(Array.isArray(s.sprinklerRecipes)&&
      s.sprinklerRecipes.length<=3&&s.sprinklerRecipes.every(validSprinklerRecipe)))
    && (s.chestKits===undefined || (Number.isInteger(s.chestKits)&&s.chestKits>=0&&s.chestKits<=9999))
    && (s.canCraftChest===undefined || typeof s.canCraftChest==="boolean")
    && (s.placementSites===undefined || (Array.isArray(s.placementSites) &&
      s.placementSites.length<=80 && s.placementSites.every(coordinate)))
    && (s.cropCatalog===undefined || (Array.isArray(s.cropCatalog) &&
      s.cropCatalog.length<=150 && s.cropCatalog.every(c=>validCropInfo(c))))
    && (s.forage === undefined || (Array.isArray(s.forage) && s.forage.length <= 80 &&
      s.forage.every(f=>coordinate(f)&&typeof f.itemId==="string"&&
        /^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(f.itemId))))
    && (s.drops===undefined || (Array.isArray(s.drops)&&s.drops.length<=80 &&
      s.drops.every(d=>coordinate(d)&&typeof d.itemId==="string"&&
        /^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(d.itemId))))
    && (s.resources === undefined || (Array.isArray(s.resources) && s.resources.length <= 120 &&
      s.resources.every(n => coordinate(n) && ["tree","stone","twig","weed"].includes(n.kind) &&
        Number.isFinite(n.health) && n.health>=0 && n.health<=1000)))
    && (s.food===undefined || (Array.isArray(s.food)&&s.food.length<=48&&s.food.every(i=>
      record(i) && typeof i.id==="string" && /^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(i.id) &&
      Number.isInteger(i.count)&&i.count>0&&i.count<=9999 &&
      Number.isInteger(i.restoreEnergy)&&i.restoreEnergy>0&&i.restoreEnergy<=500)))
    && Array.isArray(s.exits) && s.exits.length <= 50 && s.exits.every(validExit)
    && Array.isArray(s.worldLinks) && s.worldLinks.length <= 300 && s.worldLinks.every(c=>record(c)&&locName(c.from)&&locName(c.to))
    && (s.bed === null || coordinate(s.bed))
    && (s.economy === undefined || validEconomy(s.economy))
    && (s.waterSources === undefined || (Array.isArray(s.waterSources)&&s.waterSources.length<=80&&s.waterSources.every(coordinate)));
}
// Field names only: never echo inventory, save identifiers or user data to diagnostics.
export function stateValidationIssues(input: unknown): string[] {
  if (!record(input)) return ["state must be an object"];
  const s = input as Record<string, unknown>;
  const issues: string[] = [];
  const numberFields = ["day", "time", "energy", "x", "y", "inventoryFree"];
  if (typeof s.saveId !== "string" || !s.saveId.length || s.saveId.length >= 120) issues.push("saveId");
  if (!locName(s.location)) issues.push("location");
  if (typeof s.season !== "string") issues.push("season");
  if (typeof s.paused !== "boolean") issues.push("paused");
  if (s.pauseReason !== undefined && !["none","menu","event","time_stopped"].includes(s.pauseReason as string)) issues.push("pauseReason");
  for (const k of numberFields) if (!Number.isFinite(s[k])) issues.push(k);
  if (!coordinate({x: s.x, y: s.y})) issues.push("player coordinates");
  if (typeof s.day !== "number" || s.day <= 0 || s.day > 28) issues.push("day range");
  if (s.year!==undefined && (!Number.isInteger(s.year)||Number(s.year)<1||Number(s.year)>1000))issues.push("year");
  const checkArray = (key: string, max: number, validate: (v: unknown) => boolean) => {
    const values = s[key];
    if (!Array.isArray(values) || values.length > max) { issues.push(key + " array/length"); return; }
    const index = values.findIndex(v => !validate(v));
    if (index >= 0) issues.push(key + "[" + index + "]");
  };
  checkArray("crops", 250, v => coordinate(v) && typeof (v as CropTile).watered === "boolean" &&
    typeof (v as CropTile).ready === "boolean" &&
    (((v as CropTile).seedId===undefined||(v as CropTile).seedId===null) ||
      (typeof (v as CropTile).seedId==="string" &&
        /^\(O\)[A-Za-z0-9_.-]{1,80}$/.test((v as CropTile).seedId!))));
  if(s.cropCatalog!==undefined)checkArray("cropCatalog",150,validCropInfo);
  if(s.surveyTiles!==undefined)checkArray("surveyTiles",225,v=>
    coordinate(v)&&typeof (v as SurveyTile).walkable==="boolean"&&
    typeof (v as SurveyTile).soil==="boolean"&&
    typeof (v as SurveyTile).occupied==="boolean");
  if(s.isRaining!==undefined&&typeof s.isRaining!=="boolean")issues.push("isRaining");
  if(s.sprinklerSites!==undefined)checkArray("sprinklerSites",80,coordinate);
  if(s.installedSprinklers!==undefined)checkArray("installedSprinklers",160,v=>
    coordinate(v)&&validSprinklerKind((v as SprinklerItem).kind));
  if(s.sprinklerKits!==undefined)checkArray("sprinklerKits",3,v=>record(v)&&
    validSprinklerKind((v as SprinklerKit).kind)&&
    Number.isInteger((v as SprinklerKit).count)&&
    (v as SprinklerKit).count>=0&&(v as SprinklerKit).count<=9999);
  if(s.sprinklerRecipes!==undefined)checkArray("sprinklerRecipes",3,validSprinklerRecipe);
  if(s.chestKits!==undefined && (!Number.isInteger(s.chestKits)||Number(s.chestKits)<0||Number(s.chestKits)>9999))issues.push("chestKits");
  if(s.canCraftChest!==undefined && typeof s.canCraftChest!=="boolean")issues.push("canCraftChest");
  if(s.placementSites!==undefined)checkArray("placementSites",80,coordinate);
  checkArray("emptyPlots", 250, v => coordinate(v) && typeof (v as PlotTile).watered === "boolean");
  checkArray("tillable", 250, coordinate);
  checkArray("seeds", 120, v => record(v) && typeof v.id === "string" &&
    /^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(v.id) && Number.isInteger(v.count) && Number(v.count) > 0);
  if(s.forage !== undefined)
    checkArray("forage", 80, v => coordinate(v) && record(v) &&
      typeof (v as ForageItem).itemId === "string" &&
      /^\(O\)[A-Za-z0-9_.-]{1,80}$/.test((v as ForageItem).itemId));
  if(s.drops!==undefined)
    checkArray("drops",80,v=>coordinate(v)&&record(v)&&
      typeof (v as LooseDrop).itemId==="string"&&
      /^\(O\)[A-Za-z0-9_.-]{1,80}$/.test((v as LooseDrop).itemId));
  if(s.resources !== undefined)
    checkArray("resources",120, v=>coordinate(v) &&
      ["tree","stone","twig","weed"].includes((v as ResourceNode).kind) &&
      Number.isFinite((v as ResourceNode).health) &&
      (v as ResourceNode).health>=0 && (v as ResourceNode).health<=1000);
  if(s.food!==undefined)
    checkArray("food",48,v=>record(v) && typeof v.id==="string" &&
      /^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(v.id) &&
      Number.isInteger(v.count)&&Number(v.count)>0&&Number(v.count)<=9999 &&
      Number.isInteger(v.restoreEnergy)&&Number(v.restoreEnergy)>0&&Number(v.restoreEnergy)<=500);
  checkArray("exits", 50, validExit);
  checkArray("worldLinks", 300, v => record(v) && locName(v.from) && locName(v.to));
  if (s.bed !== null && !coordinate(s.bed)) issues.push("bed");
  if (s.economy !== undefined && !validEconomy(s.economy)) issues.push("economy");
  if (s.waterSources !== undefined) checkArray("waterSources", 80, coordinate);
  return issues.length ? issues.slice(0, 12) : ["unknown validation mismatch"];
}
export function actionKey(a: Action): string { return JSON.stringify(a); }

export function validEconomy(value:unknown):value is EconomyState {
  if(!record(value))return false;
  const e=value as unknown as EconomyState;
  const bag=(x:unknown):x is BagItem=>record(x)&&typeof x.id==="string"&&/^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(x.id)
    && typeof x.count==="number"&&Number.isInteger(x.count)&&x.count>0&&x.count<=9999&&Number.isInteger(x.category)&&typeof x.sellable==="boolean";
  return Number.isInteger(e.gold)&&e.gold>=0&&e.gold<100_000_000
    && Array.isArray(e.bag)&&e.bag.length<=60&&e.bag.every(bag)
    && Array.isArray(e.chests)&&e.chests.length<=40&&e.chests.every(c=>coordinate(c)&&Array.isArray(c.items)&&c.items.length<=100&&c.items.every(bag))
    && (e.shippingBin===null||coordinate(e.shippingBin))
    && (e.shop===null||(record(e.shop)&&coordinate(e.shop.keeper)&&typeof e.shop.open==="boolean"
      && Array.isArray(e.shop.offers)&&e.shop.offers.length<=100&&e.shop.offers.every(o=>
        record(o)&&typeof o.id==="string"&&/^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(o.id)
        && Number.isInteger(o.price)&&o.price>0&&o.price<=1_000_000
        && Number.isInteger(o.stock)&&o.stock>=-1)))
    && record(e.tools)&&typeof e.tools.hoe==="boolean"&&typeof e.tools.wateringCan==="boolean"
    && ["axe","pickaxe","scythe"].every(k=>(e.tools as unknown as Record<string,unknown>)[k]===undefined||
      typeof (e.tools as unknown as Record<string,unknown>)[k]==="boolean")
    && typeof e.tools.equipped==="string"&&e.tools.equipped.length<40&&Number.isFinite(e.tools.waterLeft);
}
