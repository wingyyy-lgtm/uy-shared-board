// Server-only adapter that calls an OpenAI-compatible chat endpoint with
// stream=true and forwards display text as it arrives. It owns the P0 guards:
// first-token timeout, idle timeout, whole-call cap and an output size cap.

import { AnalysisHttpError, AnalysisTimeoutError } from "./analysis-errors";
import { logAnalysisError, logAnalysisStage } from "./shared-analysis-diagnostics";
import { ViewTextStream } from "./view-stream";

const positiveNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// 30s with no output means the model is stuck (P0 requirement). The idle timer
// is reset on every token, so long but healthy answers are not cut off.
export const FIRST_OUTPUT_TIMEOUT_MS = positiveNumber(process.env.ANALYSIS_FIRST_OUTPUT_TIMEOUT_MS, 30_000);
export const IDLE_TIMEOUT_MS = positiveNumber(process.env.ANALYSIS_IDLE_TIMEOUT_MS, 30_000);
export const TOTAL_TIMEOUT_MS = positiveNumber(process.env.ANALYSIS_TOTAL_TIMEOUT_MS, 100_000);
export const MAX_OUTPUT_CHARS = positiveNumber(process.env.ANALYSIS_MAX_OUTPUT_CHARS, 12_000);

function duration(ms: number) {
  return ms >= 1000 ? `${Math.round(ms / 10) / 100} 秒` : `${ms} 毫秒`;
}

export type StreamChatOptions = {
  stage: string;
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  onDelta?: (text: string) => void;
};

export type StreamChatResult = {
  content: string;
  finishReason?: string;
  truncated: boolean;
};

export async function streamChatCompletion({ stage, url, headers, payload, onDelta }: StreamChatOptions): Promise<StreamChatResult> {
  const controller = new AbortController();
  let timeoutReason: "first" | "idle" | "total" | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const abortWith = (reason: "first" | "idle" | "total") => {
    timeoutReason ??= reason;
    controller.abort();
  };
  const armIdle = (ms: number, reason: "first" | "idle") => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortWith(reason), ms);
  };
  armIdle(FIRST_OUTPUT_TIMEOUT_MS, "first");
  const totalTimer = setTimeout(() => abortWith("total"), TOTAL_TIMEOUT_MS);

  const view = new ViewTextStream();
  let content = "";
  let finishReason: string | undefined;
  let truncated = false;

  const consume = (chunk: string) => {
    if (!chunk || truncated) return;
    content += chunk;
    if (content.length > MAX_OUTPUT_CHARS) {
      truncated = true;
      return;
    }
    const text = view.push(chunk);
    if (text) onDelta?.(text);
  };

  logAnalysisStage("start", `${stage}-stream`);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...payload, stream: true }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let responseBody = "";
      try { responseBody = await response.text(); } catch { /* diagnostics only */ }
      logAnalysisError(stage, new AnalysisHttpError(response.status), { status: response.status, responseBody });
      throw new AnalysisHttpError(response.status);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || !contentType.includes("text/event-stream")) {
      // Some gateways ignore stream=true. Treat the body as one JSON response.
      const text = await response.text();
      let message = "";
      try {
        const parsed = JSON.parse(text) as { choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }> };
        finishReason = parsed.choices?.[0]?.finish_reason;
        message = parsed.choices?.[0]?.message?.content ?? "";
      } catch {
        message = text;
      }
      consume(message);
      const tail = view.finish();
      if (tail) onDelta?.(tail);
      logAnalysisStage("success", `${stage}-stream`);
      return { content, finishReason, truncated };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data && data !== "[DONE]") {
            let parsed: { choices?: Array<{ finish_reason?: string; delta?: { content?: string | null } }> } | undefined;
            try { parsed = JSON.parse(data); } catch { /* ignore malformed keep-alive frames */ }
            const choice = parsed?.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            const delta = typeof choice?.delta?.content === "string" ? choice.delta.content : "";
            if (delta) {
              armIdle(IDLE_TIMEOUT_MS, "idle");
              consume(delta);
              if (truncated) break;
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
        if (truncated) {
          try { await reader.cancel(); } catch { /* already closed */ }
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    const tail = view.finish();
    if (tail && !truncated) onDelta?.(tail);
    logAnalysisStage("success", `${stage}-stream`);
    return { content, finishReason, truncated };
  } catch (error) {
    if (controller.signal.aborted) {
      const message = timeoutReason === "total"
        ? `分析超过总时长上限（${duration(TOTAL_TIMEOUT_MS)}），已停止。`
        : `它卡住了：${duration(timeoutReason === "idle" ? IDLE_TIMEOUT_MS : FIRST_OUTPUT_TIMEOUT_MS)}没有响应`;
      const timeoutError = new AnalysisTimeoutError(message);
      logAnalysisError(stage, timeoutError, { timeoutReason, contentType: "(streaming)" });
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  }
}
