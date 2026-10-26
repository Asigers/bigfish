import test from "node:test";
import assert from "node:assert/strict";
import { chooseModel,parseThinkingLevel } from "../src/model-config.ts";
const available=[
  {provider:"newapi",id:"glm-5.1",contextWindow:128000},
  {provider:"newapi",id:"gpt-5.6-sol",contextWindow:128000},
  {provider:"openai",id:"gpt-5.5",contextWindow:128000}
];
test("explicit BigFish selection uses exact provider/model pair",()=>{
  assert.equal(chooseModel(available,"newapi","glm-5.1"),available[0]);
  assert.equal(chooseModel(available,"newapi","gpt-5.6-sol"),available[1]);
  assert.equal(chooseModel(available,"openai","gpt-5.5"),available[2]);
});
test("omitted BigFish settings defer to existing Pi default",()=>{
  assert.equal(chooseModel(available),undefined);
  assert.equal(parseThinkingLevel(),undefined);
});
test("bad or partial model selection fails rather than silently changing model",()=>{
  assert.throws(()=>chooseModel(available,"newapi"),/together/);
  assert.throws(()=>chooseModel(available,undefined,"glm-5.1"),/together/);
  assert.throws(()=>chooseModel(available,"openai","glm-5.1"),/not available/);
  assert.throws(()=>chooseModel([],"newapi","glm-5.1"),/not available/);
});
test("thinking override validates supported levels",()=>{
  assert.equal(parseThinkingLevel("off"),"off");
  assert.equal(parseThinkingLevel("low"),"low");
  assert.equal(parseThinkingLevel("medium"),"medium");
  assert.equal(parseThinkingLevel("xhigh"),"xhigh");
  assert.throws(()=>parseThinkingLevel("extreme"),/Invalid BIGFISH_THINKING/);
});
