// Server-only error types shared by the model streaming adapter and the route.
// They are converted to short, user-facing codes before anything is sent to the browser.

export type ModelErrorCode =
  | "timeout"
  | "auth"
  | "rate-limit"
  | "upstream"
  | "http"
  | "network"
  | "evidence"
  | "failed";

export class AnalysisTimeoutError extends Error {
  readonly code = "timeout" as const;
  constructor(message = "它卡住了：30 秒没有响应") {
    super(message);
    this.name = "AnalysisTimeoutError";
  }
}

export class AnalysisHttpError extends Error {
  readonly status: number;
  constructor(status: number, message = `模型服务返回 HTTP ${status}`) {
    super(message);
    this.name = "AnalysisHttpError";
    this.status = status;
  }
}

export function describeModelError(error: unknown): { code: ModelErrorCode; message: string } {
  if (error instanceof AnalysisTimeoutError) return { code: "timeout", message: error.message };
  if (error instanceof AnalysisHttpError) {
    if (error.status === 401 || error.status === 403) return { code: "auth", message: `API Key 无效或没有权限（HTTP ${error.status}）` };
    if (error.status === 429) return { code: "rate-limit", message: "额度用完或被限流（HTTP 429）" };
    if (error.status >= 500) return { code: "upstream", message: `模型服务出错（HTTP ${error.status}）` };
    return { code: "http", message: `模型请求失败（HTTP ${error.status}）` };
  }
  if (error instanceof TypeError) return { code: "network", message: "连不上模型服务（检查网络或代理）" };
  const message = error instanceof Error ? error.message : String(error);
  if (/forced-web-search-no-selected-evidence/.test(message)) return { code: "evidence", message: "按要求联网，但没找到可用证据，本轮没有给结论。" };
  if (/unsupported.*citation/i.test(message)) return { code: "evidence", message: "模型引用了不存在的来源，已拦下本轮回答。" };
  return { code: "failed", message: "模型本轮没有给出可用回答。" };
}
