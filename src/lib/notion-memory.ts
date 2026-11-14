import type { MemorySuggestion } from "@/lib/council";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function configured() {
  return Boolean(process.env.NOTION_API_KEY && process.env.NOTION_DATABASE_ID);
}

function headers() {
  return { Authorization: `Bearer ${process.env.NOTION_API_KEY}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };
}

function richText(content: string) {
  return content ? [{ type: "text", text: { content: content.slice(0, 1_900) } }] : [];
}

export async function saveMemory(memory: MemorySuggestion) {
  if (!configured()) throw new Error("NOTION_NOT_CONFIGURED");
  const response = await fetch(`${NOTION_API}/pages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      parent: { database_id: process.env.NOTION_DATABASE_ID },
      properties: {
        Name: { title: richText(memory.name) },
        Type: { select: { name: memory.type } },
        Project: { rich_text: richText(memory.project) },
        Content: { rich_text: richText(memory.content) },
        Status: { select: { name: memory.status } },
        Source: { rich_text: richText(memory.source) },
        "Decision Result": { rich_text: richText(memory.decisionResult) },
      },
    }),
  });
  if (!response.ok) throw new Error("NOTION_WRITE_FAILED");
}

function plain(property: unknown) {
  if (!property || typeof property !== "object") return "";
  const value = property as { title?: Array<{ plain_text?: string }>; rich_text?: Array<{ plain_text?: string }>; select?: { name?: string } | null };
  return value.title?.map((part) => part.plain_text ?? "").join("") ?? value.rich_text?.map((part) => part.plain_text ?? "").join("") ?? value.select?.name ?? "";
}

export async function readRelevantMemories(project: string) {
  if (!configured()) return [];
  try {
    const response = await fetch(`${NOTION_API}/databases/${process.env.NOTION_DATABASE_ID}/query`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ filter: { property: "Project", rich_text: { equals: project } }, page_size: 10, sorts: [{ timestamp: "last_edited_time", direction: "descending" }] }),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as { results?: Array<{ properties?: Record<string, unknown> }> };
    return (payload.results ?? []).map((page) => ({
      name: plain(page.properties?.Name), type: plain(page.properties?.Type), project: plain(page.properties?.Project), content: plain(page.properties?.Content), status: plain(page.properties?.Status), source: plain(page.properties?.Source), decisionResult: plain(page.properties?.["Decision Result"]),
    })).filter((memory) => memory.project === project && ["PROJECT_STATE", "DECISION", "USER_FACT", "UNVERIFIED", "AI_JUDGMENT"].includes(memory.type)).slice(0, 10);
  } catch {
    return [];
  }
}
