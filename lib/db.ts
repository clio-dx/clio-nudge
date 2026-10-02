import { redis } from "./redis";
import type { Schedule } from "./schedule";

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
  // Where each search left off: oldest-first results, so earlier pages never shift
  searchCursors?: Partial<Record<"outgoing" | "mentions" | "with", { after: string; page: number }>>;

  // Legacy schedule fields (pre-v2); read by resolveSchedule()
  reminderHours?: number[];      // UTC hours
  reminderInterval?: number;
  timezone?: string;             // "KST" | "PT"
}

const USERS_KEY = "nudge:users";
const USER_PREFIX = "nudge:user:";

// Preferences survive a reinstall: only credentials are replaced.
export async function saveUser(user: NudgeUser): Promise<NudgeUser> {
  const key = `${USER_PREFIX}${user.slackUserId}`;
  const existing = await redis.get<NudgeUser>(key);
  const merged = existing ? { ...existing, ...user } : user;
  await redis.set(key, merged);
  await redis.sadd(USERS_KEY, user.slackUserId);
  return merged;
}

export async function getUser(slackUserId: string): Promise<NudgeUser | null> {
  const key = `${USER_PREFIX}${slackUserId}`;
  return redis.get<NudgeUser>(key);
}

export async function getAllUsers(): Promise<NudgeUser[]> {
  const userIds = await redis.smembers(USERS_KEY);
  if (userIds.length === 0) return [];

  const users = await redis.mget<(NudgeUser | null)[]>(...userIds.map((id) => `${USER_PREFIX}${id}`));
  return users.filter((u): u is NudgeUser => u !== null);
}

export async function removeUser(slackUserId: string): Promise<void> {
  const key = `${USER_PREFIX}${slackUserId}`;
  await redis.del(key);
  await redis.srem(USERS_KEY, slackUserId);
}

export async function updateUser(
  slackUserId: string,
  updates: Partial<NudgeUser>
): Promise<NudgeUser | null> {
  const existing = await getUser(slackUserId);
  if (!existing) return null;

  const key = `${USER_PREFIX}${slackUserId}`;
  const merged = { ...existing, ...updates };
  await redis.set(key, merged);
  return merged;
}
