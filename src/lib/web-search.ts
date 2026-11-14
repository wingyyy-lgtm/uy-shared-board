// Server-only entry point; never import this module into a client component.
import { diagnosticFetch, diagnosticJson, logAnalysisError, logAnalysisStage } from "./shared-analysis-diagnostics";
export type WebEvidence = { title: string; url: string; snippet: string };
export type SearchResult = { query: string; status: "ok" | "error"; results: WebEvidence[]; error?: string };

export async function webSearch({ query, topK = 5 }: { query: string; topK?: number }): Promise<SearchResult> {
  logAnalysisStage("start", "cleversee-search");
  const fail = (error: string): SearchResult => {
    logAnalysisError("cleversee-search", new Error(error));
    return { query, status: "error", results: [], error };
  };
  if (!query.trim() || query.length > 500) return fail("搜索词无效。");
  if (!process.env.IQS_API_KEY) return fail("未配置服务端 IQS_API_KEY，尚未取得联网证据。");
  const limit = Math.min(5, Math.max(1, Math.floor(topK) || 5));
  try {
    const response = await diagnosticFetch("cleversee-search", "https://cloud-iqs.aliyuncs.com/search/unified", {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${process.env.IQS_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        engineType: "CNLiteBasic",
        contents: { mainText: true, markdownText: false, summary: true, rerankScore: true },
        advancedParams: { numResults: limit },
      }),
    });
    if (!response.ok) {
      const responseBody = await response.text();
      let requestId: unknown;
      try { requestId = (JSON.parse(responseBody) as { requestId?: unknown } | null)?.requestId; }
      catch { /* Non-JSON error bodies are logged verbatim by the redacting logger. */ }
      logAnalysisError("cleversee-search", new Error("Unified search HTTP error"), { status: response.status, responseBody, requestId });
      return fail(`搜索服务请求失败（HTTP ${response.status}）。`);
    }
    const payload = await diagnosticJson<{ requestId?: string; pageItems?: Array<{ title?: unknown; link?: unknown; snippet?: unknown }> } | null>(response, "cleversee-search");
    if (!Array.isArray(payload?.pageItems)) {
      logAnalysisError("cleversee-search", new Error("Unified search response format error"), { status: response.status, responseBody: JSON.stringify(payload), requestId: payload?.requestId });
      return fail("搜索服务返回格式异常。");
    }
    const results = payload.pageItems.flatMap((item) => {
      if (!item || typeof item.title !== "string" || typeof item.link !== "string" || typeof item.snippet !== "string") return [];
      try { if (!["https:", "http:"].includes(new URL(item.link).protocol)) return []; }
      catch (error) { logAnalysisError("cleversee-search-url-parse", error); return []; }
      return [{ title: item.title.slice(0, 300), url: item.link, snippet: item.snippet.slice(0, 2000) }];
    }).slice(0, limit);
    logAnalysisStage("success", "cleversee-search");
    return { query, status: "ok", results };
  } catch (error) {
    logAnalysisError("cleversee-search", error);
    return fail("搜索超时或网络异常，尚未取得联网证据。");
  }
}
