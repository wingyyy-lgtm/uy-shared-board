import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const code = ts.transpileModule(readFileSync(new URL("../src/lib/pending-information.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function reconcile(groups, retryGroups, pending = ["P1", "P2"]) {
  const routeModule = { exports: {} }, logs = [], requests = [];
  runInNewContext(code, {
    module: routeModule, exports: routeModule.exports, AbortSignal, process: { env: {} },
    require: () => ({ logAnalysisDetail: (tag, detail) => logs.push({ tag, submissionId: "test-submission", ...detail }) }),
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      const reply = requests.length > 1 && retryGroups ? retryGroups : groups;
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ groups: reply, retiredFacts: [] }) } }] }) };
    },
  });
  const state = { version: 2, currentQuestion: "test", confirmedFacts: ["用户明确回答了 P1"], pendingInformation: pending, modelViews: { deepseek: "", qwen: "" }, changes: [] };
  const result = await routeModule.exports.reconcilePendingInformation(state);
  return { pending: Array.from(result.pendingInformation), logs, requests };
}
const close = (id) => ({ questionIds: [id], status: "closed", question: "", factIds: [0] });

test("A: close P1 (index 0), retain unmentioned P2", async () => {
  assert.deepEqual((await reconcile([close(0)])).pending, ["P2"]);
});
test("B: invalid P99 index is logged, all pending retained", async () => {
  const { pending, logs } = await reconcile([close(99)]);
  assert.deepEqual(pending, ["P1", "P2"]);
  assert.equal(logs[0].tag, "[pending-lifecycle-invalid-reference]");
  assert.equal(logs[0].submissionId, "test-submission");
});
test("C: valid closure works beside an invalid reference", async () => {
  assert.deepEqual((await reconcile([close(0), close(99)])).pending, ["P2"]);
});
test("D: all invalid references preserve the original pending", async () => {
  assert.deepEqual((await reconcile([close(99), close("P99")])).pending, ["P1", "P2"]);
});
test("valid keep/replacement and deferred retention still work", async () => {
  assert.deepEqual((await reconcile([{ questionIds: [0], status: "open", question: "P1", factIds: [] }])).pending, ["P1", "P2"]);
  assert.deepEqual((await reconcile([{ questionIds: [0], status: "partial", question: "P1剩余问题", factIds: [0] }])).pending, ["P1剩余问题", "P2"]);
  assert.deepEqual((await reconcile([{ questionIds: [0], status: "deferred", question: "", factIds: [] }])).pending, ["P1", "P2"]);
});
test("invalid fact reference cannot close a pending item", async () => {
  assert.deepEqual((await reconcile([{ ...close(0), factIds: [99] }])).pending, ["P1", "P2"]);
});

test("real failure condition: closed/partial without fact reference is ignored, not fatal", async () => {
  for (const status of ["closed", "partial"]) {
    const { pending, logs } = await reconcile([
      close(0),
      { questionIds: [1], status, question: "不应采纳的改写", factIds: [] },
    ]);
    assert.deepEqual(pending, ["P2"]);
    assert.ok(logs.some((entry) => entry.reason === "lifecycle-decision-needs-a-fact-reference"));
  }
});

test("one malformed lifecycle operation cannot discard valid closures or unresolved questions", async () => {
  for (const invalid of [
    null,
    { questionIds: [1], status: "invalid", factIds: [] },
    { questionIds: [1], status: "partial", question: "", factIds: [0] },
    { ...close(0) },
    { questionIds: [], status: "closed", factIds: [0] },
  ]) {
    const { pending, logs } = await reconcile([close(0), invalid]);
    assert.deepEqual(pending, ["P2"]);
    assert.ok(logs.some((entry) => entry.tag === "[pending-lifecycle-invalid-operation]"));
  }
});

test("rejected closure is retried once with the rejection reasons and the repaired answer is used", async () => {
  const { pending, requests } = await reconcile(
    [{ questionIds: [0], status: "closed", question: "", factIds: [] }, close(1)],
    [close(0), close(1)],
  );
  assert.deepEqual(pending, []);
  assert.equal(requests.length, 2);
  const retryInput = JSON.parse(requests[1].messages[1].content);
  assert.ok(retryInput.rejectedLastTime.some((reason) => reason.includes("lifecycle-decision-needs-a-fact-reference")));
});

test("a retry that is no better is discarded, and a clean first answer is not retried", async () => {
  const bad = { questionIds: [0], status: "closed", question: "", factIds: [] };
  assert.deepEqual((await reconcile([bad, close(1)], [bad, bad, close(1)])).pending, ["P1"]);
  assert.equal((await reconcile([close(0)])).requests.length, 1);
});

test("heading echoes and generic what-else-is-missing questions are dropped, concrete ones kept", async () => {
  const pending = ["决定性未知问题", "关键未知信息：", "判断是否值得接单还缺少哪些决定性信息？", "演示验收的具体判定标准是什么？"];
  const open = [{ questionIds: [0], status: "open", question: pending[3], factIds: [] }];
  const { pending: result, requests } = await reconcile(open, undefined, pending);
  assert.deepEqual(result, ["演示验收的具体判定标准是什么？"]);
  assert.deepEqual(JSON.parse(requests[0].messages[1].content).questions, ["演示验收的具体判定标准是什么？"]);
  // A model-rewritten remainder that degenerates into a generic question is dropped too.
  const rewritten = await reconcile([{ questionIds: [0], status: "partial", question: "还缺少哪些信息？", factIds: [0] }, close(1)]);
  assert.deepEqual(rewritten.pending, []);
});
