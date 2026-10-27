# M2.5 — Recipe-gated real sprinklers, placement and observed irrigation

**Status:** Candidate implementation. CI verifies the Node controller and simulator; actual SMAPI C# compilation and game-save acceptance on the user's Mac remain mandatory before unattended streaming.

## Authoritative inputs

- SMAPI reports the three ordinary item IDs: basic `(O)599`, quality `(O)621`, iridium `(O)645`. They are **not** `(BC)` objects.
- The snapshot obtains the installed game's `CraftingRecipe.recipeList`, `player.craftingRecipes` learned status, real backpack ingredient sufficiency and actual sprinkler item stacks. No material is conjured. Modded category-ingredient recipes are deliberately rejected until specifically supported.
- Farm-only `installedSprinklers[]` comes from real `GameLocation.objects` with `IsSprinkler()`. `sprinklerSites[]` is a bounded currently observed map patch, requiring native placeability, no tile occupancy, no crops/terrain features and no `NoSprinklers` prohibition, plus entry/exit and shipping-bin buffers. It is **not** an instant full-farm scan.
- `isRaining` comes from the location weather rather than inferred climate.

## Behavior

1. With an actual M2 farm plan and observed sprinkler candidates, BigFish picks **one** investment goal per save, persisted in `data/bigfish-memory.json`. Its displayed ingredients are read from the installed game recipe. Prioritizes available finished kits or craftable recipes and at least 2 planned crop tiles worth of irrigation.
2. If actual ingredients are missing: `materials_needed` is retained. When materials are already in a nearby owned chest, the planner may retrieve them using the existing real `withdraw_item` action. Without bars/refined quartz/battery packs it **does not** spawn them, mine, or claim construction complete. Automated smelting, mining and bar purchasing are out of scope.
3. If recipe learned and ingredients held: `craft_sprinkler` consumes the native recipe via `CraftingRecipe.consumeIngredients`, adds a real item to inventory, and checks that all listed ingredient counts went down and the right sprinkler count increased. This does **not** show the game crafting-menu animation.
4. If a real sprinkler kit exists: the planner approaches the previously observed non-field candidate. The game checks tile proximity, `NoSprinklers`, occupancy and placeability again. `place_sprinkler` calls the native `Object.placementAction`, requires an installed object of the same actual qualified item ID, then consumes exactly one kit.
5. Controller command confirmation requires actual kit increase and ingredient consumption for crafting; for installation it requires the kit decrease and new `installedSprinklers[]` entry at the action tile. Unknown results remain quarantined under M0.
6. Installation is **not** proof the sprinkler saved watering work. On a **later**, non-rainy morning before 08:50, and only when an observed crop inside its ordinary base-coverage geometry is actually wet, the persisted project status becomes `watering_verified`. If there are no covered crops, it stays `installed`. This is observational evidence, not a randomized causal experiment; no fertilizer/nozzle assumptions.
7. Automatic shipping now reserves copper, iron, gold and iridium bars, refined quartz and battery packs for construction.

## Mac acceptance on an isolated, backed-up save

1. Stop controller and Stardew/SMAPI; make a backup. After merge run `git switch main && git pull origin main && npm install && npm test && npm run typecheck`.
2. Compile against real local game assemblies:

```bash
GAME_PATH="/Volumes/lyle/SteamLibrary/steamapps/common/Stardew Valley/Contents/MacOS"
dotnet build mods/BigFishBridge/BigFishBridge.csproj -c Release -p:GamePath="$GAME_PATH"
```

3. Verify updated BigFishBridge.dll deployed to active Mods location; launch SMAPI. Inspect `/state`: `sprinklerRecipes[]`, `sprinklerKits[]`, `installedSprinklers[]`, `sprinklerSites[]`, `isRaining`.
4. Prepare one legitimate basic sprinkler recipe, one copper bar, one iron bar, and two crop tiles adjacent to a naturally placeable site on Farm. In mock mode see `[sprinkler]` go through `ready_to_craft` → `ready_to_place` → `installed`. The game should deduct bars and leave an actual sprinkler on the selected tile.
5. Check with no bars, locked recipe, blocked plot, full bag, unobserved tile or already installed device; the agent must not fabricate items, override the planned field, or repeat confirmed commands.
6. Sleep; on a dry next morning inspect watering around the installed sprinkler and compare to unwatered control plots. If there's no planted crop in range or it rains, `watering_verified` must not be recorded just from installation.
7. Stop/restart controller and change saves. Existing project must restore only for the matching save; M0 unknown commands cannot trigger duplicate tool operations.
8. Re-run earlier M1 clearing/foraging, M2 cash reserve, chest building and map planning acceptance.

## Limitations and next M2 work

- All SMAPI code depends on the user's specific Stardew Valley 1.6/SMAPI assemblies. **GitHub CI does not compile C#**; this implementation is unverified in the user's game until local compile + smoke tests.
- The tool works only with learned recipes and obtainable ingredients; BigFish still needs authentic ore mining, furnace smelting, purchase plans and better price/time comparisons.
- The 15×15 placement scan and geometry rank don't account for every multiplayer/changing-map edge case. Game-native validation is repeated at execution.
- The first saved goal is conservative: one sprinkler per save unless a future multi-build planner advances it; there is no claim that the entire farm is now auto-irrigated.
- Full long-horizon farm ROI and learning from seasonal outcomes remain future work.
