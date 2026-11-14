import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const code = ts.transpileModule(
  readFileSync(new URL("../src/lib/sse-client.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

const loaded = { exports: {} };
runInNewContext(code, { module: loaded, exports: loaded.exports, Response, ReadableStream, TextDecoder, TextEncoder, require: () => ({}) });
const { readAnalysisStream } = loaded.exports;

test("parses frames split across network chunks and skips keep-alive comments", async () => {
  const encoder = new TextEncoder();
  const pieces = [
    ": ping\n\n",
    'data: {"type":"delta","model":"deepseek","text":"你',
    '好"}\n\ndata: {"type":"delta","model":"qwen","text":"OK"}\n\n',
    'data: {"type":"done","state":{},"receivedState":{},"searchReport":{},"errors":{}}\n\n',
  ];
  const response = new Response(new ReadableStream({
    async start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  }));
  const events = [];
  await readAnalysisStream(response, (event) => events.push(event));

  assert.deepEqual(events.map((event) => event.type), ["delta", "delta", "done"]);
  assert.equal(events[0].text, "你好");
  assert.equal(events[1].model, "qwen");
});

test("a malformed frame is ignored without dropping the following events", async () => {
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {not json}\n\ndata: {"type":"reset","model":"qwen"}\n\n'));
      controller.close();
    },
  }));
  const events = [];
  await readAnalysisStream(response, (event) => events.push(event));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "reset");
});
