# M3.1 + M3.2 — Event-driven narration and an evidence-based live show director

**Scope:** Implement a proper Live Agent foundation for Stardew Valley. M3.3 authentic Bilibili/Douyin live-chat ingest, advanced cloud TTS, moderation and Stream Supervisor remain independent later milestones.

## M3.1: independent narrator

- A separate **tool-less** `LiveBrain` Pi session does not share in-flight prompts with the Game Agent. It may generate one JSON `speech` text using only the event's **verified facts**, a small recent dialogue history and its event classification.
- A `NarrationScheduler` does not block game commands while waiting for LLM output. It has one pending request at a time, an ordered queue (max 15), 12-second minimum request cadence, key-based event deduplication and output repetition suppression.
- Introductions, noon/evening check-ins, **verified** important successes, explicit game failure receipts, and challenge starts/progress/wins/losses can trigger commentary. Repetitive watering/tilling interactions are **aggregated every four confirmed actions**, not sent to the LLM on every tile.
- Narration model errors/timeouts/unavailable Pi provider fall back to concise, **truthful local Chinese captions** (also works in `npm run demo`). Fallbacks never claim unconfirmed achievements.
- Model calls happen on an independent timer and are never awaited by the game action loop. One game response delay will not hold command dispatch. Live speech is emitted through the existing `recordSpeech` → SSE `/overlay/events` → Live2D overlay, optional macOS `say` TTS. Existing avatar 9-second voice gate remains in place.
- Session and queued model outputs are invalidated on save changes. Commentaries about one save must not leak into another; game memory/chat stays separate.
- The model cannot send game actions, arbitrary shell commands, or modify world/inventory state. Narration input is treated as untrusted data and output is JSON/length validated.

## M3.2: a safe show director

- `ShowDirector` inspects **authoritative** current-game observations and offers a bounded catalog:
  - `water_sprint`: at least two currently unwatered crops, watering can available; count unique confirmed watered tiles by noon
  - `harvest_run`: at least two ripe crops and backpack space; count confirmed harvests by 16:00
  - `no_spend_expansion`: at least two observed tillable tiles and enough energy; protect seeds spending and count unique confirmed tilled tiles by 19:00
  - `forage_find`: at least one observed forage item; count a real collection by 20:00
  - `clear_obstacles`: at least two observable resource obstacles; count distinct confirmed clear strikes by 19:00
- The Live Agent **chooses only among offered IDs**. If unavailable/busy/invalid, a deterministic valid candidate is selected. It does not invent challenges that cannot be represented by existing game actions.
- **No-spend** is not an AI promise: the purchasing planner is prevented from beginning a seed-shop errand and will not execute a seed purchase while the active challenge forbids it. Game actions still pass the existing authoritative world validator.
- Challenges are persisted in a separate, save-scoped JSON journal (`data/bigfish-show.json`). Mock/demo uses `data/bigfish-show.mock.json` instead. Restart restores today's challenge and its progress. Switching saves resets the active story and events. Recent completed/failed outcomes are bounded to 12 entries.
- Challenge counts advance **only after fresh state confirmation from the bridge**, never from an HTTP ACK alone or uncertain in-flight action. Repeated same-tile actions are not double-counted. Failures and deadlines yield explicit failure results, not fabricated wins.
- Launch event, factual progress, completion and failure feed the independent narrator. There is one challenge per day, and a finished challenge cannot be silently restarted.

## Validation

Automated tests:
```bash
npm install
npm run typecheck
npm test
```

Includes candidate gating, AI invalid ID fallback, real action confirmation, replay dedup, no-spend purchasing policy, deadline/day boundary/save isolation, independent narrator pump with delayed LLM and fallback, narration priority, truthful failures and existing M0–M2 regressions.

### Local preview without an LLM or game

```bash
npm run demo
```

Visit `http://127.0.0.1:45931/overlay?preview=1` for the static model preview or `http://127.0.0.1:45931/overlay` to see live **mock game** commentary, subject to prior Live2D asset installation. The demo is intentionally deterministic: Pi is not called and mock SSE is not proof of real game quality.

### Real Mac acceptance (backed-up save)

1. Stop all BigFish processes and Stardew. Update from merged main, run Node tests, and rebuild/deploy the existing C# SMAPI mod against your own installed Stardew game.
2. Start `npm run start` with a configured Pi provider/model; open an actual save through SMAPI. Ensure Pi Game Agent and independent LiveBrain both start.
3. OBS browser source at `http://127.0.0.1:45931/overlay` displays a short introduction, observed milestones, show challenge updates and fallback subtitles if model narration fails. Test optional `BIGFISH_TTS=say` audio separately.
4. Observe a real day with two or more eligible challenge targets. The `[show]` log records only an offered challenge; game actions must **not** pause merely because narration inference is slow.
5. Pick an eligible no-spend challenge, verify no seed purchase is executed while active. A real, verified tilling action increases progress; an ACK without state confirmation does **not**.
6. Test repeat action, day rollover, model failure, switch to another save, and controller restart. Check challenge and dialogue history isolation and no fabricated success declarations.
7. Check no more than a few substantive sentences during routine repetitive watering. Compare speech statements to actual game facts.
8. If the existing C# bridge does not compile or native controls fail on the real Mac save, **do not declare full streaming readiness**.

## Limitations

- AI narration obeys a grounding prompt and basic schema checks; no LLM can be mathematically guaranteed not to hallucinate. Voice captions and story statements should be monitored in initial runs.
- Challenge targets are **prevalidated deterministic templates**. This is bounded AI show selection, not open-ended novel game-task invention.
- Completed progress depends on controller confirmation; an unresolved command pauses game actions under M0 rather than inventing an outcome.
- A game day may have no feasible challenge; the agent will still narrate factual gameplay and will not force one.
- No real platform chat feed or viewer voting is included in this PR. A local `/event` mock input exists but is not wired as a new livestream ingestion pipeline here.
- OBS process health monitoring, crash recovery, speech queue cancellation during OS-level game failures and multi-day unattended production acceptance are **separate milestones**.
- Existing DeepSeek whale-girl art is upstream **CC BY-NC-SA**; verify commercial livestream permissions before monetizing.
