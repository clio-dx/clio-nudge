// The DM with the first check's result after connecting, so people don't have to keep asking.
// The OAuth callback sends it once its first poll stops; the tick sends it to anyone who didn't
// get one (installs from before this DM existed, or a callback that died).
import { updateUser, type NudgeUser } from "@/lib/db";
import type { PollStats } from "@/lib/poll";
import { acquireLock, releaseLock } from "@/lib/store";
import { formatSchedule, resolveSchedule } from "@/lib/schedule";
import { buildDigestBlocks, countGroups, loadVisible } from "@/lib/digest";
import { postDM, teamUrlFor } from "@/lib/tick";
import { DM_PREFIX } from "@/lib/messages";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = any;

// The tick catches up on installs this recent, and leaves the first minutes to the callback
const CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;
const CALLBACK_GRACE_MS = 10 * 60 * 1000;

export function firstReportOverdue(user: NudgeUser, now = Date.now()): boolean {
  const age = now - user.installedAt;
  return !user.firstReportAt && age > CALLBACK_GRACE_MS && age < CATCH_UP_WINDOW_MS;
}

// Under the AI limit the first check often can't read the whole 7-day backlog in one go: then
// this shows what was found so far, and the rest comes with the next check (or 🔄).
// `stats` of the poll just run, if any: a whole search failing reads nothing but doesn't keep
// firstScanPending set.
export async function firstReport(user: NudgeUser, stats?: PollStats): Promise<{ text: string; blocks: Block[] }> {
  const [visible, teamUrl] = await Promise.all([loadVisible(user, Date.now(), { includeFresh: true }), teamUrlFor(user)]);
  const done = !user.firstScanPending && !stats?.errors.some((e) => /^(incoming|outgoing):/.test(e));
  const { schedule, paused } = resolveSchedule(user);
  const when = paused ? "" : `앞으로 확인할 질문이 생기면 *${formatSchedule(schedule)}*에 알려드려요`;
  const title = done
    ? "✅ *지난 7일 치 Slack을 다 확인했어요!*"
    : "⏳ *지난 7일 치 Slack 중 일부를 먼저 확인했어요.*";
  const footer = !done
    ? "확인할 메시지가 많아 아직 다 보지 못했어요 · 나머지는 다음 확인 때 이어서 보고, 지금 더 보려면 🔄를 눌러 주세요"
    : countGroups(visible) > 0
      ? ["답장했거나 신경 쓰지 않아도 되면 *완료*를 눌러 주세요", when].filter(Boolean).join(" · ")
      : when || undefined;
  return {
    text: done ? "Nudge: 지난 7일 치 확인을 마쳤어요" : "Nudge: 지난 7일 치 중 일부를 확인했어요",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: title } },
      ...buildDigestBlocks(visible, teamUrl, { maxPerSection: 20, footer, isList: true, prefix: DM_PREFIX, partial: !done }),
    ],
  };
}

// Sends it at most once per user
export async function sendFirstReport(user: NudgeUser, stats?: PollStats): Promise<boolean> {
  const lockKey = `nudge:lock:first-report:${user.slackUserId}`;
  if (user.firstReportAt || !(await acquireLock(lockKey, 24 * 60 * 60))) return false;
  try {
    const report = await firstReport(user, stats);
    await postDM(user, report.blocks, report.text);
  } catch (err) {
    await releaseLock(lockKey); // the next tick tries again
    throw err;
  }
  await updateUser(user.slackUserId, { firstReportAt: Date.now() });
  return true;
}
