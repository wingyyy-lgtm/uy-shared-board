import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Actual page submit/save/read code and both route handlers; only model/search,
// React scheduling and browser storage are simulated. No network or real keys.
const first = "有商家愿意支付5000元，让我两周内做一个AI工具。\n具体功能尚不明确，我需要判断是否值得接单。";
const second = "商家只要演示版，不要求正式上线，\n不接敏感数据，不需要后续维护。\n我预计40小时完成。\n5000元一口价，演示验收通过后付款。";
const questions = ["是否需要正式上线、敏感数据或维护？", "工时、总价和付款条件是什么？", "具体演示功能和验收标准是什么？"];

function buildSimulation(malformedOperation = false) {
  const logs = [], requests = [], modelInputs = [], storage = new Map(), context = new AsyncLocalStorage();
  const diagnostics = {
    withSubmissionContext: (request, run) => context.run(request.headers.get("x-submission-id"), run),
    getSubmissionId: () => context.getStore(),
    logAnalysisDetail: (tag, detail) => logs.push({ tag, ...detail, submissionId: context.getStore() }),
    logAnalysisStage() {}, logAnalysisError: (stage, error) => logs.push({ stage, error: error.message }),
    diagnosticStage: async (_stage, run) => run(), diagnosticJson: async (response) => response.json(),
  };
  const jsonModel = (content) => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }] });
  const modelFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.max_tokens === 240) return jsonModel({ facts: ["有商家愿意支付5000元，让我两周内做一个AI工具", "具体功能尚不明确"] });
    assert.equal(body.max_tokens, 2000);
    const input = JSON.parse(body.messages[1].content);
    if (input.missingFactIds.length) {
      // Reproduce the precise logged failure, not an assumed invalid index.
      assert.ok(input.confirmedFacts.includes(second));
      assert.deepEqual(Array.from(input.questions), questions);
      assert.equal(input.confirmedFacts[2], second);
      return jsonModel({ groups: [
        { questionIds: [0], status: "closed", question: "", factIds: [2] },
        { questionIds: [1], status: "closed", question: "", factIds: [2] },
        ...(malformedOperation
          ? [{ questionIds: [2], status: "partial", question: "", factIds: [2] }]
          : [{ questionIds: [2], status: "partial", question: "功能与验收仍待确认", factIds: [] }]),
      ], retiredFacts: [] });
    }
    return jsonModel({ groups: input.questions.map((question, id) => ({ questionIds: [id], status: "open", question, factIds: [] })), retiredFacts: [] });
  };
  diagnostics.diagnosticFetch = async (stage, _url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    modelInputs.push({ stage, state: input.sharedState });
    const round = input.sharedState.version;
    return jsonModel({
      view: `【我理解的问题】判断是否接单\n【当前判断】${round === 1 ? "范围不明，暂不能确定。" : "根据用户提供的演示版、40小时、5000元及验收后付款，可条件化接单，仍需明确验收。"}\n【关键未知信息】功能与验收标准\n【下一步建议】明确验收。`,
      evidence: [], pendingInformation: round === 1 ? questions : [questions[2]],
    });
  };
  const cache = new Map();
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    const routeModule = { exports: {} };
    const code = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(code, {
      module: routeModule, exports: routeModule.exports, Request, Response, AbortSignal, ReadableStream, TextEncoder, setInterval, clearInterval,
      console: { info() {}, error() {} }, process: { env: { DEEPSEEK_API_KEY: "placeholder", DASHSCOPE_API_KEY: "placeholder" } }, fetch: modelFetch,
      require(name) {
        if (name.endsWith("/demo-mode")) return load("src/lib/demo-mode.ts");
        if (name.endsWith("/analysis-errors")) return { describeModelError: (error) => ({ code: "failed", message: error instanceof Error ? error.message : String(error) }) };
        if (name.endsWith("/simple-correction")) return { resolveSimpleCorrection: () => null };
        if (name.endsWith("/model-stream")) return {
          streamChatCompletion: async ({ stage, url, headers, payload, onDelta }) => {
            const response = await diagnostics.diagnosticFetch(stage, url, { method: "POST", headers, body: JSON.stringify({ ...payload, stream: true }) });
            const data = await response.json();
            const content = data.choices?.[0]?.message?.content ?? "";
            const finishReason = data.choices?.[0]?.finish_reason;
            onDelta?.(content);
            return { content, finishReason, truncated: false };
          },
        };
        if (name === "next/server") return { NextResponse: Response };
        if (name === "node:crypto") return { createHash };
        if (name === "node:fs") return { appendFileSync() {} };
        if (name.endsWith("/pending-information")) return load("src/lib/pending-information.ts");
        if (name.endsWith("/shared-analysis-diagnostics")) return diagnostics;
        if (name.endsWith("/search-plan")) return { prepareWebEvidence: async () => { throw new Error("Demo must never enter search planning, including forced search"); } };
        if (name.endsWith("/evidence-quality")) return { gradeAndTraceEvidence: async () => { throw new Error("Demo must never enter evidence grading or tracing"); } };
        throw new Error(`Unexpected module ${name}`);
      },
    });
    cache.set(path, routeModule.exports);
    return routeModule.exports;
  }
  const facts = load("src/app/api/shared-facts/route.ts"), analysis = load("src/app/api/shared-analysis/route.ts");
  const localFetch = async (url, options) => {
    const request = new Request(`http://localhost${url}`, options);
    const response = await (url === "/api/shared-facts" ? facts : analysis).POST(request);
    requests.push({ url, status: response.status, submissionId: request.headers.get("x-submission-id") });
    return response;
  };
  function newPage() {
    const routeModule = { exports: {} }, hooks = [];
    let cursor = 0;
    const source = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8").replace("return <main ref={mainRef}", "globalThis.pageTest = { submit, setInput, input, error, currentRoundState, rounds, cases }; return <main ref={mainRef}");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const sandbox = {
      module: routeModule, exports: routeModule.exports, console: { info() {} }, crypto: { randomUUID }, fetch: localFetch, Event: class {},
      window: { localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }, dispatchEvent() {}, setTimeout: () => 0, setInterval: () => 0, clearInterval() {} },
      require(name) {
        if (name.endsWith("/demo-mode")) return load("src/lib/demo-mode.ts");
        if (name.endsWith("/analysis-errors")) return { describeModelError: (error) => ({ code: "failed", message: error instanceof Error ? error.message : String(error) }) };
        if (name.endsWith("/simple-correction")) return { resolveSimpleCorrection: () => null };
        if (name.endsWith("/model-stream")) return {
          streamChatCompletion: async ({ stage, url, headers, payload, onDelta }) => {
            const response = await diagnostics.diagnosticFetch(stage, url, { method: "POST", headers, body: JSON.stringify({ ...payload, stream: true }) });
            const data = await response.json();
            const content = data.choices?.[0]?.message?.content ?? "";
            const finishReason = data.choices?.[0]?.finish_reason;
            onDelta?.(content);
            return { content, finishReason, truncated: false };
          },
        };
        if (name.endsWith("/live-panel")) return { LivePanel: () => null };
        if (name.endsWith("/sse-client")) return {
          readAnalysisStream: async (response, onEvent) => {
            const text = await response.text();
            for (const frame of text.split("\n\n")) {
              const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
              if (data) onEvent(JSON.parse(data));
            }
          },
        };
        if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
        if (name === "react") return {
          useState(initial) { const id = cursor++; if (!(id in hooks)) hooks[id] = initial; return [hooks[id], (next) => { hooks[id] = typeof next === "function" ? next(hooks[id]) : next; }]; },
          useRef: () => ({ current: null }), useEffect() {}, useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
        };
        throw new Error(`Unexpected page import ${name}`);
      },
    };
    runInNewContext(code, sandbox);
    const render = () => { cursor = 0; routeModule.exports.default(); return sandbox.pageTest; };
    return { render, submit: async (input) => { render().setInput(input); await render().submit({ preventDefault() {} }); return render(); } };
  }
  return { newPage, requests, logs, modelInputs };
}

for (const malformed of [false, true]) test(`two rounds, latest shared facts and persistence with ${malformed ? "malformed question" : "missing factIds"}`, async () => {
  const { newPage, requests, logs, modelInputs } = buildSimulation(malformed);
  const page = newPage();
  const firstResult = await page.submit(first);
  assert.equal(firstResult.error, "");
  assert.equal(firstResult.rounds.length, 1);
  assert.equal(firstResult.input, "");
  assert.deepEqual(Array.from(firstResult.currentRoundState.pendingInformation), questions);
  const firstSnapshot = JSON.stringify(firstResult.rounds[0]);
  const secondResult = await page.submit(second);
  assert.equal(secondResult.error, "");
  assert.equal(secondResult.input, "");
  assert.equal(secondResult.rounds.length, 2);
  assert.equal(secondResult.currentRoundState.version, 2);
  assert.ok(secondResult.currentRoundState.confirmedFacts.includes(second));
  for (const model of ["deepseek", "qwen"]) {
    assert.notEqual(secondResult.rounds[0].state.modelViews[model], secondResult.rounds[1].state.modelViews[model]);
    assert.match(secondResult.rounds[1].state.modelViews[model], /40小时、5000元/);
  }
  assert.deepEqual(Array.from(secondResult.currentRoundState.pendingInformation), [questions[2]]);
  assert.equal(JSON.stringify(secondResult.rounds[0]), firstSnapshot);
  assert.deepEqual(requests.map(({ status }) => status), [200, 200, 200, 200]);
  assert.equal(requests[0].submissionId, requests[1].submissionId);
  assert.equal(requests[2].submissionId, requests[3].submissionId);
  assert.ok(logs.some((entry) => entry.reason === (malformed ? "invalid-remaining-question" : "lifecycle-decision-needs-a-fact-reference") && entry.submissionId === requests[2].submissionId));
  const latestModelInputs = modelInputs.filter(({ state }) => state.version === 2);
  assert.equal(latestModelInputs.length, 2);
  assert.ok(latestModelInputs.some(({ stage }) => stage.startsWith("deepseek")));
  assert.ok(latestModelInputs.some(({ stage }) => stage.startsWith("qwen")));
  assert.deepEqual(latestModelInputs[0].state, latestModelInputs[1].state);
  assert.ok(latestModelInputs[0].state.confirmedFacts.includes(second));
  assert.deepEqual(Array.from(latestModelInputs[0].state.pendingInformation), [questions[2]]);
  // New page/module/hook state, with only the same serialized storage retained.
  const reloaded = newPage().render();
  assert.equal(reloaded.rounds.length, 2);
  assert.equal(reloaded.rounds[0].userInput, first);
  assert.equal(reloaded.rounds[1].userInput, second);
  assert.deepEqual(Array.from(reloaded.currentRoundState.pendingInformation), [questions[2]]);
});
