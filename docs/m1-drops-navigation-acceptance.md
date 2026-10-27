# M1 — Native dropped-material recovery and route failure memory

Status: candidate implementation; Node CI required; C# game compilation and gameplay acceptance **not yet performed**.

## Behavior

- SMAPI reports up to 80 nearby `drops[]` from **actual GameLocation.debris**. Only whitelisted construction materials (wood, stone, fiber, coal, sap) are presented. It reads the underlying debris item's qualified ID and first chunk's pixel position.
- When work allows gathering, `DropPlanner` chooses an observed drop. The command `pickup_drop` asks SMAPI to find the matching world debris again, computes up to four real collision-aware paths to its tile or an adjacent tile, and walks near it so the **native magnetic pickup logic** can work. The mod never invokes `Debris.collect` or adds items.
- Success requires the player's **actual bag count** of that item to increase. Drop disappearance on its own cannot count as collection. The M0 result UUID and unknown-result quarantine continue to apply.
- The simulator now models two distinct events: clearing an obstacle creates a world drop; a later pickup command moves near it and grants an earned item. Integration tests verify the separation and the inventory postcondition.
- Route failure memory for clearing resources is retained across player movement during the same game day, rather than being accidentally cleared after moving to an alternative tile.
- Wood, stone, fiber, coal and sap are protected from the generic ship-every-saleable-item policy. Storage still puts these materials in a nearby owned chest when inventory space is low.

## Local acceptance on a backed-up save

1. Quit Stardew/SMAPI and controller, back up save. `git switch main && git pull origin main` once merged.
2. Run `npm install && npm test && npm run typecheck`.
3. Build C# using installed game binaries:

```bash
GAME_PATH="/Volumes/lyle/SteamLibrary/steamapps/common/Stardew Valley/Contents/MacOS"
dotnet build mods/BigFishBridge/BigFishBridge.csproj -c Release -p:GamePath="$GAME_PATH"
```

4. Verify new DLL deployed into Mods and restart SMAPI. In a test save with ordinary farm twigs/rocks, run `node --experimental-strip-types src/index.ts --mock` with existing token.
5. Watch one resource tile get destroyed, observe a `drops[]` entry, then observe BigFish move towards it and **bag count increase**. Confirm no fake success if debris disappears into water, another player picks it up, or the bag stays unchanged.
6. Put rocks or trees between the player and a loose drop. Check that the native path search chooses another nearby reachable tile or reports failure, and the planner stops trying the same failed target after two attempts.
7. Verify resource stock remains available for storage/planning and is not accidentally shipped.
8. Repeat previous farmhouse/harvest/watering/sleep tests and check M0 command timeout recovery.

## Deliberate restrictions

- Only a whitelist of known resource items; arbitrary dropped quest items, weapons, gems etc. are not collected.
- Pathfinding is still native engine A*, with a bounded number of candidate positions per drop. This is **not** a complete collision grid or global route optimization layer.
- Node tests do not verify C# compilation, the true magnetic range, real-time debris movement or dropped material disappearing upon map reload.
- Eating and harvesting operations remain unchanged. Automatic crafting/chest creation, 2×2 clumps, full farm layout planning and persistent route learning belong to future M1/M2 work.
