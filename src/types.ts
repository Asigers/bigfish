export type CropTile = { x: number; y: number; watered: boolean };
export type GameState = {
  saveId: string;
  location: string;
  day: number;
  season: string;
  time: number;
  energy: number;
  x: number;
  y: number;
  paused: boolean;
  crops: CropTile[];
};
export type Action =
  | { type: "move_to"; x: number; y: number }
  | { type: "water_tile"; x: number; y: number }
  | { type: "wait"; seconds: number };
export type Command = Exclude<Action, { type: "wait" }> & { id: string };
export type ActionResult = { id: string; ok: boolean; message: string };
export type ViewerEvent = { kind: "chat" | "gift"; user: string; text: string };
export type Decision = { action: Action; speech: string; reason: string };

export function validState(input: unknown): input is GameState {
  if (!input || typeof input !== "object") return false;
  const s = input as Partial<GameState>;
  return typeof s.saveId === "string" && s.saveId.length < 120
    && typeof s.location === "string" && s.location.length < 120
    && ["day", "time", "energy", "x", "y"].every((k) => Number.isFinite((s as Record<string, unknown>)[k]))
    && typeof s.season === "string" && typeof s.paused === "boolean"
    && Array.isArray(s.crops) && s.crops.length <= 200
    && s.crops.every(c => Number.isInteger(c.x) && Number.isInteger(c.y) && typeof c.watered === "boolean");
}
