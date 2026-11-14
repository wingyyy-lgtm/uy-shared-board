"use client";

import { MODEL_LABELS, type ModelFailure, type ModelName } from "@/lib/analysis-stream-events";

export type LiveStatus = "waiting" | "streaming" | "done" | "error";

export type LiveModelState = {
  status: LiveStatus;
  text: string;
  stage?: string;
  message?: string;
  code?: ModelFailure["code"];
  startedAt: number;
  truncated?: boolean;
};

function elapsed(now: number, startedAt: number) {
  const seconds = Math.max(0, (now - startedAt) / 1000);
  return `${seconds.toFixed(1)}s`;
}

function statusText(item: LiveModelState, now: number) {
  if (item.status === "waiting") return `${item.stage ?? "等待响应"} · ${elapsed(now, item.startedAt)}`;
  if (item.status === "streaming") return `生成中 · ${elapsed(now, item.startedAt)} · ${item.text.length} 字`;
  if (item.status === "done") return `完成 · ${elapsed(now, item.startedAt)}`;
  return item.code === "timeout" ? "它卡住了" : "本轮失败";
}

export function LivePanel({
  live,
  now,
  previous,
}: {
  live: Record<ModelName, LiveModelState>;
  now: number;
  previous?: Record<ModelName, string>;
}) {
  return (
    <div className="mt-5 space-y-3">
      <div className="grid gap-5 md:grid-cols-2">
        {(["deepseek", "qwen"] as const).map((model) => {
          const item = live[model];
          const isStreaming = item.status === "streaming";
          const tone = item.status === "error"
            ? "border-rose-200 bg-rose-50 text-rose-700"
            : item.status === "done"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : isStreaming
                ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                : "border-slate-200 bg-slate-50 text-slate-600";
          return (
            <section key={model} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5">
              <div className="flex items-start justify-between gap-3">
                <h2 className={`font-semibold ${model === "deepseek" ? "text-cyan-700" : "text-violet-700"}`}>{MODEL_LABELS[model]} 当前观点</h2>
                <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium tabular-nums ${tone}`} aria-live="polite">
                  {statusText(item, now)}
                </span>
              </div>

              {item.status === "error" && item.message && (
                <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm leading-6 text-rose-700">{item.message}</p>
              )}

              {item.text ? (
                <div className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-slate-700">
                  {item.text}
                  {isStreaming && <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-indigo-500 align-middle" aria-hidden />}
                </div>
              ) : (
                <div className="mt-3 space-y-2" aria-hidden>
                  {item.status === "waiting" || isStreaming ? (
                    <>
                      <div className="h-3 w-3/4 animate-pulse rounded bg-slate-100" />
                      <div className="h-3 w-1/2 animate-pulse rounded bg-slate-100" />
                      <p className="pt-1 text-sm text-slate-500">{item.status === "waiting" ? "正在等待第一个字…" : "正在组织回答…"}</p>
                    </>
                  ) : item.status === "error" ? (
                    <p className="text-sm leading-6 text-slate-500">这一侧本轮没有返回内容{previous?.[model] ? "，下方保留上一轮观点。" : "。"}</p>
                  ) : (
                    <p className="text-sm text-slate-500">没有内容。</p>
                  )}
                </div>
              )}

              {item.truncated && <p className="mt-2 text-xs text-amber-700">已到达长度上限，回答可能被截断。</p>}

              {item.status === "error" && previous?.[model] && (
                <details className="mt-3 rounded-lg border border-slate-200 p-3">
                  <summary className="cursor-pointer text-sm text-slate-600">查看上一轮观点（本轮未更新）</summary>
                  <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-7 text-slate-600">{previous[model]}</div>
                </details>
              )}
            </section>
          );
        })}
      </div>
      <p className="text-xs leading-5 text-slate-500">两边是独立请求：谁先返回就先显示；30 秒没有响应的一侧会标记为卡住，不影响另一侧。</p>
    </div>
  );
}
