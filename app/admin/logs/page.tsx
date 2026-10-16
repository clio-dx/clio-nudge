import { requireAdmin } from "../auth";
import { Section, Shell, Table, kst } from "../ui";
import { recentLogs } from "@/lib/admin";

export const dynamic = "force-dynamic";

const SEVERITIES = ["DEFAULT", "INFO", "WARNING", "ERROR"];
const field = "mt-1 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";

export default async function LogsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const admin = await requireAdmin();
  const q = await searchParams;
  const hours = Math.min(168, Math.max(1, Number(q.hours ?? 6) || 6));
  const severity = SEVERITIES.includes(q.severity ?? "") ? q.severity! : "DEFAULT";
  const search = (q.q ?? "").slice(0, 100);
  const { lines, error } = await recentLogs({ hours, severity, search }).then(
    (lines) => ({ lines, error: "" }),
    (err) => ({ lines: [], error: String(err).slice(0, 300) })
  );

  return (
    <Shell email={admin.email}>
      <form className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col text-xs text-zinc-500">
          기간(시간)
          <input name="hours" defaultValue={hours} className={`${field} w-20`} />
        </label>
        <label className="flex flex-col text-xs text-zinc-500">
          심각도
          <select name="severity" defaultValue={severity} className={field}>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>{s === "DEFAULT" ? "전체" : `${s} 이상`}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs text-zinc-500">
          검색
          <input name="q" defaultValue={search} placeholder="예: poll U097…, failed" className={`${field} w-64`} />
        </label>
        <button className="rounded bg-zinc-900 px-3 py-1.5 text-white dark:bg-zinc-100 dark:text-zinc-900">보기</button>
      </form>
      {error ? <p className="mb-4 text-red-600">로그를 불러오지 못했어요: {error}</p> : null}
      <Section title={`로그 ${lines.length}줄`}>
        <Table
          head={["시각", "심각도", "서비스", "내용"]}
          rows={lines.map((l) => [
            <span key="t" className="whitespace-nowrap">{kst(l.at)}</span>,
            <span key="s" className={l.severity === "ERROR" ? "text-red-600" : l.severity === "WARNING" ? "text-amber-600" : ""}>
              {l.severity}
            </span>,
            l.service,
            <pre key="x" className="max-w-3xl whitespace-pre-wrap break-all font-mono text-xs">{l.text.slice(0, 2000)}</pre>,
          ])}
        />
      </Section>
    </Shell>
  );
}
