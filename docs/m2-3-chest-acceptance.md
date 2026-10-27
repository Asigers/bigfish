# M2.3 — Verified first chest construction and local placement survey

Status: **candidate code**, implemented on PR #11. Native SMAPI C# compilation and actual Stardew gameplay acceptance are outstanding. Do not use an irreplaceable livestream save to test.

## Implemented (vertical slice)

- `GameState.chestKits` is the actual count of player-held `(BC)130` wooden chests. `canCraftChest` requires a learned **Chest** recipe and genuine ingredients. The SMAPI snapshot reports at most 80 candidate `placementSites` near the farmer, filtered by native `CanItemBePlacedHere`, map bounds, terrain features, existing objects, and a safety buffer around the initial shipping bin and warps. **Only surveyed sites are eligible; this is not a global farm map.**
- `craft_chest`: game-thread operation verifies the recipe is known, the output is the real `(BC)130` chest, 50 wood is in the backpack, and a slot is available. It uses `CraftingRecipe.consumeIngredients` and adds the native recipe result to the actual inventory. Completion requires observed wood decrease and chest-kit increase. The controller never manually inserts a chest into a map from a fictitious item.
- `place_chest`: requires a real crafted kit, nearby surveyed site, and a second **fresh** game-native placement test. Calls `Chest.placementAction` and decrements the kit stack only if a player-owned chest is actually on that tile. Completion requires kit decrement and a new owned chest in the `economy.chests` snapshot.
- The multi-day task graph now includes `craft_chest → place_chest`, both progressing from real state. A pre-existing chest already satisfies the first storage-construction goal: the planner never crafts duplicates just for the sake of activity.
- `InfrastructurePlanner` executes construction only after farming/economy tasks are exhausted, avoids current and protected field tiles, and caps retries on failing tiles/skills. It does not override watering, harvesting, or forced rest.
- Simulator and Node tests model two real separate stages: 50 wood consumed → kit in inventory → move to a real surveyed tile → new placed chest.
- Prevent old-save strategy text from being sent to Pi when a different game save is loaded.

## Verify on user's Mac

1. Exit both game and BigFish; back up a test save before editing it. Checkout latest main after merge and run `npm install && npm test && npm run typecheck`.
2. Build against local game assemblies:
```bash
GAME_PATH="/Volumes/lyle/SteamLibrary/steamapps/common/Stardew Valley/Contents/MacOS"
dotnet build mods/BigFishBridge/BigFishBridge.csproj -c Release -p:GamePath="$GAME_PATH"
```
3. Verify `BigFishBridge.dll` was deployed to `$GAME_PATH/Mods/BigFishBridge/`. Restart Stardew via SMAPI and open the test save.
4. If no player chest exists on the farm, gather 50 wood **into the player's backpack**. Make sure the real chest recipe is unlocked and there is one empty inventory slot. In mock controller mode, wait until farm work completes and inspect `[farm-work]` for `craft_chest:ready`.
5. Observe `craft_chest` and the inventory change (50 wood gone, one actual chest kit). Then `place_chest` on a nearby, engine-approved tile away from planned fields/warps/shipping bin. Confirm the chest is in game, has correct player ownership and is usable.
6. Repeat in a farm with an existing chest: no needless crafting. Try moving to a different farm map position, blocked tiles, a full bag, a locked recipe, insufficient materials and an interrupted command; no duplicate result or injected item should occur.
7. Restart controller and switch between two different saves. `data/bigfish-memory.json` should not transfer old save's project or model strategy notes. Existing M0 command recovery should still quarantine unknown outcomes.

## Known limitations

- Native `CraftingRecipe` and `Chest.placementAction` calls are based on Stardew 1.6 game API source but **have not been compiled against user's game** in GitHub CI; compiler/runtime behavior and animation parity need local acceptance.
- There is no full-farm map/collision graph or guaranteed safe long-term access route; only a bounded local placeability survey with access buffers. Sprinklers, paths, floors, building footprints and farm zoning remain future M2.4.
- Crafting is performed through the game recipe API, **not the in-game player menu animation**. Do not claim faithful UI animation. A complete atomic material rollback on an unexpected game inventory failure is not implemented; use backup saves.
- Chest construction is an initial production skill, **not an LLM-generated arbitrary crafting pipeline**. Future task generation must validate game recipes, inventory reservations, dependency graphs, costs and observed completion.
- This slice does not solve late-day sleep strategy or all previous game's SMAPI compile uncertainties.
