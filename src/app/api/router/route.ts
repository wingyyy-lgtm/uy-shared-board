import { NextResponse } from "next/server";
import type { ExecutionMode, FileContext, ModelName, RouterRecommendation, TaskType } from "@/lib/council";
import { readRelevantMemories } from "@/lib/notion-memory";

export const runtime = "nodejs";

const ROUTER_URL = "https://api.deepseek.com/chat/completions";
const ROUTER_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

type RouterPayload = { choices?: Array<{ message?: { content?: string | null } }> };

const fallback: RouterRecommendation = {
  taskType: "decision",
  mode: "council",
  primaryModel: "deepseek",
  reviewerModel: "qwen",
  futurePreferred: "GPT",
  reason: "Router 未能生成可校验的推荐，因此采用保守的双模型综合分析方案。",
  limitations: ["当前模型不具备实时互联网搜索能力。"],
  requiredInfo: ["请补充目标、约束条件与已有事实。"],
};

function parseJson(text: string) {
  const cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
  const candidate = cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function isTaskType(value: unknown): value is TaskType {
  return value === "intelligence" || value === "data" || value === "document" || value === "decision";
}

function isMode(value: unknown): value is ExecutionMode {
  return value === "single" || value === "review" || value === "council";
}

function isModel(value: unknown): value is ModelName {
  return value === "deepseek" || value === "qwen";
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 5) : [];
}

function validateRecommendation(value: unknown, hasFile: boolean): RouterRecommendation {
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<RouterRecommendation>;
  if (!isTaskType(candidate.taskType) || !isMode(candidate.mode) || !isModel(candidate.primaryModel)) return fallback;
  if (candidate.mode === "council" && candidate.primaryModel !== "deepseek") return fallback;
  if (candidate.mode === "review" && (!isModel(candidate.reviewerModel) || candidate.reviewerModel === candidate.primaryModel)) return fallback;
  const futurePreferred = candidate.taskType === "intelligence" ? "Grok" : candidate.taskType === "data" ? "Gemini" : candidate.taskType === "document" ? "Claude" : "GPT";
  const limitations = strings(candidate.limitations);
  const requiredInfo = strings(candidate.requiredInfo);
  if (candidate.taskType === "intelligence") limitations.unshift("当前模型本身不能保证获得实时互联网信息。");
  if (candidate.taskType === "document" && !hasFile) requiredInfo.unshift("尚未提供文件；请提供文件内容或粘贴需要审查的文本。");
  const normalizedPlan = candidate.taskType === "intelligence"
    ? { mode: "single" as const, primaryModel: "deepseek" as const, reviewerModel: undefined }
    : candidate.taskType === "data"
      ? { mode: "single" as const, primaryModel: "qwen" as const, reviewerModel: undefined }
      : candidate.taskType === "document"
        ? { mode: "review" as const, primaryModel: "qwen" as const, reviewerModel: "deepseek" as const }
        : { mode: candidate.mode, primaryModel: candidate.primaryModel, reviewerModel: candidate.mode === "council" ? "qwen" : candidate.mode === "review" ? candidate.reviewerModel : undefined };
  return {
    taskType: candidate.taskType,
    ...normalizedPlan,
    futurePreferred,
    reason: typeof candidate.reason === "string" ? candidate.reason.slice(0, 800) : fallback.reason,
    limitations: [...new Set(limitations)].slice(0, 5),
    requiredInfo: [...new Set(requiredInfo)].slice(0, 5),
  };
}

export async function POST(request: Request) {
  if (!process.env.DEEPSEEK_API_KEY) return NextResponse.json({ error: "服务端模型配置不完整。" }, { status: 500 });
  const body = (await request.json()) as { task?: unknown; fileContext?: unknown; project?: unknown };
  const task = typeof body.task === "string" ? body.task.trim() : "";
  const project = typeof body.project === "string" && body.project.trim() ? body.project.trim().slice(0, 120) : "AI Studio";
  const file = body.fileContext as Partial<FileContext> | undefined;
  const hasFile = Boolean(file && typeof file.fileName === "string" && typeof file.extractedText === "string" && file.extractedText.trim() && (!file.extractionWarning || file.truncated));
  if (!task || task.length > 2_000) return NextResponse.json({ error: "请输入 1 到 2000 个字符的任务。" }, { status: 400 });

  try {
    const memories = await readRelevantMemories(project);
    const memoryContext = memories.map((memory) => `[${memory.type}${memory.source ? ` - ${memory.source}` : ""}]\n${memory.content}`).join("\n\n") || "无相关长期记忆。";
    const response = await fetch(ROUTER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ROUTER_MODEL,
        max_tokens: 400,
        stream: false,
        messages: [
          { role: "system", content: "你是任务路由器。根据任务语义（不是关键词匹配）只输出 JSON，不要 Markdown。taskType 只能是 intelligence/data/document/decision；mode 只能是 single/review/council；primaryModel 和 reviewerModel 只能是 deepseek/qwen。intelligence 当前推荐 deepseek，data/document 当前推荐 qwen；简单 decision 推荐 deepseek single，复杂或重要 decision 推荐 deepseek + qwen council。语义边界与优先级：审查合同、报告、协议或长文属于 document；当核心对象是一组销售、测试、产品或指标数据，且任务要求从数据中找规律、比较表现或作出数据结论时，必须归为 data，即使最终还要决定“哪个继续”；只有没有待分析数据或文档时，比较方向、优先级或是否继续才属于 decision；询问近期动态、行业变化、趋势属于 intelligence。JSON 字段：taskType, mode, primaryModel, reviewerModel, reason, limitations, requiredInfo。情报类必须说明没有实时互联网能力；文档类仅在没有有效解析文本时要求文件或文本。" },
          { role: "user", content: `${task}\n\n相关长期记忆（AI_JUDGMENT 不是用户事实；UNVERIFIED 未确认）：\n${memoryContext}\n\n文件上下文：${hasFile ? `已上传并成功解析 ${file!.fileType} 文件 ${file!.fileName}。受控文本片段：\n${file!.extractedText!.slice(0, 6_000)}` : "未提供可用文件文本。"}` },
        ],
      }),
    });
    const payload = (await response.json()) as RouterPayload;
    const content = payload.choices?.[0]?.message?.content;
    if (!response.ok || !content) return NextResponse.json({ recommendation: fallback });
    return NextResponse.json({ recommendation: validateRecommendation(parseJson(content), hasFile) });
  } catch {
    return NextResponse.json({ recommendation: fallback });
  }
}
