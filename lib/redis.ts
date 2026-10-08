import { Redis } from "@upstash/redis";

// Reads UPSTASH_REDIS_REST_URL/TOKEN, falling back to KV_REST_API_URL/TOKEN
// (the names injected by the Vercel Marketplace Upstash integration).
export const redis = Redis.fromEnv();

// outgoing = I asked, waiting for an answer
// incoming = someone asked me, waiting for my reply
export type FollowUpKind = "outgoing" | "incoming";
export type ConvType = "im" | "mpim" | "channel";

export interface FollowUp {
  kind?: FollowUpKind;         // missing on records created before incoming tracking existed → outgoing
  userId: string;              // Nudge user this item belongs to
  channel: string;
  threadTs: string;            // The message timestamp (unique identifier)
  parentThreadTs?: string;     // Parent thread ts (if message is inside a thread)
  originalMessage: string;
  convType?: ConvType;
  askerId?: string;            // incoming: who asked
  checkedTs?: string;          // latest reply ts already judged "not an answer"
  judgeVersion?: number;       // answer rules checkedTs was computed with (poll.ts JUDGE_VERSION)
  promised?: boolean;          // whoever owes the answer said they'd get back ("확인 후 회신드릴게요")
  summary?: string;
  summaryVersion?: number;
  createdAt: number;
  lastRemindedAt: number | null;
  lastActivityAt: number;
}

export function kindOf(f: Pick<FollowUp, "kind">): FollowUpKind {
  return f.kind ?? "outgoing";
}

// Outgoing keys keep their original names so existing data stays valid
function setKey(kind: FollowUpKind, userId: string): string {
  return kind === "incoming" ? `incomings:${userId}` : `followups:${userId}`;
}

function itemKey(kind: FollowUpKind, userId: string, channel: string, threadTs: string): string {
  return kind === "incoming"
    ? `incoming:${userId}:${channel}:${threadTs}`
    : `followup:${userId}:${channel}:${threadTs}`;
}

// Identifier shared by the seen-list, digest diffing and dismiss buttons
export function itemId(kind: FollowUpKind, channel: string, threadTs: string): string {
  return `${kind}:${channel}:${threadTs}`;
}

export async function addFollowUp(followUp: FollowUp): Promise<void> {
  const kind = kindOf(followUp);
  const key = itemKey(kind, followUp.userId, followUp.channel, followUp.threadTs);
  await redis.set(key, { ...followUp, kind });
  await redis.zadd(setKey(kind, followUp.userId), { score: followUp.createdAt, member: key });
}

export async function getFollowUp(
  kind: FollowUpKind,
  userId: string,
  channel: string,
  threadTs: string
): Promise<FollowUp | null> {
  return redis.get<FollowUp>(itemKey(kind, userId, channel, threadTs));
}

export async function updateFollowUp(
  kind: FollowUpKind,
  userId: string,
  channel: string,
  threadTs: string,
  updates: Partial<FollowUp>
): Promise<void> {
  const existing = await getFollowUp(kind, userId, channel, threadTs);
  if (!existing) return;
  await redis.set(itemKey(kind, userId, channel, threadTs), { ...existing, ...updates });
}

export async function removeFollowUp(
  kind: FollowUpKind,
  userId: string,
  channel: string,
  threadTs: string
): Promise<void> {
  const key = itemKey(kind, userId, channel, threadTs);
  await redis.del(key);
  await redis.zrem(setKey(kind, userId), key);
}

export async function getUserFollowUps(userId: string, kind: FollowUpKind): Promise<FollowUp[]> {
  const sKey = setKey(kind, userId);
  const keys = await redis.zrange<string[]>(sKey, 0, -1);
  if (keys.length === 0) return [];

  const values = await redis.mget<(FollowUp | null)[]>(...keys);
  // Drop index entries whose item vanished
  const dangling = keys.filter((_, i) => !values[i]);
  if (dangling.length > 0) await redis.zrem(sKey, ...dangling);

  return values
    .filter((f): f is FollowUp => f !== null)
    .map((f) => ({ ...f, kind: kindOf(f) }));
}

export async function isTracked(
  kind: FollowUpKind,
  userId: string,
  channel: string,
  threadTs: string
): Promise<boolean> {
  return (await redis.exists(itemKey(kind, userId, channel, threadTs))) === 1;
}

// ---------------------------------------------------------------------------
// Seen list: messages already judged answered, not directed at the user, or
// dismissed — so polls don't re-classify (or resurrect) them.

const SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function seenKey(userId: string): string {
  return `seen:${userId}`;
}

export async function markSeen(userId: string, id: string, messageMs: number): Promise<void> {
  await redis.zadd(seenKey(userId), { score: messageMs, member: id });
}

export async function getSeen(userId: string): Promise<Set<string>> {
  await redis.zremrangebyscore(seenKey(userId), 0, Date.now() - SEEN_RETENTION_MS);
  const ids = await redis.zrange<string[]>(seenKey(userId), 0, -1);
  return new Set(ids);
}

// ---------------------------------------------------------------------------
// Locks

// True only the first time it's called for `key` (one-off greetings)
export async function firstTime(key: string): Promise<boolean> {
  return (await redis.set(key, Date.now(), { nx: true })) === "OK";
}

export async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  const result = await redis.set(key, Date.now(), { nx: true, ex: ttlSeconds });
  return result === "OK";
}

export async function releaseLock(key: string): Promise<void> {
  await redis.del(key);
}

// ---------------------------------------------------------------------------
// Tick bookkeeping — lets /nudge tell whether the hourly trigger is running.

const TICKS_KEY = "nudge:ticks";

export async function recordTick(slot: number, source: string): Promise<void> {
  await redis.zadd(TICKS_KEY, { score: slot, member: `${slot}` });
  await redis.zremrangebyscore(TICKS_KEY, 0, slot - 48);
  await redis.set("nudge:lastTick", { slot, source, at: Date.now() });
}

// Distinct hours in the last `hours` hours that saw at least one tick
export async function recentTickHours(currentSlot: number, hours: number): Promise<number> {
  return redis.zcount(TICKS_KEY, currentSlot - hours + 1, currentSlot);
}

// ---------------------------------------------------------------------------

export async function clearUserFollowUps(userId: string): Promise<number> {
  let deleted = 0;
  for (const kind of ["outgoing", "incoming"] as const) {
    const sKey = setKey(kind, userId);
    const keys = await redis.zrange<string[]>(sKey, 0, -1);
    if (keys.length > 0) await redis.del(...keys);
    deleted += keys.length;
    await redis.del(sKey);
  }
  await redis.del(seenKey(userId));
  return deleted;
}
