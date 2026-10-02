import { getAllUsers, getUser, updateUser, type NudgeUser } from "@/lib/db";
import { pollUser, type PollStats } from "@/lib/poll";
import { acquireLock, recentTickHours, recordTick, redis } from "@/lib/redis";
import { currentSlot, findDueSlot, resolveSchedule, resolveTimezone } from "@/lib/schedule";
import { buildDigestBlocks, digestFallbackText, loadVisible, visibleIds } from "@/lib/digest";
import { createBoundedClient, getTeamUrl } from "@/lib/slack";

const USER_CONCURRENCY = 2;
const MAX_POLL_MS_PER_USER = 90_000;
const BACKGROUND_POLL_MS = 60_000;
const STALE_AFTER_MS = 2 * 60 * 60 * 1000; // users not due get re-polled when data is older than this
// Hourly trigger counts as healthy when ticks landed in most of the recent hours
const HOURLY_PROBE_HOURS = 6;
const HOURLY_MIN_TICKS = 3;

export async function hourlyTriggerActive(nowMs = Date.now()): Promise<boolean> {
  return (await recentTickHours(currentSlot(nowMs), HOURLY_PROBE_HOURS)) >= HOURLY_MIN_TICKS;
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

// Poll, but give up waiting at `untilMs` (the poll keeps running in the background)
async function pollWithin(user: NudgeUser, untilMs: number): Promise<Pick<UserResult, "poll" | "pollTimedOut">> {
  const stats = await settleBy(
    pollUser(user, untilMs - 10_000).catch((err) => {
      console.error(`poll failed for ${user.slackUserId}:`, err);
      return undefined;
    }),
    untilMs
  );
  if (!stats) return { pollTimedOut: true };
  const { errors, ...rest } = stats;
  if (errors.length > 0) console.error(`poll errors for ${user.slackUserId}:`, errors.slice(0, 10));
  return { poll: { ...rest, errorCount: errors.length } };
}

function dueSlotFor(user: NudgeUser, nowMs: number) {
  const { schedule, paused } = resolveSchedule(user);
  return {
    schedule,
    paused,
    due: findDueSlot(schedule, paused, resolveTimezone(user), nowMs, user.lastSlot, user.lastSentDate),
  };
}

async function deliver(user: NudgeUser, nowMs: number, deadline: number): Promise<UserResult> {
  const { schedule, due } = dueSlotFor(user, nowMs);
  if (!due) return { userId: user.slackUserId, skipped: "not due" };

  // Vercel Cron and GitHub Actions can both fire in the same hour — first one wins.
  // Short TTL so a crashed run doesn't block the retry from the next tick.
  if (!(await acquireLock(`nudge:lock:digest:${user.slackUserId}:${due.slot}`, 600))) {
    return { userId: user.slackUserId, slot: due.slot, skipped: "handled by another tick" };
  }

  // Fresh data right before the digest — but the digest goes out on time even if the
  // poll is stuck (rate limits, slow AI).
  const pollUntil = Math.min(deadline - 30_000, Date.now() + MAX_POLL_MS_PER_USER);
  const result: UserResult = {
    userId: user.slackUserId,
    slot: due.slot,
    ...(Date.now() < pollUntil ? await pollWithin(user, pollUntil) : {}),
  };

  const fresh = (await getUser(user.slackUserId)) ?? user;
  // Already delivered by an overlapping tick (also guards against lastSlot being rolled back
  // by a concurrent read-modify-write of the user record)
  const sentKey = `nudge:sent:${user.slackUserId}:${due.slot}`;
  if ((fresh.lastSlot !== undefined && fresh.lastSlot >= due.slot) || (await redis.exists(sentKey)) === 1) {
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
    await redis.set(sentKey, Date.now(), { ex: 4 * 60 * 60 });
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

// Runs `fn` over `items` with a few workers, stopping new work once `stopAt` passes
async function each<T>(items: T[], stopAt: number, fn: (item: T) => Promise<void>): Promise<T[]> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(USER_CONCURRENCY, items.length) }, async () => {
      while (next < items.length && Date.now() < stopAt) await fn(items[next++]);
    })
  );
  return items.slice(next);
}

export async function runTick(source: string, nowMs = Date.now(), deadline = nowMs + 240_000) {
  const slot = currentSlot(nowMs);
  await recordTick(slot, source);

  // Stalest data first, so a deadline cut-off doesn't starve the same users every time
  const users = (await getAllUsers()).sort((a, b) => (a.lastPolledAt ?? 0) - (b.lastPolledAt ?? 0));
  const due = users.filter((u) => dueSlotFor(u, nowMs).due);
  const results: UserResult[] = [];

  // 1) Digests for everyone due this hour
  const leftDue = await each(due, deadline - 15_000, async (user) => {
    try {
      results.push(await deliver(user, nowMs, deadline));
    } catch (err) {
      console.error(`tick failed for ${user.slackUserId}:`, err);
      results.push({ userId: user.slackUserId, error: String(err) });
    }
  });
  // Not marked as handled — the next tick (within the catch-up window) picks them up
  leftDue.forEach((u) => results.push({ userId: u.slackUserId, skipped: "out of time" }));

  // 2) Spare time: refresh users whose data is getting old, so their next digest and
  //    /nudge list are current even though only due users are polled before sending
  const stale = users.filter(
    (u) => !due.includes(u) && !resolveSchedule(u).paused && Date.now() - (u.lastPolledAt ?? 0) > STALE_AFTER_MS
  );
  const backgroundPolled: string[] = [];
  await each(stale, deadline - 40_000, async (user) => {
    await pollWithin(user, Math.min(deadline - 20_000, Date.now() + BACKGROUND_POLL_MS));
    backgroundPolled.push(user.slackUserId);
  });

  const summary = {
    ok: true,
    source,
    ranAt: new Date(nowMs).toISOString(),
    slot,
    usersTotal: users.length,
    usersDue: due.length,
    usersNotified: results.filter((r) => (r.sent ?? 0) > 0).length,
    backgroundPolled: backgroundPolled.length,
    results,
  };
  console.log("tick", JSON.stringify(summary));
  return summary;
}
