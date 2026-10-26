# BigFish 🐟

**A Mac-first experimental autonomous Stardew Valley agent**, using Pi SDK + TypeScript + a SMAPI (C#) game bridge. No Windows VM, Python daemon or Redis required.

> v0.1 MVP, **not** production-ready unattended gameplay. The offline demo is runnable without Stardew Valley or an AI account. The real-game bridge requires a local SMAPI build and game-side verification.

## What works in v0.1

- A loop that observes game state, asks Pi for one JSON action, validates it and waits for a real result before replanning.
- A restricted Pi session with **no shell, file, browser or arbitrary tools**, and no user extensions/skills.
- A local authenticated HTTP bridge with heartbeat freshness, one-command-at-a-time, command timeouts, result IDs and mock viewer events.
- A SMAPI source mod that reads player position, farm crops, time, energy and menu state; provides path movement and **prototype crop watering**.
- A deterministic offline simulator and unit tests for the parser/planner.

**Not yet built:** real watering-can animation and water consumption, planting, harvesting, fishing, mining, sleeping, multi-day unattended play, OBS integration, TTS, an avatar, or authenticated Bilibili gifts. A live SMAPI build and integration test has **not** been performed in this repository.

## Requirements

- macOS (Apple Silicon or Intel), Steam Stardew Valley 1.6.x, SMAPI 4.5.x.
- Node.js 22.16+ and npm.
- .NET SDK compatible with SMAPI, for building the included C# mod.
- A Pi model/provider configured locally for real AI mode; **not needed** for the demo.
- Separate **backup save** for testing. The prototype mutates planted soil directly.

## 1. Offline demo: no game or API key

```sh
git clone https://github.com/Asigers/bigfish.git
cd bigfish
npm install
npm test
npm run demo
```

The demo starts a simulated farm. You should see `move_to` and `water_tile` actions followed by 'today's crops are watered'. Stop with Ctrl+C. The mock decision mode deliberately **does not call Pi**.

## 2. Build/install the game bridge on Mac

Install Stardew Valley and SMAPI first, then open the game once through SMAPI. Build from this repository:

```sh
dotnet build mods/BigFishBridge/BigFishBridge.csproj -c Release
```

The ModBuildConfig package generally copies builds into the game's Mods directory when it detects the installed game. Confirm that the resulting directory contains `BigFishBridge.dll` and `manifest.json`. If auto-detection fails, set the documented ModBuildConfig `GamePath` option or manually copy the build output and manifest into `Stardew Valley/Mods/BigFishBridge/`.

Create or edit `Mods/BigFishBridge/config.json`:

```json
{ "Port": 45931, "Token": "your-random-token-should-be-16-or-more-characters" }
```

## 3. Run with the real game

Generate a secret on the Mac terminal and set that **same token** in the mod config:

```sh
export BIGFISH_TOKEN="$(openssl rand -hex 24)"
npm run start
```

Start Stardew Valley **through SMAPI**, load a *backup* save and enter the Farm. The console should show state sync and Pi decisions. `npm run start` uses your locally configured Pi provider/model and needs valid credentials. Keep the game and terminal open.

For initial debugging, you can disable model calls and run only deterministic actions:

```sh
BIGFISH_TOKEN="same-token-as-in-mod-config" node --experimental-strip-types src/index.ts --mock
```

Health check (no secret required):

```sh
curl http://127.0.0.1:45931/health
```

If `connected:false`, check SMAPI logs, whether a save is open, the mod's config and port. No remote binding or external dashboard is exposed.

## 4. Simulate a viewer event

The `/event` endpoint merely queues context for the next Pi decision. It does **not** grant in-game rewards and is **not** a Bilibili webhook.

```sh
curl -X POST http://127.0.0.1:45931/event \
  -H "x-bigfish-token: $BIGFISH_TOKEN" \
  -H "content-type: application/json" \
  -d '{"kind":"chat","user":"test-viewer","text":"今天先去浇水"}'
```

## Privacy and safety

- Binding is hardcoded to `127.0.0.1`; every mutation route requires a shared secret.
- The secret is never committed. Use `.env.example` as a reference, not a real token.
- Do not expose port 45931 to the network or use the mod against your main save.
- Back up saves, and verify permissions/licensing before using third-party character artwork or enabling monetized live gifting.

See [architecture and limitations](docs/architecture.md).
