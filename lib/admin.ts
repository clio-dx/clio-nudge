// Numbers and lists for the admin pages (app/admin). Read-only.
import { getAllUsers, type NudgeUser } from "@/lib/db";
import { getUserFollowUps, lastTick } from "@/lib/store";
import { backend } from "@/lib/store/backend";
import { recentRuns, type Run } from "@/lib/runs";
import { createBoundedClient } from "@/lib/slack";
import { formatSchedule, resolveSchedule, resolveTimezone } from "@/lib/schedule";
import { gcpFetch, PROJECT_ID } from "@/lib/gcp";
import type { AiCall } from "@/lib/ai-log";
import type { Feedback } from "@/lib/feedback";

const HOUR = 60 * 60 * 1000;

// Slack display names, looked up with each user's own token (users:read), cached for a while
const names = new Map<string, { name: string; at: number }>();
async function nameOf(u: NudgeUser): Promise<string> {
  const hit = names.get(u.slackUserId);
  if (hit && Date.now() - hit.at < 6 * HOUR) return hit.name;
  try {
    const res = await createBoundedClient(u.userToken).users.info({ user: u.slackUserId });
    const user = res.user as { real_name?: string; profile?: { display_name?: string } } | undefined;
    const name = user?.real_name || user?.profile?.display_name || u.slackUserId;
    names.set(u.slackUserId, { name, at: Date.now() });
    return name;
  } catch {
    return u.slackUserId;
  }
}

export interface UserRow {
  id: string;
  name: string;
  installedAt: number;
  lastPolledAt?: number;
  schedule: string;
  paused: boolean;
  tz: string;
  firstScanPending: boolean;
  incoming: number;
  outgoing: number;
  lastSentDate?: string;
}

export async function userRows(): Promise<UserRow[]> {
  const users = await getAllUsers();
  const rows = await Promise.all(
    users.map(async (u) => {
      const { schedule, paused } = resolveSchedule(u);
      const [incoming, outgoing, name] = await Promise.all([
        getUserFollowUps(u.slackUserId, "incoming"),
        getUserFollowUps(u.slackUserId, "outgoing"),
        nameOf(u),
      ]);
      return {
        id: u.slackUserId,
        name,
        installedAt: u.installedAt,
        lastPolledAt: u.lastPolledAt,
        schedule: formatSchedule(schedule),
        paused,
        tz: resolveTimezone(u),
        firstScanPending: !!u.firstScanPending,
        incoming: incoming.length,
        outgoing: outgoing.length,
        lastSentDate: u.lastSentDate,
      } satisfies UserRow;
    })
  );
  return rows.sort((a, b) => b.installedAt - a.installedAt);
}

export interface AiStat {
  key: string; // "task · model"
  calls: number;
  failed: number;
  p50: number;
  p90: number;
}

export async function aiStats(hours = 24): Promise<{ total: number; failed: number; rows: AiStat[] }> {
  const since = new Date(Date.now() - hours * HOUR);
  const calls = (await backend.query<AiCall>("ai_calls", { where: [["at", ">=", since]] })).map((r) => r.data);
  const groups = new Map<string, AiCall[]>();
  for (const c of calls) groups.set(`${c.task} · ${c.model}`, [...(groups.get(`${c.task} · ${c.model}`) ?? []), c]);
  const pct = (ms: number[], p: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] ?? 0;
  const rows = [...groups.entries()].map(([key, cs]) => {
    const ms = cs.filter((c) => c.ok).map((c) => c.ms).sort((a, b) => a - b);
    return { key, calls: cs.length, failed: cs.filter((c) => !c.ok).length, p50: pct(ms, 0.5), p90: pct(ms, 0.9) };
  });
  return { total: calls.length, failed: calls.filter((c) => !c.ok).length, rows: rows.sort((a, b) => b.calls - a.calls) };
}

export interface Overview {
  users: number;
  active24h: number;
  firstScanPending: number;
  paused: number;
  installed7d: number;
  incoming: number;
  outgoing: number;
  digests24h: number;
  polls24h: number;
  pollErrors24h: number;
  feedback: number;
  lastTick: { slot: number; source: string; at: number } | null;
}

export async function overview(rows: UserRow[], runs: { data: Run }[]): Promise<Overview> {
  const now = Date.now();
  const recent = runs.filter((r) => now - r.data.at.getTime() < 24 * HOUR);
  return {
    users: rows.length,
    active24h: rows.filter((r) => r.lastPolledAt && now - r.lastPolledAt < 24 * HOUR).length,
    firstScanPending: rows.filter((r) => r.firstScanPending).length,
    paused: rows.filter((r) => r.paused).length,
    installed7d: rows.filter((r) => now - r.installedAt < 7 * 24 * HOUR).length,
    incoming: rows.reduce((n, r) => n + r.incoming, 0),
    outgoing: rows.reduce((n, r) => n + r.outgoing, 0),
    digests24h: recent.filter((r) => r.data.kind === "deliver" && Number(r.data.summary.sent ?? 0) > 0).length,
    polls24h: recent.filter((r) => r.data.kind === "poll").length,
    pollErrors24h: recent.filter((r) => r.data.kind === "poll" && Number(r.data.summary.errors ?? 0) > 0).length,
    feedback: await backend.count("feedback"),
    lastTick: (await lastTick()) ?? null,
  };
}

export { recentRuns };

export async function recentFeedback(limit = 100) {
  return backend.query<Feedback>("feedback", { orderBy: ["at", "desc"], limit });
}

// ---------------------------------------------------------------------------
// Cloud Logging

export interface LogLine {
  at: string;
  severity: string;
  service: string;
  text: string;
}

export async function recentLogs({
  hours = 6,
  severity = "DEFAULT",
  search = "",
  limit = 200,
}: { hours?: number; severity?: string; search?: string; limit?: number }): Promise<LogLine[]> {
  const since = new Date(Date.now() - hours * HOUR).toISOString();
  const parts = [
    'resource.type="cloud_run_revision"',
    'resource.labels.service_name=("nudge" OR "nudge-admin")',
    `timestamp>="${since}"`,
    `severity>=${severity}`,
    // Request logs repeat what the app logs; keep the app's own lines
    'logName:"run.googleapis.com%2Fstdout" OR logName:"run.googleapis.com%2Fstderr"',
  ];
  if (search.trim()) parts.push(`"${search.replace(/["\\]/g, "")}"`);
  const res = await gcpFetch<{
    entries?: { timestamp: string; severity?: string; textPayload?: string; jsonPayload?: unknown; resource?: { labels?: { service_name?: string } } }[];
  }>("https://logging.googleapis.com/v2/entries:list", {
    body: { resourceNames: [`projects/${PROJECT_ID}`], filter: parts.join(" AND "), orderBy: "timestamp desc", pageSize: limit },
  });
  return (res.entries ?? []).map((e) => ({
    at: e.timestamp,
    severity: e.severity ?? "DEFAULT",
    service: e.resource?.labels?.service_name ?? "",
    text: e.textPayload ?? JSON.stringify(e.jsonPayload ?? ""),
  }));
}
