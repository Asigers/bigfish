# BigFish 🐟 — Autonomous Stardew Valley farm agent (v0.2)

Mac-first autonomous **farming cycle** using Pi SDK (TypeScript) plus a local SMAPI (C#) mod. The controller is a process on your Mac. No Windows VM or Python runtime required.

> **Experimental game-control prototype, not a complete general Stardew player.** The farm loop is implemented in source and exercised in the offline simulator; the C# mod still requires compilation with your installed game and real gameplay testing. Use a BACKUP SAVE, not your main save.

## v0.2 farming loop

After loading a game, the controller reads world state and performs:

1. **Harvest** mature crops, if there is inventory space.
2. **Water** planted dry crops.
3. **Plant** seeds that already exist in the player's inventory into empty tilled soil.
4. **Till** a small number of nearby safe diggable tiles when more plots are needed.
5. **Travel** through mapped location exits (including Farm ↔ FarmHouse door fallback).
6. **Sleep** in the actual farmhouse bed through the game's built-in sleep action, then repeat next morning.

Failure counters prevent repeatedly issuing a permanently failing action in the same day. Commands include save ID, day and source location to reject stale commands, and the controller waits for a new game snapshot after each action.

Pi is **optional for the deterministic offline demo**, but used in real `npm run start` mode for character speech and suggestions. The farm-day planner retains control of the task phase so a model cannot idle forever or wander away in place of farming.

### Remaining limitations

- **Needs pre-existing seeds**: buying seeds, chest withdrawal, shipping/selling, tools crafting and general exploration are NOT implemented. On an empty inventory the agent will finish the day and sleep rather than magically create seeds.
- Tilling and watering still use prototype game-state mutations, not visible Hoe/watering-can tool animations. Planting calls `HoeDirt.plant`; harvesting calls the built-in `Crop.harvest`.
- Multi-location travel follows game `warps` and the farmhouse-door fallback; custom door actions, festivals and locked transitions may not work.
- Multiplayer is unsupported. Menus, scripted events, unsupported maps, inaccessible plots and some mod combinations require intervention.
- No Bilibili integration, actual gift effects, TTS, avatar or OBS overlay yet.
- Snapshot protocol and the TypeScript integration tests are verified in CI; **SMAPI Mac compilation, game animation and overnight saving remain unverified** until tested against a local Stardew installation.

## Mac requirements

- macOS, Steam/GOG Stardew Valley 1.6.14+, SMAPI 4.5.x.
- Node.js 22.16+ and npm; .NET 6-capable SDK for the C# mod.
- Optional: a working Pi model/provider configuration to enable AI dialogue.

## Quick start: fully simulated farm (no game, API keys or Steam)

```bash
git clone https://github.com/Asigers/bigfish.git
cd bigfish
npm install
npm test
npm run demo
```

The simulator exercises real HTTP routes with a fake game, including planting, tilling, watering, harvesting and day changes. Stop with Ctrl+C.

## Install SMAPI bridge on your Mac

1. Install Stardew Valley, install SMAPI, run the game once through SMAPI.
2. From the repository root, compile:

```bash
dotnet build mods/BigFishBridge/BigFishBridge.csproj -c Release
```

SMAPI's ModBuildConfig normally locates and deploys the assembly to the game's `Mods` directory. If it does not, inspect the build output, and manually place `BigFishBridge.dll` and `manifest.json` into `Stardew Valley/Mods/BigFishBridge/`. Check the exact Mods path SMAPI logs on startup. Do not copy `mods/BigFishBridge/` source files into Mods instead of the compiled DLL.

3. Generate **one** random token in the current terminal:

```bash
export BIGFISH_TOKEN="$(openssl rand -hex 24)"
echo "$BIGFISH_TOKEN"
```

4. In the installed `Mods/BigFishBridge/config.json`, set:

```json
{"Port":45931,"Token":"PASTE_THE_EXACT_BIGFISH_TOKEN_FROM_YOUR_TERMINAL"}
```

5. With that same environment variable in the current terminal, start the controller:

```bash
npm run start
```

6. Launch Stardew through SMAPI, load a **throwaway/backup** save, and enter the farm. Ensure some starter seeds exist in the backpack. Start small (2–3 plots) until game actions have been verified.

For testing the C# bridge **without spending model tokens**, run instead:

```bash
node --experimental-strip-types src/index.ts --mock
```

Check the local bridge health:

```bash
curl http://127.0.0.1:45931/health
```

`connected: true` means the game posted state recently. A healthy connection alone does not validate that all C# actions are safe in-game.

## Simulated viewer chat

```bash
curl -X POST http://127.0.0.1:45931/event \
  -H "x-bigfish-token: $BIGFISH_TOKEN" \
  -H "content-type: application/json" \
  -d '{"kind":"chat","user":"viewer","text":"记得浇水"}'
```

This **is not** a verified Bilibili event or an actual gift reward.

## Safety

The bridge is bound to `127.0.0.1`, mutating endpoints require a shared token, and the Pi session has no shell/file/browser tools. Never expose port 45931 publicly. Never commit your `config.json`, `.env` or game saves.

See [architecture and protocol](docs/architecture.md) for the source-state contract, failure boundaries and extension plan.
