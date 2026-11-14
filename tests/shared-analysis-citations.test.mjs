import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Execute the actual route with local model/search responses; no credentials or network.
const routeCode = ts.transpileModule(
  readFileSync(new URL("../src/app/api/shared-analysis/route.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

async function analyze({ ids = ["S1", "S2"], selectedIds = ["S3", "S4"], missingSource = false, missingSupport = false, badQuote = false, badClaim = false, content, contents, searchDecision, logs = [], evidenceId = (id) => id, finishReasons = ["stop"], requests = [], demoMode = false } = {}) {
  const routeModule = { exports: {} };
  const selected = (missingSource ? [] : selectedIds).map((id) => ({
    id, title: id, url: `https://example.com/${id}`, snippet: "Original supporting snippet",
    grade: "A", sourceType: "官方", reason: "Test source", scope: "Test scope",
  }));
  const claims = ids.map((id) => `${id} 对应的结论。`);
  const view = `【我理解的问题】\n测试问题\n【当前判断】\n${ids.map((id, i) => `${claims[i]}[${id}]`).join("\n")}\n【关键未知信息】\n暂无决定性缺口\n【下一步建议】\n核实。`;
  const evidence = ids.filter((id) => !(missingSupport && id === ids[0])).map((id, i) => ({
    id: evidenceId(id), claim: badClaim ? "正文中不存在的句子。" : claims[i],
    supports: "Supports the claim", quote: badQuote ? "Absent quote" : "supporting snippet",
  }));
  const diagnostics = {
    withSubmissionContext: (_request, run) => run(),
    logAnalysisDetail: (tag, details) => logs.push([tag, JSON.stringify(details)]),
    logAnalysisStage() {}, logAnalysisError: (stage, error) => logs.push([stage, error.message]),
    diagnosticStage: async (_stage, run) => run(),
    diagnosticJson: async (response) => response.json(),
    diagnosticFetch: async (stage, _url, options) => {
      const attempt = requests.filter((request) => request.stage === stage).length;
      requests.push({ stage, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ choices: [{ finish_reason: finishReasons[Math.min(attempt, finishReasons.length - 1)], message: { content: contents?.[Math.min(attempt, contents.length - 1)] ?? content ?? JSON.stringify({ view, evidence, pendingInformation: [] }) } }] }));
    },
  };
  runInNewContext(routeCode, {
    module: routeModule, exports: routeModule.exports, Response, AbortSignal,
    console: { info: (...args) => logs.push(args) },
    process: { env: { DEEPSEEK_API_KEY: "test-placeholder", DASHSCOPE_API_KEY: "test-placeholder" } },
    require(name) {
      if (name.endsWith("/demo-mode")) return { DEMO_MODE: demoMode };
      if (name.endsWith("/analysis-errors")) return { describeModelError: (error) => ({ code: "failed", message: error instanceof Error ? error.message : String(error) }) };
      if (name.endsWith("/model-stream")) return { streamChatCompletion: async () => { throw new Error("streaming must not run in these non-stream tests"); } };
      if (name === "next/server") return { NextResponse: Response };
      if (name === "node:crypto") return { createHash };
      if (name.endsWith("/search-plan")) return {
        prepareWebEvidence: async () => { assert.equal(demoMode, false, "Demo cannot enter automatic/forced search"); return { category: "B", unknowns: [], searches: [], searchDecision }; },
      };
      if (name.endsWith("/evidence-quality")) return {
        gradeAndTraceEvidence: async () => { assert.equal(demoMode, false, "Demo cannot enter evidence processing"); return { sources: selected, selected, followUps: [] }; },
      };
      if (name.endsWith("/shared-analysis-diagnostics")) return diagnostics;
      if (name.endsWith("/pending-information")) return {
        reconcilePendingInformation: async () => ({ pendingInformation: [] }),
      };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const state = {
    version: 1, currentQuestion: demoMode ? "必须联网查询当前价格" : "Test", confirmedFacts: [], pendingInformation: [],
    changes: [], modelViews: { deepseek: "", qwen: "" },
  };
  return routeModule.exports.POST(new Request("http://localhost/api/shared-analysis", {
    method: "POST", body: JSON.stringify({ state }),
  }));
}

test("demo bypasses even explicit forced search and uses both real model adapters", async () => {
  const requests = [], logs = [];
  const content = JSON.stringify({ view: "【我理解的问题】用户决策【当前判断】当前无法核实外部价格【关键未知信息】用户范围【下一步建议】确认范围", evidence: [], pendingInformation: [] });
  const response = await analyze({ demoMode: true, searchDecision: "user-forced-search", content, requests, logs });
  assert.equal(response.status, 200);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(r => r.body.model).sort(), ["deepseek-chat", "qwen-plus"]);
  for (const request of requests) {
    assert.deepEqual(Object.keys(JSON.parse(request.body.messages[1].content)), ["sharedState"]);
    assert.match(request.body.messages[0].content, /未经核实的市场价格/);
    assert.match(request.body.messages[0].content, /只用自己的上一轮观点/);
  }
  const payload = await response.json();
  assert.equal(payload.receivedState.deepseek, payload.receivedState.qwen);
  assert.doesNotMatch(payload.state.modelViews.qwen, /我查到的证据|全部搜索结果|\[S\d+\]/);
  assert.equal(logs.filter(([tag]) => tag === "[demo-mode]").length, 2);
});

test("demo never accepts fabricated source IDs, even after its one bounded regeneration", async () => {
  const requests = [];
  const response = await analyze({ demoMode: true, requests });
  assert.equal(response.status, 502);
  for (const model of ["deepseek", "qwen"]) assert.equal(requests.filter(r => r.stage === `${model}-final-analysis`).length, 2);
});

test("local S1/S2 citations pass when claim text excludes citation markers", async () => {
  const response = await analyze();
  assert.equal(response.status, 200);
  const payload = await response.json();
  for (const model of ["deepseek", "qwen"]) {
    assert.match(payload.state.modelViews[model], /S1 对应的结论。\[S1\]/);
    assert.match(payload.state.modelViews[model], /S2 对应的结论。\[S2\]/);
  }
});

test("S99 is rejected when only S3/S4 are selected", async () => {
  assert.equal((await analyze({ ids: ["S1", "S99"] })).status, 502);
});

test("selected citation without corresponding support is rejected", async () => {
  assert.equal((await analyze({ missingSupport: true })).status, 502);
});

test("claim/view checks remain enforced", async () => {
  assert.equal((await analyze({ badClaim: true })).status, 502);
});

test("selected S1/S4 with non-verbatim quote passes and records quality signal", async () => {
  const logs = [];
  assert.equal((await analyze({ ids: ["S1", "S2"], selectedIds: ["S1", "S4"], badQuote: true, logs })).status, 200);
  const quality = logs.filter(([event]) => event === "[citation-quality]").map(([, detail]) => JSON.parse(detail));
  assert.equal(quality.length, 4);
  assert.ok(quality.every((entry) => entry.quoteMatchesSnippet === false));
});

test("S99, missing S1 source/support, and mismatched S1 claim are still rejected", async () => {
  const selectedIds = ["S1", "S4"];
  for (const options of [
    { ids: ["S99"] },
    { ids: ["S1"], missingSource: true },
    { ids: ["S1"], missingSupport: true },
    { ids: ["S1"], badClaim: true },
  ]) {
    assert.equal((await analyze({ selectedIds, ...options })).status, 502);
  }
});

const plainView = "【我理解的问题】用户要查询 GitHub Copilot。\n【当前判断】当前无法确定。\n【关键未知信息】需要核实。\n【下一步建议】核实官方资料。";

test("no evidence: nonexistent citation regenerates once rather than being stripped", async () => {
  const invalid = JSON.stringify({ view: plainView.replace("当前无法确定。", "官方价格为10美元。[S1]"), evidence: [], pendingInformation: [] });
  const corrected = JSON.stringify({ view: plainView, evidence: [], pendingInformation: [] });
  const requests = [];
  const response = await analyze({ selectedIds: [], ids: [], contents: [invalid, corrected], requests });
  assert.equal(response.status, 200);
  for (const model of ["deepseek", "qwen"]) {
    const calls = requests.filter((request) => request.stage === `${model}-final-analysis`);
    assert.equal(calls.length, 2);
    assert.match(calls[1].body.messages[0].content, /删除.*无证据/);
  }
  const payload = await response.json();
  assert.ok(!payload.state.modelViews.qwen.includes("10美元"));
  assert.ok(!payload.state.modelViews.qwen.includes("[S1]"));
});

test("no evidence: clean answer succeeds without regeneration", async () => {
  const requests = [];
  assert.equal((await analyze({ selectedIds: [], ids: [], content: JSON.stringify({ view: plainView, evidence: [] }), requests })).status, 200);
  assert.equal(requests.length, 2);
});

test("no evidence: second fabricated citation fails with no third call", async () => {
  const requests = [], logs = [];
  const content = JSON.stringify({ view: plainView.replace("当前无法确定。", "无依据结论。[S1]"), evidence: [] });
  assert.equal((await analyze({ selectedIds: [], ids: [], content, requests, logs })).status, 502);
  for (const model of ["deepseek", "qwen"]) assert.equal(requests.filter((request) => request.stage === `${model}-final-analysis`).length, 2);
  assert.ok(logs.some(([, message]) => message === "unsupported-no-evidence-citation-after-regeneration"));
});

test("forced search without evidence fails before final model invocation", async () => {
  const requests = [];
  assert.equal((await analyze({ selectedIds: [], ids: [], searchDecision: "user-forced-search", requests })).status, 502);
  assert.equal(requests.length, 0);
});

test("nonempty evidence retains strict S1 / S99 validation without regeneration", async () => {
  assert.equal((await analyze({ selectedIds: ["S5"], ids: ["S1"] })).status, 200);
  const requests = [];
  assert.equal((await analyze({ selectedIds: ["S5"], ids: ["S99"], requests })).status, 502);
  assert.equal(requests.length, 2);
});

test("model support IDs normalize and bind to S1 without fabricating support", async () => {
  for (const evidenceId of [(id) => id, (id) => `[${id}]`, (id) => ` ${id.toLowerCase()} `]) {
    const logs = [];
    const response = await analyze({ ids: ["S1", "S2"], selectedIds: ["S1", "S3"], evidenceId, logs });
    assert.equal(response.status, 200);
    const bindings = logs.filter(([event, value]) => event === "[support-binding]" && value.startsWith("{")).map(([, value]) => JSON.parse(value));
    assert.ok(bindings.filter((entry) => entry.citation === "S1").every((entry) => entry.supportFound && entry.supportMapKeys.includes("S1")));
  }
});

test("absent model support and S3-only support cannot satisfy S1", async () => {
  for (const options of [{ missingSupport: true }, { evidenceId: () => "S3" }]) {
    const logs = [];
    assert.equal((await analyze({ ids: ["S1"], selectedIds: ["S1", "S3"], logs, ...options })).status, 502);
    assert.ok(logs.some(([event, value]) => event === "[support-binding]" && value.includes("missing-model-support-for-citation=S1")));
  }
});

for (const [name, content] of [
  ["plain Chinese text", plainView],
  ["JSON view", JSON.stringify({ view: plainView })],
  ["JSON string wrapping JSON", JSON.stringify(JSON.stringify({ view: plainView }))],
  ["nested view wrappers", JSON.stringify({ view: JSON.stringify({ view: plainView }) })],
  ["malformed JSON-looking text", `[${plainView}`],
]) {
  test(`${name} safely reaches a successful route response`, async () => {
    const response = await analyze({ ids: [], content });
    assert.equal(response.status, 200);
    const payload = await response.json();
    for (const model of ["deepseek", "qwen"]) {
      assert.ok(payload.state.modelViews[model].includes("【我理解的问题】用户要查询 GitHub Copilot。"));
      assert.ok(!payload.state.modelViews[model].includes('"view":'));
    }
  });
}

test("view-only JSON parses its body without needing report headings", () => {
  const routeModule = { exports: {} };
  runInNewContext(`${routeCode}\nmodule.exports.parseForTest = parse;`, {
    module: routeModule, exports: routeModule.exports,
    process: { env: {} },
    require: () => ({ logAnalysisError() {} }),
  });
  for (const content of [JSON.stringify({ view: "正文" }), JSON.stringify(JSON.stringify({ view: "正文" }))]) {
    assert.equal(routeModule.exports.parseForTest(content).view, "正文");
  }
});

test("structured and nested responses preserve evidence and pending siblings", () => {
  const routeModule = { exports: {} };
  runInNewContext(`${routeCode}\nmodule.exports.parseForTest = parse;`, {
    module: routeModule, exports: routeModule.exports,
    process: { env: {} },
    require: () => ({ logAnalysisError() {} }),
  });
  const parse = routeModule.exports.parseForTest;
  const evidence = [{ id: "S1", claim: "结论", supports: "支持说明", quote: "原文" }];
  const payload = { view: "正文 [S1]", evidence, pendingInformation: ["待确认"] };
  for (const input of [
    payload,
    JSON.stringify(payload),
    JSON.stringify(JSON.stringify(payload)),
    { view: JSON.stringify(payload) },
    { view: { view: "正文 [S1]" }, evidence, pendingInformation: ["待确认"] },
    { view: JSON.stringify({ view: payload }) },
  ]) {
    const result = parse(input);
    assert.equal(result.view, "正文 [S1]");
    assert.equal(result.evidence.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(result.evidence)), evidence);
    assert.equal(result.pendingInformation[0], "待确认");
  }
  const plain = parse("【我理解的问题】普通回答");
  assert.equal(plain.view, "【我理解的问题】普通回答");
  assert.equal(plain.evidence.length, 0);
  assert.equal(plain.pendingInformation.length, 0);
});

test("evidence inside encoded view reaches support binding", async () => {
  const view = "【我理解的问题】测试\n【当前判断】结论。[S1]\n【关键未知信息】暂无决定性缺口\n【下一步建议】核实。";
  const inner = { view, evidence: [{ id: "S1", claim: "结论。", supports: "支持", quote: "supporting snippet" }], pendingInformation: [] };
  const response = await analyze({ selectedIds: ["S1"], content: JSON.stringify({ view: JSON.stringify(inner) }) });
  assert.equal(response.status, 200);
});

test("local citation mapping is assigned before final request and preserves original sources", async () => {
  for (const selectedIds of [["S2"], ["S2", "S5"], ["S5", "S2"]]) {
    const ids = selectedIds.map((_, index) => `S${index + 1}`);
    const requests = [], logs = [];
    const response = await analyze({ ids, selectedIds, requests, logs });
    assert.equal(response.status, 200);
    const payload = await response.json();
    for (const request of requests) {
      const sent = JSON.parse(request.body.messages[1].content).webEvidence;
      assert.deepEqual(sent.map((source) => source.id), ids);
      assert.deepEqual(sent.map((source) => source.localCitationId), ids);
      assert.deepEqual(sent.map((source) => source.url), selectedIds.map((id) => `https://example.com/${id}`));
    }
    for (const model of ["deepseek", "qwen"]) {
      for (const [index, original] of selectedIds.entries()) {
        assert.ok(payload.state.modelViews[model].includes(`[S${index + 1}] ${original}\n`));
        assert.ok(payload.state.modelViews[model].includes(`https://example.com/${original}`));
      }
      const mapping = logs.filter(([tag]) => tag === "[local-citation-mapping]").map(([, value]) => JSON.parse(value)).find((entry) => entry.model === model);
      assert.deepEqual(mapping.mappings, selectedIds.map((originalSourceId, index) => ({ localCitationId: `S${index + 1}`, originalSourceId })));
    }
  }
});

test("S3 remains forbidden when only two local citations exist", async () => {
  assert.equal((await analyze({ selectedIds: ["S2", "S5"], ids: ["S3"] })).status, 502);
});

for (const [name, finishReasons, expectedStatus, expectedCalls] of [
  ["stop does not retry", ["stop"], 200, 1],
  ["length then stop retries once", ["length", "stop"], 200, 2],
  ["length twice fails without third request", ["length", "length"], 502, 2],
]) {
  test(name, async () => {
    const requests = [], logs = [];
    const response = await analyze({ finishReasons, requests, logs });
    assert.equal(response.status, expectedStatus);
    for (const model of ["deepseek", "qwen"]) {
      const calls = requests.filter((request) => request.stage === `${model}-final-analysis`);
      assert.equal(calls.length, expectedCalls);
      assert.equal(calls[0].body.max_tokens, 900);
      if (expectedCalls === 2) {
        assert.equal(calls[1].body.max_tokens, 1800);
        assert.deepEqual(calls[0].body.messages, calls[1].body.messages);
      }
    }
    if (expectedStatus === 502) assert.ok(logs.some(([, message]) => message === "final-analysis-truncated-after-retry"));
  });
}
