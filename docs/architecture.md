# BigFish architecture — v0.2

## Modules and responsibility

- **Autopilot** (`src/decision.ts`): deterministic minimum viable farm-day progression, high-level phase state, failure blacklist. Owns the day's `endingDay` intention until the next day is observed.
- **PiBrain** (`src/brain.ts`): Pi SDK restricted no-tools session, Chinese character speech and action proposals. Model cannot replace a mandatory objective with arbitrary waiting or detours.
- **Controller** (`src/index.ts`): one action at a time, validates against current world state, waits for HTTP acknowledgement **and a later state snapshot**, triggers cooldown on failure.
- **Bridge** (`src/bridge.ts`): localhost-only authenticated HTTP server. Commands carry `id`, `saveId`, `day` and `location`.
- **SMAPI Mod** (`mods/BigFishBridge/ModEntry.cs`): does game API work on the main tick, sends serialized state asynchronously; uses built-in crop planting/harvesting and bed sleep action.
- **Simulator** (`src/simulator.ts`): fake two-room farm with plant/harvest/till/water/travel/sleep effects, useful for regression tests.

## Local API

All except `GET /health` require `x-bigfish-token`.

- `POST /state`: structured snapshot with crops (ready, watered), empty plots, tillable tiles, inventory seeds, exits/world graph, bed tile, energy, save/day/location.
- `GET /next`: one pending command or null.
- `POST /result`: result for exact command UUID.
- `POST /event`: unverified mock viewer message; not a platform webhook.
- `GET /health`: recent heartbeat.

The game-side Mod rejects commands for a stale day, save or source location. After each acknowledgement, the controller **must wait for another state snapshot** before the next decision.

## Allowed actions

`move_to`, `till_tile`, `plant_seed`, `water_tile`, `harvest_crop`, `travel_to`, `sleep`, `wait`.

All tiles are bounded and mod-side actions enforce proximity, crop/soil/inventory preconditions and actual connected exits. `sleep` requires the farmhouse, a real bed and the host player. An all-day failure blacklist prevents repeated failed commands from being issued indefinitely.

### Why two AI layers?

The deterministic controller handles low-level timing, progress and correctness (the Pi model isn't called per frame). Pi creates optional personality/dialogue and can select feasible alternate targets inside the same task phase. It does not grant cheats or change any arbitrary game state.

## Caveats before unattended operation

1. **No game-dependent C# CI**: Stardew game assemblies are not bundled. Need `dotnet build` locally on macOS and in-game smoke test; Node CI is not equivalent.
2. **No true tool simulation yet**: watering/tilling mutate game soil state; replace with built-in tool-use/animation and stamina consumption after SMAPI gameplay verification.
3. **Seed supply limited**: the model can't buy seeds or withdraw chest items. The current finite-resource loop intentionally sleeps when out of available tasks.
4. **Travel only via mapped exit**: some doors use map actions instead of entries in `warps`; special farmhouse fallback included. No unrestricted teleport API.
5. **Multi-step command uncertainty**: if a command times out after game-side progress, the caller may need a result reconciliation; true distributed cancellation/reconciliation remains to be implemented.
6. **UI/event limitations**: only local mock viewer messages; no platform-verified gifts, avatar, audio or stream overlay.
7. **Not multiplayer safe**: only use a local single-player backed-up save.

## Next implementation milestones

- Mac game + SMAPI 4.5.x build/load and movement/bed/warp smoke tests.
- Replace tilling and watering prototypes with actual hoe and watering-can use.
- Implement inventory management, purchase seeds, chest access and selling crops.
- Add persistent task state, precise action cancellation, detailed streaming observability and human takeover.
