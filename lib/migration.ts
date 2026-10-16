// One-off move from the Vercel deployment (Upstash) to GCP (docs/gcp-migration.md). Runs as the
// nudge-runtime service account: the frozen Vercel side only answers that identity.
import { idTokenFor, putSecret } from "@/lib/gcp";
import { addFollowUp, firstTime, getUserFollowUps, kindOf, markSeen, removeFollowUp, type FollowUp } from "@/lib/store";
import { backend, clean } from "@/lib/store/backend";
import type { NudgeUser } from "@/lib/db";

export const VERCEL_URL = "https://clio-nudge.vercel.app";
const EXPORT_URL = `${VERCEL_URL}/api/admin/export`;

export interface MigrationExport {
  version: 1;
  exportedAt: number;
  users: NudgeUser[];
  followups: FollowUp[];
  seen: Record<string, Record<string, number>>;
  flags: string[];
  slack: { clientId?: string; clientSecret?: string; signingSecret?: string };
}

export interface ImportResult {
  exportedAt: number;
  users: number;
  followups: number;
  removedFollowups: number;
  seen: number;
  flags: number;
  secretsUpdated: string[];
  frozen?: boolean;
}

async function callExport(init?: { method: "POST"; body: unknown }): Promise<Response> {
  const token = await idTokenFor(EXPORT_URL);
  return fetch(EXPORT_URL, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: init ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
}

export async function fetchExport(): Promise<MigrationExport> {
  const res = await callExport();
  if (!res.ok) throw new Error(`export ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as MigrationExport;
}

export async function setVercelState(action: "freeze" | "unfreeze" | "lock"): Promise<unknown> {
  const res = await callExport({ method: "POST", body: { action } });
  if (!res.ok) throw new Error(`${action} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Writes the export as GCP's data. Safe to run again before the cutover: Vercel stays the source
// of truth until it is frozen (questions resolved there since the last run are removed here).
export async function applyExport(data: MigrationExport): Promise<Omit<ImportResult, "secretsUpdated" | "frozen">> {
  for (const u of data.users) await backend.set(`users/${u.slackUserId}`, clean(u));

  let removed = 0;
  const keep = new Set(data.followups.map((f) => `${kindOf(f)}:${f.userId}:${f.channel}:${f.threadTs}`));
  for (const u of data.users) {
    for (const kind of ["incoming", "outgoing"] as const) {
      for (const f of await getUserFollowUps(u.slackUserId, kind)) {
        if (!keep.has(`${kind}:${f.userId}:${f.channel}:${f.threadTs}`)) {
          await removeFollowUp(kind, f.userId, f.channel, f.threadTs);
          removed++;
        }
      }
    }
  }
  for (const f of data.followups) await addFollowUp({ ...f, kind: kindOf(f) });

  let seen = 0;
  for (const [userId, ids] of Object.entries(data.seen)) {
    for (const [id, ms] of Object.entries(ids)) {
      await markSeen(userId, id, ms);
      seen++;
    }
  }
  for (const key of data.flags) await firstTime(key);

  return {
    exportedAt: data.exportedAt,
    users: data.users.length,
    followups: data.followups.length,
    removedFollowups: removed,
    seen,
    flags: data.flags.length,
  };
}

export async function importFromVercel({ freeze = false }: { freeze?: boolean } = {}): Promise<ImportResult> {
  const data = await fetchExport();
  const counts = await applyExport(data);

  const secretsUpdated: string[] = [];
  const secrets: [string, string | undefined][] = [
    ["slack-client-id", data.slack.clientId],
    ["slack-client-secret", data.slack.clientSecret],
    ["slack-signing-secret", data.slack.signingSecret],
  ];
  for (const [name, value] of secrets) if (value && (await putSecret(name, value))) secretsUpdated.push(name);

  const result: ImportResult = { ...counts, secretsUpdated };
  if (freeze) {
    await setVercelState("freeze");
    result.frozen = true;
  }
  return result;
}
