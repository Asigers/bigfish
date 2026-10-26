import { access } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const assetRoot = fileURLToPath(new URL("../overlay/assets/",import.meta.url));
const essential=[
  "SOURCE.json",
  "model/c_0120.model3.json",
  "model/c_0120.moc3",
  "model/manifest.json",
  "vendor/pixi.min.js",
  "vendor/cubism4.min.js",
  "vendor/live2dcubismcore.min.js"
];
export function allowedAsset(path:string):boolean{
  if(path.length>240||path.startsWith("/")||path.includes("\\")||
    path.split("/").some(part=>!part||part==="."||part===".."))return false;
  return /^vendor\/(?:pixi|cubism4|live2dcubismcore)\.min\.js$/.test(path)
    || /^model\/[\p{L}\p{N}_.\-\/]+\.(?:json|png|moc3)$/u.test(path);
}
export function resolvedAsset(path:string):string|undefined{
  if(!allowedAsset(path))return;
  const full=resolve(assetRoot,path);
  return full.startsWith(resolve(assetRoot)+sep)?full:undefined;
}
export function assetContentType(path:string):string{
  if(path.endsWith(".json"))return "application/json; charset=utf-8";
  if(path.endsWith(".js"))return "text/javascript; charset=utf-8";
  if(path.endsWith(".png"))return "image/png";
  return "application/octet-stream";
}
export async function hasInstalledModel():Promise<boolean>{
  try{await Promise.all(essential.map(item=>access(resolve(assetRoot,item))));return true;}
  catch{return false;}
}
