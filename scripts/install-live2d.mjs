#!/usr/bin/env node
/**
 * Installs the upstream Live2D model and matching browser runtimes ONLY after
 * the user explicitly acknowledges the artwork's non-commercial license.
 * Assets never enter the BigFish Git history.
 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM = "Andersen216/dsh-whale-girl-live2d";
export const REVISION = "f977bef508690e75ba6535cd8f4ce18e7f6ba9b0";
const sourceRoot = "assets/";
const vendors = new Set([
  "vendor/live2dcubismcore.min.js",
  "vendor/pixi.min.js",
  "vendor/cubism4.min.js",
]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "overlay", "assets");

export function safeAssetPath(path) {
  if (typeof path !== "string" || path.startsWith("/") || path.includes("\\") ||
      path.split("/").some(x => !x || x === "." || x === "..")) return false;
  return vendors.has(path) ||
    (path.startsWith("model/") && /\.(?:json|moc3|png)$/.test(path));
}
export function blobSha(buffer) {
  return createHash("sha1").update(Buffer.from("blob " + buffer.length + "\0")).update(buffer).digest("hex");
}
export function selectAssets(tree) {
  if (!Array.isArray(tree)) throw new Error("Invalid Git tree response");
  const list = tree.filter(e => e.type === "blob" && typeof e.path === "string" &&
    e.path.startsWith(sourceRoot) && safeAssetPath(e.path.slice(sourceRoot.length)))
    .map(e => ({ path:e.path.slice(sourceRoot.length), sha:e.sha, size:e.size }));
  if (!list.some(x => x.path === "model/c_0120.model3.json") ||
      !list.some(x => x.path === "model/c_0120.moc3") ||
      !list.some(x => x.path === "model/manifest.json") ||
      [...vendors].some(name => !list.some(x => x.path === name))) {
    throw new Error("Missing required Live2D model or runtime files");
  }
  if (list.length > 120 || list.some(x => !Number.isInteger(x.size) || x.size > 12_000_000 || x.size < 1 ||
      !/^[0-9a-f]{40}$/.test(x.sha))) throw new Error("Unexpected upstream file inventory");
  return list;
}
async function loadBuffer(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "BigFish-Live2D-installer", "accept": "application/octet-stream" },
    signal:AbortSignal.timeout(25000)
  });
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
  return Buffer.from(await response.arrayBuffer());
}
async function install() {
  if (!process.argv.includes("--acknowledge-noncommercial")) {
    console.error(`The selected artwork is CC BY-NC-SA 4.0 (not a commercial license).
Origin: https://github.com/${UPSTREAM}
Creators: 上善无形 (original character), ZipZipPipe (derivative design), 氵六青 (Live2D rig).
A model maker's statement regarding livestreams does NOT automatically clear the
underlying character and derivative design rights.

To install for a non-commercial / appropriately licensed use, run:
  npm run live2d:install -- --acknowledge-noncommercial

For monetized livestreams, seek permission from all relevant rights holders.`);
    process.exitCode = 2;
    return;
  }
  console.log("Downloading pinned Live2D model assets, not adding them to Git...");
  const listingUrl = `https://api.github.com/repos/${UPSTREAM}/git/trees/${REVISION}?recursive=1`;
  const treeResponse = await fetch(listingUrl, {headers:{"user-agent":"BigFish-Live2D-installer"},signal:AbortSignal.timeout(20000)});
  if (!treeResponse.ok) throw new Error("Cannot fetch pinned source inventory (HTTP " + treeResponse.status + ")");
  const tree = await treeResponse.json();
  if (tree.truncated) throw new Error("Upstream inventory was truncated");
  const assets = selectAssets(tree.tree);
  const staging = await mkdtemp(join(root,"overlay",".live2d-stage-"));
  const backup = output + ".previous";
  try {
    let cursor=0;
    await Promise.all(Array.from({length:Math.min(4,assets.length)},async () => {
      while(cursor < assets.length) {
        const asset=assets[cursor++];
        const url = `https://raw.githubusercontent.com/${UPSTREAM}/${REVISION}/assets/`+
          asset.path.split("/").map(encodeURIComponent).join("/");
        const bytes=await loadBuffer(url);
        if (bytes.length!==asset.size || blobSha(bytes)!==asset.sha)
          throw new Error("Asset integrity mismatch: " + asset.path);
        const dest=join(staging,asset.path);
        await mkdir(dirname(dest),{recursive:true});
        await writeFile(dest,bytes);
        console.log("✓ "+asset.path);
      }
    }));
    await writeFile(join(staging,"SOURCE.json"),JSON.stringify({
      repo:UPSTREAM,revision:REVISION,license:"CC BY-NC-SA 4.0",creators:["上善无形","ZipZipPipe","氵六青"],
      files:assets.length,installedAt:new Date().toISOString()
    },null,2));
    await rm(backup,{recursive:true,force:true});
    try { await rename(output,backup); } catch(error) {
      if(error.code!=="ENOENT")throw error;
    }
    try { await rename(staging,output); }
    catch(error) {
      try{await rename(backup,output);}catch{}
      throw error;
    }
    await rm(backup,{recursive:true,force:true});
    console.log("\nLive2D model installed locally. Restart BigFish and open /overlay.");
  } finally {
    await rm(staging,{recursive:true,force:true});
  }
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  install().catch(error => {console.error("[live2d:install]",error);process.exitCode=1;});
}
