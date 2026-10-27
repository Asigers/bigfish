# M2.2 — Multi-day dependencies, honest blockers, and farm reservations

**Implementation slice: project planning and economic constraints.** This is not a whole-farm map or actual chest crafting system. A real SMAPI game/saved-file acceptance run is still required.

## Current capabilities

1. On Farm only, the controller reconciles a persisted `FarmWorkProject` from authoritative bag, player-owned chests and gold. Its lifetime is **across in-game days**, keyed by save ID. On shop/other locations it reuses the last farm observation rather than resetting stored materials to zero.
2. Explicit, bounded tasks are `wood (50)`, `stone (30)`, `fiber (15)`, `seed_budget (100g)` and `craft_chest`, with dependency `craft_chest → wood`. A task is completed only after actual material stock meets the reserve. **Crafting remains blocked** even with 50 wood because BigFish has no supported craft skill. It never injects or conjures a chest.
3. The resource planner uses these durable work targets to select among real, observed map resources, rather than creating infinite fixed farming targets. Gathering is still capped by energy/time and daily strike counts.
4. The economy planner deducts the 100g emergency cash reservation **before** calculating seed-shopping budgets. Actual store price and stock are still required. This prevents purchasing a crop batch that leaves the farm penniless. A route will not be started when discretionary cash is too low even for a minimal seed.
5. Farm blueprint protects observed surveyed tillable cells near **chests, starter shipping bin and map exits** (Manhattan buffer of one cell). Existing crops are never destroyed or relocated. `protectedTiles[]` are **avoidance hints from observation**, not a proof of path navigability or full-farm zoning.
6. `[farm-work]` log displays what materials are reserved, the current dependency state and next supported task. Updated status is saved in `data/bigfish-memory.json` and restored after the process restarts.
7. Deterministic executor still decides exact tools and action coordinates; the model cannot override the confirmed plan. No new SMAPI C# action is introduced in this PR.

## Technical acceptance

- Unit tests: tests/farm-work.test.ts verifies project structure and crafting blocker, chest stock count, store snapshot without farm state, separate save isolation, cash-reserved shopping, protected farm cells, and resource target fulfillment.
- Regression: `npm test && npm run typecheck` must pass on Linux/macOS, preserving earlier mock bridge scenarios.
- On Mac: back up save, shut down controller + SMAPI, update code on main after merge, then run `npm test` and build/deploy the already modified C# bridge using the actual installed Stardew assemblies:

```bash
GAME_PATH="/Volumes/lyle/SteamLibrary/steamapps/common/Stardew Valley/Contents/MacOS"
dotnet build mods/BigFishBridge/BigFishBridge.csproj -c Release -p:GamePath="$GAME_PATH"
```

- Check morning log of `[farm-work]`: before collecting, wood status should be `ready`; after filling bag+chests to 50 wood, it should become `done`; `craft_chest` must remain `blocked`.
- Visit Pierre with 120g and a 100g cash reserve, verify no seed transaction that would drop money below 100g. With enough surplus cash, it may buy a smaller batch. Old save farm occupancy should survive cross-location travel.
- Reload BigFish or advance a game day. Same-save task graph should remain; switching to a different save must reset it.
- Test rerouting and tree/tool animations with the user's backed-up game save. **Node CI does not compile C# or prove runtime interactions.**

## Next M2.3

- A real farm-wide (bounded, incrementally scanned) navigability grid and layout zoning, including sprinkler footprint and protected transit routes.
- Real crafting/placement prerequisites and outcome verification (chests, sprinklers, paths, scarecrows).
- A time/resource/reserve-aware multi-day task graph covering these actual executable skills.
- Better performance model: average per-tile watering cost, crop growth observation and quality-aware realized profit. Current predictions are baseline estimates.
- Resolve the earlier early-sleep planner design: advancing a day should be an explicit planned strategy after feasible tasks are exhausted, not a default disguised as productive gameplay.

## Known behavior

The current work planner is **deterministic adaptive bookkeeping**; it is not a dynamically LLM-generated plan DAG. The model still proposes a coarse daily goal. Cross-day tasks are stored and updated from observed world state, and supported resource work follows those needs. It is honest about unavailable crafting skills.
