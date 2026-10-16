import Link from "next/link";

const KST = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export const kst = (ms: number | Date | string | undefined) => (ms ? KST.format(new Date(ms)) : "—");

export function ago(ms: number | undefined): string {
  if (!ms) return "—";
  const m = Math.floor((Date.now() - ms) / 60_000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}시간 전` : `${Math.floor(h / 24)}일 전`;
}

export function Shell({ email, children }: { email: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 text-sm">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-lg font-semibold">🔔 Nudge 관리자</h1>
          <nav className="flex flex-wrap gap-3 text-zinc-600 dark:text-zinc-400">
            <Link href="/admin" className="hover:underline">개요</Link>
            <Link href="/admin/logs" className="hover:underline">로그</Link>
            <a href="/admin/export/feedback.jsonl" className="hover:underline">피드백 내보내기</a>
            <a href="/admin/export/tuning.jsonl" className="hover:underline">튜닝 데이터</a>
          </nav>
        </div>
        <span className="text-zinc-500">{email}</span>
      </header>
      {children}
    </div>
  );
}

export function Card({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs text-zinc-500">{hint}</div> : null}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-base font-semibold">{title}</h2>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

export function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <table className="w-full border-collapse text-left">
      <thead>
        <tr className="border-b border-zinc-200 text-xs text-zinc-500 dark:border-zinc-800">
          {head.map((h) => (
            <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td className="px-2 py-3 text-zinc-500" colSpan={head.length}>없음</td>
          </tr>
        ) : (
          rows.map((r, i) => (
            <tr key={i} className="border-b border-zinc-100 align-top dark:border-zinc-900">
              {r.map((c, j) => (
                <td key={j} className="px-2 py-1.5">{c}</td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
