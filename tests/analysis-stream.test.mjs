import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { posix } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// End-to-end tests for the streaming analysis route. The real route,
// model-stream adapter, view extractor and diagnostics run in a VM; only the
// network (fetch), Next.js response object and search/evidence stages are local.

const compile = (path) => ts.transpileModule(
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createHarness(env = {}) {
  const calls = [];
  const processEnv = { DEEPSEEK_API_KEY: "test-placeholder", DASHSCOPE_API_KEY: "test-placeholder", ...env };
  let handler = async () => new Response("{}", { status: 200 });
  const cache = new Map();

  const sandboxExtras = {
    Request, Response, Headers, AbortSignal, AbortController, ReadableStream, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, URL,
    console: { info() {}, error() {} },
    process: { env: processEnv },
    fetch: async (url, init) => {
      try { calls.push(JSON.parse(init.body)); } catch { /* non-JSON bodies are irrelevant here */ }
      return handler(url, init);
    },
  };

  function resolveFrom(name, dir) {
    if (name.startsWith(".")) return load(posix.normalize(`${dir}/${name}.ts`));
    if (name === "next/server") return { NextResponse: Response };
    if (name === "node:crypto") return { createHash };
    if (name === "node:async_hooks") return { AsyncLocalStorage };
    if (name.startsWith("@/")) {
      if (name.endsWith("/search-plan")) return { prepareWebEvidence: async () => { throw new Error("search must not run in demo stream tests"); } };
      if (name.endsWith("/evidence-quality")) return { gradeAndTraceEvidence: async () => { throw new Error("evidence grading must not run in demo stream tests"); } };
      if (name.endsWith("/pending-information")) return { reconcilePendingInformation: async (state) => ({ ...state, pendingInformation: [] }) };
      return load(`src/${name.slice(2)}.ts`);
    }
    throw new Error(`Unexpected import: ${name}`);
  }

  function load(path) {
    if (cache.has(path)) return cache.get(path);
    const loaded = { exports: {} };
    const dir = path.slice(0, path.lastIndexOf("/"));
    runInNewContext(compile(path), {
      ...sandboxExtras,
      module: loaded,
      exports: loaded.exports,
      require: (name) => resolveFrom(name, dir),
    });
    cache.set(path, loaded.exports);
    return loaded.exports;
  }

  return {
    load,
    calls,
    set handler(next) { handler = next; },
  };
}

function eventStream(chunks, { delay = 15, finish = "stop" } = {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        await sleep(delay);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`));
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

// A stream that never produces a token, but rejects when the adapter aborts.
function stalledStream(signal) {
  return new Response(new ReadableStream({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })));
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

async function collect(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const at = Date.now();
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) events.push({ event: JSON.parse(data), at });
      boundary = buffer.indexOf("\n\n");
    }
  }
  return events;
}

const state = () => ({
  version: 2,
  currentQuestion: "演示问题：零预算的个人项目先做什么？",
  confirmedFacts: ["用户明确提供：预算为零"],
  pendingInformation: [],
  modelViews: { deepseek: "上一轮 DeepSeek 观点", qwen: "上一轮 Qwen 观点" },
  changes: [],
});

async function analyzeStream(harness, payload = state(), extra = {}) {
  const route = harness.load("src/app/api/shared-analysis/route.ts");
  const response = await route.POST(new Request("http://localhost/api/shared-analysis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: payload, stream: true, ...extra }),
  }));
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    throw new Error(`Expected an SSE response, got ${response.status}: ${await response.clone().text()}`);
  }
  return { response, events: await collect(response) };
}

const textOf = (events, model) => events
  .filter(({ event }) => event.type === "delta" && event.model === model)
  .map(({ event }) => event.text)
  .join("");

test("streams each model independently: deltas arrive before the slower model finishes", async () => {
  const harness = createHarness();
  harness.handler = async (url) => {
    if (url.includes("deepseek")) return eventStream(["DeepSeek 第一段。", "DeepSeek 第二段。"], { delay: 15 });
    await sleep(120);
    return eventStream(["Qwen 第一段。"], { delay: 15 });
  };
  const { events } = await analyzeStream(harness);

  const deepseekDeltas = events.filter(({ event }) => event.type === "delta" && event.model === "deepseek");
  const qwenDoneIndex = events.findIndex(({ event }) => event.type === "model-done" && event.model === "qwen");
  const finalDoneIndex = events.findIndex(({ event }) => event.type === "done");
  const lastDeepseekDelta = events[events.findLastIndex(({ event }) => event.type === "delta" && event.model === "deepseek")];

  assert.ok(deepseekDeltas.length >= 2, "DeepSeek 的文字应该分多段到达");
  assert.ok(lastDeepseekDelta.at < events[qwenDoneIndex].at, "DeepSeek 的文字应该早于 Qwen 完成");
  assert.ok(qwenDoneIndex < finalDoneIndex, "最终结果必须在两边都结束后才发");
  assert.equal(textOf(events, "deepseek"), "DeepSeek 第一段。DeepSeek 第二段。");
  assert.equal(textOf(events, "qwen"), "Qwen 第一段。");
  assert.equal(events[finalDoneIndex].event.state.modelViews.deepseek, "DeepSeek 第一段。DeepSeek 第二段。");
  assert.equal(events[finalDoneIndex].event.state.modelViews.qwen, "Qwen 第一段。");
});

test("keeps the healthy side when the other model fails", async () => {
  const harness = createHarness();
  harness.handler = async (url) => {
    if (url.includes("deepseek")) return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: { "Content-Type": "application/json" } });
    return eventStream(["Qwen 正常回答。"]);
  };
  const { events } = await analyzeStream(harness);

  const failure = events.find(({ event }) => event.type === "model-error");
  const done = events.find(({ event }) => event.type === "done");
  assert.equal(failure.event.model, "deepseek");
  assert.equal(failure.event.code, "upstream");
  assert.ok(done, "另一侧成功后仍要保存本轮");
  assert.equal(done.event.state.modelViews.qwen, "Qwen 正常回答。");
  assert.equal(done.event.state.modelViews.deepseek, "上一轮 DeepSeek 观点", "失败的一侧保留上一轮观点");
  assert.equal(done.event.errors.deepseek.code, "upstream");
  assert.ok(!events.some(({ event }) => event.type === "error"), "单侧失败不能升级成整轮失败");
});

test("marks a stuck model at the timeout instead of blocking the page", async () => {
  const harness = createHarness({ ANALYSIS_FIRST_OUTPUT_TIMEOUT_MS: "80" });
  harness.handler = async (url, init) => {
    if (url.includes("deepseek")) return stalledStream(init.signal);
    return eventStream(["Qwen 不受影响。"]);
  };
  const started = Date.now();
  const { events } = await analyzeStream(harness);

  const failure = events.find(({ event }) => event.type === "model-error" && event.model === "deepseek");
  const done = events.find(({ event }) => event.type === "done");
  assert.equal(failure.event.code, "timeout");
  assert.match(failure.event.message, /卡住/);
  assert.ok(failure.at - started < 1500, "超时应该在配置的首字时间内触发");
  assert.equal(done.event.state.modelViews.qwen, "Qwen 不受影响。");
  assert.equal(done.event.state.modelViews.deepseek, "上一轮 DeepSeek 观点");
});

test("both models failing ends the stream with one error event, no done", async () => {
  const harness = createHarness();
  harness.handler = async (url) => new Response(JSON.stringify({ error: "nope" }), {
    status: url.includes("deepseek") ? 401 : 429,
    headers: { "Content-Type": "application/json" },
  });
  const { events } = await analyzeStream(harness);

  const errors = events.filter(({ event }) => event.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].event.errors.deepseek.code, "auth");
  assert.equal(errors[0].event.errors.qwen.code, "rate-limit");
  assert.ok(!events.some(({ event }) => event.type === "done"));
});

test("extracts view text from a streamed JSON answer instead of showing raw JSON", async () => {
  const harness = createHarness();
  const chunks = ['{"view":"', "你好", "，世界", '","pendingInformation":[],"evidence":[]}'];
  harness.handler = async () => eventStream(chunks);
  const { events } = await analyzeStream(harness);

  assert.equal(textOf(events, "deepseek"), "你好，世界");
  assert.equal(textOf(events, "qwen"), "你好，世界");
  assert.ok(!textOf(events, "qwen").includes('"view"'));
});

test("sends stream=true and the 900-token cap to both models", async () => {
  const harness = createHarness();
  harness.handler = async () => eventStream(["好。"]);
  await analyzeStream(harness);

  assert.equal(harness.calls.length, 2);
  for (const body of harness.calls) {
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 900);
    assert.deepEqual(body.messages.map((message) => message.role), ["system", "user"]);
  }
  assert.deepEqual(harness.calls.map((body) => body.model).sort(), ["deepseek-chat", "qwen-plus"]);
});

test("ViewTextStream tolerates chunk boundaries, escapes and Unicode splits", () => {
  const harness = createHarness();
  const { ViewTextStream } = harness.load("src/lib/view-stream.ts");
  const stream = new ViewTextStream();
  const chunks = ['{"view":"a\\n', "b\\u4f60", "\\u597d", '","pendingInformation":[]}'];
  const output = chunks.map((chunk) => stream.push(chunk)).join("") + stream.finish();
  assert.equal(output, "a\nb你好");
});

test("retrying one model leaves the other model untouched", async () => {
  const harness = createHarness();
  harness.handler = async (url) => {
    assert.ok(url.includes("dashscope"), "只应该请求 Qwen");
    return eventStream(["Qwen 重试后的回答。"]);
  };
  const { events } = await analyzeStream(harness, state(), { models: ["qwen"] });

  const done = events.find(({ event }) => event.type === "done");
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].model, "qwen-plus");
  assert.equal(done.event.state.modelViews.qwen, "Qwen 重试后的回答。");
  assert.equal(done.event.state.modelViews.deepseek, "上一轮 DeepSeek 观点");
  assert.match(done.event.state.changes.at(-1), /Qwen/);
});

test("an empty model list is rejected before any model call", async () => {
  const harness = createHarness();
  const route = harness.load("src/app/api/shared-analysis/route.ts");
  const response = await route.POST(new Request("http://localhost/api/shared-analysis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state: state(), stream: true, models: [] }),
  }));
  assert.equal(response.status, 400);
  assert.equal(harness.calls.length, 0);
});
