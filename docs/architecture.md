# BigFish v0.3 Architecture

## Components

1. **PiBrain** (TypeScript, Pi SDK): once per game day can propose one strictly bounded strategy: `goal = profit | expand | save`, `targetGold` and `seedReserve` (with a concise note). Generates short Chinese speech. No OS tools or extensions; model cannot directly alter the save.
2. **EconomyPlanner**: prioritizes real produce shipments, recovering stored seeds, clearing inventory, refilling the watering can and purchasing seasonal seeds when the farm is ready. Maintains a multi-step shopping errand across Town and SeedShop. Strategy affects spending fraction.
3. **Autopilot**: crop operation baseline, map traversal, return-home and sleep, including a per-day intent guard and failure blacklist.
4. **GoalMemory**: atomic JSON persisted journal at `data/bigfish-memory.json`. Survives Node restarts and prompts daily goals based on recent history.
5. **GameBridge**: localhost-only HTTP, shared token for commands, state snapshots, command UUID acknowledgements, SSE for an OBS browser source.
6. **SMAPI Mod**: C# reads world/inventory/shop/chests/tool state, processes one validated command on the main game thread. `ShopBuilder.GetShopStock("SeedShop")` resolves current game stock; `Farm.shipItem` handles shipment; `Chest` transfers; `Hoe.DoFunction` and `WateringCan.DoFunction` handle tools.
7. **Fish overlay**: transparent HTML/Canvas/Live2D browser page `/overlay`, live speech captions from `/overlay/events`. No Node authentication secret or remote access needed. Optional macOS `say` audio.

## Commands

`move_to`, `travel_to`, `till_tile`, `plant_seed`, `water_tile`, `refill_watering_can`, `harvest_crop`, `equip_tool`, `buy_seed`, `ship_item`, `store_item`, `withdraw_item`, `sleep`, `wait`.

All game-side mutations restrict inventory, balance, map location, state identity and nearby targets. Only locally reachable exit names may be traversed. Shop buying is restricted to `SeedShop` stock, player proximity to Pierre and opening hours. It is **not a complete native ShopMenu purchase** and may not honor all stock/quest side effects. Storage is restricted to accessible player chests. Selling goes to the game's farm shipping bin.

## World-state snapshot

Base: save/day/season/time/location, energy, player position, crop maturity/watering, empty/tillable tiles, available seeds, warps, beds, inventory slots and nearby refill sources.

Economy: player gold, bag item IDs/categories/saleability, player-owned chests + item summaries, farm shipping bin, shopkeeper tile + real stock/price, tool availability/equipment/water.

The executor checks that an action matches the *observed state*. The Mod re-checks source save/day/location and actual game items or objects, and acknowledges with a command UUID. After each result, the controller waits for a fresh snapshot before replanning. For long-running production, cancellation and uncertainty reconciliation must still be added.

## Live interaction design

Game events produce a speech request and predefined emotion:

| Game event | Fish emotion |
| --- | --- |
| Planting / watering / tilling | happy |
| Harvesting / buying / shipping | excited |
| Travelling / planning | thinking |
| Sleeping | tired |
| Action failure | sad |
| Idle | idle |

OBS Browser Source is rendered as 1920×1080 transparent frame and anchored bottom-right. Text is applied with `textContent` (not `innerHTML`) to avoid interpreting LLM/viewer text as HTML. EventSource reconnects automatically. Live gift validation has not been implemented.

## Testing

`npm test` tests the core policy, journal, shop/ship simulator workflow, farm days, bridge and SSE, on Ubuntu and macOS runners. `npm run typecheck` verifies TypeScript. The GitHub CI **does not** assert SMAPI compatibility or whole-game correctness; local C# compilation and save-backed smoke tests remain mandatory before broadcasting.

## Known gaps

Fishing, combat, NPC friendship, crafting/tool upgrades, foraging, buying/selling in other shops, native shop purchase callbacks, moved shipping bin, festivals, story progression, general game exploration, cloud TTS, live Bilibili gift integration, full command cancellation/commit log, stream control dashboard.

## Popular whale-girl Live2D integration

The optional community model is downloaded by `npm run live2d:install -- --acknowledge-noncommercial` from pinned revision `f977bef508690e75ba6535cd8f4ce18e7f6ba9b0`. Runtime and assets are **not** part of this Git repository. The installer verifies upstream Git Blob SHA-1 checksums before atomically replacing ignored `overlay/assets/`. The renderer uses PIXI 6.5.10 + pixi-live2d-display 0.4.0 + separately licensed Cubism Core loaded from localhost, not from the DSH desktop plugin. Rendering is capped at 30 FPS. SSE events trigger additive Cubism expression params, one-shot motions and a modest mouth movement while the text is visible.

Public loopback-only routes: `GET /overlay`, `GET /overlay/live2d.js`, `GET /overlay/assets/status`, and allowlisted `GET /overlay/assets/{model|vendor}/...`. The model art is governed by CC BY-NC-SA 4.0 per upstream, not BigFish code license. Commercial livestream rights should be separately confirmed with the chain of creators. See `docs/live2d.md`.
