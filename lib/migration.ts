// Moving Nudge to GCP (docs/gcp-migration.md): the GCP side pulls everything from here once,
// then freezes this deployment so both never send digests to the same people.
import { redis, getUserFollowUps, type FollowUp } from "@/lib/redis";
import { getAllUsers, type NudgeUser } from "@/lib/db";

export const GCP_URL = "https://nudge-233887047351.asia-northeast3.run.app";
// Only the GCP runtime service account may pull the data
export const GCP_RUNTIME_SA = "nudge-runtime@clio-nudge.iam.gserviceaccount.com";

const FROZEN_KEY = "nudge:migrated"; // set → ticks stop here and new connections go to GCP
const LOCKED_KEY = "nudge:export-locked"; // set → the export can't be read again

export async function isFrozen(): Promise<boolean> {
  return (await redis.exists(FROZEN_KEY)) === 1;
}

export async function isExportLocked(): Promise<boolean> {
  return (await redis.exists(LOCKED_KEY)) === 1;
}

export async function setMigrationState(action: "freeze" | "unfreeze" | "lock"): Promise<void> {
  if (action === "freeze") await redis.set(FROZEN_KEY, { at: Date.now(), to: GCP_URL });
  else if (action === "unfreeze") await redis.del(FROZEN_KEY, LOCKED_KEY);
  else await redis.set(LOCKED_KEY, Date.now());
}

export interface MigrationExport {
  version: 1;
  exportedAt: number;
  users: NudgeUser[];
  followups: FollowUp[];
  seen: Record<string, Record<string, number>>; // userId → itemId → message time
  flags: string[]; // one-time keys (e.g. nudge:onboarded:U…)
  slack: { clientId?: string; clientSecret?: string; signingSecret?: string };
}

// Upstash returns [member, score, member, score, …] for withScores
function pairs(flat: (string | number)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = Number(flat[i + 1]);
  return out;
}

export async function buildExport(): Promise<MigrationExport> {
  const users = await getAllUsers();
  const followups: FollowUp[] = [];
  const seen: MigrationExport["seen"] = {};
  for (const u of users) {
    for (const kind of ["incoming", "outgoing"] as const) followups.push(...(await getUserFollowUps(u.slackUserId, kind)));
    seen[u.slackUserId] = pairs(await redis.zrange<(string | number)[]>(`seen:${u.slackUserId}`, 0, -1, { withScores: true }));
  }
  const flags = await redis.keys("nudge:onboarded:*");
  return {
    version: 1,
    exportedAt: Date.now(),
    users,
    followups,
    seen,
    flags,
    slack: {
      clientId: process.env.SLACK_CLIENT_ID,
      clientSecret: process.env.SLACK_CLIENT_SECRET,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
    },
  };
}
