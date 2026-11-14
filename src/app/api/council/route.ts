import { NextResponse } from "next/server";
import { advisors, type Advisor, type CouncilAdvice, type CouncilRound, type ExecutionResult, type FileContext, type ModelCouncil } from "@/lib/council";

export const runtime = "nodejs";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const QWEN_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
const QWEN_MODEL = process.env.QWEN_MODEL ?? "qwen-plus";

type Provider = "deepseek" | "qwen";
type ChatPayload = { choices?: Array<{ message?: { content?: string | null } }> };

class ModelApiError extends Error {
  constructor(public provider: Provider, public status: number) {
    super("Model request failed");
  }
}

function outputText(payload: ChatPayload) {
  return payload.choices?.[0]?.message?.content?.trim();
}

function isAdvisorId(value: unknown): value is Advisor["id"] {
  return typeof value === "string" && advisors.some((advisor) => advisor.id === value);
}

function parseAdvice(value: unknown): CouncilAdvice[] | null {
  if (!Array.isArray(value) || value.length !== advisors.length) return null;
  const advice: CouncilAdvice[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const candidate = item as Partial<CouncilAdvice>;
    if (!isAdvisorId(candidate.advisorId) || typeof candidate.response !== "string" || candidate.response.length > 8_000) return null;
    advice.push({ advisorId: candidate.advisorId, response: candidate.response });
  }
  return new Set(advice.map((item) => item.advisorId)).size === advisors.length ? advice : null;
}

function parseModelCouncil(value: unknown): ModelCouncil | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ModelCouncil>;
  const fields: Array<keyof ModelCouncil> = ["deepseekAnalysis", "qwenAnalysis", "deepseekReview", "qwenReview"];
  if (fields.some((field) => typeof candidate[field] !== "string" || candidate[field]!.length > 8_000)) return null;
  return {
    deepseekAnalysis: candidate.deepseekAnalysis!,
    qwenAnalysis: candidate.qwenAnalysis!,
    deepseekReview: candidate.deepseekReview!,
    qwenReview: candidate.qwenReview!,
  };
}

function parseExecution(value: unknown): ExecutionResult | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ExecutionResult>;
  if ((candidate.mode !== "single" && candidate.mode !== "review") || (candidate.primaryModel !== "deepseek" && candidate.primaryModel !== "qwen") || typeof candidate.primaryAnalysis !== "string") return null;
  if (candidate.mode === "review" && ((candidate.reviewerModel !== "deepseek" && candidate.reviewerModel !== "qwen") || typeof candidate.review !== "string")) return null;
  return candidate as ExecutionResult;
}

function parsePreviousRounds(value: unknown): CouncilRound[] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const rounds: CouncilRound[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!item || typeof item !== "object") return null;
    const candidate = item as Partial<CouncilRound>;
    if (candidate.round !== index + 1 || typeof candidate.addedInformation !== "string" || candidate.addedInformation.length > 2_000 || typeof candidate.summary !== "string" || candidate.summary.length > 8_000) return null;
    const modelCouncil = parseModelCouncil(candidate.modelCouncil);
    const execution = modelCouncil ? undefined : parseExecution(candidate.execution);
    const advice = modelCouncil || execution ? undefined : parseAdvice(candidate.advice);
    if (!modelCouncil && !execution && !advice) return null;
    rounds.push({ round: candidate.round, addedInformation: candidate.addedInformation, summary: candidate.summary, modelCouncil: modelCouncil ?? undefined, execution: execution ?? undefined, advice: advice ?? undefined });
  }
  return rounds;
}

function legacyAdviceText(advice: CouncilAdvice[]) {
  return advice.map((item) => `${advisors.find((advisor) => advisor.id === item.advisorId)?.title ?? item.advisorId}：\n${item.response}`).join("\n\n");
}

function priorRoundText(round: CouncilRound) {
  const base = [`第${round.round}轮 Council 记录`, `该轮用户新增信息：\n${round.addedInformation || "无（原始问题轮）"}`];
  if (round.modelCouncil) {
    base.push(`DeepSeek 第一阶段分析：\n${round.modelCouncil.deepseekAnalysis}`, `Qwen 第一阶段分析：\n${round.modelCouncil.qwenAnalysis}`, `DeepSeek 对 Qwen 的审查：\n${round.modelCouncil.deepseekReview}`, `Qwen 对 DeepSeek 的审查：\n${round.modelCouncil.qwenReview}`);
  } else if (round.advice) {
    base.push(`历史四角色完整分析：\n${legacyAdviceText(round.advice)}`);
  } else if (round.execution) {
    base.push(`历史执行结果：\n主模型 ${round.execution.primaryModel}：\n${round.execution.primaryAnalysis}`);
    if (round.execution.review) base.push(`复核模型 ${round.execution.reviewerModel}：\n${round.execution.review}`);
  }
  base.push(`该轮最终汇总：\n${round.summary}`);
  return base.join("\n\n");
}

function sharedContext(originalQuestion: string, previousRounds: CouncilRound[], newInformation: string) {
  const history = previousRounds.length ? previousRounds.map(priorRoundText).join("\n\n---\n\n") : "无（当前是首轮讨论）。";
  return ["你正在就同一个议题进行 AI Council 多轮讨论。必须基于完整共享上下文重新判断，不能把本轮新增信息当作全新的问题。", `原始用户问题：\n${originalQuestion}`, `此前结构化 Council 记录：\n${history}`, `本轮新增信息：\n${newInformation || "无（请只基于原始用户问题分析）。"}`].join("\n\n");
}

async function requestCompletion(provider: Provider, instructions: string, input: string) {
  const isDeepSeek = provider === "deepseek";
  const response = await fetch(isDeepSeek ? DEEPSEEK_URL : QWEN_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${isDeepSeek ? process.env.DEEPSEEK_API_KEY : process.env.DASHSCOPE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: isDeepSeek ? DEEPSEEK_MODEL : QWEN_MODEL, messages: [{ role: "system", content: instructions }, { role: "user", content: input }], max_tokens: 900, stream: false }),
  });
  const payload = (await response.json()) as ChatPayload;
  const text = outputText(payload);
  if (!response.ok || !text) throw new ModelApiError(provider, response.status || 502);
  return text;
}

function needsNumberRevision(text: string) {
  const withoutHeadingNumbers = text.replace(/^\s*(?:#+\s*)?[1-9]\.\s+/gm, "");
  return /\d|[一二三四五六七八九十百千万亿两半]/.test(withoutHeadingNumbers);
}

async function askModel(provider: Provider, instructions: string, input: string) {
  const text = await requestCompletion(provider, instructions, input);
  if (!needsNumberRevision(text)) return text;
  return requestCompletion(
    provider,
    "你是输出合规校对者。保留原回答的事实边界、判断与固定标题，不添加任何新信息。删除或改写所有无依据的阿拉伯数字、中文数词、百分比、价格、时间周期、样本量与阈值；仅保留固定标题的编号和用户明确提供的数字。",
    `请合规重写以下回答：\n${text}`,
  );
}

const numericRule = "数字规则：除固定标题的编号，以及用户明确提供的数字外，输出中不得出现阿拉伯数字、中文数词、百分比、价格、时间周期、样本量或阈值；不得用具体数字举例或建议验证标准。";

const independentInstructions = [
  `你是 AI Council 的独立决策分析师。只根据用户提供的共享上下文进行分析，不得假定或补全任何未提供的信息。严格区分事实、判断与推测；信息不足时明确写“当前无法确定”，并指出需要补充的事实。不得无依据给出具体概率、数字、阈值或市场数据。${numericRule}请按以下结构输出：`,
  "1. 用户已提供的事实",
  "2. 我的判断",
  "3. 我的推测",
  "4. 当前缺失的关键信息",
  "5. 建议行动",
].join("\n");

const reviewInstructions = [
  `你是 AI Council 的交叉审查者。你将看到自己的第一阶段分析和另一模型的独立分析。只根据这些材料与共享上下文审查，不得补全事实或制造分歧。严格区分事实、判断与推测；信息不足时明确写“当前无法确定”。不得无依据给出具体概率、数字、阈值或市场数据。${numericRule}必须严格使用以下六个标题：`,
  "1. 对方哪些判断我同意",
  "2. 对方哪些判断证据不足",
  "3. 对方遗漏了什么",
  "4. 我与对方最大的分歧",
  "5. 什么新事实可以解决这个分歧",
  "6. 看完对方意见后，我是否修改原判断",
].join("\n");

const summaryInstructions = [
  `你是 AI Council 的主持人。只基于完整共享上下文、两份独立分析和两份交叉审查生成最终汇总。不得补全事实、虚构分歧或无依据制造具体概率、数字或阈值。必须区分事实、判断与推测；信息不足时明确写“当前无法确定”。若不存在实质性不同，必须逐字写出“当前不存在显著分歧”。${numericRule}必须严格使用以下九个标题：`,
  "1. 已确认事实",
  "2. DeepSeek 的核心判断",
  "3. Qwen 的核心判断",
  "4. 两个模型的共识",
  "5. 两个模型的主要分歧",
  "6. 哪些结论证据不足",
  "7. 哪个新事实最能解决分歧",
  "8. 当前仍无法确定的事情",
  "9. 当前最小可执行下一步",
].join("\n");

export async function POST(request: Request) {
  if (!process.env.DEEPSEEK_API_KEY || !process.env.DASHSCOPE_API_KEY) return NextResponse.json({ error: "服务端模型配置不完整。" }, { status: 500 });
  const body = (await request.json()) as { originalQuestion?: unknown; newInformation?: unknown; previousRounds?: unknown; question?: unknown };
  const originalQuestion = typeof body.originalQuestion === "string" ? body.originalQuestion.trim() : typeof body.question === "string" ? body.question.trim() : "";
  const newInformation = typeof body.newInformation === "string" ? body.newInformation.trim() : "";
  const previousRounds = parsePreviousRounds(body.previousRounds ?? []);
  const file = (body as { fileContext?: unknown }).fileContext as Partial<FileContext> | undefined;
  const fileText = file && typeof file.fileName === "string" && typeof file.extractedText === "string" ? file.extractedText : "";
  if (!originalQuestion || originalQuestion.length > 2_000) return NextResponse.json({ error: "请输入 1 到 2000 个字符的问题。" }, { status: 400 });
  if (previousRounds === null) return NextResponse.json({ error: "此前 Council 上下文格式无效。" }, { status: 400 });
  if (previousRounds.length > 0 && !newInformation) return NextResponse.json({ error: "请输入本轮要补充的信息。" }, { status: 400 });
  if (newInformation.length > 2_000) return NextResponse.json({ error: "本轮补充信息不能超过 2000 个字符。" }, { status: 400 });
  if (file && !fileText) return NextResponse.json({ error: file.extractionWarning || "文件无法解析，不能进行文档分析。" }, { status: 400 });
  const context = `${sharedContext(originalQuestion, previousRounds, newInformation)}${fileText ? `\n\n真实文件内容（只可据此声称文件事实）：\n文件名：${file!.fileName}\n${file!.truncated ? "注意：文本已截断，结论可能不完整。\n" : ""}正文：\n${fileText}` : ""}`;

  try {
    const [deepseekAnalysis, qwenAnalysis] = await Promise.all([askModel("deepseek", independentInstructions, context), askModel("qwen", independentInstructions, context)]);
    const [deepseekReview, qwenReview] = await Promise.all([
      askModel("deepseek", reviewInstructions, `${context}\n\n你的第一阶段分析：\n${deepseekAnalysis}\n\nQwen 的完整第一阶段分析：\n${qwenAnalysis}`),
      askModel("qwen", reviewInstructions, `${context}\n\n你的第一阶段分析：\n${qwenAnalysis}\n\nDeepSeek 的完整第一阶段分析：\n${deepseekAnalysis}`),
    ]);
    const modelCouncil = { deepseekAnalysis, qwenAnalysis, deepseekReview, qwenReview };
    const summary = await askModel("deepseek", summaryInstructions, `${context}\n\nDeepSeek 第一阶段分析：\n${deepseekAnalysis}\n\nQwen 第一阶段分析：\n${qwenAnalysis}\n\nDeepSeek 对 Qwen 的审查：\n${deepseekReview}\n\nQwen 对 DeepSeek 的审查：\n${qwenReview}`);
    return NextResponse.json({ modelCouncil, summary });
  } catch (error) {
    if (error instanceof ModelApiError) {
      const provider = error.provider === "deepseek" ? "DeepSeek" : "Qwen";
      return NextResponse.json({ error: `${provider} 请求失败，请稍后重试。` }, { status: 502 });
    }
    if (error instanceof TypeError) return NextResponse.json({ error: "服务端无法连接模型 API，请检查网络后重试。" }, { status: 502 });
    return NextResponse.json({ error: "AI 分析暂时失败，请稍后重试。" }, { status: 502 });
  }
}
