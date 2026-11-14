// Browser-side SSE reader for the analysis event stream.
// Handles frames split across chunks and ignores keep-alive comments.

import type { AnalysisStreamEvent } from "./analysis-stream-events";

export async function readAnalysisStream(
  response: Response,
  onEvent: (event: AnalysisStreamEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error("服务端没有返回可读的数据流。");
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
        if (data) {
          try {
            onEvent(JSON.parse(data) as AnalysisStreamEvent);
          } catch {
            // A single malformed frame must not tear down the whole round.
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* stream already released */ }
  }
}
