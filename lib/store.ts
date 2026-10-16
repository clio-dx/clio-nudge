// Tracked questions, the seen-list, locks and bookkeeping (Firestore; see lib/store/backend.ts).
//
//   users/{u}/followups/{kind}~{channel}~{threadTs}   tracked questions
//   seen/{u}            { ids: { [itemId]: message ms } } — one read per poll
//   locks/{key}         { expiresAt } — TTL policy cleans them up
//   markers/{key}       { expiresAt } — "already done" notes that expire
//   flags/{key}         one-time things (greetings)
//   meta/ticks          recent tick slots
import { backend } from "@/lib/store/backend";

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
  promiserId?: string;         // outgoing opened by someone's promise to me ("검토 의견 드리겠습니다"): who owes it
  about?: string;              // promise items: my message they promised a reply to (for the topic)
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

// Document ids can't hold "/"
const safe = (key: string) => key.replace(/\//g, "_");

const followupsOf = (userId: string) => `users/${safe(userId)}/followups`;
const followupPath = (kind: FollowUpKind, userId: string, channel: string, threadTs: string) =>
  `${followupsOf(userId)}/${kind}~${safe(channel)}~${safe(threadTs)}`;

// Identifier shared by the seen-list, digest diffing and dismiss buttons
export function itemId(kind: FollowUpKind, channel: string, threadTs: string): string {
  return `${kind}:${channel}:${threadTs}`;
}

export async function addFollowUp(followUp: FollowUp): Promise<void> {
  const kind = kindOf(followUp);
  await backend.set(followupPath(kind, followUp.userId, followUp.channel, followUp.threadTs), { ...followUp, kind });
}

export async function getFollowUp(
  kind: FollowUpKind,
  userId: string,
  channel: string,
  threadTs: string
): Promise<FollowUp | null> {
  return backend.get<FollowUp>(followupPath(kind, userId, channel, threadTs));
}

export async function updateFollowUp(
  kind: FollowUpKind,
  userId: string,
  channel: string,
  threadTs: string,
  updates: Partial<FollowUp>
): Promise<void> {
  const path = followupPath(kind, userId, channel, threadTs);
  await backend.transaction(async (tx) => {
    const existing = await tx.get<FollowUp>(path);
    if (existing) tx.set(path, { ...existing, ...updates });
  });
}

export async function removeFollowUp(
  kind: FollowUpKind,
  userId: string,
  channel: string,
  threadTs: string
): Promise<void> {
  await backend.delete(followupPath(kind, userId, channel, threadTs));
}

// Oldest first
export async function getUserFollowUps(userId: string, kind: FollowUpKind): Promise<FollowUp[]> {
  // Equality filter only (no composite index); sorted here
  const rows = await backend.query<FollowUp>(followupsOf(userId), { where: [["kind", "==", kind]] });
  return rows.map((r) => ({ ...r.data, kind })).sort((a, b) => a.createdAt - b.createdAt);
}

export async function isTracked(
  kind: FollowUpKind,
  userId: string,
  channel: string,
  threadTs: string
): Promise<boolean> {
  return (await getFollowUp(kind, userId, channel, threadTs)) !== null;
}

// ---------------------------------------------------------------------------
// Seen list: messages already judged answered, not directed at the user, or
// dismissed — so polls don't re-classify (or resurrect) them.

const SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const seenPath = (userId: string) => `seen/${safe(userId)}`;

export async function markSeen(userId: string, id: string, messageMs: number): Promise<void> {
  await backend.mapMerge(seenPath(userId), "ids", { [id]: messageMs });
}

export async function getSeen(userId: string): Promise<Set<string>> {
  const doc = await backend.get<{ ids?: Record<string, number> }>(seenPath(userId));
  const ids = doc?.ids ?? {};
  const cutoff = Date.now() - SEEN_RETENTION_MS;
  const old = Object.keys(ids).filter((id) => ids[id] < cutoff);
  if (old.length > 0) await backend.mapDelete(seenPath(userId), "ids", old);
  return new Set(Object.keys(ids).filter((id) => ids[id] >= cutoff));
}

// Every seen id with its message time (migration, admin)
export async function getSeenEntries(userId: string): Promise<Record<string, number>> {
  return (await backend.get<{ ids?: Record<string, number> }>(seenPath(userId)))?.ids ?? {};
}

// ---------------------------------------------------------------------------
// Locks, markers, flags

const expiresAtMs = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === "number" ? v : 0);

// True only the first time it's called for `key` (one-off greetings)
export async function firstTime(key: string): Promise<boolean> {
  return backend.create(`flags/${safe(key)}`, { at: new Date() });
}

// The lock's owner id, or null when someone else holds it
export async function acquireOwnedLock(key: string, ttlSeconds: number): Promise<string | null> {
  const path = `locks/${safe(key)}`;
  const owner = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return backend.transaction(async (tx) => {
    const held = await tx.get<{ expiresAt?: unknown }>(path);
    if (held && expiresAtMs(held.expiresAt) > Date.now()) return null;
    tx.set(path, { owner, at: new Date(), expiresAt: new Date(Date.now() + ttlSeconds * 1000) });
    return owner;
  });
}

export async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  return (await acquireOwnedLock(key, ttlSeconds)) !== null;
}

// With `owner`, only that holder's lock is released — a late finisher can't free a newer lock
export async function releaseLock(key: string, owner?: string): Promise<void> {
  const path = `locks/${safe(key)}`;
  if (!owner) return backend.delete(path);
  await backend.transaction(async (tx) => {
    const held = await tx.get<{ owner?: string }>(path);
    if (held?.owner === owner) tx.delete(path);
  });
}

export async function setMarker(key: string, ttlSeconds: number): Promise<void> {
  await backend.set(`markers/${safe(key)}`, { at: new Date(), expiresAt: new Date(Date.now() + ttlSeconds * 1000) });
}

export async function hasMarker(key: string): Promise<boolean> {
  const m = await backend.get<{ expiresAt?: unknown }>(`markers/${safe(key)}`);
  return !!m && expiresAtMs(m.expiresAt) > Date.now();
}

// ---------------------------------------------------------------------------
// Tick bookkeeping — lets /nudge tell whether the scheduler is running.

const TICKS = "meta/ticks";

interface TickDoc {
  slots?: Record<string, string>;
  last?: { slot: number; source: string; at: number };
}

export async function recordTick(slot: number, source: string): Promise<void> {
  await backend.transaction(async (tx) => {
    const doc = (await tx.get<TickDoc>(TICKS)) ?? {};
    const slots = Object.fromEntries(Object.entries({ ...doc.slots, [slot]: source }).filter(([s]) => Number(s) > slot - 48));
    tx.set(TICKS, { slots, last: { slot, source, at: Date.now() } });
  });
}

// Distinct hours in the last `hours` hours that saw at least one tick
export async function recentTickHours(currentSlot: number, hours: number): Promise<number> {
  const slots = Object.keys((await backend.get<TickDoc>(TICKS))?.slots ?? {}).map(Number);
  return slots.filter((s) => s > currentSlot - hours && s <= currentSlot).length;
}

export async function lastTick(): Promise<TickDoc["last"] | null> {
  return (await backend.get<TickDoc>(TICKS))?.last ?? null;
}

// ---------------------------------------------------------------------------

export async function clearUserFollowUps(userId: string): Promise<number> {
  const rows = await backend.query(followupsOf(userId));
  await Promise.all(rows.map((r) => backend.delete(`${followupsOf(userId)}/${r.id}`)));
  await backend.delete(seenPath(userId));
  return rows.length;
}
