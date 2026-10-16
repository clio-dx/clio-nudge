import { getAllUsers, getUser, updateUser, type NudgeUser } from "@/lib/db";
import { pollUser, type PollStats } from "@/lib/poll";
import { acquireLock, hasMarker, recentTickHours, recordTick, setMarker } from "@/lib/store";
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
// The scheduler counts as healthy when ticks landed in most of the recent hours
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

// Poll, but give up waiting at `untilMs`. The poll keeps running and saves its progress; the
// digest doesn't wait for it.
async function pollWithin(user: NudgeUser, untilMs: number): Promise<Pick<UserResult, "poll" | "pollTimedOut">> {
  const poll = pollUser(user, untilMs - 10_000).catch((err) => {
    console.error(`poll failed for ${user.slackUserId}:`, err);
    return undefined;
  });
  const stats = await settleBy(poll, untilMs);
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

export async function deliver(user: NudgeUser, nowMs: number, deadline: number): Promise<UserResult> {
  const { schedule, due } = dueSlotFor(user, nowMs);
  if (!due) return { userId: user.slackUserId, skipped: "not due" };

  // Two ticks (or a retried task) for the same slot — first one wins.
  // Short TTL so a crashed run doesn't block the retry.
  if (!(await acquireLock(`nudge:lock:digest:${user.slackUserId}:${due.slot}`, 600))) {
    return { userId: user.slackUserId, slot: due.slot, skipped: "handled by another tick" };
  }

  // Polled shortly before (the pre-poll): send from that. Otherwise fresh data first — but the
  // digest goes out on time even if the poll is stuck (rate limits, slow AI).
  const recentlyPolled = Date.now() - (user.lastPolledAt ?? 0) < FRESH_ENOUGH_MS;
  const pollUntil = Math.min(deadline - 30_000, Date.now() + DELIVER_POLL_MS);
  const result: UserResult = {
    userId: user.slackUserId,
    slot: due.slot,
    ...(!recentlyPolled && Date.now() < pollUntil ? await pollWithin(user, pollUntil) : {}),
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
  const result = await deliver(user, now, now + 10 * 60_000);
  await recordRun("deliver", { ...result }, userId);
  return result;
}

// Background poll: fresh data ahead of a digest, or when it got old
export async function pollJob(userId: string): Promise<UserResult | null> {
  const user = await getUser(userId);
  if (!user) return null;
  return { userId, ...(await pollWithin(user, Date.now() + BACKGROUND_POLL_MS)) };
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
    const { schedule, paused, due } = dueSlotFor(user, nowMs);
    const age = nowMs - (user.lastPolledAt ?? 0);

    if (due) {
      await queue("deliver", () => enqueue({ type: "deliver", userId }, { name: `deliver-${userId}-${due.slot}` }));
      continue;
    }
    if (firstReportOverdue(user, nowMs)) {
      await queue("firstReport", () => enqueue({ type: "first-report", userId }, { name: `first-report-${userId}` }));
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
