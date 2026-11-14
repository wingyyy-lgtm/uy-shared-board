import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const code = ts.transpileModule(readFileSync(new URL("../src/lib/search-plan.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function plan(model, question, unknowns, searchStatus = "success") {
  const routeModule = { exports: {} };
  const queries = [];
  runInNewContext(code, {
    module: routeModule, exports: routeModule.exports, AbortSignal, console: { info() {} },
    process: { env: {} },
    require(name) {
      if (name === "./web-search") return { webSearch: async ({ query }) => {
        queries.push(query);
        return { query, status: searchStatus, results: [] };
      } };
      return {
        diagnosticFetch: async () => ({ ok: true }),
        diagnosticJson: async () => ({ choices: [{ message: { content: JSON.stringify({ unknowns }) } }] }),
        logAnalysisError() {}, logAnalysisStage() {},
      };
    },
  });
  const report = await routeModule.exports.prepareWebEvidence(model, JSON.stringify({ currentQuestion: question }));
  return { queries, report };
}

test("A/C: both models execute a fallback query when forced plans are empty", async () => {
  for (const model of ["deepseek", "qwen"]) {
    const { queries, report } = await plan(model, "这个问题必须联网查询 GitHub Copilot 当前官方价格。", []);
    assert.ok(queries.length >= 1);
    assert.match(queries[0], /GitHub Copilot/);
    assert.equal(report.searchDecision, "forced-search-fallback");
  }
});

test("B: ordinary decisions remain independent, including no-search", async () => {
  const question = "我今天应该先写代码还是先访谈？";
  const deepseek = await plan("deepseek", question, []);
  const qwen = await plan("qwen", question, [{ kind: "public", question: "验证方法", query: "customer discovery methods" }]);
  assert.equal(deepseek.queries.length, 0);
  assert.equal(deepseek.report.searchDecision, "independent-no-search");
  assert.equal(qwen.report.searchDecision, "independent-search");
});

test("forced nonempty independent queries keep their distinct directions", async () => {
  for (const [model, query] of [["deepseek", "GitHub pricing official"], ["qwen", "Copilot plan comparison official"]]) {
    const result = await plan(model, "请联网查询当前价格。", [{ kind: "public", question: "官方价格", query }]);
    assert.equal(result.queries[0], query);
    assert.equal(result.report.searchDecision, "user-forced-search");
  }
});

test("search failure is not a no-search decision", async () => {
  const result = await plan("deepseek", "必须联网查询官方价格。", [], "error");
  assert.equal(result.report.searchDecision, "forced-search-fallback");
  assert.equal(result.report.searches[0].status, "error");
});

test("negative search instructions do not force search", async () => {
  assert.equal((await plan("deepseek", "不要联网查询，先给建议。", [])).report.searchDecision, "independent-no-search");
});
