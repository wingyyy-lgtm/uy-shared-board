import { NextResponse } from "next/server";
import type { MemoryStatus, MemorySuggestion, MemoryType } from "@/lib/council";

export const runtime = "nodejs";

const types: MemoryType[] = ["USER_FACT", "PROJECT_STATE", "DECISION", "AI_JUDGMENT", "UNVERIFIED"];
const statuses: MemoryStatus[] = ["CONFIRMED", "UNVERIFIED", "SUPERSEDED"];

function parse(text: string) {
  try { return JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]") as unknown; } catch { return []; }
}

function validate(value: unknown, project: string) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).flatMap((item, index): MemorySuggestion[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<MemorySuggestion>;
    if (!types.includes(candidate.type as MemoryType) || !statuses.includes(candidate.status as MemoryStatus) || typeof candidate.name !== "string" || typeof candidate.content !== "string" || typeof candidate.source !== "string") return [];
    if (candidate.type === "USER_FACT" && candidate.status !== "CONFIRMED") return [];
    if (candidate.type === "UNVERIFIED" && candidate.status !== "UNVERIFIED") return [];
    if (candidate.type === "DECISION" && candidate.status !== "CONFIRMED") return [];
    if (candidate.type === "AI_JUDGMENT" && !/DeepSeek|Qwen|AI/i.test(candidate.source + candidate.content)) return [];
    return [{ id: `${Date.now()}-${index}`, name: candidate.name.slice(0, 160), type: candidate.type as MemoryType, project, content: candidate.content.slice(0, 1_800), status: candidate.status as MemoryStatus, source: candidate.source.slice(0, 400), decisionResult: typeof candidate.decisionResult === "string" ? candidate.decisionResult.slice(0, 800) : "" }];
  });
}

function explicitFallback(task: string, project: string, systemStatus: string) {
  const suggestions: MemorySuggestion[] = [];
  const budget = task.match(/预算是\s*([^。！!\n]+)/);
  if (budget) suggestions.push({ id: `${Date.now()}-budget`, name: "项目预算", type: "USER_FACT", project, content: `用户明确提供：项目预算是 ${budget[1].trim()}。`, status: "CONFIRMED", source: "用户明确陈述", decisionResult: "" });
  const decision = task.match(/(?:我最终决定|我决定)\s*([^。！!\n]+)/);
  if (decision) suggestions.push({ id: `${Date.now()}-decision`, name: "用户最终决定", type: "DECISION", project, content: `用户明确决定：${decision[1].trim()}。`, status: "CONFIRMED", source: "用户明确陈述", decisionResult: decision[1].trim() });
  if (systemStatus.includes("执行已完成")) suggestions.push({ id: `${Date.now()}-state`, name: "本轮执行状态", type: "PROJECT_STATE", project, content: systemStatus, status: "CONFIRMED", source: "AI Studio 系统实际执行状态", decisionResult: "" });
  return suggestions.slice(0, 5);
}

export async function POST(request: Request) {
  if (!process.env.DEEPSEEK_API_KEY) return NextResponse.json({ suggestions: [] });
  const body = (await request.json()) as { task?: unknown; result?: unknown; project?: unknown; systemStatus?: unknown };
  const task = typeof body.task === "string" ? body.task.slice(0, 4_000) : "";
  const result = typeof body.result === "string" ? body.result.slice(0, 6_000) : "";
  const project = typeof body.project === "string" && body.project.trim() ? body.project.trim().slice(0, 120) : "AI Studio";
  if (!task || !result) return NextResponse.json({ suggestions: [] });
  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat", max_tokens: 500, stream: false, messages: [{ role: "system", content: "你是记忆候选提取器。只输出 JSON 数组，最多五项，每项字段为 name,type,content,status,source,decisionResult。类型只能 USER_FACT/PROJECT_STATE/DECISION/AI_JUDGMENT/UNVERIFIED，状态只能 CONFIRMED/UNVERIFIED/SUPERSEDED。USER_FACT 仅能来自用户明确陈述且才可 CONFIRMED；PROJECT_STATE 仅能来自系统实际完成或验证；DECISION 仅在用户明确最终决定时才可 CONFIRMED，AI 建议绝不能是 DECISION；AI_JUDGMENT 必须明确写出 DeepSeek、Qwen 或 AI 判断；UNVERIFIED 必须是 UNVERIFIED。无长期价值则返回 []。绝不自动保存。" }, { role: "user", content: `项目：${project}\n用户任务：${task}\n系统实际状态：${typeof body.systemStatus === "string" ? body.systemStatus : ""}\n本轮结果：${result}` }] }) });
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const suggestions = validate(parse(payload.choices?.[0]?.message?.content ?? "[]"), project);
    return NextResponse.json({ suggestions: suggestions.length ? suggestions : explicitFallback(task, project, typeof body.systemStatus === "string" ? body.systemStatus : "") });
  } catch { return NextResponse.json({ suggestions: explicitFallback(task, project, typeof body.systemStatus === "string" ? body.systemStatus : "") }); }
}
