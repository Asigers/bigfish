/** Resolve a dedicated BigFish model without silently selecting a different provider. */
export type ModelName={provider:string;id:string};
export function chooseModel<T extends ModelName>(
  available:readonly T[],provider?:string,modelId?:string
):T|undefined{
  if(!provider&&!modelId)return undefined; // defer to Pi's saved default
  if(!provider||!modelId)throw Error(
    "Set BIGFISH_PROVIDER and BIGFISH_MODEL together (e.g. BIGFISH_PROVIDER=newapi BIGFISH_MODEL=glm-5.1)."
  );
  const exact=available.find(m=>m.provider===provider&&m.id===modelId);
  if(!exact){
    const listed=available.map(m=>m.provider+"/"+m.id).slice(0,24).join(", ");
    throw Error("BigFish model "+provider+"/"+modelId+" not available. Configured: "+(listed||"(none)")+
      ". Check ~/.pi/agent/models.json and credentials.");
  }
  return exact;
}
export type ThinkingLevel="off"|"minimal"|"low"|"medium"|"high"|"xhigh";
export function parseThinkingLevel(raw?:string):ThinkingLevel|undefined{
  if(!raw)return undefined; // defer to Pi settings
  if(["off","minimal","low","medium","high","xhigh"].includes(raw))
    return raw as ThinkingLevel;
  throw Error("Invalid BIGFISH_THINKING. Use off, minimal, low, medium, high or xhigh.");
}
