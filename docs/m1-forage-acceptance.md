# M1.1 — Foraging vertical slice

Status: staged for main after successful Node CI. This implements **wild object pickup**, not the full M1 roadmap (trees, rocks, weeds, eating/energy recovery and material planning remain outstanding).

## What is real

- The game mod enumerates `GameLocation.objects` and exports only spawned, ordinary (O) objects at valid map tiles as `forage[]`.
- `collect_forage(x,y)` checks player proximity, object presence, ownership of inventory space and calls the game's `GameLocation.checkAction`. It **does not add items manually**.
- Successful collection is determined by the source object disappearing. The game engine manages pickup animation, quality and foraging skill experience.
- Node validates the current `forage[]` and inventory space. A command is confirmed by a fresh game state where that observed forage item has disappeared. M0's command UUID/outcome protocol continues to protect uncertain actions.
- `ForagePlanner` chooses observed items, tries nearby approach tiles with bounded failure tracking, visits at most a few supported map locations once per day, and then yields control back to farm/home policy. It must not repeatedly tour the same map.

## Manual test on backup save

1. Stop both Node and the game, `git pull origin main` after the merge, `npm install && npm test && npm run typecheck`.
2. Build the C# mod with your installed game assemblies:
   ```bash
   GAME_PATH="/Volumes/lyle/SteamLibrary/steamapps/common/Stardew Valley/Contents/MacOS"
   dotnet build mods/BigFishBridge/BigFishBridge.csproj -c Release -p:GamePath="$GAME_PATH"
   ```
3. Confirm the compiled `BigFishBridge.dll` is deployed to the game Mods folder (compare hashes). Restart Stardew/SMAPI.
4. Use a backed-up save with a visible forage item in a reachable area. Start `node --experimental-strip-types src/index.ts --mock` using the existing matching `BIGFISH_TOKEN`.
5. After crop maintenance, verify `[bigfish]` reports `collect_forage` (or `move_to` followed by `collect_forage`) on the real map, watch the character pick up the item, and verify the item enters inventory and disappears from ground. Check no duplicate pickup.
6. Verify a map with no forage is visited at most once as part of the bounded trip; when inventory is full or energy is low, the forage plan should stop rather than spamming commands.
7. Then stop the mock process and run `npm run start`; verify that the LLM cannot override the planned forage target and that the next snapshot confirms the inventory/world delta.

## Known limitations / next M1 slice

- The nearest approach tile is chosen from geometrical neighbors, not a pre-scanned collision grid. If blocked, bounded alternate targets are tried; full obstacle-aware foraging pathfinding is **not** implemented.
- Today's collection route uses a small fixed list of map names; it has no persistent known spawn-probability or season/weather model.
- Trees, stones, weeds, resource clumps, food/eating, resource storage and farm clearing are **not implemented**.
- Genuine macOS SMAPI compile and game interaction remain mandatory even when TypeScript CI is green.
