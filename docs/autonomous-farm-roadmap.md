# BigFish — Autonomous Farm & Livestream Roadmap (proposed)

Status: **design proposal**, not implemented. Baseline: BigFish v0.3 on main. This document does not supersede the unfinished early-sleep/itinerary PR #2. Prioritize observed progress rather than aimless travel or idle loops.

## Product contract

BigFish should develop and execute a **multi-day farm strategy**, keep earning and progressing when crops are growing, and explain real decisions to livestream viewers. "Learning" means a durable loop of observation → hypothesis/plan → executable tasks → measured results → calibration → revised plan. It does not mean fine-tuning the foundation model after every action.

Non-goals: fabricating items/money/fish, warping around locked doors, instant fishing catches, manipulating game saves directly, or having the LLM send frame-by-frame inputs. Only in-game-legal operations performed through game mechanics count as success.

## Architecture: keep reasoning separate from reflexes

1. **SMAPI sensory layer (C#):** read authoritative game state and map semantics on the game thread; stream *delta events* when appropriate. Include map obstacles, interactable objects, resource nodes, tree/debris, forage spawns, fishable water, NPCs, weather, crop phase and quality, skills, active quest milestones, crafting recipes, tool upgrades, buildings, farm machinery, movable bin/chests, and live minigame state. Handle unknown modded assets safely.
2. **Primitive motor and skill layer (C#):** pathfinding, proximity/interaction, tool selection + natural animation, resource interactions, fishing rod cast/hook/reel and local high-frequency minigame control, contextual dialogue/shop/menu interactions. Every skill exposes preconditions, progress, completion evidence, timeout, and explicit failure category; never simply mark success because an API call returned.
3. **World model and knowledge (Node/TS):** structured snapshot; data tables read from game assets (e.g. Data/Crops, Data/Objects, Data/Shops, Data/Locations, Data/Fish); unknown areas and incomplete observations flagged, not guessed. Store map tiles/layouts and durable, structured facts.
4. **Goal planner (Pi, low frequency):** produce competing goals, choose an objective, propose an *ordered task graph* with resource/time budget and measurable expected results. Example: save 800g → obtain parsnip seeds → clear six tiles near water → plant/water → earn by day 7.
5. **Deterministic scheduler/executor (Node):** convert the approved task graph to available skills, continuously validate world preconditions, reserve money/items and route time, execute one mutation at a time. Replan on unexpected state or failed prerequisites. The LLM **must not** turn structured narration into unvalidated actions.
6. **Learning & evidence ledger (SQLite suggested):** actual results, costs, failures, changes in predicted profit/growth rates, discovered safe routes, success rates for fishing, outcomes of multi-day plans. Summarize periodically for Pi; raw events stay queryable.
7. **Livestream director:** viewer-facing goals, reasoning summary, achievement clips, event-based expressions, commentary cooldowns, chat suggestions as inputs to the goal scheduler rather than direct in-game commands.

## Skill interfaces and essential schema

A high-level goal is not a primitive action. Example:
- Goal: "Expand my profitable spring field to 20 watered plots before day 10".
- Steps: inspect layout → price crops → reserve emergency gold → obtain seed stock → clear accessible area → till/plant/water → maintain → harvest/ship → compare actual with forecast.
- Primitive skills: inspect_area, route_to, interact_at, collect_forage, clear_debris, chop_tree, break_rock, equip_tool, eat_food, buy_item, move_to, till_tile, plant_seed, water_tile, harvest_crop, craft_item, place_item, fish_cast, fish_reel, speak_to_npc, give_gift, accept_quest, sleep.
- Skill result: {id, phase, ok, startSnapshotId, endSnapshotId, evidence, elapsedGameMinutes, energyDelta, inventoryDelta, goldDelta, failureCode}. Phase: accepted/running/committed/reconciled/failed/unknown. Acknowledge/reconcile separately.
- World observation: {saveId, date, time, weather, energy, skills, inventory, gold, farmGrid, objects, interactables, exits, npcVisibility, questJournal, fishableAreas, equipment, gameMode}.
- Task: {goalId, type, preconditions, target, reservation, estimatedCost, expectedEffect, priority, deadline, recoveryPlan}.

All actions must be whitelisted with argument bounds and authoritative validation in both Node and SMAPI. The bridge must not leak secrets, save paths, or credentials to the OBS overlay.

## Gameplay expansion milestones (incremental vertical slices)

### M0 — Stabilize and instrument (blocker)

- Preserve working move/travel/water/harvest; verify actual SMAPI build on a backed-up save.
- Full command lifecycle, durable idempotent acknowledgment, state reconciliation on warp/day transition, no indefinitely unconfirmed command or silent repeated failed action.
- Game pause reason separated into menu/cutscene/focus/transition; log game time, energy, selected tool, location and task ID.
- Natural tool visuals validated against real game; do not direct-mutate crop state or inventory to fake results.
- Acceptance: 3 consecutive real-game days: exit house, water/plant, return, sleep; no duplicated command, no incorrect sleep before objective/time/energy condition.

### M1 — Productive exploration and material gathering

- New sensors: traversable/collision-aware tiles, forage item spawns, trees/wood/stone/grass/weeds, dropped items, safe tool targets, inventory capacity and resource counts.
- New skills: collect_forage, clear_debris, chop_tree, break_rock, pick_up, eat_food, resource-based storage.
- Navigation works by physical interaction point, not just direct graph warps. Maintain obstacle/collision/failure memory by map version; temporary obstacles expire.
- New strategic alternatives: stockpile starter wood/stone, forage for quick cash/food, clear paths and field space, with explicit energy reserve and anti-deforestation limits.
- Acceptance: after watering, collect accessible forage and gather a specified number of resources without leaving items behind or exhausting all energy. No repeated loop over inaccessible targets.

### M2 — Farm planning (the main intelligence milestone)

- Read crop data from the game installation: seed buy price, growth/regrowth, legal seasons, harvest output, quality ranges, sale values, season days remaining, and available local stock.
- Build a farm-grid model with zones: house paths, shipping bin, field plots, watering access, future sprinkler cells, paths, chest/storage, reserved expansion and obstacles.
- Produce multiple candidate layouts and 3–7 game-day schedules under constraints of **gold, tile reachability, water/energy/time, season deadline and inventory space**. Reject infeasible plans.
- Forecast cash flows with simple expected-profit models (including seed and tool costs, probability of watering delays and replanting). Compare alternatives based on goal utility rather than always choosing the cheapest seed.
- Persist a chosen layout blueprint and adjust it after observing actual collisions, labor costs and revenue; show both projected and actual profit.
- Add atomic multi-day task tracking, resource reservations, task dependency graph, partial completion recovery and reasons for revising a plan.
- Acceptance: start from the same save, create a nontrivial field, purchase valid seed stock, harvest and ship before season end, preserve needed cash/tools; demonstrate at least one explainable *plan revision* driven by observed cost/outcome.

### M3 — Fishing as a genuine closed-loop skill

- Preconditions: verify actual fishing rod in inventory; acquire it legitimately, verify fishable tile, current weather/time/location and stamina.
- SMAPI fishing state machine: approach shore → face water/cast rod → wait for bite → hook → play minigame → collect catch/treasure → verify inventory and stamina → clean up.
- **Fast control lives in the SMAPI mod**, not in one LLM call per frame or one 200ms HTTP command. Read local minigame state and adjust press/release decisions deterministically, with conservative recovery and explicit stop conditions.
- Record cast location, weather/time, bait/rod, reaction, fish type, catch/miss, time/energy cost. Use actual game mechanics; no injecting fish, forced success, or bypassing fish availability.
- Use Data/Fish and Data/Locations as *prior knowledge* to choose fishing spots; calibrate expected gold/game-hour from real catches. Plan fishing on rain days or when the farm has no urgent maintenance.
- Acceptance: repeatable full rod animation and real catch/miss sequence; nonzero beginner-fish catch rate, no invented inventory, safely abandon difficult minigames, no lost command after exiting a menu.

### M4 — NPC, quest and town economy

- Read NPC positions, schedules, friendship/events and available quest objectives. Make actual interaction available: talk, limited gift, real shop UI transaction, accept/turn in quests, purchase tools/materials when valid.
- NPC safety: respect locked locations, menu state, festivals, daily gift limits and finite inventory; do not bypass story progression.
- Example task graph: earn friendship by talking near NPC schedule, buy a missing ingredient, craft a quest item, deliver it and verify quest progress.
- Acceptance: visit the right NPC at the right time, successfully complete one lawful repeatable interaction and log the evidence.

### M5 — Crafting, sprinklers, layout execution and longer progression

- Add crafting/placement, sprinklers/scarecrows, chest management, building upgrades, tool upgrades, animal care and production machines in vertical slices.
- Multi-day dependencies: gather wood/stone → craft/place chest/scarecrow → buy/fill more field space → install sprinklers → expand labor capacity.
- Mining and combat only after threat/health/escape policy and a dedicated local reflex controller exist.
- Acceptance: upgrade a farm plan using legitimately obtained materials, maintain paths and cover planned crops without destroying unrelated objects.

### M6 — Livestream agent director

- Overlay: current goal, planned next task, reason, progress, budget/energy, last success/failure, day forecast and observed vs predicted performance.
- Event-driven dialogue and highlights: first catch, near-miss, rare drop, season milestone, crop failure, navigation recovery; rate-limit repetition.
- Connect legitimate audience input via verified platform connector only; moderate and queue suggestions for approval by planner, never execute arbitrary chat commands.
- Audience engagement objective has guardrails: prioritize meaningful game progression and measured novelty; avoid fake reactions, looping map tourism and permanent waiting.
- Before any monetized stream, independently clear Live2D character/artwork rights and other platform-use conditions.

## When to sleep or explore

Idle is not a goal. The planner first asks whether there is productive farm work, a feasible procurement trip, a forage/resource route, a fishing opportunity, a quest or a recoverable plan dependency.

Sleep is justified by night/critical energy, or by a **deliberate strategic decision** to advance crop growth after a completed daily plan and no available worthwhile alternative. That decision must include a reason and expected next-day benefit. Avoid both "sleep immediately in the morning" and "walk in circles until midnight" hardcoded rules.

Sightseeing has a hard budget, destination, and one-time novelty condition; it is only an optional short filler, never a default replacement for gameplay.

## Explicit learning mechanism

**Knowledge sources**
- Game-rules knowledge: local game assets for crops, fish, shops, recipes. Versioned/cached, not hallucinated.
- Observed facts: what was visible and actually done on the save.
- Experience statistics: estimates of yields, action durations, failures, stamina costs, navigation and fishing catch rates.
- Preferences: stream style, acceptable risks, financial goals, variety, audience interests.

**Planning and update loop**
1. State delta or day start triggers a planner event (not every tick).
2. Generate candidate goals with estimated gold/day, progression unlocks, energy/time consumption, novelty and downside.
3. Evaluate preconditions; reserve resources and select one goal with a feasible task DAG.
4. Execute skills locally; inspect authoritative postconditions.
5. Compare prediction against observed outcome; update cost/yield/success priors (exponentially weighted averages or simple Bayesian/Beta counts as appropriate).
6. Replan only when a material state change or threshold invalidates the plan, not because Pi narrated a different idea.
7. After each in-game day, record predictions, actual gains, missed objectives, and lessons. Next-day prompt includes concise evidence, not uncontrolled full logs.

Example: expected 20 crops with one watering can but actual watering costs too much energy → record measured work per plot → next plan reduces area or prioritizes sprinklers. If fishing earns more than foraging on rainy days, learned expected gold/game-hour may move fishing above exploration.

A change qualifies as learning only if it is persisted, traceable to experience and changes a later decision; repeating a daily prompt with a journal does not count.

## Suggested evaluation metrics

- Correct postconditions / committed actions, recovery rate after transient timeouts, duplicate-action rate, and indefinite idle loops (target **zero**).
- In-game 7-day earned gold, retained emergency cash, harvested crop yield, missed watering/season deadlines, energy wasted.
- Skill-level progress, genuinely acquired resources, fish attempts/catches, NPC interaction completion, multi-day task success.
- Model cost per in-game day and average decision time; check faster/smaller models can run routine choices.
- Novel meaningful actions per broadcast hour and viewer-visible reason accuracy (qualitative; don't optimize for random movement).
- A/B compare **same backed-up save and game seed** with (a) fixed rules (b) adaptive planning. Require stable, reproducible improvements, not one successful anecdote.

## Implementation boundaries and order

Start with **M0 + M1**: productive forage/resource collection is the quickest fix for "farm work finished, nothing to do". Build **M2** early, in parallel with the next motor skill, because layout/crop scheduling is the central intelligence requirement. Implement **M3 fishing** as a high-visibility vertical slice after action-state reconciliation and basic inventory/animation are reliable. Then M4→M5→M6.

Do not add every action at once. Each milestone needs a snapshot fixture, planner/skill unit tests, Node simulator regression, a C# compilation check against the actual Stardew version, and a real-game acceptance script. Use a test save backup and do not merge an unverified SMAPI change based only on Node CI.

## Sources for game data and APIs

- SMAPI API guide: https://wiki.stardewvalley.net/Modding:Modder_Guide/APIs
- SMAPI events and game-thread restrictions: https://wiki.stardewvalley.net/Modding:Modder_Guide/APIs/Events
- Stardew crop data (1.6): https://wiki.stardewvalley.net/Modding:Crop_data
- Stardew fish data: https://wiki.stardewvalley.net/Modding:Fish_data
- Stardew location/fish spawns: https://wiki.stardewvalley.net/Modding:Location_data
- API details must be compiled and checked against the user's actual Stardew/SMAPI game assemblies before implementation.
