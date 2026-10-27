# M1 — Farm resource clearing (axe, pickaxe, scythe)

Status: **candidate implementation, C# / live-game acceptance pending**.

## Implemented

- A new `resources[]` snapshot reports at most 120 resource nodes on Farm, with kinds `tree`, `stone`, `twig`, `weed`, and per-node health/durability.
- Only full-grown *non-fruit* trees not fitted with a tapper and not already stumps are eligible. Only naturally occurring stone, twig and weed objects (via game object classification APIs) are eligible; **no chests, craftables, floors, or player-placed equipment are targeted**.
- Weeds within two tiles of a planted crop are excluded because native scythe attacks have an area of effect.
- `clear_resource` is **one tool strike per command** using the equipped in-game axe, pickaxe, or scythe. A strike is successful only if the target disappears, becomes a stump, or loses recorded health/durability.
- The agent checks energy (at least 65 before planning), inventory space, in-game time (before 18:00), and quotas (14 tool strikes daily; at most 8 on trees). The game checks location, proximity, minimum stamina and the actual resource/tool again.
- The planner aims for a conservative starter stock of 50 wood, 30 stone and 15 fiber; the model's narration may change, but the selected target cannot be overridden by the model.
- Resources are acquired through game tool side effects, not direct inventory modification. The simulator grants resources on object destruction only and verifies multi-hit behavior.

## Verify before relying on the code

1. Quit SMAPI and controller. Back up the actual save.
2. Update to the branch/merge commit. Verify Node `npm test` and `npm run typecheck`.
3. Build with the actual Mac game assemblies:
```bash
GAME_PATH="/Volumes/lyle/SteamLibrary/steamapps/common/Stardew Valley/Contents/MacOS"
dotnet build mods/BigFishBridge/BigFishBridge.csproj -c Release -p:GamePath="$GAME_PATH"
```
4. Verify that the built DLL was deployed into `$GAME_PATH/Mods/BigFishBridge/`; compare compiled/deployed checksums if ModBuildConfig did not automatically copy.
5. Start SMAPI and an isolated backed-up save. Run `node --experimental-strip-types src/index.ts --mock`, keeping the same existing BIGFISH_TOKEN.
6. Confirm tool switching and real side effects: remove one stick with the axe, one ordinary farm stone with pickaxe, one isolated weed with scythe, strike a mature untapped tree repeatedly, inspect wood/stone/fiber drops and energy; see resource node disappear or health fall in snapshots.
7. Verify crop/objects and tapped trees stay untouched. Verify failures on unreachable tiles cause alternative target choice. Verify the quota and low-energy policy.
8. Re-test 3-day farm crop/warp/sleep cycle with the previous M0 telemetry, then test with `npm run start`.

## Known limitations

- C# game DLL compilation and actual tool animation cannot be verified in the GitHub Node CI; **never claim full gameplay success based on CI alone**.
- Resource drops can appear as game world debris before entering the bag; one correct tool hit need not immediately increase inventory. They may require nearby movement to collect.
- Full obstacle-aware navigation, chests organization, eating/energy replenishment, 2x2 resource clumps, protected tree plots, tool upgrades and general mining are not implemented in this slice.
- The simple quota and material reserves are placeholders until the M2 learning-based farm task planner chooses construction requirements and layout.
