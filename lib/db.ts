import { backend, clean } from "@/lib/store/backend";
import type { Schedule } from "@/lib/schedule";

export interface NudgeUser {
  slackUserId: string;
  slackTeamId: string;
  botToken: string;
  userToken: string;
  installedAt: number;
  teamUrl?: string;
  botDmChannel?: string;         // the user's DM with Nudge (never tracked)

  // Preferences
  schedule?: Schedule;
  paused?: boolean;
  tz?: string;                   // IANA timezone, e.g. "Asia/Seoul"
  trackIncoming?: boolean;       // default on
  trackOutgoing?: boolean;       // default on

  // Delivery state
  lastSlot?: number;             // epoch hour of the last schedule slot handled
  lastSentDate?: string;         // local YYYY-MM-DD of the last digest actually posted
  lastDigestIds?: string[];      // items in the last digest (to detect new ones)
  lastPolledAt?: number;
  lastGoodPollAt?: number;       // last poll whose searches all went through (digests trust this one)
  firstScanPending?: boolean;    // set on install; cleared once a poll got through the 7-day backlog
  firstReportAt?: number;        // when the DM with the first check's result went out
  // Where each search left off: oldest-first results, so earlier pages never shift
  searchCursors?: Partial<Record<"outgoing" | "mentions" | "with", { after: string; page: number }>>;

  // Legacy schedule fields (pre-v2); read by resolveSchedule()
  reminderHours?: number[];      // UTC hours
  reminderInterval?: number;
  timezone?: string;             // "KST" | "PT"
}

// users/{slackUserId}
const userPath = (slackUserId: string) => `users/${slackUserId.replace(/\//g, "_")}`;

// Preferences survive a reinstall: only credentials are replaced.
export async function saveUser(user: NudgeUser): Promise<NudgeUser> {
  const path = userPath(user.slackUserId);
  return backend.transaction(async (tx) => {
    const existing = await tx.get<NudgeUser>(path);
    const merged = clean(existing ? { ...existing, ...user } : user);
    tx.set(path, merged);
    return merged;
  });
}

export async function getUser(slackUserId: string): Promise<NudgeUser | null> {
  return backend.get<NudgeUser>(userPath(slackUserId));
}

export async function getAllUsers(): Promise<NudgeUser[]> {
  return (await backend.query<NudgeUser>("users")).map((r) => r.data).filter((u) => !!u.slackUserId);
}

export async function removeUser(slackUserId: string): Promise<void> {
  await backend.delete(userPath(slackUserId));
}

// A field set to undefined is removed
export async function updateUser(
  slackUserId: string,
  updates: Partial<NudgeUser>
): Promise<NudgeUser | null> {
  const path = userPath(slackUserId);
  return backend.transaction(async (tx) => {
    const existing = await tx.get<NudgeUser>(path);
    if (!existing) return null;
    const merged = clean({ ...existing, ...updates });
    tx.set(path, merged);
    return merged;
  });
}
