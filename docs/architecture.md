# BigFish v0.1 architecture

## Purpose

The goal is to verify a fully autonomous decision loop on macOS against a real SMAPI game bridge. This is not a full Stardew Valley autoplayer or a complete streaming integration.

## Components

- Pi SDK session: JSON-only plans from observed state; no built-in tools or user extensions.
- TypeScript controller: validates allowlisted decisions, enforces one in-flight command and 15-second timeout, maintains a short recent-result window.
- HTTP bridge: local 127.0.0.1 and shared random token; snapshots arrive from game, commands polled by the mod, results reported separately.
- SMAPI C# mod: all game API calls occur on the game update thread; network requests are asynchronous.
- Simulator: fake farm runs the same HTTP command protocol without Stardew Valley or model credentials.

## Protocol

All routes except GET /health require header x-bigfish-token.

- POST /state: GameState JSON. Game reports every 40 ticks.
- GET /next: {command:null} or {command:{id,type,x,y}}. Poll repeatedly. Single in-flight command.
- POST /result: {id,ok,message}. Matching ID resolves the command.
- POST /event: {kind:'chat'|'gift',user,text}. Optional manually injected viewer events; no platform integration or real gift effects.
- GET /health: {ok,connected} where connected means a recent state heartbeat (within 4 seconds).

Commands are idempotently ignored by the mod when the command ID repeats. The state is scoped to a local game and only the current player.

## Design boundaries

- Movement delegates to Stardew Valley PathFindController. It may not navigate every farm arrangement or map.
- Watering is a direct HoeDirt.state prototype (no tool animation or water consumption). Do not use on your main save.
- No auto-planting, harvesting, mining, fishing, sleeping or warps in v0.1.
- The model may make bad plans. Parsing and game-side checks prevent arbitrary commands, but do not guarantee successful gameplay.
- Events are untrusted input: not instructions and not platform-verified rewards.
- Long-running reliability, task persistence, OBS, voice, avatar, Bilibili open platform and paid-gift integration are future milestones.

## Next milestones

1. Local Mac build + smoke test of pathfinder and crop enumeration on supported Stardew/SMAPI versions.
2. True tool-driven farming: tool activation, energy costs, inventory, blocked-tile-aware routing and animation.
3. Progress goals: plant/harvest/sleep with save persistence, fault recovery and session memory.
4. Stream overlay + TTS + official live event access and consent-based gift mapping.
