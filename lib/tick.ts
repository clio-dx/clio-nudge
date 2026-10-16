import { getAllUsers, getUser, updateUser, type NudgeUser } from "@/lib/db";
import { pollUser, type PollStats } from "@/lib/poll";
import { acquireOwnedLock, hasMarker, lastTick, recordTick, releaseLock, setMarker } from "@/lib/store";
import { currentSlot, findDueSlot, nextSlotTime, resolveSchedule, resolveTimezone } from "@/lib/schedule";
import { buildDigestBlocks, digestFallbackText, loadVisible, visibleIds } from "@/lib/digest";
import { createBoundedClient, getTeamUrl } from "@/lib/slack";
import { firstReportOverdue } from "@/lib/first-report";
import { enqueue } from "@/lib/tasks";
import { recordRun } from "@/lib/runs";

const DELIVER_POLL_MS = 120_000;
const BACKGROUND_POLL_MS = 300_000;
const STALE_AFTER_MS = 2 * 60 * 60 * 1000; // users not due get re-polled when data is older than this
// Digests send from stored data when a poll this recent exists: the pre-poll, queued 20 minutes
// before the hour for anyone whose data is older than 15 minutes
const FRESH_ENOUGH_MS = 30 * 60 * 1000;
const PREPOLL_WITHIN_MS = 20 * 60 * 1000;
const PREPOLL_IF_OLDER_MS = 15 * 60 * 1000;
// Cloud Scheduler ticks every 5 minutes: healthy when one landed recently
const TICK_HEALTHY_WITHIN_MS = 20 * 60 * 1000;
// A deliver that failed can be queued again by a tick in the next 10-minute window (the task
// name stays taken for about an hour after it ran)
const DELIVER_RETRY_WINDOW_MS = 10 * 60 * 1000;

export async function hourlyTriggerActive(nowMs = Date.now()): Promise<boolean> {
  const last = await lastTick();
  return !!last && nowMs - last.at < TICK_HEALTHY_WITHIN_MS;
}

export async function teamUrlFor(user: NudgeUser): Promise<string> {
  if (user.teamUrl) return user.teamUrl;
  const url = await getTeamUrl(createBoundedClient(user.userToken));
  if (url !== "https://slack.com") await updateUser(user.slackUserId, { teamUrl: url });
  return url;
}

// Resolves with the promise's value, or `undefined` once `untilMs` passes (the promise keeps running)
export async function settleBy<T>(promise: Promise<T>, untilMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, untilMs - Date.now()));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Posts to the user's Nudge DM and remembers that channel so polls never track it
export async function postDM(user: NudgeUser, blocks: unknown[], text: string): Promise<void> {
  const res = await createBoundedClient(user.botToken).chat.postMessage({
    channel: user.slackUserId,
    text,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blocks: blocks as any,
  });
  if (res.channel && res.channel !== user.botDmChannel) {
    await updateUser(user.slackUserId, { botDmChannel: res.channel });
  }
}

interface UserResult {
  userId: string;
  slot?: number;
  sent?: number;
  skipped?: string;
  poll?: Omit<PollStats, "errors"> & { errorCount: number };
  pollTimedOut?: boolean;
  error?: string;
}

// Poll, but stop waiting at `untilMs` so the digest goes out on time. `pending` is the poll
// itself: the job awaits it before returning, because Cloud Run gives no CPU to work left
// running after a request answered.
async function pollWithin(
  user: NudgeUser,
  untilMs: number
): Promise<Pick<UserResult, "poll" | "pollTimedOut"> & { pending: Promise<unknown> }> {
  const poll = pollUser(user, untilMs - 10_000).catch((err) => {
    console.error(`poll failed for ${user.slackUserId}:`, String(err).slice(0, 300));
    return undefined;
  });
  const stats = await settleBy(poll, untilMs);
  if (!stats) return { pollTimedOut: true, pending: poll };
  const { errors, ...rest } = stats;
  if (errors.length > 0) console.error(`poll errors for ${user.slackUserId}:`, errors.slice(0, 10));
  return { poll: { ...rest, errorCount: errors.length }, pending: poll };
}

function dueSlotFor(user: NudgeUser, nowMs: number) {
  const { schedule, paused } = resolveSchedule(user);
  return {
    schedule,
    paused,
    due: findDueSlot(schedule, paused, resolveTimezone(user), nowMs, user.lastSlot, user.lastSentDate),
  };
}

type Due = NonNullable<ReturnType<typeof findDueSlot>>;
type Delivered = UserResult & { pending?: Promise<unknown> };

// `pending`: a poll that outlasted the digest — the caller awaits it
export async function deliver(user: NudgeUser, nowMs: number, deadline: number): Promise<Delivered> {
  const { schedule, due } = dueSlotFor(user, nowMs);
  if (!due) return { userId: user.slackUserId, skipped: "not due" };

  // Two ticks (or a retried task) for the same slot — first one wins.
  // Short TTL so a crashed run doesn't block the retry.
  const lockKey = `nudge:lock:digest:${user.slackUserId}:${due.slot}`;
  const lockOwner = await acquireOwnedLock(lockKey, 600);
  if (!lockOwner) {
    return { userId: user.slackUserId, slot: due.slot, skipped: "handled by another tick" };
  }
  try {
    return await sendDue(user, schedule, due, deadline);
  } catch (err) {
    // Not sent: free the slot so the next tick's task can try again
    await releaseLock(lockKey, lockOwner).catch(() => {});
    throw err;
  }
}

async function sendDue(user: NudgeUser, schedule: ReturnType<typeof resolveSchedule>["schedule"], due: Due, deadline: number): Promise<Delivered> {
  // A good poll shortly before (the pre-poll): send from that. Otherwise fresh data first — but
  // the digest goes out on time even if the poll is stuck (rate limits, slow AI).
  const recentlyPolled = Date.now() - (user.lastGoodPollAt ?? 0) < FRESH_ENOUGH_MS;
  const pollUntil = Math.min(deadline - 30_000, Date.now() + DELIVER_POLL_MS);
  const polled = !recentlyPolled && Date.now() < pollUntil ? await pollWithin(user, pollUntil) : undefined;
  const result: Delivered = {
    userId: user.slackUserId,
    slot: due.slot,
    ...(polled ? { poll: polled.poll, pollTimedOut: polled.pollTimedOut, pending: polled.pending } : {}),
  };

  const fresh = (await getUser(user.slackUserId)) ?? user;
  // Already delivered (also guards against lastSlot being rolled back by a concurrent write)
  const sentKey = `nudge:sent:${user.slackUserId}:${due.slot}`;
  if ((fresh.lastSlot !== undefined && fresh.lastSlot >= due.slot) || (await hasMarker(sentKey))) {
    return { ...result, skipped: "already handled" };
  }

  const visible = await loadVisible(fresh, Date.now());
  const ids = visibleIds(visible);
  const previous = new Set(fresh.lastDigestIds ?? []);
  const hasNew = ids.some((id) => !previous.has(id));

  // Fixed times: always send when something is pending.
  // Hourly/interval: full list on the day's first delivery, then only when something new shows up.
  const send = ids.length > 0 && (schedule.kind === "times" || due.isFirstOfDay || hasNew);

  if (send) {
    const teamUrl = await teamUrlFor(fresh);
    await postDM(fresh, buildDigestBlocks(visible, teamUrl, { maxPerSection: 10 }), digestFallbackText(visible));
    await setMarker(sentKey, 4 * 60 * 60);
    result.sent = ids.length;
  } else {
    result.skipped = ids.length === 0 ? "nothing pending" : "no new items since last digest";
  }

  await updateUser(user.slackUserId, {
    lastSlot: Math.max(fresh.lastSlot ?? -Infinity, due.slot),
    ...(send ? { lastDigestIds: ids, lastSentDate: due.dateKey } : {}),
  });
  return result;
}

export async function deliverJob(userId: string): Promise<UserResult | null> {
  const user = await getUser(userId);
  if (!user) return null;
  const now = Date.now();
  let result: Delivered;
  try {
    result = await deliver(user, now, now + 10 * 60_000);
  } catch (err) {
    await recordRun("deliver", { userId, ok: false, error: String(err).slice(0, 300) }, userId, Date.now() - now);
    throw err;
  }
  const { pending, ...summary } = result;
  await recordRun("deliver", { ...summary }, userId, Date.now() - now);
  await pending; // the poll that outlasted the digest finishes inside this task
  return summary;
}

// Background poll: fresh data ahead of a digest, or when it got old. Awaited in full — the
// poll's own deadline bounds it.
export async function pollJob(userId: string): Promise<UserResult | null> {
  const user = await getUser(userId);
  if (!user) return null;
  const { errors, ...rest } = await pollUser(user, Date.now() + BACKGROUND_POLL_MS);
  return { userId, poll: { ...rest, errorCount: errors.length } };
}

// Every 5 minutes (Cloud Scheduler): decide what needs doing and queue it. Task names keep each
// piece of work to once per user and slot, however many ticks see it.
export async function runTick(source: string, nowMs = Date.now()) {
  const slot = currentSlot(nowMs);
  await recordTick(slot, source);

  const users = await getAllUsers();
  const queued = { deliver: 0, prepoll: 0, stale: 0, firstReport: 0 };
  const errors: string[] = [];
  const queue = async (what: keyof typeof queued, run: () => Promise<boolean>) => {
    try {
      if (await run()) queued[what]++;
    } catch (err) {
      errors.push(`${what}: ${String(err).slice(0, 200)}`);
    }
  };

  for (const user of users) {
    const userId = user.slackUserId;
    if (user.revokedAt) continue; // Slack rejected their token; connecting again clears this
    const { schedule, paused, due } = dueSlotFor(user, nowMs);
    const age = nowMs - (user.lastPolledAt ?? 0);

    if (due) {
      const retryWindow = Math.floor(nowMs / DELIVER_RETRY_WINDOW_MS);
      await queue("deliver", () => enqueue({ type: "deliver", userId }, { name: `deliver-${userId}-${due.slot}-${retryWindow}` }));
      continue;
    }
    if (firstReportOverdue(user, nowMs)) {
      await queue("firstReport", () => enqueue({ type: "first-report", userId }, { name: `first-report-${userId}-${slot}` }));
      continue;
    }
    if (paused) continue;
    // Fresh data for the next digest, so it can go out right on the hour
    const next = nextSlotTime(schedule, resolveTimezone(user), nowMs);
    if (next !== null && next - nowMs <= PREPOLL_WITHIN_MS && age > PREPOLL_IF_OLDER_MS) {
      await queue("prepoll", () => enqueue({ type: "poll", userId }, { name: `prepoll-${userId}-${currentSlot(next)}` }));
      continue;
    }
    // Keeps 목록 and the 홈 tab current between digests
    if (age > STALE_AFTER_MS) {
      await queue("stale", () => enqueue({ type: "poll", userId }, { name: `poll-${userId}-${slot}` }));
    }
  }

  const summary = {
    ok: errors.length === 0,
    source,
    ranAt: new Date(nowMs).toISOString(),
    slot,
    usersTotal: users.length,
    queued,
    errors,
  };
  console.log("tick", JSON.stringify(summary));
  await recordRun("tick", summary);
  return summary;
}
