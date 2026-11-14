import { NextResponse } from "next/server";
import type { SharedFactState } from "@/lib/council";
import { reconcilePendingInformation } from "@/lib/pending-information";
import { getSubmissionId, withSubmissionContext } from "@/lib/shared-analysis-diagnostics";
import { mentionsCorrectionTarget, replaceSimpleCorrection, resolveSimpleCorrection } from "@/lib/simple-correction";

type ChatPayload = { choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }> };
type CorrectionResolution = { supersededFacts: string[]; replacementFacts: string[] };

function safeText(text: string) {
  let safe = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (value && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)) {
      for (const secret of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]) safe = safe.split(secret).join("[REDACTED]");
    }
  }
  return safe.replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]");
}

function contentSummary(text: string) {
  const safe = safeText(text);
  return { contentLength: text.length, prefix: safe.slice(0, 100), suffix: safe.length > 100 ? safe.slice(-100) : "" };
}

function factsLog(event: "start" | "success" | "error", stage: string, details: Record<string, unknown> = {}) {
  try { console.info(`[shared-facts] ${event} stage=${stage}`, safeText(JSON.stringify({ ...details, submissionId: getSubmissionId() }))); }
  catch { console.error(`[shared-facts] error stage=${stage} submissionId=${getSubmissionId()} diagnostic-format-failed`); }
}

function factsError(stage: string, error: unknown, details: Record<string, unknown> = {}) {
  factsLog("error", stage, { ...details, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
}

async function factsStage<T>(stage: string, run: () => Promise<T>): Promise<T> {
  factsLog("start", stage);
  try { const result = await run(); factsLog("success", stage); return result; }
  catch (error) { factsError(stage, error); throw error; }
}

const modelResponseSummaries = new WeakMap<Response, ReturnType<typeof contentSummary>>();
async function factsFetch(...args: Parameters<typeof fetch>) {
  return factsStage("shared-facts-model-http", async () => {
    const response = await fetch(...args);
    try { modelResponseSummaries.set(response, contentSummary(await response.clone().text())); }
    catch (error) { factsError("shared-facts-model-response-summary", error, { status: response.status }); }
    if (!response.ok) factsError("shared-facts-model-http", new Error("Non-2xx model response"), { status: response.status, responseBodySummary: modelResponseSummaries.get(response) });
    return response;
  });
}

async function factsPayload(response: Response) {
  factsLog("start", "shared-facts-model-response-parse");
  try {
    const payload = await response.json() as ChatPayload;
    const choice = payload.choices?.[0];
    const details = { status: response.status, finish_reason: choice?.finish_reason, contentLength: choice?.message?.content?.length ?? 0, responseBodySummary: modelResponseSummaries.get(response) };
    factsLog("success", "shared-facts-model-response-parse", details);
    if (choice?.finish_reason === "length") factsError("shared-facts-model-response-parse", new Error("Model output truncated"), details);
    if (!response.ok || !choice?.message?.content?.trim()) factsError("shared-facts-model-response-parse", new Error("Model response failed or empty"), details);
    return payload;
  } catch (error) {
    factsError("shared-facts-model-response-parse", error, { status: response.status, responseBodySummary: modelResponseSummaries.get(response) });
    throw error;
  }
}

function factsJson(text: string) {
  factsLog("start", "shared-facts-json-normalize", { contentLength: text.length });
  try {
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    factsLog("success", "shared-facts-json-normalize");
    return parsed;
  } catch (error) { factsError("shared-facts-json-normalize", error, contentSummary(text)); throw error; }
}

function factsResponse(body: unknown) {
  factsLog("start", "shared-facts-final-serialization");
  try { const response = NextResponse.json(body); factsLog("success", "shared-facts-final-serialization"); return response; }
  catch (error) { factsError("shared-facts-final-serialization", error); throw error; }
}

function normalize(value: string) {
  return value.replace(/\s/g, "");
}

function isInstruction(value: string) {
  return /^(我想|我希望|我准备|请|帮我|你们|不要|必须|只|能否|是否|应该|请你|告诉我)/.test(value) || /[？?]$/.test(value);
}

function isExplicitCorrection(value: string) {
  // "实际占比是 30%" is a new fact, not a correction: it has no old value to
  // replace. Only explicit "不是 X，是 Y" / "更正" / "改成" forms take the
  // correction path.
  return /更正|说错|不是[\s\S]{0,40}是|改成/.test(value);
}

function parseFacts(text: string, source: string) {
  try {
    const value = factsJson(text) as { facts?: unknown };
    if (!Array.isArray(value.facts)) return [];
    const normalizedSource = normalize(source);
    const facts = value.facts.filter((fact): fact is string => typeof fact === "string").map((fact) => fact.trim()).map((fact) => normalizedSource.includes(`其中${normalize(fact)}`) && !normalize(fact).startsWith("其中") ? `其中${fact}` : fact);
    return [...new Set(facts.filter((fact) => fact.length > 0 && fact.length <= 240 && !isInstruction(fact) && normalizedSource.includes(normalize(fact))))].slice(0, 8);
  } catch {
    return [];
  }
}

async function extractInitialFacts(question: string) {
  const response = await factsFetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
      max_tokens: 240,
      stream: false,
      messages: [
        { role: "system", content: "从用户首轮输入中提取明确陈述、可直接核对的事实。只输出 JSON：{\"facts\":[\"...\"]}。每一项必须是用户原文中的连续片段，不能改写、补全或推测；一个事实一项，遇到并列事实必须拆开。绝不提取提问、请求、任务指令、输出格式要求、限制性指令、判断或意愿；无论这些指令有几条，均不得出现在 facts 中。用户明确陈述的当前缺口也可作为事实，例如‘还没有验证真实需求’。没有事实时返回空数组。" },
        { role: "user", content: question },
      ],
    }),
  });
  const payload = await factsPayload(response);
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!response.ok || !content) throw new Error("fact extraction failed");
  return parseFacts(content, question);
}

function parseCorrection(text: string, currentFacts: string[]): CorrectionResolution {
  try {
    const value = factsJson(text) as { supersededFacts?: unknown; replacementFacts?: unknown };
    const supersededFacts = Array.isArray(value.supersededFacts) ? value.supersededFacts.filter((fact): fact is string => typeof fact === "string" && currentFacts.includes(fact)) : [];
    const replacementFacts = Array.isArray(value.replacementFacts) ? value.replacementFacts.filter((fact): fact is string => typeof fact === "string").map((fact) => fact.replace(/^用户明确提供：/, "").trim()).filter((fact) => fact.length > 0 && fact.length <= 240 && !isInstruction(fact)) : [];
    return { supersededFacts: [...new Set(supersededFacts)], replacementFacts: [...new Set(replacementFacts)] };
  } catch {
    return { supersededFacts: [], replacementFacts: [] };
  }
}

async function resolveCorrection(currentFacts: string[], correction: string) {
  const response = await factsFetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
      max_tokens: 300,
      stream: false,
      messages: [
        { role: "system", content: "你是 Shared Fact State 的事实更正解析器，不是分析器。只输出 JSON：{\"supersededFacts\":[\"...\"],\"replacementFacts\":[\"...\"]}。supersededFacts 只能逐字选择给出的当前有效事实，且只能在用户明确更正它时选择。replacementFacts 只写用户明确更正后的当前事实，每条必须原子化。可以把更正中的数量与被明确更正的旧事实中未被否定的限定条件合并；不得推测其他信息。没有明确关系时，两个数组都为空。示例：旧事实‘用户明确提供：我已经有20个用户愿意每月支付99元’，用户说‘不是20个，是12个’，应替换为‘12个用户愿意每月支付99元’。用户说‘12个人里只有3个人明确愿意付99元，另外9个人只是愿意免费试用’，应替换为‘3个人明确愿意支付99元’和‘9个人只愿意免费试用’。" },
        { role: "user", content: JSON.stringify({ currentFacts, correction }) },
      ],
    }),
  });
  const payload = await factsPayload(response);
  const content = payload.choices?.[0]?.message?.content?.trim();
  if (!response.ok || !content) throw new Error("correction resolution failed");
  return parseCorrection(content, currentFacts);
}

function validState(value: unknown): value is SharedFactState {
  factsLog("start", "shared-facts-state-validation");
  const candidate = value && typeof value === "object" ? value as Partial<SharedFactState> : {};
  const failures = Object.entries({
    "state-not-object": !value || typeof value !== "object",
    "version-not-number": typeof candidate.version !== "number",
    "currentQuestion-not-string": typeof candidate.currentQuestion !== "string",
    "confirmedFacts-not-array": !Array.isArray(candidate.confirmedFacts),
    "pendingInformation-not-array": !Array.isArray(candidate.pendingInformation),
    "changes-not-array": !Array.isArray(candidate.changes),
    "modelViews-missing": !candidate.modelViews,
    "deepseek-view-not-string": typeof candidate.modelViews?.deepseek !== "string",
    "qwen-view-not-string": typeof candidate.modelViews?.qwen !== "string",
  }).filter(([, failed]) => failed).map(([name]) => name);
  if (failures.length) factsError("shared-facts-state-validation", new Error("Invalid shared state"), { failedFields: failures });
  else factsLog("success", "shared-facts-state-validation");
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<SharedFactState>;
  return typeof state.version === "number" && typeof state.currentQuestion === "string" && Array.isArray(state.confirmedFacts) && Array.isArray(state.pendingInformation) && Array.isArray(state.changes) && Boolean(state.modelViews) && typeof state.modelViews?.deepseek === "string" && typeof state.modelViews?.qwen === "string";
}

async function updatedStateResponse(state: SharedFactState) {
  try {
    return factsResponse({ state: await factsStage("shared-facts-pending-information-reconciliation", () => reconcilePendingInformation(state, state.pendingInformation, true)) });
  } catch (error) {
    factsError("shared-facts-updated-state-response", error);
    return NextResponse.json({ error: "当前未知信息整理失败，请重试；本轮尚未保存。" }, { status: 502 });
  }
}

// Two-model analysis can run well past the platform default timeout.
export const maxDuration = 300;

export async function POST(request: Request) {
  return withSubmissionContext(request, () => handleRequest(request));
}

async function handleRequest(request: Request) {
  const body = await factsStage("shared-facts-request-read", async () => await request.json() as { state?: unknown; userInput?: unknown });
  const userInput = typeof body.userInput === "string" ? body.userInput.trim() : "";
  if (!userInput || userInput.length > 2_000) return NextResponse.json({ error: "请输入 1 到 2000 个字符的内容。" }, { status: 400 });

  if (!body.state) {
    if (!process.env.DEEPSEEK_API_KEY) return NextResponse.json({ error: "服务端模型配置不完整。" }, { status: 500 });
    let extractedFacts: string[];
    try {
      extractedFacts = await factsStage("shared-facts-initial-extraction", () => extractInitialFacts(userInput));
    } catch (error) {
      factsError("shared-facts-initial-extraction", error);
      return NextResponse.json({ error: "首轮事实抽取失败，请稍后重试。" }, { status: 502 });
    }
    const confirmedFacts = extractedFacts.map((fact) => `用户明确提供：${fact}`);
    const changes = ["已设置当前核心问题。", ...(confirmedFacts.length ? ["已从用户初始问题提取明确事实。"] : [])];
    const state: SharedFactState = { version: 1, currentQuestion: userInput, confirmedFacts, pendingInformation: [], modelViews: { deepseek: "", qwen: "" }, changes };
    return factsResponse({ state });
  }
  if (!validState(body.state)) return NextResponse.json({ error: "共享事实状态无效。" }, { status: 400 });

  const state = body.state;
  if (isExplicitCorrection(userInput)) {
    let resolution: CorrectionResolution;
    const simple = resolveSimpleCorrection(state.confirmedFacts, userInput);
    if (simple) {
      // "不是 X，是 Y" with exactly one matching fact: no model needed, so this
      // path cannot fail the way the LLM resolver occasionally does.
      factsLog("success", "shared-facts-simple-correction", { supersededFacts: simple.supersededFacts.length });
      resolution = simple;
    } else {
      // The number may only exist in the original question, never in
      // confirmedFacts. Correct that text instead of failing the round.
      const onlyInQuestion = !state.confirmedFacts.some((fact) => mentionsCorrectionTarget(fact, userInput));
      const correctedQuestion = onlyInQuestion ? replaceSimpleCorrection(state.currentQuestion, userInput) : null;
      if (correctedQuestion) {
        factsLog("success", "shared-facts-question-correction");
        return updatedStateResponse({
          ...state,
          version: state.version + 1,
          currentQuestion: correctedQuestion,
          changes: [`用户明确更正问题中的表述：${userInput}`],
        });
      }
      if (!process.env.DEEPSEEK_API_KEY) return NextResponse.json({ error: "服务端模型配置不完整。" }, { status: 500 });
      try {
        resolution = await factsStage("shared-facts-correction-reconciliation", () => resolveCorrection(state.confirmedFacts, userInput));
      } catch (error) {
        factsError("shared-facts-correction-reconciliation", error);
        return NextResponse.json({ error: "事实更正解析失败，请稍后重试。" }, { status: 502 });
      }
    }
    if (!resolution.supersededFacts.length || !resolution.replacementFacts.length) {
      const inModelViews = Object.values(state.modelViews).some((view) => mentionsCorrectionTarget(view, userInput));
      const message = inModelViews
        ? "这个数字只出现在模型回答里，不在背景事实中。系统不会改模型写过的话；请补一句完整事实，例如“重复问题的实际占比是 30%”。"
        : "背景事实和当前问题里都没有找到这个数字。请先补充要更正的那条事实，或把旧原话一起写出来。";
      return NextResponse.json({ error: message }, { status: 422 });
    }
    const confirmedFacts = [...state.confirmedFacts.filter((fact) => !resolution.supersededFacts.includes(fact)), ...resolution.replacementFacts.map((fact) => `用户明确提供：${fact}`)].slice(-20);
    const changes = [`用户明确更正事实：已使 ${resolution.supersededFacts.length} 条旧事实失效。`, ...resolution.replacementFacts.map((fact) => `当前有效事实：${fact}`)];
    return updatedStateResponse({ ...state, version: state.version + 1, confirmedFacts, changes });
  }

  const confirmedFacts = [...state.confirmedFacts, userInput].slice(-20);
  return updatedStateResponse({ ...state, version: state.version + 1, confirmedFacts, changes: [`用户明确补充事实：${userInput}`] });
}
