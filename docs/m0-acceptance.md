# M0 — In-game reliability acceptance and recovery runbook

Status: **implementation candidate in Draft PR #4**. No real Stardew/SMAPI compilation or gameplay validation has been performed by GitHub Actions. Test on a backup save; do not use a production livestream save.

## What M0 currently changes

- Command transport: a request has one UUID; Node isolates a timed-out in-flight UUID instead of allowing a second potentially destructive action. Late results use the same UUID and identical retransmissions get idempotent HTTP 200.
- The controller stores unresolved commands and bounded ACK history in ignored `data/bridge-commands.json`, using atomic write/rename. On controller restart it must reconcile the saved UUID with a fresh authoritative game snapshot (or a late failure receipt) before sending another command.
- The SMAPI mod suppresses recently seen command UUIDs (last 256), queues outbound result receipts and retries temporary HTTP failures. **This cache/queue is currently in-memory and does not survive a complete SMAPI/game process restart.**
- Snapshots include optional `pauseReason` = `none`, `menu`, `event` or `time_stopped`. `time_stopped` is deliberately neutral: it is NOT proof of focus loss.
- `GET /health` includes `connected`, `commandPhase` (`idle`/`running`/`unknown`), `commandAgeMs`, `paused`, `pauseReason`. `GET /command-status` requires the controller token and exposes the command UUID and late receipt.
- Controller prints **MANUAL ATTENTION REQUIRED** if a command is still unconfirmed after 45 seconds. It refuses to blindly reissue the action.

## Build and deploy on the user's macOS Stardew installation

1. Quit Stardew and stop `npm run start`; back up the test save before every run. Confirm `git status --short` is clean or stash unrelated modifications.
2. `git fetch origin && git switch --track origin/feat/m0-command-reconciliation-20261027` (or `git switch feat/m0-command-reconciliation-20261027 && git pull` when it already exists).
3. `npm install && npm test && npm run typecheck`.
4. `GAME_PATH="/Volumes/lyle/SteamLibrary/steamapps/common/Stardew Valley/Contents/MacOS"`
5. `dotnet build mods/BigFishBridge/BigFishBridge.csproj -c Release -p:GamePath="$GAME_PATH"`
6. Verify the built DLL and deployed `$GAME_PATH/Mods/BigFishBridge/BigFishBridge.dll` match (e.g. `shasum -a 256` for both). If ModBuildConfig has not deployed it, copy it only with the game stopped and verify hashes.
7. Start game via SMAPI, enter backed-up save, and start the controller using its **existing** `BIGFISH_TOKEN`: `node --experimental-strip-types src/index.ts --mock`. Only one Node controller per port.
8. After deterministic smoke test succeeds, stop mock process and run `npm run start` with configured Pi model.

## Real-game smoke matrix (record SMAPI and Node logs)

| Case | Procedure | Required evidence |
| --- | --- | --- |
| Entry and movement | Start day inside FarmHouse; travel out to Farm; traverse clear tile | actual location/coordinates change, single result UUID, path progress log |
| Farming | Equip watering can, water dry crop; equip hoe and till tile; plant; harvest ripe crop | selected real tool, soil/seed/inventory deltas, meaningful tool visuals documented |
| End of day | Return to FarmHouse and sleep on appropriate schedule | next day/season state, no duplicate sleep command |
| Warp / transient pause | Cross map while snapshot is temporarily stale | correct `pauseReason`, no false claim of action failure |
| HTTP result retry | Temporarily interrupt only Node controller's HTTP service while a safe command finishes (backup save first) | SMAPI retries result; controller restarts, preserves UUID in local journal and blocks new work until reconciled |
| Duplicate result | POST an identical result receipt for a completed UUID through authenticated bridge | HTTP 200 `duplicate:true`, no extra game mutation |
| Unknown command | Force a short timeout with a **non-destructive test action** | `commandPhase=unknown`; no duplicate /next command; prominent warning and no new mutations |
| Save isolation | Return to title, load different save | no accidental cross-save execution; stale saved command remains quarantined until manually reviewed |

### Checking health and result status

```bash
curl http://127.0.0.1:45931/health
# Use the configured secret in the same terminal (do not paste its actual value into logs):
curl -H "x-bigfish-token: $BIGFISH_TOKEN" http://127.0.0.1:45931/command-status
```

If `commandPhase=unknown`, **do not delete the journal or reissue the action while the game is running**. Stop automation, inspect whether the action actually changed the game (location/day/inventory/gold), and collect the recent SMAPI/Node logs and the command ID. If you need to reset this state for a disposable backed-up test, quit both processes, preserve a copy of `data/bridge-commands.json`, then reset only after manually reconciling the save. Deleting the journal is an unsafe recovery method for a running farm.

## Remaining M0 blockers before merge

- **Must compile C# against local Stardew/SMAPI assemblies** and fix any compile errors; CI only checks the Node side.
- **Must pass at least three consecutive real-game days** with recorded tool/warp/sleep traces and no false duplicate actions.
- C# result queue/ID cache not yet disk durable; a simultaneous game+Node crash still requires explicit manual recovery and a documented policy.
- Faithful player/tool animations are not implemented. The current `Hoe.DoFunction` and `WateringCan.DoFunction` do real game effects without the entire normal player input/animation sequence. Do not claim animation parity until in-game verified.
- The existing daytime `goHome`/sleep behavior in main is an unrelated gameplay-strategy problem; separate Draft PR #2 explores a temporary policy, not a fully learned farm planner. It is **not** solved by this M0 transport patch.
- A working fully autonomous livestream still needs M1 material gathering and M2 planning; safety gating, logging and command reconciliation are prerequisites, not gameplay content.
