"use client";

import { type FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SharedFactCase, SharedFactRound, SharedFactState } from "@/lib/council";
import type { AdvisorSearchReports } from "@/lib/search-plan";
import { DEMO_MODE } from "@/lib/demo-mode";
import { LivePanel, type LiveModelState } from "@/components/live-panel";
import type { AnalysisStreamEvent, ModelFailure, ModelName } from "@/lib/analysis-stream-events";
import { readAnalysisStream } from "@/lib/sse-client";

const storageKey = "ai-council-shared-fact-cases-v1";
const storageEvent = "ai-council-shared-fact-cases-updated";
const activeCaseKey = "ai-council-active-case-v1";
// The server marks a stuck model after 30s. This is the browser-side backstop
// for a dead connection, where no server event can arrive at all.
const CONNECTION_STALL_MS = 35_000;

function getActiveCaseId() {
  return window.localStorage.getItem(activeCaseKey);
}

function setActiveCaseId(id: string | null) {
  if (id) window.localStorage.setItem(activeCaseKey, id);
  else window.localStorage.removeItem(activeCaseKey);
  window.dispatchEvent(new Event(storageEvent));
}
const emptyCases: SharedFactCase[] = [];
let cachedRaw: string | null | undefined;
let cachedCases: SharedFactCase[] = emptyCases;

function List({ items, empty }: { items: string[]; empty: string }) {
  return items.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-slate-700">{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul> : <p className="mt-2 text-sm text-slate-500">{empty}</p>;
}

function normalizeModelView(value: unknown) {
  let current = value;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const view = (current as { view?: unknown }).view;
      if (view === undefined) return JSON.stringify(current);
      current = view;
      continue;
    }
    if (typeof current !== "string") return current == null ? "" : String(current);
    try {
      const parsed = JSON.parse(current) as unknown;
      if (parsed === current) return current;
      current = parsed;
    } catch {
      return current;
    }
  }
  return typeof current === "string" ? current : current == null ? "" : JSON.stringify(current);
}

function isCase(value: unknown): value is SharedFactCase {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SharedFactCase>;
  return typeof item.caseId === "string" && typeof item.originalQuestion === "string" && Boolean(item.currentState) && Array.isArray(item.rounds) && typeof item.createdAt === "string" && typeof item.updatedAt === "string";
}

function ModelView({ value }: { value: unknown }) {
  const text = String(normalizeModelView(value) ?? "");
  const marker = "【我查到的证据】";
  const start = text.indexOf(marker);
  const end = start < 0 ? -1 : text.indexOf("【关键未知信息】", start + marker.length);
  if (start < 0 || end < 0) return <div className="whitespace-pre-wrap">{text}</div>;
  if (DEMO_MODE) return <div className="whitespace-pre-wrap">{`${text.slice(0, start).trim()}\n\n${text.slice(end).trim()}`}</div>;
  const evidenceSection = text.slice(start + marker.length, end).trim();
  const [evidence, allResults] = evidenceSection.split("【全部搜索结果】");
  const count = new Set(evidence.match(/^\[S\d+\]/gm) ?? []).size;
  return <div className="space-y-3">
    <div className="whitespace-pre-wrap">{text.slice(0, start).trim()}</div>
    <details className="rounded-lg border border-slate-200 p-3">
      <summary className="cursor-pointer font-medium">我查到的证据（{count}条）</summary>
      <div className="mt-3 whitespace-pre-wrap break-words">{evidence.split(/(https?:\/\/[^\s]+)/g).map((part, index) =>
        /^https?:\/\//.test(part) ? <a key={index} href={part} target="_blank" rel="noopener noreferrer" className="text-indigo-700 underline">{part}</a> : part
      )}</div>
      {allResults && <details className="mt-3 rounded-lg border border-slate-200 p-3">
        <summary className="cursor-pointer">全部搜索结果</summary>
        <div className="mt-3 whitespace-pre-wrap break-words">{allResults.trim().split(/(https?:\/\/[^\s]+)/g).map((part, index) =>
          /^https?:\/\//.test(part) ? <a key={index} href={part} target="_blank" rel="noopener noreferrer" className="text-indigo-700 underline">{part}</a> : part
        )}</div>
      </details>}
    </details>
    <div className="whitespace-pre-wrap">{text.slice(end).trim()}</div>
  </div>;
}

// History chips keep only a short name; the full question stays in the title
// attribute and in the line under the chips.
function shortLabel(question: string, max = 10) {
  const compact = question.replace(/[\s，。！？；：、,.!?;:]/g, "");
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function newCaseId() {
  return globalThis.crypto?.randomUUID?.() ?? `case-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getStoredCases() {
  if (typeof window === "undefined") return [] as SharedFactCase[];
  const raw = window.localStorage.getItem(storageKey);
  if (raw === cachedRaw) return cachedCases;
  try {
    const saved = JSON.parse(raw ?? "[]") as unknown;
    cachedRaw = raw;
    cachedCases = Array.isArray(saved) ? saved.filter(isCase) : emptyCases;
    return cachedCases;
  } catch {
    window.localStorage.removeItem(storageKey);
    cachedRaw = null;
    cachedCases = emptyCases;
    return cachedCases;
  }
}

function subscribeToCases(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(storageEvent, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(storageEvent, onStoreChange);
  };
}

function saveCases(items: SharedFactCase[]) {
  const raw = JSON.stringify(items);
  window.localStorage.setItem(storageKey, raw);
  cachedRaw = raw;
  cachedCases = items;
  window.dispatchEvent(new Event(storageEvent));
}

export default function Home() {
  const [input, setInput] = useState("");
  const [state, setState] = useState<SharedFactState | null>(null);
  const [, setHistory] = useState<SharedFactState[]>([]);
  const [receivedState, setReceivedState] = useState<{ deepseek: string; qwen: string } | null>(null);
  const cases = useSyncExternalStore(subscribeToCases, getStoredCases, () => emptyCases);
  const activeCaseId = useSyncExternalStore(subscribeToCases, getActiveCaseId, () => null);
  const mainRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastStreamEventAt = useRef(0);
  const [isRoundOpen, setIsRoundOpen] = useState(false);
  const [isBackgroundOpen, setIsBackgroundOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isCaseListOpen, setIsCaseListOpen] = useState(true);
  const [isWorking, setIsWorking] = useState(false);
  const [live, setLive] = useState<Record<ModelName, LiveModelState> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [roundErrors, setRoundErrors] = useState<Partial<Record<ModelName, ModelFailure>>>({});
  const [error, setError] = useState("");
  const [searchReport, setSearchReport] = useState<AdvisorSearchReports | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const [caseToDelete, setCaseToDelete] = useState<SharedFactCase | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const activeCase = cases.find((item) => item.caseId === activeCaseId);
  const caseNumbers = new Map([...cases].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((item, index) => [item.caseId, index + 1]));
  const rounds = activeCase?.rounds ?? [];
  const latestRound = rounds.length > 0 ? rounds[rounds.length - 1] : undefined;
  const currentRoundState = latestRound ? latestRound.state : state;
  const historicalRounds = rounds.length > 0 ? rounds.slice(0, -1).reverse() : [];
  const previousRound = historicalRounds[0];
  const newFacts = currentRoundState?.confirmedFacts.filter((fact) => !previousRound?.state.confirmedFacts.includes(fact)) ?? [];
  const removedUnknowns = previousRound?.state.pendingInformation.filter((question) => !currentRoundState?.pendingInformation.includes(question)) ?? [];
  const newUnknowns = currentRoundState?.pendingInformation.filter((question) => !previousRound?.state.pendingInformation.includes(question)) ?? [];

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(138, Math.max(40, textarea.scrollHeight))}px`;
  }, [input]);

  const updateLive = (model: ModelName, patch: (current: LiveModelState) => LiveModelState) => {
    setLive((current) => current ? { ...current, [model]: patch(current[model]) } : current);
  };
  const liveActive = Boolean(live && isWorking);
  useEffect(() => {
    if (!liveActive) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current - lastStreamEventAt.current <= CONNECTION_STALL_MS) return;
      setLive((state) => {
        if (!state) return state;
        const stuck = (["deepseek", "qwen"] as const).filter((model) => state[model].status === "waiting" || state[model].status === "streaming");
        if (!stuck.length) return state;
        const next = { ...state };
        for (const model of stuck) {
          next[model] = { ...next[model], status: "error" as const, code: "timeout" as const, message: "连接好像断了：35 秒没有收到新内容，请重试。" };
        }
        return next;
      });
    }, 200);
    return () => window.clearInterval(timer);
  }, [liveActive]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    const reserveSpace = () => mainRef.current?.style.setProperty("padding-bottom", `${composer.getBoundingClientRect().height + 24}px`);
    reserveSpace();
    const observer = new ResizeObserver(reserveSpace);
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);

  function startNewQuestion() {
    if (isWorking) return;
    setSearchReport(null);
    setInput("");
    setState(null);
    setHistory([]);
    setReceivedState(null);
    setActiveCaseId(null);
    setIsBackgroundOpen(false);
    setIsRoundOpen(false);
    setIsHistoryOpen(false);
    setIsCaseListOpen(true);
    setError("");
    setLive(null);
    setRoundErrors({});
  }

  function openCase(item: SharedFactCase) {
    if (isWorking) return;
    setSearchReport(null);
    setInput("");
    setState(item.currentState);
    setHistory(item.rounds.slice(0, -1).map((round) => round.state));
    setReceivedState(null);
    setActiveCaseId(item.caseId);
    setIsBackgroundOpen(false);
    setIsRoundOpen(false);
    setIsHistoryOpen(false);
    setError("");
    setLive(null);
    setRoundErrors({});
  }

  function saveRound(nextState: SharedFactState, userInput: string) {
    const now = new Date().toISOString();
    const round: SharedFactRound = { userInput, state: nextState, createdAt: now };
    if (!activeCase) {
      const item: SharedFactCase = { caseId: newCaseId(), originalQuestion: userInput, currentState: nextState, rounds: [round], createdAt: now, updatedAt: now };
      saveCases([item, ...cases]);
      setActiveCaseId(item.caseId);
      return;
    }
    saveCases(cases.map((item) => item.caseId === activeCaseId ? { ...item, currentState: nextState, rounds: [...item.rounds, round], updatedAt: now } : item));
  }

  // A side retry does not add a new round; it replaces the latest round's
  // snapshot so the saved history matches what the two columns show.
  function replaceLatestRoundState(nextState: SharedFactState) {
    if (!activeCase) { setState(nextState); return; }
    const now = new Date().toISOString();
    saveCases(cases.map((item) => item.caseId === activeCaseId ? {
      ...item,
      currentState: nextState,
      rounds: item.rounds.map((round, index) => index === item.rounds.length - 1 ? { ...round, state: nextState } : round),
      updatedAt: now,
    } : item));
    setState(nextState);
  }

  function requestDeleteCase(item: SharedFactCase) {
    if (isWorking) return;
    setCaseToDelete(item);
    setDeleteError("");
    deleteDialogRef.current?.showModal();
  }

  function confirmDeleteCase() {
    if (isWorking || !caseToDelete) return;
    try {
      // Read the latest stored list so deleting one Case preserves other updates.
      const remaining = getStoredCases().filter((item) => item.caseId !== caseToDelete.caseId);
      const deletingActive = getActiveCaseId() === caseToDelete.caseId;
      saveCases(remaining);
      if (deletingActive) {
        const mostRecent = [...remaining].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (mostRecent) openCase(mostRecent);
        else startNewQuestion();
      }
      deleteDialogRef.current?.close();
      setCaseToDelete(null);
      setDeleteError("");
    } catch {
      setDeleteError("无法完成删除，请检查浏览器存储权限后重试。");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const userInput = input.trim();
    if (!userInput) return;
    const submissionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    console.info("[submission]", { submissionId, stage: "start" });
    setIsWorking(true); setError(""); setRoundErrors({});
    const startedAt = Date.now();
    setLive({
      deepseek: { status: "waiting", text: "", stage: "整理共享背景", startedAt },
      qwen: { status: "waiting", text: "", stage: "整理共享背景", startedAt },
    });
    setNow(startedAt);
    lastStreamEventAt.current = startedAt;
    const streamResult: { done: Extract<AnalysisStreamEvent, { type: "done" }> | null; error: Error | null } = { done: null, error: null };
    try {
      const update = await fetch("/api/shared-facts", { method: "POST", headers: { "Content-Type": "application/json", "x-submission-id": submissionId }, body: JSON.stringify({ state: currentRoundState, userInput }) });
      const updatePayload = (await update.json()) as { state?: SharedFactState; error?: string };
      console.info("[submission]", { submissionId, stage: "shared-facts-response", status: update.status, hasState: Boolean(updatePayload.state), error: updatePayload.error ?? null });
      if (!update.ok || !updatePayload.state) throw new Error(updatePayload.error ?? "共享事实状态更新失败。");

      const analysis = await fetch("/api/shared-analysis", { method: "POST", headers: { "Content-Type": "application/json", "x-submission-id": submissionId }, body: JSON.stringify({ state: updatePayload.state, stream: true }) });
      if (!analysis.ok || !analysis.body) {
        const payload = (await analysis.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "双模型分析没有启动成功。");
      }
      lastStreamEventAt.current = Date.now();
      await readAnalysisStream(analysis, (streamEvent) => {
        lastStreamEventAt.current = Date.now();
        switch (streamEvent.type) {
          case "stage":
            updateLive(streamEvent.model, (item) => item.status === "waiting" ? { ...item, stage: streamEvent.label } : item);
            break;
          case "reset":
            updateLive(streamEvent.model, (item) => ({ ...item, text: "", status: "waiting", message: undefined, code: undefined }));
            break;
          case "delta":
            updateLive(streamEvent.model, (item) => ({ ...item, status: "streaming", text: item.text + streamEvent.text }));
            break;
          case "model-done":
            updateLive(streamEvent.model, (item) => ({ ...item, status: "done", text: streamEvent.view, truncated: Boolean(streamEvent.truncated), message: undefined, code: undefined }));
            break;
          case "model-error":
            updateLive(streamEvent.model, (item) => ({ ...item, status: "error", code: streamEvent.code, message: streamEvent.message }));
            break;
          case "done":
            streamResult.done = streamEvent;
            break;
          case "error":
            streamResult.error = new Error(streamEvent.message);
            break;
        }
      });
      if (streamResult.error) throw streamResult.error;
      const done = streamResult.done;
      if (!done) throw new Error("连接提前中断，没有收到完整结果。");
      if (state) setHistory((items) => [...items, state]);
      setState(done.state);
      setReceivedState(done.receivedState);
      setSearchReport(done.searchReport ?? null);
      setRoundErrors(done.errors ?? {});
      saveRound(done.state, userInput);
      setIsCaseListOpen(true);
      console.info("[submission]", { submissionId, stage: "saved" });
      setInput("");
      window.setTimeout(() => {
        setLive((current) => current && (current.deepseek.status === "done" || current.deepseek.status === "error") && (current.qwen.status === "done" || current.qwen.status === "error") ? null : current);
      }, 500);
    } catch (submitError) {
      const rawMessage = submitError instanceof Error ? submitError.message : "实验执行失败。";
      console.info("[submission]", { submissionId, stage: "failed", error: rawMessage });
      setError(/failed to fetch|networkerror|load failed|network error/i.test(rawMessage) ? "连不上服务，请检查网络后重试。" : rawMessage);
      // If the failure happened before the stream opened (facts step or HTTP
      // error), both columns are still "waiting". Drop the empty live panel so
      // the user is not left looking at a spinner that will never move.
      setLive((current) => current && current.deepseek.status === "waiting" && current.qwen.status === "waiting" ? null : current);
    } finally {
      setIsWorking(false);
    }
  }

  async function retryModel(model: ModelName) {
    if (isWorking || !currentRoundState) return;
    const label = model === "deepseek" ? "DeepSeek" : "Qwen";
    setIsWorking(true);
    setError("");
    const startedAt = Date.now();
    const views = currentRoundState.modelViews;
    setLive({
      deepseek: model === "deepseek" ? { status: "waiting", text: "", stage: "重新生成", startedAt } : { status: "done", text: views.deepseek, startedAt },
      qwen: model === "qwen" ? { status: "waiting", text: "", stage: "重新生成", startedAt } : { status: "done", text: views.qwen, startedAt },
    });
    setNow(startedAt);
    lastStreamEventAt.current = startedAt;
    const result: { done: Extract<AnalysisStreamEvent, { type: "done" }> | null; error: Error | null; failure: ModelFailure | null } = { done: null, error: null, failure: null };
    try {
      const response = await fetch("/api/shared-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: currentRoundState, stream: true, models: [model] }),
      });
      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `${label} 重试没有启动成功。`);
      }
      await readAnalysisStream(response, (streamEvent) => {
        lastStreamEventAt.current = Date.now();
        switch (streamEvent.type) {
          case "stage":
            updateLive(streamEvent.model, (item) => item.status === "waiting" ? { ...item, stage: streamEvent.label } : item);
            break;
          case "reset":
            updateLive(streamEvent.model, (item) => ({ ...item, text: "", status: "waiting", message: undefined, code: undefined }));
            break;
          case "delta":
            updateLive(streamEvent.model, (item) => ({ ...item, status: "streaming", text: item.text + streamEvent.text }));
            break;
          case "model-done":
            updateLive(streamEvent.model, (item) => ({ ...item, status: "done", text: streamEvent.view, truncated: Boolean(streamEvent.truncated), message: undefined, code: undefined }));
            break;
          case "model-error":
            result.failure = { code: streamEvent.code, message: streamEvent.message };
            updateLive(streamEvent.model, (item) => ({ ...item, status: "error", code: streamEvent.code, message: streamEvent.message }));
            break;
          case "done":
            result.done = streamEvent;
            break;
          case "error":
            result.error = new Error(streamEvent.message);
            break;
        }
      });
      if (result.error) throw result.error;
      const done = result.done;
      if (!done) throw new Error("连接提前中断，没有收到完整结果。");
      setRoundErrors((current) => {
        const next = { ...current };
        delete next[model];
        return next;
      });
      replaceLatestRoundState(done.state);
      console.info("[retry]", { model, stage: "saved" });
      window.setTimeout(() => setLive(null), 500);
    } catch (retryError) {
      const rawMessage = retryError instanceof Error ? retryError.message : "重试失败。";
      const friendly = /failed to fetch|networkerror|load failed|network error/i.test(rawMessage) ? "连不上服务，请检查网络后重试。" : rawMessage;
      setRoundErrors((current) => ({ ...current, [model]: result.failure ?? { code: "failed", message: friendly } }));
      setError(friendly);
      setLive(null);
    } finally {
      setIsWorking(false);
    }
  }

  return <main ref={mainRef} className="min-h-screen bg-[#f8fafc] pb-28 text-slate-900"><section className="mx-auto max-w-5xl px-5 pb-14 pt-8 sm:px-8">
    <header className="flex items-center justify-between gap-3"><div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-slate-950 text-sm font-bold text-white">UY</div><div><p className="text-lg font-semibold">共享背景板</p><p className="text-xs text-slate-500">两个 AI，同一份背景，各自回答</p></div></div><button type="button" onClick={startNewQuestion} className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700">新建问题</button></header>

    <div className="mt-5 rounded-xl border border-slate-200 bg-white px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">历史问题{cases.length ? <span className="ml-1 font-normal text-slate-500">（{cases.length}）</span> : null}</h2>
        {cases.length > 0 && <button type="button" aria-expanded={isCaseListOpen} onClick={() => setIsCaseListOpen((open) => !open)} className="shrink-0 text-xs font-medium text-slate-600">{isCaseListOpen ? "收起" : "展开"}</button>}
      </div>
      {!cases.length ? <p className="mt-2 text-sm text-slate-500">还没有历史问题。在下方输入问题开始。</p> : isCaseListOpen && <>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {cases.map((item) => {
            const active = item.caseId === activeCaseId;
            return <li key={item.caseId} className={`flex items-center gap-0.5 rounded-full border ${active ? "border-indigo-300 bg-indigo-50" : "border-slate-200 bg-white"}`}>
              <button type="button" onClick={() => openCase(item)} title={item.originalQuestion} aria-label={`打开历史问题：${item.originalQuestion}`} className={`min-w-0 max-w-[12rem] truncate py-1 pl-2.5 pr-1 text-xs ${active ? "text-indigo-800" : "text-slate-600"}`}>
                <span className="mr-1 tabular-nums text-slate-400">#{caseNumbers.get(item.caseId)}</span>{shortLabel(item.originalQuestion)}
              </button>
              <button type="button" disabled={isWorking} onClick={() => requestDeleteCase(item)} aria-label={`删除历史问题：${item.originalQuestion}`} className="mr-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-sm leading-none text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40">×</button>
            </li>;
          })}
        </ul>
        {activeCase && <p className="mt-2 truncate text-xs leading-5 text-slate-500" title={activeCase.originalQuestion}>{activeCase.originalQuestion}</p>}
      </>}
    </div>
    {!currentRoundState && <div className="mt-8"><h1 className="text-2xl font-semibold">一份事实，两个独立观点</h1><p className="mt-3 text-slate-600">输入核心问题，两个 AI 会用同一份背景各自回答。</p></div>}

    {live && <LivePanel live={live} now={now} previous={currentRoundState?.modelViews} />}
    {!live && currentRoundState && Object.keys(roundErrors).length > 0 && <div role="status" className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
      本轮有模型没返回结果：{(["deepseek", "qwen"] as const).filter((model) => roundErrors[model]).map((model) => `${model === "deepseek" ? "DeepSeek" : "Qwen"}：${roundErrors[model]?.message}`).join("；")}。已返回的观点已经保存，可以只重试失败的那一侧。
    </div>}
    {!live && currentRoundState && <div className="mt-5 space-y-4">
      <div className="grid gap-5 md:grid-cols-2">
        <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold text-cyan-700">DeepSeek 当前观点{roundErrors.deepseek && <span className="ml-2 text-xs font-normal text-amber-700">{currentRoundState.modelViews.deepseek ? "本轮未更新" : "本轮无内容"}</span>}</h2>
          <div className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-slate-700"><ModelView value={currentRoundState.modelViews.deepseek} /></div>
          {!currentRoundState.modelViews.deepseek && !roundErrors.deepseek && <p className="mt-3 text-sm leading-6 text-slate-500">这一轮没有留下观点。</p>}
          {roundErrors.deepseek && <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3">
            <p className="text-sm leading-6 text-rose-700">这一侧本轮没有返回内容：{roundErrors.deepseek.message}</p>
            <button type="button" disabled={isWorking} onClick={() => retryModel("deepseek")} className="mt-2 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 ring-1 ring-rose-200 disabled:opacity-50">重试这一侧</button>
          </div>}
        </section>
        <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold text-violet-700">Qwen 当前观点{roundErrors.qwen && <span className="ml-2 text-xs font-normal text-amber-700">{currentRoundState.modelViews.qwen ? "本轮未更新" : "本轮无内容"}</span>}</h2>
          <div className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-slate-700"><ModelView value={currentRoundState.modelViews.qwen} /></div>
          {!currentRoundState.modelViews.qwen && !roundErrors.qwen && <p className="mt-3 text-sm leading-6 text-slate-500">这一轮没有留下观点。</p>}
          {roundErrors.qwen && <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3">
            <p className="text-sm leading-6 text-rose-700">这一侧本轮没有返回内容：{roundErrors.qwen.message}</p>
            <button type="button" disabled={isWorking} onClick={() => retryModel("qwen")} className="mt-2 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 ring-1 ring-rose-200 disabled:opacity-50">重试这一侧</button>
          </div>}
        </section>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white">
        <button type="button" aria-expanded={isBackgroundOpen} onClick={() => setIsBackgroundOpen((open) => !open)} className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left">
          <div><h2 className="font-semibold">当前背景</h2><p className="mt-1 text-sm text-slate-500">已确认事实 {currentRoundState.confirmedFacts.length} 条 · 待确认信息 {currentRoundState.pendingInformation.length} 条</p></div>
          <span className="shrink-0 text-sm text-slate-600">{isBackgroundOpen ? "收起" : "展开 >"}</span>
        </button>
        {isBackgroundOpen && <div className="border-t border-slate-100 p-5">
          <p className="text-xs text-slate-500">背景版本 v{currentRoundState.version}</p>
          <h3 className="mt-3 font-semibold">核心问题</h3><p className="mt-2 whitespace-pre-wrap leading-7">{currentRoundState.currentQuestion}</p>
          <div className="mt-5 grid gap-5 md:grid-cols-2"><div><h3 className="font-semibold">已确认事实</h3><List items={currentRoundState.confirmedFacts} empty="当前没有已确认事实。" /></div><div><h3 className="font-semibold">当前待确认信息</h3><List items={currentRoundState.pendingInformation} empty="当前没有待确认项。" /></div></div>
        </div>}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white">
        <button type="button" aria-expanded={isRoundOpen} onClick={() => setIsRoundOpen((open) => !open)} className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left"><h2 className="font-semibold">本轮详情</h2><span className="text-sm text-slate-600">{isRoundOpen ? "收起" : "展开 >"}</span></button>
        {isRoundOpen && <div className="space-y-5 border-t border-slate-100 p-5">
          <div><h3 className="font-semibold">你这一轮的输入</h3><p className="mt-2 whitespace-pre-wrap leading-7">{latestRound?.userInput ?? currentRoundState.currentQuestion}</p></div>
          <div><h3 className="font-semibold">本轮新增 / 替换后的事实</h3><List items={newFacts} empty="本轮没有新增事实文本。" /></div>
          <div><h3 className="font-semibold">不再列出的旧未知项</h3><p className="mt-1 text-xs text-slate-500">按前后快照文本对照；可能已关闭、改写、合并或暂不列为重点，历史数据没有逐项原因映射。</p><List items={removedUnknowns} empty="没有不再列出的旧未知项。" /></div>
          <div><h3 className="font-semibold">本轮新增 / 改写后的未知项</h3><List items={newUnknowns} empty="没有新增的未知项文本。" /></div>
          <div><h3 className="font-semibold">本轮状态变化</h3><List items={currentRoundState.changes} empty="无状态变化。" /></div>
          <p className="text-sm text-slate-500">{receivedState ? receivedState.deepseek === receivedState.qwen ? "两个模型收到的是同一份背景（校验值一致）。" : "本轮有一侧没有完成，两个模型收到的背景不一致。" : "这一轮的背景校验值没有保存在历史数据里，重新打开后无法核对。"}</p>
      {!DEMO_MODE && searchReport && (["deepseek", "qwen"] as const).map((model) => {
        const report = searchReport[model];
        const modelLabel = model === "deepseek" ? "DeepSeek" : "Qwen";
        return <details key={model} className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
        <summary className="cursor-pointer font-semibold">{modelLabel} 检索详情：{report.searches.length ? `检索返回 ${new Set(report.searches.flatMap((search) => search.results.map((source) => source.url))).size} 条来源` : report.category === "unavailable" ? "未执行" : "本轮无需搜索"}</summary>
        {report.error && <p className="mt-2 text-amber-700">{report.error}</p>}
        {report.searches.map((search) => <div key={search.query} className="mt-2"><p>搜索：{search.query}</p>{search.error && <p className="text-amber-700">{search.error}</p>}{search.status === "ok" && search.results.length === 0 && <p>未找到可用来源，尚无法验证。</p>}</div>)}
        {report.unknowns.some((gap) => gap.kind === "private") && <p className="mt-2 text-slate-600">需要你补充：{report.unknowns.filter((gap) => gap.kind === "private").map((gap) => gap.question).join("；")}</p>}
        {report.searches.some((search) => search.results.length) && <details className="mt-2"><summary className="cursor-pointer">查看来源</summary>{report.searches.flatMap((search) => search.results.map((source) => <div key={`${search.query}-${source.url}`} className="mt-3"><a href={source.url} target="_blank" rel="noopener noreferrer" className="text-indigo-700 underline">{source.title}</a><p className="mt-1 text-slate-600">{source.snippet}</p></div>))}</details>}
      </details>;
      })}

        </div>}
      </section>
    </div>}

    <div ref={composerRef} className="fixed inset-x-0 bottom-0 z-50 mx-auto w-full max-w-[900px] px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
      {error && <p role="alert" className="mb-2 max-h-20 overflow-y-auto rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      <form onSubmit={submit} className="flex items-end gap-2 rounded-2xl border border-slate-300 bg-white/95 p-2 shadow-[0_-4px_24px_rgba(15,23,42,0.12)] backdrop-blur">
        <label htmlFor="shared-input" className="sr-only">{currentRoundState ? "继续补充信息" : "当前核心问题"}</label>
        <textarea ref={inputRef} id="shared-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={currentRoundState ? "补充新事实或继续说明…" : "输入你的核心问题…"} rows={1} className="block h-10 min-h-10 max-h-[138px] min-w-0 flex-1 resize-none overflow-y-auto rounded-xl px-3 py-2 text-sm leading-6 outline-none focus:ring-1 focus:ring-indigo-300" />
        <button type="submit" disabled={!input.trim() || isWorking} className="h-10 shrink-0 rounded-xl bg-slate-950 px-4 text-sm font-semibold text-white disabled:bg-slate-300">{isWorking ? "处理中…" : currentRoundState ? "提交补充" : "开始"}</button>
      </form>
    </div>

    {currentRoundState && <section className="mt-5 rounded-2xl border border-slate-200 bg-white"><button type="button" aria-expanded={isHistoryOpen} onClick={() => setIsHistoryOpen((open) => !open)} className="flex w-full items-center justify-between gap-4 p-5 text-left"><div><h2 className="font-semibold">历史与对照</h2><p className="mt-1 text-sm text-slate-500">仅包含当前轮之前的状态、观点与轮次</p></div><span className="text-sm font-semibold text-slate-700">{isHistoryOpen ? "收起" : "展开"}</span></button>{isHistoryOpen && <div className="space-y-5 border-t border-slate-100 p-5">{previousRound && <section><h3 className="font-semibold">上一轮状态与观点对照</h3><div className="mt-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-600"><p>版本 v{previousRound.state.version} 的已确认事实：{previousRound.state.confirmedFacts.join("；") || "无"}</p><div className="mt-2">DeepSeek 前一轮观点：<ModelView value={previousRound.state.modelViews.deepseek} /></div><div className="mt-2">Qwen 前一轮观点：<ModelView value={previousRound.state.modelViews.qwen} /></div></div></section>}{activeCase && <section><h3 className="font-semibold">这个问题的历史轮次</h3><p className="mt-1 text-sm text-slate-500">当前最新轮不在此处；更早轮次按最新到最早排列。</p><div className="mt-4 space-y-4">{historicalRounds.map((round) => <article key={round.createdAt} className="rounded-xl bg-slate-50 p-4 text-sm text-slate-700"><p className="font-semibold">第 {round.state.version} 轮 · 背景版本 v{round.state.version}</p><p className="mt-2">用户输入：{round.userInput}</p><div className="mt-4 border-t border-slate-200 pt-3"><p className="font-medium">该轮状态报告</p><div className="mt-3 grid gap-4 md:grid-cols-2"><div><p className="text-sm font-medium">已确认事实</p><List items={round.state.confirmedFacts} empty="该轮没有已确认事实。" /></div><div><p className="text-sm font-medium">待确认 / 关键未知信息</p><List items={round.state.pendingInformation} empty="该轮没有待确认项。" /></div></div><div className="mt-3"><p className="text-sm font-medium">状态变化</p><List items={round.state.changes} empty="该轮没有记录状态变化。" /></div></div><div className="mt-4 grid gap-4 md:grid-cols-2"><div><p className="text-sm font-medium text-cyan-700">DeepSeek</p><div className="mt-2 whitespace-pre-wrap leading-7"><ModelView value={round.state.modelViews.deepseek} /></div></div><div><p className="text-sm font-medium text-violet-700">Qwen</p><div className="mt-2 whitespace-pre-wrap leading-7"><ModelView value={round.state.modelViews.qwen} /></div></div></div><details className="mt-4 rounded-lg border border-slate-200 bg-white p-3"><summary className="cursor-pointer text-sm font-medium">更多实验信息</summary><p className="mt-2 text-sm text-slate-600">背景版本：v{round.state.version}</p><p className="mt-2 text-sm text-slate-600">该轮核心问题：{round.state.currentQuestion}</p><p className="mt-2 text-xs text-slate-500">该轮共享背景的校验值没有存入历史记录，无法从历史里恢复。</p></details></article>)}</div></section>}</div>}</section>}
  </section>
    <dialog ref={deleteDialogRef} onClose={() => { setCaseToDelete(null); setDeleteError(""); }} aria-labelledby="delete-case-title" aria-describedby="delete-case-description" className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-xl backdrop:bg-black/40">
      <h2 id="delete-case-title" className="text-lg font-semibold">确定删除这个历史对话吗？</h2>
      <p className="mt-2 break-words text-sm text-slate-600">{caseToDelete?.originalQuestion}</p>
      <p id="delete-case-description" className="mt-3 text-sm leading-6">这个历史问题的所有轮次、背景快照、DeepSeek/Qwen 历史观点都会一起删除。此操作无法撤销。</p>
      {deleteError && <p role="alert" className="mt-3 text-sm text-rose-700">{deleteError}</p>}
      <div className="mt-5 flex justify-end gap-3">
        <button type="button" onClick={() => deleteDialogRef.current?.close()} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">取消</button>
        <button type="button" disabled={isWorking || !caseToDelete} onClick={confirmDeleteCase} className="rounded-lg bg-rose-600 px-4 py-2 text-sm text-white disabled:opacity-40">删除</button>
      </div>
    </dialog>
  </main>;
}
