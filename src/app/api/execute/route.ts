import { NextResponse } from "next/server";
import type { ExecutionMode, ExecutionResult, FileContext, ModelName } from "@/lib/council";

export const runtime = "nodejs";

const endpoints: Record<ModelName, string> = {
  deepseek: "https://api.deepseek.com/chat/completions",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
};

const models: Record<ModelName, string> = {
  deepseek: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
  qwen: process.env.QWEN_MODEL ?? "qwen-plus",
};

type ChatPayload = { choices?: Array<{ message?: { content?: string | null } }> };

function isModel(value: unknown): value is ModelName {
  return value === "deepseek" || value === "qwen";
}

function isMode(value: unknown): value is Extract<ExecutionMode, "single" | "review"> {
  return value === "single" || value === "review";
}

function historyText(value: unknown) {
  if (!Array.isArray(value) || value.length > 8) return null;
  const rounds: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const round = item as { round?: unknown; addedInformation?: unknown; summary?: unknown; modelCouncil?: unknown; execution?: unknown; advice?: unknown; fileContext?: unknown };
    if (typeof round.round !== "number" || typeof round.addedInformation !== "string" || typeof round.summary !== "string") return null;
    const details = round.modelCouncil && typeof round.modelCouncil === "object" ? JSON.stringify(round.modelCouncil) : round.execution && typeof round.execution === "object" ? JSON.stringify(round.execution) : Array.isArray(round.advice) ? JSON.stringify(round.advice) : "";
    const file = round.fileContext as Partial<FileContext> | undefined;
    const fileDetails = file && typeof file.fileName === "string" && typeof file.extractedText === "string" ? `\n历史真实文件内容：\n文件名：${file.fileName}\n${file.truncated ? "注意：文本已截断。\n" : ""}${file.extractedText}` : "";
    rounds.push(`第${round.round}轮新增信息：${round.addedInformation}\n完整结果：${details}\n最终汇总：${round.summary}${fileDetails}`);
  }
  return rounds.join("\n---\n") || "无（当前是首轮）。";
}

async function ask(model: ModelName, instructions: string, input: string) {
  const response = await fetch(endpoints[model], {
    method: "POST",
    headers: { Authorization: `Bearer ${model === "deepseek" ? process.env.DEEPSEEK_API_KEY : process.env.DASHSCOPE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: models[model], max_tokens: 900, stream: false, messages: [{ role: "system", content: instructions }, { role: "user", content: input }] }),
  });
  const payload = (await response.json()) as ChatPayload;
  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!response.ok || !text) throw new Error("model request failed");
  return text;
}

export async function POST(request: Request) {
  if (!process.env.DEEPSEEK_API_KEY || !process.env.DASHSCOPE_API_KEY) return NextResponse.json({ error: "服务端模型配置不完整。" }, { status: 500 });
  const body = (await request.json()) as { originalQuestion?: unknown; newInformation?: unknown; previousRounds?: unknown; mode?: unknown; primaryModel?: unknown; reviewerModel?: unknown; fileContext?: unknown };
  const originalQuestion = typeof body.originalQuestion === "string" ? body.originalQuestion.trim() : "";
  const newInformation = typeof body.newInformation === "string" ? body.newInformation.trim() : "";
  const history = historyText(body.previousRounds ?? []);
  const file = body.fileContext as Partial<FileContext> | undefined;
  const fileText = file && typeof file.fileName === "string" && typeof file.extractedText === "string" ? file.extractedText : "";
  if (!originalQuestion || !isMode(body.mode) || !isModel(body.primaryModel) || history === null) return NextResponse.json({ error: "执行方案或上下文无效。" }, { status: 400 });
  if (body.mode === "review" && (!isModel(body.reviewerModel) || body.reviewerModel === body.primaryModel)) return NextResponse.json({ error: "复核模型无效。" }, { status: 400 });
  if (file && !fileText) return NextResponse.json({ error: file.extractionWarning || "文件无法解析，不能进行文档分析。" }, { status: 400 });
  const fileContext = fileText ? `\n\n真实文件内容（仅据此判断文件事实）：\n文件名：${file!.fileName}\n类型：${file!.fileType}\n${file!.truncated ? "注意：文本已截断，结论可能不完整。\n" : ""}正文：\n${fileText}` : "";
  const context = `原始用户任务：\n${originalQuestion}\n\n此前结构化讨论：\n${history}\n\n本轮新增信息：\n${newInformation || "无"}${fileContext}`;

  try {
    const primaryAnalysis = await ask(body.primaryModel, "你是任务执行分析师。只基于任务与共享上下文回答；区分事实、判断、推测与信息缺口。若提供文件，只能根据真实提取文本声称文件内容；文件未出现的信息必须说无法从文件确认。文本截断时提醒结论可能不完整。若文件无法解析，停止文档分析。若任务是实时情报，必须说明你不能保证实时互联网信息。不得编造事实。", context);
    let execution: ExecutionResult = { mode: body.mode, primaryModel: body.primaryModel, primaryAnalysis };
    if (body.mode === "review" && isModel(body.reviewerModel)) {
      const review = await ask(body.reviewerModel, "你是独立复核者。审查主分析中哪些判断有依据、哪些证据不足、遗漏了什么、是否应修改结论。只基于任务、共享上下文及主分析；不得编造事实。", `${context}\n\n主模型分析：\n${primaryAnalysis}`);
      execution = { ...execution, reviewerModel: body.reviewerModel, review };
    }
    const summary = body.mode === "review" && execution.review ? `${body.primaryModel} 主分析与 ${body.reviewerModel} 复核已完成。请结合两份输出继续讨论。` : `${body.primaryModel} 单模型分析已完成。请结合结果继续讨论。`;
    return NextResponse.json({ execution, summary });
  } catch {
    return NextResponse.json({ error: "模型请求失败，请稍后重试。" }, { status: 502 });
  }
}
