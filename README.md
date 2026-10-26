# BigFish — autonomously farming & live fish avatar

**Mac-first autonomous Stardew Valley farm economy** powered by the Pi SDK, TypeScript and a SMAPI C# mod. It supports the popular community **DeepSeek 鲸鱼娘 Live2D** model as an optional locally-installed OBS character, displayed in the bottom-right of the stream.

> v0.3 experimental. **Node/controller and mock-game integration tests run in CI on macOS & Linux, but the SMAPI mod still needs to be compiled and tested against your own Stardew Valley installation.** Back up your save before testing. This is a focused farm/economy agent, not a complete open-world game player.

## Features

- Farm loop: water, till, plant, harvest, walk and move between game locations, return home and sleep.
- Starter economy: read real player gold/inventory/chests/shop stock; **buy available seasonal seed items from Pierre**, **ship actual crops via farm shipping bin** for next-day settlement, **store/withdraw** items from accessible player chests.
- Tool management: select the real hoe/watering can; call their DoFunction for tile effects; detect and refill from water tiles. Character/tool animations may need additional Mac-game refinement.
- Planning: Pi chooses a bounded **daily multi-day strategy** (`profit`, `expand`, `save`, seed reserve and money goal). A deterministic executor enforces real-world preconditions. Goal and activity journal persist in `data/bigfish-memory.json` through process restarts.
- Livestream companion: **community DeepSeek whale-girl Live2D** (installed separately): native model animation, preset game-driven expressions, Pi speech bubbles and optional macOS TTS. An OBS browser source anchors the character bottom-right. Artwork is not committed to the repository.
- Reliability: local token-authenticated bridge, one command in flight, command identity, game-state heartbeat and failure limits. Critical actions re-evaluate state after completion.

## Quick start (mock game, no key or Stardew)

```bash
git clone https://github.com/Asigers/bigfish.git
cd bigfish
npm install
npm test
npm run demo
```

Before previewing the whale-girl model, run the optional asset installer (see below). Then open **http://127.0.0.1:45931/overlay?preview=1** for expression/action samples, or **/overlay** for real game commentary. The demo autonomously farms a simulated map with a shop, banked gold, an inventory, shipping income and a household.

The demo does **not** use a live model; the speech lines are preconfigured by the rule executor so everything can be tested offline.

## Install the community DeepSeek whale-girl Live2D model

The actual **Live2D model is not included in this repository**. It is downloaded from a pinned upstream revision only on your machine after you acknowledge its non-commercial license. This avoids distributing the character artwork as if it were BigFish MIT code.

[Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d) supplies the model, expressions, 8 motions and compatible PIXI/Cubism runtime.

```bash
# One-time opt-in for noncommercial use / otherwise appropriately cleared usage:
npm run live2d:install -- --acknowledge-noncommercial
npm run demo
```

Preview **http://127.0.0.1:45931/overlay?preview=1**. The `preview=1` mode cycles 6 sample emotions without a Pi account; ordinary `/overlay` listens to actual BigFish events.

No DSH plugin, external website, Electron container or independent avatar server is required. Model files are stored in ignored `overlay/assets/`, never committed. The download is pinned and each asset's Git Blob hash is checked. To adjust the displayed model scale, use e.g. `/overlay?zoom=1.3`.

### Slow network / TimeoutError during model installation

The installer uses the system curl (respects `HTTPS_PROXY` / `ALL_PROXY`), verifies each Git blob and **keeps verified model files in `overlay/.live2d-cache/` across failed runs**. A timeout no longer forces every successful file to be downloaded again. Standard settings: 120 seconds per file, 4 attempts, 2 concurrent downloads.

Start by updating the repository and rerunning the same command:

```bash
git pull
npm run live2d:install -- --acknowledge-noncommercial
```

For slower connections, reduce parallel requests and increase the per-file timeout (seconds):

```bash
BIGFISH_DOWNLOAD_TIMEOUT=180 BIGFISH_DOWNLOAD_RETRIES=6 BIGFISH_DOWNLOAD_CONCURRENCY=1 \
  npm run live2d:install -- --acknowledge-noncommercial
```

If you use a local HTTP proxy, launch from a terminal with its correct `HTTPS_PROXY` variable set (curl honors it). Check the real proxy port rather than copying somebody else's port. If access to `raw.githubusercontent.com` is blocked, an increased timeout alone will not resolve it.

The failed original installer deleted its temporary staging files, so **downloads from before this fix cannot normally be recovered**; subsequent interrupted runs will reuse the cache. The cache remains outside Git.

**Licensing**: upstream lists **上善无形 (original character), ZipZipPipe (DeepSeek derivative design), 氵六青 (Live2D model)**; their character art is marked **CC BY-NC-SA 4.0**. Use with attribution, preserve the share-alike conditions on artwork modifications, and do **not** assume commercial livestream rights from another streamer's usage. The upstream `NOTICE.md` and `PROVENANCE.md` explicitly distinguish code, model art and proprietary Live2D Cubism Core runtime. No commercial permission is granted by this installer. See [docs/live2d.md](docs/live2d.md).

## OBS: display the whale-girl Live2D character

On the **same Mac** as the agent:
1. Add **Browser Source** in OBS.
2. Set URL to `http://127.0.0.1:45931/overlay`.
3. Set Width to **1920** and Height to **1080**, or match your canvas dimensions.
4. Keep the source above the game capture. The page has a **transparent background** and places the fish near the lower-right corner.
5. Position/scale as desired in OBS. No image files or browser extensions are needed.

The Live2D avatar reacts to game actions. If Pi is enabled, speech bubbles show its Chinese commentary. Expression mapping is defined in `overlay/live2d.js`. Motion and expression assets are installed locally rather than being committed.

Optional Mac speech synthesis (not required for subtitle/avatar support):

```bash
export BIGFISH_TTS=say
npm run start
```

This invokes the built-in `say` program with safe process arguments. OBS must capture the audio from your Mac appropriately. For natural high-quality voices a cloud TTS provider can later replace the system voice.

## Install the actual game bridge (macOS)

Prerequisites: Stardew Valley 1.6.x, a compatible SMAPI 4.5.x release, .NET SDK to build mods, Node.js 22.16+, npm. See [SMAPI](https://smapi.io/).

1. Install SMAPI and launch the game through SMAPI at least once.
2. Build the included mod:
```bash
dotnet build mods/BigFishBridge/BigFishBridge.csproj -c Release
```
3. Check that the game Mods directory contains `BigFishBridge/manifest.json` and the compiled `BigFishBridge.dll`. ModBuildConfig may copy them automatically; otherwise copy from build output to the directory shown in SMAPI logs.
4. Generate **one secret** and keep it in this terminal:
```bash
export BIGFISH_TOKEN="$(openssl rand -hex 24)"
echo "$BIGFISH_TOKEN"
```
5. In the installed `Mods/BigFishBridge/config.json`, configure the exact same value:
```json
{"Port":45931,"Token":"PASTE_TOKEN_PRINTED_ABOVE"}
```
6. Run the controller using the same terminal (choose a valid Pi provider/model in Pi first):
```bash
npm run start
```
7. Open a backed-up Stardew save through SMAPI and enter the farm.

For a first game-side test **without model calls** use:
```bash
node --experimental-strip-types src/index.ts --mock
```

Health: `curl http://127.0.0.1:45931/health`. A true `connected` means recent game state, not that game actions are guaranteed to succeed.

## Choose the Pi model (including your own New API)

BigFish embeds `@earendil-works/pi-coding-agent`. **It does not take a model from the `npm run start` command line or use a Pi terminal's currently selected model session**. It loads Pi's global model catalog and saved default settings from `~/.pi/agent/`, and lets you override the model for BigFish only.

**Option A: use your saved Pi default**

1. Run `pi`, configure credentials via `/login` if needed.
2. Run `/model`, choose a working model, and press **Ctrl+S** to save it as the default for new sessions.
3. Exit Pi, retain your BigFish bridge token, then run `npm run start`.

Pi's **saved default**, not an unsaved session selection, is what BigFish loads. The BigFish startup console logs the selected provider, model and thinking level.

**Option B: pin a dedicated BigFish model without changing your everyday Pi model**

```bash
# Values are examples: match provider/id from your own ~/.pi/agent/models.json or Pi model picker.
export BIGFISH_PROVIDER=newapi
export BIGFISH_MODEL=glm-5.1
export BIGFISH_THINKING=low
npm run start
```

`BIGFISH_PROVIDER` and `BIGFISH_MODEL` must be set together. A missing or unavailable explicit model is a startup error (never silently falls back to another provider). Thinking can be `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Omit all three variables to reuse the default Pi model and thinking level.

**Option C: add a custom compatible New API endpoint to Pi**

Create or **merge** into `~/.pi/agent/models.json`, preserving your existing providers:

```json
{
  "providers": {
    "newapi": {
      "baseUrl": "https://YOUR-NEWAPI-HOST/v1",
      "api": "openai-completions",
      "apiKey": "$NEWAPI_API_KEY",
      "compat": {
        "supportsDeveloperRole": false
      },
      "models": [
        {
          "id": "glm-5.1",
          "name": "GLM via my New API",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 8192,
          "cost": {"input":0,"output":0,"cacheRead":0,"cacheWrite":0}
        }
      ]
    }
  }
}
```

In the same terminal as the controller, `export NEWAPI_API_KEY="..."`; keep this secret out of source control. Use the exact model ID exposed by **your** upstream gateway, not necessarily `glm-5.1`. If your endpoint supports only Responses, set `api` to `openai-responses` instead. The numeric limits above are merely examples; set them to your actual model capabilities. Never replace an existing populated `models.json` wholesale. The `supportsDeveloperRole: false` flag is appropriate for gateways that reject the `developer` message role.

To test custom models before running the game, open `pi` and confirm the chosen model responds to a message. Then run the BigFish process with `BIGFISH_PROVIDER` and `BIGFISH_MODEL`.

For an in-game test, **stop `--mock` (Ctrl+C) first** and run only one BigFish controller on port 45931. Make sure `BIGFISH_TOKEN` is the same value already stored in the Mod's `config.json`. The controller prints `[bigfish] Pi model: provider/id | thinking=...` on startup. The model generates **strategy and speech**, while policy validation owns the actual game actions. Re-running `npm run demo` will not call Pi.

## Personality and goals

- `src/brain.ts`: Pi session, daily strategy prompt and Chinese speech prompt (tool-less/no shell).
- `src/strategy.ts`: durable bounded goal journal. Edit or remove `data/bigfish-memory.json` only while the controller is stopped.
- `src/economy.ts`: deterministic economic tasks (shop trips, sale, storage, replenishment, strategy-dependent budgets).
- `src/decision.ts`: crop and daily sleep planner.
- `overlay/index.html`, `overlay/live2d.js`: whale-girl Cubism character, animation, subtitle and expressions.
- `src/avatar.ts`: game action → facial expression mapping, TTS setting and speech throttling.

The long-term **Pi strategy affects purchasing behavior and seed inventory targets**. It does not yet generate arbitrary fully general game goals such as an NPC marriage quest or mine expeditions; these are future gameplay skills.

## Important constraints

- Seed purchases require available money, the game stock listing, Pierre present, business hours and a valid local route. **The initial transaction handler uses game shop stock/prices and inventory mutation but does not invoke all native ShopMenu purchase callbacks, price/stock sync or quest triggers**. Do not rely on it for limited-stock/special merchandise.
- Sale is a real farm shipping-bin transfer; money appears at the next game-day settlement, **not** when the item is shipped.
- Shipping position currently uses the farm's starter-bin location; moved shipping bins need more map support.
- Chest support is restricted to accessible **player-owned** chests; multiplayer is not supported.
- Tool use is through game methods, but fully faithful character animations and all upgrades require in-game verification.
- Not all game maps, festivals, narrative locked doors, minigames, menus, shops or route variants are supported.
- Automatic gold generation is **not** implemented. An empty save with no money, seeds or sellable crops needs a new source of income before this focused farm loop can recover.
- No live Bilibili gift feed yet. `POST /event` accepts **local simulated events**, not verified platform events.
- The optional avatar uses the community whale-girl character by **上善无形 / ZipZipPipe / 氵六青**, licensed by upstream as **CC BY-NC-SA 4.0** (noncommercial/share-alike). The modeling artist's livestream permission does not by itself clear underlying character rights. **Do not monetize a livestream using these assets without separate written clearance from relevant rights holders.** The artwork is not an official DeepSeek asset.
- Unattended production streaming is **not yet warranted** without real-game build/runtime testing and game action reconciliation after timeouts.

## Architecture & developer notes

See [docs/architecture.md](docs/architecture.md).

### Tests

```bash
npm test
npm run typecheck
```

These run on macOS and Linux in GitHub Actions. They cover schema, policy decisions, persistence, crop loop, buying/shipping simulated bridge flow and the OBS page/SSE. They **do not compile the C# SMAPI mod**.

## Safety

HTTP is bound only to `127.0.0.1`, with a shared secret on all mutation routes. The token is never sent to the OBS overlay; the latter only streams non-sensitive speech events. Do not expose the bridge port publicly or commit credentials/save files. Viewer text is untrusted data; the Pi SDK session has no filesystem, shell, browser or arbitrary tools.
