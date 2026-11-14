import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const code = ts.transpileModule(
  readFileSync(new URL("../src/lib/simple-correction.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const loaded = { exports: {} };
runInNewContext(code, { module: loaded, exports: loaded.exports });
const { parseSimpleCorrection, resolveSimpleCorrection, replaceSimpleCorrection, mentionsCorrectionTarget } = loaded.exports;

test("parses the common 不是 X，是 Y shape", () => {
  const percent = parseSimpleCorrection("不是 80%，是 30%。");
  assert.equal(percent.from, "80%");
  assert.equal(percent.to, "30%");
  const hours = parseSimpleCorrection("不是 40 小时，是 80 小时。");
  assert.equal(hours.from, "40 小时");
  assert.equal(hours.to, "80 小时");
  assert.equal(parseSimpleCorrection("把截止时间改一下"), null);
});

test("replaces a percentage fact without a model call", () => {
  const facts = ["用户明确提供：他们每天有 200 条咨询", "其中 80% 是重复问题。"];
  assert.deepEqual(JSON.parse(JSON.stringify(resolveSimpleCorrection(facts, "不是 80%，是 30%。"))), {
    supersededFacts: ["其中 80% 是重复问题。"],
    replacementFacts: ["其中 30% 是重复问题。"],
  });
});

test("strips the 用户明确提供 prefix before the route re-adds it", () => {
  const facts = ["用户明确提供：他们每天有 200 条咨询"];
  assert.deepEqual(JSON.parse(JSON.stringify(resolveSimpleCorrection(facts, "不是 200 条，是 500 条。"))), {
    supersededFacts: ["用户明确提供：他们每天有 200 条咨询"],
    replacementFacts: ["他们每天有 500 条咨询"],
  });
});

test("tolerates spaces and full-width percent signs", () => {
  const facts = ["其中 80 ％ 是重复问题。"];
  assert.deepEqual(JSON.parse(JSON.stringify(resolveSimpleCorrection(facts, "不是 80%，是 30%。"))), {
    supersededFacts: ["其中 80 ％ 是重复问题。"],
    replacementFacts: ["其中 30% 是重复问题。"],
  });
});

test("falls back to the model when the reference is ambiguous or absent", () => {
  assert.equal(resolveSimpleCorrection(["80% 是重复问题", "80% 客户在海外"], "不是 80%，是 30%。"), null);
  assert.equal(resolveSimpleCorrection(["预算 2 万"], "不是 80%，是 30%。"), null);
});

test("replaces every copy when the same claim was added twice", () => {
  const facts = ["用户明确提供：其中 80% 是重复问题", "其中 80% 是重复问题。"];
  const result = JSON.parse(JSON.stringify(resolveSimpleCorrection(facts, "不是 80%，是 30%。")));
  assert.equal(result.supersededFacts.length, 2);
  assert.deepEqual(result.replacementFacts, ["其中 30% 是重复问题。"]);
});

test("corrects the question text when the number never became a fact", () => {
  const question = "每天 200 条咨询，其中 80% 是重复问题，先做 FAQ 还是坐席辅助？";
  assert.equal(replaceSimpleCorrection(question, "不是 80%，是 30%。"), "每天 200 条咨询，其中 30% 是重复问题，先做 FAQ 还是坐席辅助？");
  assert.equal(mentionsCorrectionTarget(question, "不是 80%，是 30%。"), true);
  assert.equal(mentionsCorrectionTarget("预算 2 万", "不是 80%，是 30%。"), false);
});
