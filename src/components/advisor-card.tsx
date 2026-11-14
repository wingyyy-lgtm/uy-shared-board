import type { Advisor } from "@/lib/council";

export function AdvisorCard({ advisor, response }: { advisor: Advisor; response?: string }) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/60">
      <div className="flex items-start gap-3">
        <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${advisor.accent} text-xs font-bold text-white shadow-sm`}>{advisor.role.slice(0, 3)}</div>
        <div><p className="font-semibold text-slate-950">{advisor.title}</p><p className="mt-0.5 text-sm text-slate-500">{advisor.focus}</p></div>
      </div>
      {response ? <p className="mt-5 whitespace-pre-wrap text-[15px] leading-7 text-slate-700">{response}</p> : <p className="mt-5 text-[15px] leading-7 text-slate-500">提交问题后，这位顾问会给出独立的真实分析。</p>}
    </article>
  );
}
