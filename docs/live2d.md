# DeepSeek whale-girl Live2D integration

**Model source:** [Andersen216/dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d) (pinned commit `f977bef508690e75ba6535cd8f4ce18e7f6ba9b0`).

**Creators and attributions:**
- 上善无形 (original character 「溟月」): https://space.bilibili.com/4456176
- ZipZipPipe (DeepSeek maid whale-girl derivative): https://space.bilibili.com/4168597
- 氵六青 (Live2D model, binding/expressions): https://space.bilibili.com/11272072
- Live2D adaptation project: Andersen216 https://github.com/Andersen216/dsh-whale-girl-live2d

**Licensing:** Consult upstream [NOTICE.md](https://github.com/Andersen216/dsh-whale-girl-live2d/blob/main/NOTICE.md), [PROVENANCE.md](https://github.com/Andersen216/dsh-whale-girl-live2d/blob/main/PROVENANCE.md), [AUTHORS.md](https://github.com/Andersen216/dsh-whale-girl-live2d/blob/main/AUTHORS.md). They state model artwork is **CC BY-NC-SA 4.0** (attribution, noncommercial, share alike), even though a model creator's original notice allows commercial livestreams; these separate rights may conflict. Model-specific permission alone does not override original character/derivative-design authors' rights. BigFish does **not** claim the materials are freely commercial, does **not** distribute them or the proprietary Cubism Core runtime within its own repository, and is not an official DeepSeek character.

**For monetized livestreams:** Contact rights holders for the intended use. Do not infer commercial authorization from someone else already streaming with the same avatar.

## Setup

```bash
npm install
npm run live2d:install -- --acknowledge-noncommercial
npm run demo
```

Open `http://127.0.0.1:45931/overlay?preview=1`; add an OBS Browser Source `http://127.0.0.1:45931/overlay`, size 1920 × 1080. Background transparent. Use `?zoom=1.3` (0.4–2.4) if the model needs enlargement. Model is anchored at bottom-right.

Local files are placed in ignored `overlay/assets/model/` and `overlay/assets/vendor/`. The installer pins the source revision, verifies Git Blob hashes, and stages files before renaming into place.

## Model events

| BigFish emotion | Live2D expression | Motion |
| --- | --- | --- |
| idle | reset | idle |
| happy | 开心兴奋 | aidale |
| excited | 星星眼 | splash |
| thinking | 问号 | selfieQuick |
| tired | 闭眼口水 | bubble |
| sad | 悲伤 | idle |
| surprised | 感叹号 | splash |

The BigFish SSE interface remains `GET /overlay/events`: text, emotion and task goal. It drives mouth movement, subtitles and expressions. `/overlay?preview=1` cycles sample reactions without model credentials.

The rendering code is a separate, minimal PIXI/Cubism adapter. The DSH-specific Pet desktop app and agent integration are **not** installed or embedded.

**Limitations:** This project tests paths, routes, event schema and code loading in CI. It cannot certify visual quality or true Cubism animation until model assets are installed and previewed in a browser/OBS. Some phones/embedded browsers may not support the WebGL/Cubism runtime. TTS is still separately controlled by BigFish and macOS `say`.


## Recovering from slow GitHub downloads

After running `git pull`, rerun the installer. The improved installer uses macOS curl (honors HTTPS_PROXY / ALL_PROXY) with retries and a persistent, digest-checked `overlay/.live2d-cache/`. Successful downloads remain cached even if a later model texture times out.

For very slow links:

```bash
BIGFISH_DOWNLOAD_TIMEOUT=180 BIGFISH_DOWNLOAD_CONCURRENCY=1 BIGFISH_DOWNLOAD_RETRIES=6 \
  npm run live2d:install -- --acknowledge-noncommercial
```

The default is 120 seconds, 4 attempts and 2 parallel downloads. Original pre-fix downloads were staged in a temporary directory and unfortunately are usually not recoverable.
