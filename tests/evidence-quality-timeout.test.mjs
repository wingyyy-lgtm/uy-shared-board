import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const code = ts.transpileModule(readFileSync(new URL("../src/lib/evidence-quality.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function evaluate({ empty = false, forced = false, timeout = true, searchTimeout = false } = {}) {
  const routeModule = { exports: {} }, logs = [];
  let calls = 0;
  const rating = (id, grade = "B") => ({ id, grade, sourceType: "媒体", reason: "摘要评估", scope: "公开信息" });
  const initial = { ratings: [rating("S1"), rating("S2")], selectedIds: empty ? [] : ["S1", "S2"], traces: [{ sourceId: "S1", query: "original report", claim: "report says", impact: "影响建议" }] };
  runInNewContext(code, {
    module: routeModule, exports: routeModule.exports, URL, AbortSignal, process: { env: {} },
    require(name) {
      if (name === "./web-search") return { webSearch: async () => {
        if (searchTimeout) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
        return { query: "original report", status: "ok", results: [{ title: "Original", url: "https://example.org/report", snippet: "original report" }] };
      } };
      return {
        logAnalysisError() {}, logAnalysisStage() {}, logAnalysisDetail: (tag, details) => logs.push({ tag, ...details }),
        diagnosticStage: async (_stage, run) => run(),
        diagnosticFetch: async () => {
          calls += 1;
          if (calls === 2 && timeout) throw Object.assign(new Error("operation aborted due to timeout"), { name: "TimeoutError" });
          return { ok: true };
        },
        diagnosticJson: async () => ({ choices: [{ message: { content: JSON.stringify(calls === 1 ? initial : { ratings: [rating("S1"), rating("S2"), rating("S3", "A")], selectedIds: ["S3"], links: [] }) } }] }),
      };
    },
  });
  const searches = [{ query: "initial", status: "ok", results: [1, 2].map((id) => ({ title: `Source ${id}`, url: `https://example.org/${id}`, snippet: "report says" })) }];
  const result = await routeModule.exports.gradeAndTraceEvidence("qwen", {}, searches, forced);
  return { result, logs, calls };
}

test("A: follow-up review timeout restores pre-follow-up selected sources", async () => {
  const { result, logs, calls } = await evaluate();
  assert.deepEqual(Array.from(result.selected, (source) => source.id), ["S1", "S2"]);
  assert.equal(result.sources.length, 2);
  assert.equal(result.followUps.length, 0);
  assert.equal(calls, 2);
  assert.equal(logs[0].fallback, "pre-follow-up-selected-evidence");
});
test("B: forced search with zero selected evidence fails before enhancement", async () => {
  await assert.rejects(evaluate({ empty: true, forced: true }), /forced-web-search-no-selected-evidence/);
});
test("C: unforced zero evidence continues without invented evidence", async () => {
  const { result, calls } = await evaluate({ empty: true });
  assert.equal(result.selected.length, 0);
  assert.equal(calls, 1);
});
test("D: successful second assessment retains enhanced selection", async () => {
  const { result, logs } = await evaluate({ timeout: false });
  assert.deepEqual(Array.from(result.selected, (source) => source.id), ["S3"]);
  assert.equal(logs.length, 0);
});
test("follow-up search timeout also restores the baseline", async () => {
  const { result, calls } = await evaluate({ searchTimeout: true });
  assert.equal(result.selected.length, 2);
  assert.equal(calls, 1);
});
