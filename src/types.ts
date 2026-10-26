export type Tile = { x: number; y: number };
export type CropTile = Tile & { watered: boolean; ready: boolean };
export type PlotTile = Tile & { watered: boolean };
export type SeedStack = { id: string; count: number };
export type Exit = Tile & { target: string };
export type WorldLink = { from: string; to: string };
export type GameState = {
  saveId: string; location: string; day: number; season: string; time: number;
  energy: number; x: number; y: number; paused: boolean;
  crops: CropTile[]; emptyPlots: PlotTile[]; tillable: Tile[];
  seeds: SeedStack[]; exits: Exit[]; worldLinks: WorldLink[];
  bed: Tile | null; inventoryFree: number;
};
export type Action =
  | { type: "move_to" | "water_tile" | "harvest_crop" | "till_tile"; x: number; y: number }
  | { type: "plant_seed"; x: number; y: number; seedId: string }
  | { type: "travel_to"; target: string }
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
export function validState(input: unknown): input is GameState {
  if (!record(input)) return false;
  const s=input as Partial<GameState>;
  return typeof s.saveId === "string" && s.saveId.length > 0 && s.saveId.length < 120
    && locName(s.location) && typeof s.season === "string" && typeof s.paused === "boolean"
    && ["day","time","energy","x","y","inventoryFree"].every(k => Number.isFinite(s[k as keyof GameState]))
    && coordinate({x:s.x,y:s.y}) && Number(s.day) > 0 && Number(s.day) <= 28
    && Array.isArray(s.crops) && s.crops.length <= 250 && s.crops.every(c=>coordinate(c)&&typeof c.watered==="boolean"&&typeof c.ready==="boolean")
    && Array.isArray(s.emptyPlots) && s.emptyPlots.length <= 250 && s.emptyPlots.every(c=>coordinate(c)&&typeof c.watered==="boolean")
    && Array.isArray(s.tillable) && s.tillable.length <= 250 && s.tillable.every(coordinate)
    && Array.isArray(s.seeds) && s.seeds.length <= 120 && s.seeds.every(c=>record(c)&&typeof c.id==="string"&&/^\(O\)[A-Za-z0-9_.-]{1,80}$/.test(c.id)&&Number.isInteger(c.count)&&c.count>0)
    && Array.isArray(s.exits) && s.exits.length <= 50 && s.exits.every(c=>coordinate(c)&&locName(c.target))
    && Array.isArray(s.worldLinks) && s.worldLinks.length <= 300 && s.worldLinks.every(c=>record(c)&&locName(c.from)&&locName(c.to))
    && (s.bed === null || coordinate(s.bed));
}
export function actionKey(a: Action): string { return JSON.stringify(a); }
