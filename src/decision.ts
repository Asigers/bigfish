import type { Action, Decision, GameState } from "./types.ts";

const wait = (reason: string): Decision => ({
  action: { type: "wait", seconds: 3 }, reason, speech: "先观察一下农场。"
});

export function parseDecision(raw: string): Decision {
  const cleaned = raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "");
  const obj: unknown = JSON.parse(cleaned);
  if (!obj || typeof obj !== "object") throw new Error("Decision must be a JSON object");
  const d = obj as { action?: Record<string, unknown>; speech?: unknown; reason?: unknown };
  if (!d.action || typeof d.action !== "object") throw new Error("Missing action");
  const action: Record<string, unknown> = d.action;
  let checked: Action;
  if (action.type === "wait" && Number.isFinite(action.seconds) && Number(action.seconds) >= 1 && Number(action.seconds) <= 15) {
    checked = { type: "wait", seconds: Number(action.seconds) };
  } else if ((action.type === "move_to" || action.type === "water_tile")
     && Number.isInteger(action.x) && Number.isInteger(action.y)
     && Number(action.x) >= 0 && Number(action.y) >= 0
     && Number(action.x) <= 150 && Number(action.y) <= 150) {
    checked = { type: action.type, x: Number(action.x), y: Number(action.y) };
  } else {
    throw new Error("Unknown or out-of-bounds action");
  }
  return {
    action: checked,
    speech: typeof d.speech === "string" ? d.speech.slice(0, 100) : "",
    reason: typeof d.reason === "string" ? d.reason.slice(0, 120) : ""
  };
}

export function mockDecision(state: GameState): Decision {
  if (state.paused || state.location !== "Farm") return wait("Not safely active on the farm");
  const targets = state.crops.filter(c => !c.watered);
  if (!targets.length) return { action: { type: "wait", seconds: 5 }, speech: "今天地都浇完了。", reason: "No dry crops" };
  targets.sort((a,b) => (Math.abs(a.x - state.x) + Math.abs(a.y - state.y)) - (Math.abs(b.x - state.x) + Math.abs(b.y - state.y)));
  const c = targets[0];
  if (Math.abs(c.x-state.x) <= 1 && Math.abs(c.y-state.y) <= 1) {
    return { action: { type: "water_tile", x: c.x, y: c.y }, reason: "Water adjacent crop", speech: "给这棵苗喝点水。" };
  }
  const x = c.x + (state.x < c.x ? -1 : state.x > c.x ? 1 : 0);
  const y = c.y + (state.y < c.y ? -1 : state.y > c.y ? 1 : 0);
  return { action: { type: "move_to", x: Math.max(0,x), y: Math.max(0,y) }, reason: "Reach dry crop", speech: "去给庄稼浇水。" };
}
