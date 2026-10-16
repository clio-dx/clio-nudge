// 완료 on a digest or list row: forget that question group, then redraw the message it sat on
import { getFollowUp, itemId, markSeen, removeFollowUp, type FollowUpKind } from "@/lib/store";
import type { NudgeUser } from "@/lib/db";
import { buildDigestBlocks, digestFallbackText, loadVisible } from "@/lib/digest";
import { teamUrlFor } from "@/lib/tick";
import type { Reply } from "@/lib/nudge-command";
import { feedbackFromItem, recordFeedback } from "@/lib/feedback";

// The 완료 button's value
export interface DismissValue {
  k?: FollowUpKind;
  c?: string;
  t?: string[];
  l?: 1; // the row sits in a list (목록/새로고침), not a scheduled digest
  // Buttons rendered before incoming tracking existed
  userId?: string;
  channel?: string;
  threadTs?: string;
}

// `isList`: the message is a list (more rows, list buttons). Returns null when the value names
// nothing to dismiss.
export async function dismissGroup(
  user: NudgeUser,
  value: DismissValue,
  isList: boolean,
  prefix: string
): Promise<Reply | null> {
  const userId = user.slackUserId;
  const kind: FollowUpKind = value.k === "incoming" ? "incoming" : "outgoing";
  const channel = value.c ?? value.channel;
  const timestamps = value.t ?? (value.threadTs ? [value.threadTs] : []);
  if (!channel || timestamps.length === 0) return null;

  // Remove the whole group and remember it so the next poll doesn't bring it back. Items
  // already resolved (or a retried click) skip the writes but still refresh the message,
  // so a stale digest row never looks like a broken button.
  const existing = await Promise.all(timestamps.map((ts) => getFollowUp(kind, userId, channel, ts)));
  await Promise.all(
    timestamps.map(async (ts, i) => {
      if (!existing[i]) return;
      await removeFollowUp(kind, userId, channel, ts);
      await markSeen(userId, itemId(kind, channel, ts), existing[i]!.createdAt);
      await recordFeedback(feedbackFromItem(userId, existing[i]!, "done", "dismiss"), `done~${userId}~${itemId(kind, channel, ts)}`);
    })
  );

  // Every question still tracked, also those inside the digest's 2h/24h wait — only the
  // scheduled send waits. A redrawn digest that hid them said "모두 처리했어요" while the
  // 홈 tab and 목록 still counted them.
  const [visible, teamUrl] = await Promise.all([
    loadVisible(user, Date.now(), { includeFresh: true }),
    teamUrlFor(user),
  ]);
  const blocks = buildDigestBlocks(visible, teamUrl, { maxPerSection: isList ? 20 : 10, isList, prefix });
  return { text: digestFallbackText(visible), blocks };
}
