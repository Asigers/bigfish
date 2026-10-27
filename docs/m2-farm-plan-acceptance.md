# M2.1 — Farm blueprint, seasonal crop economics, and measured re-planning

**Status:** First M2 implementation slice. This is **not** the finished autonomous farm brain, and the C# changes still need compilation and three-day real-game acceptance on a backed-up Mac save.

## Real inputs

- SMAPI reports `cropCatalog[]` from the **installed game's** `Game1.cropData` (season, growth phase total, regrowth, harvest item, min yield, watering, trellis) and `Game1.objectData` (base harvest sale price). No prices/yields are invented by the language model.
- Existing crops optionally report their seed ID. Unknown crops may report `seedId:null`; the bridge accepts that without rejecting the entire snapshot.
- `tillable[]` is still **nearby discovered terrain**, not a full farm-wide collision grid. The planner never invents map cells outside actual `crops[]`, `emptyPlots[]`, `tillable[]`.
- `ShopOffer.price` is the **actual observed seed purchase price**, distinct from seed sell value. A crop's estimated net margin stays `null` when the purchase price has never been observed.

## Planner and execution

1. On each game day, Pi can still choose a bounded `profit / expand / save` strategy; the deterministic farm planner converts it to a field target of at most 20 tiles, considering observed plots, available tillable land, remaining stamina, and day of season.
2. The planner prefers connected/nearby existing field cells, excludes observed resource/forage obstacles and a buffer around shipping bin/warps. This is a **partial field blueprint**, not a guaranteed complete collision-safe layout.
3. Only crops that can reach first harvest before the current season ends are considered. Trellis crops are excluded in this slice to avoid obstructing paths. Potential regrowth is included in conservative base-revenue forecasts.
4. With actual merchant offers, compare estimated **per-game-day gross margin** (minimum harvest quantity × base sale price × predicted harvest cycles − observed seed price). This ignores quality bonuses, fertilizer, daily labor, possible crop failures and taxes; it is not a guaranteed result.
5. At the farm, `Autopilot` now sows valid seasonal seeds and tills only planned cells; existing crop watering and harvesting remain higher priority.
6. The economy planner uses planned target minus **remembered occupied crop plots**, then deducts already-owned seed stacks. Since entering the shop removes farm crop observations, the farm's occupied count is persisted to avoid overbuying.
7. Seed shopping is suppressed if no observed crop can mature before season's end. If metadata is absent (older Mod), the old policy remains as a backward-compatible fallback.

## Memory and genuine feedback

- `data/bigfish-memory.json` now persists `farmPlan`, `dailyProgress`, and up to 14 `farmOutcomes`. The plan is scoped to save ID and day, with strict restore validation.
- Only a confirmed planting/watering/harvest action (or an authoritative failure) counts in daily progress. HTTP command acknowledgment without a matching fresh game-state observation does **not** count as a verified farming outcome.
- At the next game day, the previous outcome is archived. Morning gold includes the game's overnight shipping settlement; `closingGold − openingGold` is a cash change, **not** crop-only profit.
- If the previous day had three or more failed farming actions, the next target shrinks by two (never below already planted cells). A productive failure-free planting day may expand by two, within stamina/space limits.
- Pi receives the latest measured day summaries when deciding a new high-level strategy; it cannot bypass tool or world validators to create impossible profit.
- Evidence of improvement must be visible over several days; this is **rule-based adaptive learning from real outcomes**, not online neural-network fine-tuning.

## Test on Mac before using an unattended save

1. Back up the game save and stop BigFish/SMAPI.
2. Update the branch, run `npm install && npm test && npm run typecheck`.
3. Compile against the actual installed game:
```bash
GAME_PATH="/Volumes/lyle/SteamLibrary/steamapps/common/Stardew Valley/Contents/MacOS"
dotnet build mods/BigFishBridge/BigFishBridge.csproj -c Release -p:GamePath="$GAME_PATH"
```
4. Verify the DLL was deployed, restart SMAPI and load a **test save** with spring crops.
5. In `--mock`, observe `[farm-plan]` for planned cells, seasonal crops and seed ID. Check that till/plant actions stay within the displayed plan and that native watering/harvest still function.
6. Reach Pierre, compare logged actual offers to the preferred seed: verify no overbuy when crops were already planted before leaving Farm.
7. Advance to day 27 with only slow crops available: no seed shopping for crops that cannot finish before season end.
8. Simulate three failed tool actions in a backed-up test and inspect the next-day target reduction. Restart the controller; verify the plan/day outcomes persist but do not leak to another save.
9. Re-run M0 command recovery plus M1 forage/resources/eating/drop tests.

## Limits and next M2 slices

- **No global farm collision/zone map**, sprinklers, chest placement, crafting, quests, animals or buildings yet.
- The crop value estimate uses base sale price and minimum harvest. It is intentionally cautious and does not model quality, fertilizer, energy/time labor cost or price changes.
- Unknown crop rules and unsupported locations (greenhouse, seasonal overrides, multi-season behavior) need dedicated checks, not speculative recommendations.
- The current Pi strategy controls high-level objectives; a future M2.2 step will let it propose a **validated multi-day task DAG** with material reservations and explicit alternatives.
- Prior premature daytime sleep strategy is not removed here; the current Autopilot's `goHome()` remains separate technical debt.
- Passing TypeScript CI **does not** prove the new SMAPI crop API code compiles or plays correctly on the user's Mac.
