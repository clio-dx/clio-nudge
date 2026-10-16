// Feedback in Slack: the "🙋 잘못 찾은 질문 알려주기" modal under digests and lists, the
// "Nudge가 놓친 질문" message shortcut, and the `의견 …` command (lib/nudge-command.ts).
import { createBoundedClient, createSlackClient } from "@/lib/slack";
import { getUser, type NudgeUser } from "@/lib/db";
import { addFollowUp, getFollowUp, itemId, markSeen, removeFollowUp, type FollowUp, type FollowUpKind } from "@/lib/store";
import { buildDigestBlocks, digestFallbackText, digestGroups, FEEDBACK_ACTION, loadVisible } from "@/lib/digest";
import { teamUrlFor } from "@/lib/tick";
import { FEEDBACK_LABELS, feedbackFromItem, recordFeedback, type FeedbackLabel } from "@/lib/feedback";
import { DM_PREFIX, notInstalledReply, SLASH_PREFIX } from "@/lib/messages";

export { FEEDBACK_ACTION };
export const FEEDBACK_VIEW = "nudge_feedback_modal";
export const MISSED_SHORTCUT = "nudge_missed";

// Where the modal was opened from, so the message can be redrawn after "목록에서 지우기"
interface ModalMeta {
  channel?: string;
  ts?: string;
  responseUrl?: string;
  isList?: boolean;
  prefix: string;
  groups: { k: FollowUpKind; c: string; t: string[] }[];
}

const plain = (text: string) => ({ type: "plain_text", text, emoji: true });
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// private_metadata holds at most 3000 characters: drop groups (and timestamps) that don't fit
function packMeta(meta: ModalMeta): string {
  const m = { ...meta, groups: meta.groups.map((g) => ({ ...g, t: g.t.slice(0, 10) })) };
  while (JSON.stringify(m).length > 2900 && m.groups.length > 0) m.groups.pop();
  return JSON.stringify(m);
}

export function feedbackModal(meta: ModalMeta, labels: string[]): object {
  const hasItems = meta.groups.length > 0;
  const reasons = (Object.keys(FEEDBACK_LABELS) as (keyof typeof FEEDBACK_LABELS)[]).map((k) => ({
    text: plain(FEEDBACK_LABELS[k]),
    value: k,
  }));
  return {
    type: "modal",
    callback_id: FEEDBACK_VIEW,
    title: plain(hasItems ? "잘못 찾은 질문 알려주기" : "의견 보내기"),
    submit: plain("보내기"),
    close: plain("취소"),
    private_metadata: packMeta(meta),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: hasItems
            ? "Nudge가 잘못 찾은 질문을 알려주시면 다음부터 더 정확하게 찾을게요. 놓친 질문은 그 메시지의 *⋯ → Nudge가 놓친 질문*으로 알려 주세요."
            : "Nudge에 바라는 점이나 불편한 점을 알려 주세요.",
        },
      },
      ...(hasItems
        ? [
            {
              type: "input",
              block_id: "items",
              label: plain("어떤 질문인가요?"),
              element: {
                type: "multi_static_select",
                action_id: "v",
                placeholder: plain("질문 고르기"),
                options: meta.groups.slice(0, 100).map((_, i) => ({ text: plain(cut(labels[i] || "질문", 75)), value: String(i) })),
              },
            },
            {
              type: "input",
              block_id: "reason",
              label: plain("무엇이 잘못됐나요?"),
              element: { type: "radio_buttons", action_id: "v", initial_option: reasons[0], options: reasons },
            },
          ]
        : []),
      {
        type: "input",
        block_id: "note",
        optional: hasItems,
        label: plain(hasItems ? "더 하고 싶은 말 (선택)" : "의견"),
        element: { type: "plain_text_input", action_id: "v", multiline: true, max_length: 1000 },
      },
      ...(hasItems
        ? [
            {
              type: "input",
              block_id: "dismiss",
              optional: true,
              label: plain("목록"),
              element: {
                type: "checkboxes",
                action_id: "v",
                options: [{ text: plain("고른 질문을 목록에서 지우기"), value: "yes" }],
                initial_options: [{ text: plain("고른 질문을 목록에서 지우기"), value: "yes" }],
              },
            },
          ]
        : []),
    ],
  };
}

export const thanksView = (text: string) => ({
  type: "modal",
  title: plain("고마워요"),
  close: plain("닫기"),
  blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
});

// ---------------------------------------------------------------------------
// Opening the modal: runs inside the interaction request — trigger_id is only good for 3 seconds

export interface FeedbackButtonPayload {
  trigger_id?: string;
  user?: { id?: string };
  container?: { is_ephemeral?: boolean };
  response_url?: string;
  channel?: { id?: string };
  message?: { ts?: string };
  actions?: { value?: string }[];
}

export async function openFeedbackModal(payload: FeedbackButtonPayload): Promise<void> {
  const userId = payload.user?.id;
  if (!userId || !payload.trigger_id) return;
  const user = await getUser(userId);
  if (!user) return;
  // Commands in the redrawn message are written the way they're typed where the button was
  const prefix = payload.channel?.id && payload.channel.id === user.botDmChannel ? DM_PREFIX : SLASH_PREFIX;
  const visible = await loadVisible(user, Date.now(), { includeFresh: true });
  const groups = digestGroups(visible);
  const meta: ModalMeta = {
    ...(payload.container?.is_ephemeral ? { responseUrl: payload.response_url } : { channel: payload.channel?.id, ts: payload.message?.ts }),
    isList: payload.actions?.[0]?.value === "list" || payload.container?.is_ephemeral === true,
    prefix,
    groups: groups.map((g) => ({ k: g.kind, c: g.channel, t: g.threadTs })),
  };
  await createSlackClient(user.botToken).views.open({
    trigger_id: payload.trigger_id,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    view: feedbackModal(meta, groups.map((g) => g.label)) as any,
  });
}

// ---------------------------------------------------------------------------
// Submitting it: Slack gets the thank-you right away, this runs as a task

type StateValues = Record<string, Record<string, {
  selected_options?: { value: string }[];
  selected_option?: { value: string };
  value?: string | null;
}>>;

export interface FeedbackSubmission {
  userId: string;
  values: StateValues;
  meta: string;
}

export async function handleFeedbackSubmission({ userId, values, meta: rawMeta }: FeedbackSubmission): Promise<void> {
  const user = await getUser(userId);
  if (!user) return;
  let meta: ModalMeta;
  try {
    meta = JSON.parse(rawMeta);
  } catch {
    return;
  }
  const picked = (values.items?.v?.selected_options ?? []).map((o) => meta.groups[Number(o.value)]).filter(Boolean);
  const label = (values.reason?.v?.selected_option?.value ?? "not_question") as FeedbackLabel;
  const note = values.note?.v?.value?.trim() || undefined;
  const dismiss = (values.dismiss?.v?.selected_options ?? []).some((o) => o.value === "yes");

  if (picked.length === 0 && note) {
    await recordFeedback({ userId, label: "comment", source: "modal", note });
    return;
  }
  for (const g of picked) {
    for (const ts of g.t) {
      const item = await getFollowUp(g.k, userId, g.c, ts);
      if (!item) continue;
      await recordFeedback(feedbackFromItem(userId, item, label, "modal", note));
      if (dismiss) {
        await removeFollowUp(g.k, userId, g.c, ts);
        await markSeen(userId, itemId(g.k, g.c, ts), item.createdAt);
      }
    }
  }
  if (dismiss && picked.length > 0) await redraw(user, meta).catch((err) => console.error("feedback redraw failed:", err));
}

// The digest or list the modal was opened from, without the questions just removed
async function redraw(user: NudgeUser, meta: ModalMeta): Promise<void> {
  const [visible, teamUrl] = await Promise.all([loadVisible(user, Date.now(), { includeFresh: true }), teamUrlFor(user)]);
  const isList = meta.isList === true;
  const blocks = buildDigestBlocks(visible, teamUrl, { maxPerSection: isList ? 20 : 10, isList, prefix: meta.prefix });
  const text = digestFallbackText(visible);
  if (meta.responseUrl) {
    await fetch(meta.responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replace_original: true, text, blocks }),
    });
  } else if (meta.channel && meta.ts) {
    await createBoundedClient(user.botToken).chat.update({ channel: meta.channel, ts: meta.ts, text, blocks });
  }
}

// ---------------------------------------------------------------------------
// "Nudge가 놓친 질문" on any message: track it from now on, and remember Nudge missed it

export interface MissedQuestion {
  userId: string;
  teamId?: string;
  channel: string;
  responseUrl?: string;
  message: { ts: string; thread_ts?: string; user?: string; text?: string };
}

async function ephemeral(url: string | undefined, text: string, extra: object = {}): Promise<void> {
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text, ...extra }),
  });
}

export async function handleMissedQuestion(m: MissedQuestion): Promise<void> {
  const user = await getUser(m.userId);
  if (!user) {
    await ephemeral(m.responseUrl, notInstalledReply().text, { blocks: notInstalledReply().blocks });
    return;
  }
  const ts = m.message.ts;
  // My own message: a question I'm waiting on. Anyone else's: one I have to answer.
  const kind: FollowUpKind = m.message.user === m.userId ? "outgoing" : "incoming";
  const inThread = !!m.message.thread_ts && m.message.thread_ts !== ts;
  const convType = m.channel.startsWith("D") ? "im" : undefined;
  const item: FollowUp = {
    kind,
    userId: m.userId,
    channel: m.channel,
    threadTs: ts,
    ...(inThread ? { parentThreadTs: m.message.thread_ts } : {}),
    originalMessage: m.message.text ?? "",
    ...(convType ? { convType } : {}),
    ...(kind === "incoming" && m.message.user ? { askerId: m.message.user } : {}),
    createdAt: Math.floor(parseFloat(ts) * 1000),
    lastRemindedAt: null,
    lastActivityAt: Date.now(),
  };
  const already = await getFollowUp(kind, m.userId, m.channel, ts);
  if (!already) await addFollowUp(item);
  await recordFeedback(feedbackFromItem(m.userId, item, "missed", "shortcut"));
  await ephemeral(
    m.responseUrl,
    already
      ? "📌 이미 Nudge 목록에 있는 질문이에요. 알려주셔서 고마워요!"
      : `📌 ${kind === "incoming" ? "답해야 할 질문" : "답을 기다리는 질문"}으로 Nudge 목록에 추가했어요. 알려주셔서 고마워요!`
  );
}
