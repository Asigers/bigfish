# M2.4 — Incremental farm map, verified access lanes and sprinkler proposals

**Status:** Implemented in Node and SMAPI bridge source, NOT YET accepted against the user's real Mac Stardew game DLL. This is a planning-only milestone, not automated sprinkler installation.

## Behavior and evidence

- While on Farm, the SMAPI bridge checks a bounded **15×15** player-centered patch. Every reported coordinate comes from an actual `isTileOnMap` and `isTilePassable` probe, plus observed real objects, terrain features and a diggable/tilled-soil check. Unknown cells are **not** assumed open or buildable.
- The controller incrementally merges those observations into a persisted, **per-save** `FarmMap` in `data/bigfish-memory.json`, capped at **1500 unique cells**. Reobserved cells override old occupancy. The map carries `year:season:day` observation freshness, so yesterday's or last year's free paths are not blindly trusted as today's safe paths.
- Known traversable cells feed a four-direction bounded BFS. The planner records corridor cells supported by a **fully observed connected route** from the player towards the exits, starter shipping bin, owned chests and, where possible, between known warps. **No inferred route across unmapped gaps.**
- The daily farm blueprint excludes newly planned planting positions on these corridors. Pre-existing crops are grandfathered; no destructive relocations.
- Generates at most five **advisory** candidate locations for basic (4 orthogonal), quality (8 adjacent), and iridium (24 in 5×5) sprinklers. They target actual planned plots and require current-day observed soil and space, avoid planned crops/corridor cells and observed shipping-bin, chest and exit buffers. Estimates ignore `NoSprinklers` map rules, sprinklers with nozzles and true recipe availability; never execute installation from these suggestions.
- The logic does not add sprinkler crafting, resource production or terrain modifications. Game-side state validation remains required before any future sprinkler command is developed.

## Mac acceptance (backup save only)

1. Stop controller and SMAPI. Back up save and update from merged main.
2. Run `npm install && npm test && npm run typecheck`.
3. Build game mod against installed game assemblies:
```bash
GAME_PATH="/Volumes/lyle/SteamLibrary/steamapps/common/Stardew Valley/Contents/MacOS"
dotnet build mods/BigFishBridge/BigFishBridge.csproj -c Release -p:GamePath="$GAME_PATH"
```
4. Confirm compiled DLL is deployed. Restart SMAPI, load a backup save and run controller in `--mock` mode. Verify a non-empty `surveyTiles` field on Farm with <=225 entries and zero entries off Farm; check the controller prints `[farm-map]` on initial observation.
5. Move through the farm. Confirm mapped tiles grow while never exceeding 1500 and that obstacles, chests and farm buildings are not classified as walkable. Inspect the `farmMap` in the memory JSON.
6. Restart the controller on same save and confirm map restored. Advance in-game date and check old terrain is not used to assert a current-day corridor until it is seen again. Switch to another save and verify map resets.
7. Inspect `[farm-plan]` protected-cell count and sprinkler ideas; check actual planned farm cells remain reachable. Suggestions must **not** issue `place_sprinkler` or reserve real materials.
8. Regression-test M0 command reconciliation, M1 clearing/drop recovery, M2.3 native chest placement and automatic watering on backup save.

## Limits / M2.5

- Only a player-centered bounded patch per snapshot. Map coverage increases with exploration but is **not** initially complete.
- The corridor planner proves reachability only on the currently observed grid, **not** via the game's exact dynamic pathfinding controller; NPC collision, temporary items, festivals and warps can still alter reachability.
- Sprinkler coverage scores are **geometry-only suggestions** and may not reflect modifiers, upgrade nozzles, beach farm sand or installed sprinkler placements. Placement needs a separate real native-game skill and confirmation.
- Plan is generated once per game day, so discoveries later in that same day inform the next full plan rather than replacing already enacted fields mid-day. Runtime world validation remains authoritative.
- GitHub CI tests the TypeScript controller but does not compile SMAPI C# DLL. All game-specific API assumptions require a real Mac build and gameplay test before unattended livestream deployment.
