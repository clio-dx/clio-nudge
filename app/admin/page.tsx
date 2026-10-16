import { requireAdmin } from "./auth";
import { Card, Section, Shell, Table, ago, kst } from "./ui";
import { aiStats, overview, recentFeedback, recentRuns, userRows } from "@/lib/admin";
import { FEEDBACK_LABELS } from "@/lib/feedback";

export const dynamic = "force-dynamic";

const LABELS: Record<string, string> = { ...FEEDBACK_LABELS, missed: "놓친 질문", done: "완료", comment: "의견" };

function runSummary(kind: string, s: Record<string, unknown>): string {
  if (kind === "tick") return `대기열 ${JSON.stringify(s.queued ?? {})}${(s.errors as unknown[] | undefined)?.length ? " · 오류 있음" : ""}`;
  if (kind === "poll") {
    const o = s.outgoing as { candidates?: number; tracked?: number } | undefined;
    const i = s.incoming as { candidates?: number; tracked?: number } | undefined;
    const left = (s.incomplete as string[] | undefined)?.length ?? 0;
    return (
      `받은 후보 ${i?.candidates ?? 0}→${i?.tracked ?? 0} · 보낸 후보 ${o?.candidates ?? 0}→${o?.tracked ?? 0} · 오류 ${s.errors ?? 0}` +
      (left ? ` · 이어서 ${left}` : "") +
      (s.skipped ? ` · ${s.skipped}` : "")
    );
  }
  if (kind === "deliver") return s.sent ? `알림 보냄 (${s.sent}개)` : String(s.skipped ?? s.error ?? "");
  return JSON.stringify(s).slice(0, 140);
}

export default async function AdminPage() {
  const admin = await requireAdmin();
  const [users, runs, ai, feedback] = await Promise.all([userRows(), recentRuns(150), aiStats(24), recentFeedback(30)]);
  const o = await overview(users);
  const names = new Map(users.map((u) => [u.id, u.name]));

  return (
    <Shell email={admin.email}>
      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Card label="사용자" value={o.users} hint={`최근 7일 연결 ${o.installed7d}명`} />
        <Card label="24시간 안에 수집" value={o.active24h} hint={`첫 수집 중 ${o.firstScanPending} · 알림 끔 ${o.paused}`} />
        <Card label="추적 중 질문" value={o.incoming + o.outgoing} hint={`📥 ${o.incoming} · 📤 ${o.outgoing}`} />
        <Card label="24시간 알림 발송" value={o.digests24h} hint={`수집 ${o.polls24h}회 · 오류 ${o.pollErrors24h}`} />
        <Card label="AI 호출 24시간" value={ai.total} hint={`실패 ${ai.failed}`} />
        <Card label="피드백" value={o.feedback} hint={`완료 ${o.done}회 · ${o.lastTick ? `마지막 tick ${ago(o.lastTick.at)}` : "tick 기록 없음"}`} />
      </div>

      <Section title="사용자">
        <Table
          head={["이름", "Slack ID", "연결", "마지막 수집", "알림", "📥", "📤", "상태", "마지막 알림"]}
          rows={users.map((u) => [
            u.name,
            <code key="id" className="text-xs">{u.id}</code>,
            kst(u.installedAt),
            ago(u.lastPolledAt),
            u.schedule,
            u.incoming,
            u.outgoing,
            [u.paused ? "끔" : "", u.firstScanPending ? "첫 수집 중" : ""].filter(Boolean).join(" · ") || "정상",
            u.lastSentDate ?? "—",
          ])}
        />
      </Section>

      <Section title="AI 호출 (24시간)">
        <Table head={["작업 · 모델", "호출", "실패", "p50 (ms)", "p90 (ms)"]} rows={ai.rows.map((r) => [r.key, r.calls, r.failed, r.p50, r.p90])} />
      </Section>

      <Section title="최근 실행">
        <Table
          head={["시각", "종류", "사용자", "소요", "결과"]}
          rows={runs.slice(0, 80).map(({ data: r }) => [
            <span key="t" className="whitespace-nowrap">{kst(r.at)}</span>,
            r.kind,
            r.userId ? names.get(r.userId) ?? r.userId : "—",
            r.ms ? `${(r.ms / 1000).toFixed(1)}s` : "—",
            <span key="s" className={r.ok === false ? "text-red-600" : ""}>{runSummary(r.kind, r.summary)}</span>,
          ])}
        />
      </Section>

      <Section title="최근 피드백">
        <Table
          head={["시각", "사용자", "종류", "경로", "메시지", "메모"]}
          rows={feedback.map(({ data: f }) => [
            <span key="t" className="whitespace-nowrap">{kst(f.at)}</span>,
            names.get(f.userId) ?? f.userId,
            LABELS[f.label] ?? f.label,
            f.source,
            <span key="m" className="line-clamp-2 max-w-md">{f.summary || f.originalMessage || "—"}</span>,
            f.note ?? "",
          ])}
        />
      </Section>
    </Shell>
  );
}
