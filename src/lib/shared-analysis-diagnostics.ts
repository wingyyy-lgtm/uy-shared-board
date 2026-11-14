// Server-side diagnostics only. Never include request headers or environment values.
import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage<{ submissionId?: string; status?: number; responseBody?: string }>();

export function withSubmissionContext<T>(request: Request, run: () => T): T {
  const id = request.headers.get("x-submission-id");
  const submissionId = id && /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : "unavailable";
  return context.run({ submissionId }, run);
}

export function getSubmissionId() { return context.getStore()?.submissionId ?? "unavailable"; }

export function logAnalysisDetail(tag: string, details: Record<string, unknown>) {
  console.info(tag, JSON.stringify({ ...details, submissionId: getSubmissionId() }));
}

export function logAnalysisStage(event: "start" | "success", stage: string) {
  console.info(`[shared-analysis] ${event} stage=${stage} submissionId=${getSubmissionId()}`);
}

export function logAnalysisError(stage: string, error: unknown, details: Record<string, unknown> = {}) {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    let output = JSON.stringify({ error: message, stack: stack ?? "(unavailable)", status: context.getStore()?.status ?? "(no HTTP response)", responseBody: context.getStore()?.responseBody ?? "(no HTTP response)", ...details, submissionId: getSubmissionId() });
    for (const [name, value] of Object.entries(process.env)) {
      if (!value || !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) continue;
      for (const secret of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]) {
        output = output.split(secret).join("[REDACTED]");
      }
    }
    console.error(`[shared-analysis] stage=${stage}\n${output}`);
  } catch {
    console.error(`[shared-analysis] stage=${stage} submissionId=${getSubmissionId()} error=Unable to format diagnostic safely`);
  }
}

export async function diagnosticStage<T>(stage: string, run: () => Promise<T>): Promise<T> {
  return context.run({ ...context.getStore() }, async () => {
    logAnalysisStage("start", stage);
    try {
      const result = await run();
      logAnalysisStage("success", stage);
      return result;
    } catch (error) { logAnalysisError(stage, error); throw error; }
  });
}

export async function diagnosticFetch(stage: string, ...args: Parameters<typeof fetch>) {
  logAnalysisStage("start", `${stage}-http`);
  let response: Response;
  try { response = await fetch(...args); }
  catch (error) { logAnalysisError(stage, error, { status: "(no HTTP response)", responseBody: "(no HTTP response)" }); throw error; }
  let responseBody = "(response body unavailable)";
  try { responseBody = await response.clone().text(); }
  catch (error) { logAnalysisError(`${stage}-response-body`, error, { status: response.status, responseBody }); }
  const current = context.getStore();
  if (current) { current.status = response.status; current.responseBody = responseBody; }
  if (!response.ok) {
    logAnalysisError(stage, new Error("External API returned non-2xx"), { status: response.status, responseBody });
  } else {
    logAnalysisStage("success", `${stage}-http`);
  }
  return response;
}

export async function diagnosticJson<T>(response: Response, stage: string): Promise<T> {
  logAnalysisStage("start", `${stage}-response-json-parse`);
  const copy = response.clone();
  try {
    const parsed = await response.json() as T;
    logAnalysisStage("success", `${stage}-response-json-parse`);
    return parsed;
  }
  catch (error) {
    let responseBody = "(response body unavailable)";
    try { responseBody = await copy.text(); }
    catch (bodyError) { logAnalysisError(`${stage}-response-body`, bodyError, { status: response.status, responseBody }); }
    logAnalysisError("json-parse-normalize", error, { context: stage, status: response.status, responseBody });
    throw error;
  }
}
