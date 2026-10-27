# M1 — Real food recovery and material storage

Status: candidate implementation. SMAPI game compilation and live-state verification pending. This slice continues M1 after the forage pickup and farm resource clearing changes.

## Behavior
- Snapshot adds optional `food[]` containing **actual owned, positively edible** items and in-game stamina recovery estimates (read with `staminaRecoveredOnConsumption`). Quest items and Stardrops are excluded.
- `eat_food` is a single-item, whitelisted action. SMAPI selects the real inventory item and invokes `Farmer.eatHeldObject()` to use the game's normal eating animation and consumption. It waits for stamina to increase; a consumed item without stamina gain is **not** reported as successful.
- Node requires a fresh authoritative snapshot with **both** less of the same food in the bag and more stamina before confirming completion. M0 protects late or unknown results.
- Food planner acts at stamina <=80, only outside paused transitions, before 22:00, with 4 verified meals/day max and bounded failed-food retries; it does not generate food.
- Economy planner does not automatically ship the last edible supply (current shipping action empties whole stacks). It stores ordinary wood, stone, fiber and other safe non-sellable construction materials in existing accessible player chests when backpack space is low (<=2 free slots).
- Material targets now count items in owned chests as well as player inventory, so storage does **not** trigger unnecessary re-gathering.

## Test procedure on macOS
1. **Back up the save and stop BigFish/SMAPI.**
2. `git switch main && git pull origin main` after merge; run `npm install && npm test && npm run typecheck`.
3. `GAME_PATH="/Volumes/lyle/SteamLibrary/steamapps/common/Stardew Valley/Contents/MacOS"`
4. `dotnet build mods/BigFishBridge/BigFishBridge.csproj -c Release -p:GamePath="$GAME_PATH"`
5. Verify new DLL deployment into the game Mods folder, then restart SMAPI and BigFish with `node --experimental-strip-types src/index.ts --mock`. Use a **test copy** of the save.
6. Place two standard edible forage items in inventory and lower stamina using normal work. Verify BigFish selects only a positively edible non-quest item, uses the native eating animation, removes exactly one item, then observes stamina increase and keeps farming. Test a full backpack with a chest, and check non-food construction items are stored, food is reserved.
7. Force low stamina with no food: BigFish must not invent a meal, must not spam eat actions, and eventually use existing safe home/sleep policy.
8. Test failure receipt and Node restart while eating. M0 should quarantine the command if the result is unknown; don't delete the journal to override safety.

## Limitations
- The exact eating animation, timing and native game method compatibility **must be verified against the installed Stardew/SMAPI assemblies**; the Node CI cannot compile C# with game references.
- Energy planner is a simple bound, not yet a forecast of task requirements or food market opportunity cost.
- World debris from tree/stone destruction is **not** yet mapped to reliably collectable loose drops. Do not treat node disappearance as evidence material is in the bag. Nearby drop collection and obstacle-aware path planning are next.
- No automatic fabrication or buying of food, no fishing, no chest creation if there are no chests, and no farm blueprint planner in this slice.
