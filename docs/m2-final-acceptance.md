# M2 final integration — multi-day autonomy and evidence-backed economics

**Status: Node implementation and simulated acceptance candidates. Live SMAPI Mac acceptance REQUIRED.**

## Architecture and execution

- **Bounded Pi objective proposal**: Pi's agent (no tools) may choose 1–3 goals among `expand_fields`, `build_storage`, `automate_watering`, `save_gold`, plus a 3–7-day horizon, field target (1–20) and minimum cash reserve (100–5000g). Arbitrary AI-generated action IDs, fabricated inventory and off-map goals cannot pass the strict parser.
- **Validated task DAG**: `src/campaign.ts` expands proposed goals into dependencies (prepare soil → plant crops; wood → craft chest → place chest; survey sprinkler → collect recipe ingredients → craft → install → prove watering; reserve cash). Status is refreshed **only from authoritative game observations**. Missing smelting/mining/locked recipes mean **blocked**, never completed.
- **Actual priority effects**: the active campaign adjusts the seed target/field plan and emergency gold floor; the farm resource planner avoids permanent fixed wood/stone/fiber targets for unrelated campaigns. Existing deterministic farm/economy/M0-safe game actions retain full world authority. A campaign may remain blocked; it cannot grant nonexistent game capabilities.
- **Durable plans**: `GoalMemory` persists the campaign and day plans in the existing JSON file, scoped by actual save ID; a multi-day campaign expires on the correct in-game ordinal even over season/year rollover. Pi's in-memory conversation resets on a save switch, preventing cross-save strategy contamination.
- **SQLite evidence**: the real Pi controller writes `data/bigfish-history.sqlite` (Node 22 built-in `node:sqlite`, no extra service); `--mock` and `--demo` write **separately** to `data/bigfish-history.mock.sqlite` and do not count toward production acceptance. Rows include deduplicated verified command IDs, observed energy use, gold deltas and settled day outcomes. Every query is scoped by save ID and uses parameter binding. Reported cash change is **not net crop profit**.
- **Economics**: `src/investment.ts` explicitly distinguishes known shop seed prices from unknown acquisition costs, estimates base sale margins with caveats, measured daily watering energy, and estimated sprinkler labor savings without inventing a gold payback date.

## Automated tests

Run:

```bash
npm install
npm run typecheck
npm test
```

New tests cover invalid model proposals, DAG cycle detection and truthful status, 3–7 day/season/year boundaries, save switching, SQLite replay deduplication, cross-save metrics, unknown costs, and seven in-game days via actual mock HTTP bridge commands and a restart of persisted campaign state. Existing M0–M2.5 tests must continue passing.

**These tests are synthetic.** Seven simulated days do **not** establish seven real Stardew days, farm ROI, or reliable gameplay on a Mac.

## Mandatory real-game signoff on user's Mac

1. Back up the Stardew save, quit the game and controller. Checkout merged main and run Node checks.
2. Compile C# game bridge against installed Stardew/SMAPI assemblies:

```bash
GAME_PATH="/Volumes/lyle/SteamLibrary/steamapps/common/Stardew Valley/Contents/MacOS"
dotnet build mods/BigFishBridge/BigFishBridge.csproj -c Release -p:GamePath="$GAME_PATH"
```

3. Compare game Mods deployed `BigFishBridge.dll` to build output. Launch SMAPI, use the backed-up save, run BigFish in mock first, then with Pi after building and verifying the game DLL.
4. Monitor `[campaign]` goal selection and DAG, `[farm-work]` resource tasks, `[farm-plan]` field/seed decisions, `[sprinkler]` pending and installation state, and SQLite recorded days.
5. Observe at least **seven consecutive real game days** with authentic tool animations and changing seasons where feasible; ensure harvest, water, seed purchasing, store/withdraw, crafting/installing and native verification work. Confirm planned reserves are not spent and inaccessible steps become blocked rather than loop forever.
6. Restart the controller during a valid game day, observe goal/history recovery; switch between two backups/saves and verify goal/model conversation separation. Simulate lost ACKs/timeout: command journal must quarantine unknown side-effects before any retry.
7. Compare net observed wallet change and action energy from SQLite to the save. Test day rollover and one unavailable recipe, full bag and no money to confirm safe fallback.
8. After seven real days in **production Pi mode**, run `npm run m2:report`. It checks the active save ID, **seven consecutive** recorded game-day ordinals, a persisted valid campaign, and at least one verified action. If evidence is insufficient it exits nonzero and reports `pending`. It deliberately **does not** assert C# compile or real-world game quality; finish the above manual checklist before signing off.

## Completion criteria

- Node/autonomy code can be merged after all automated checks.
- **M2 gameplay completion cannot be declared** until a successful local SMAPI compile, deployment verification, seven real-game-day acceptance and remaining blocking defects are resolved.
- Unsupported new skills (ore mining/smelting, quests, fishing, NPC interactions) are not silently added to M2 scope. They remain later game-skill milestones.
- Node 22 `node:sqlite` is marked experimental upstream; verify compatibility with the installed Node 22.16+ runtime and revisit if long-term durability requires a stable driver.
