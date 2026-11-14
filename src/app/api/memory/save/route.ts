import { NextResponse } from "next/server";
import { saveMemory } from "@/lib/notion-memory";
import type { MemorySuggestion } from "@/lib/council";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json()) as { memory?: MemorySuggestion };
  if (!body.memory) return NextResponse.json({ error: "缺少候选记忆。" }, { status: 400 });
  try {
    await saveMemory(body.memory);
    return NextResponse.json({ saved: true });
  } catch (error) {
    if (error instanceof Error && error.message === "NOTION_NOT_CONFIGURED") return NextResponse.json({ error: "尚未配置 NOTION_API_KEY 和 NOTION_DATABASE_ID，无法写入 AI Studio Memory。" }, { status: 503 });
    return NextResponse.json({ error: "Notion 写入失败，请确认数据库已共享给集成且字段类型匹配。" }, { status: 502 });
  }
}
