import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createSlackClient, verifySlackRequest } from "@/lib/slack";
import { getFollowUp, itemId, markSeen, removeFollowUp, type FollowUpKind } from "@/lib/redis";
import { getUser, type NudgeUser } from "@/lib/db";
import { buildDigestBlocks, digestFallbackText, loadVisible, QUICK_ACTIONS } from "@/lib/digest";
import { teamUrlFor } from "@/lib/tick";
import { parseCommand } from "@/lib/command";
import { runCommand, type Reply, type Responder } from "@/lib/nudge-command";
import { DM_PREFIX, SLASH_PREFIX } from "@/lib/messages";

// "🔄 지금 다시 확인" polls Slack inside waitUntil
export const maxDuration = 300;

interface DismissValue {
  k?: FollowUpKind;
  c?: string;
  t?: string[];
  // Buttons rendered before incoming tracking existed
  userId?: string;
  channel?: string;
  threadTs?: string;
}

interface BlockActionsPayload {
  user?: { id?: string };
  actions?: { action_id?: string; value?: string }[];
  container?: { is_ephemeral?: boolean };
  response_url?: string;
  channel?: { id?: string };
  message?: { ts?: string; blocks?: { type?: string }[] };
}

async function postToResponseUrl(url: string, body: Record<string, unknown>): Promise<void> {
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// Rewrites the message the button sits on: an ephemeral /nudge list via its response_url,
// a digest DM via chat.update
async function updateOriginal(payload: BlockActionsPayload, user: NudgeUser, reply: Reply): Promise<void> {
  const text = reply.text ?? "Nudge";
  if (payload.container?.is_ephemeral && payload.response_url) {
    await postToResponseUrl(payload.response_url, { replace_original: true, text, blocks: reply.blocks ?? [] });
  } else if (payload.channel?.id && payload.message?.ts) {
    await createSlackClient(user.botToken).chat.update({
      channel: payload.channel.id,
      ts: payload.message.ts,
      text,
      blocks: reply.blocks ?? [],
    });
  }
}

async function handleQuickAction(payload: BlockActionsPayload, user: NudgeUser, actionId: string) {
  // Commands in the reply are written the way they're typed where the button was clicked
  const prefix = payload.channel?.id && payload.channel.id === user.botDmChannel ? DM_PREFIX : SLASH_PREFIX;

  if (actionId === QUICK_ACTIONS.refresh) {
    // Show progress in place, then replace the same message with the fresh list
    const inPlace: Responder = {
      prefix,
      send: (reply) => updateOriginal(payload, user, reply),
      replace: (reply) => updateOriginal(payload, user, reply),
    };
    await runCommand(user, { type: "refresh" }, inPlace);
    return;
  }

  // Settings / help: a separate message only the clicker sees, the digest stays as it is
  const ephemeral: Responder = {
    prefix,
    send: async (reply) => {
      if (payload.response_url) {
        await postToResponseUrl(payload.response_url, {
          response_type: "ephemeral",
          replace_original: false,
          text: reply.text ?? "Nudge",
          ...(reply.blocks ? { blocks: reply.blocks } : {}),
        });
      }
    },
    replace: async (reply) => ephemeral.send(reply),
  };
  try {
    await runCommand(user, parseCommand(actionId === QUICK_ACTIONS.help ? "도움말" : "설정"), ephemeral);
  } catch (err) {
    console.error("quick action failed:", err);
    await ephemeral.send({ text: "😵 처리하다가 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요." }).catch(() => {});
  }
}

async function handleDismiss(payload: BlockActionsPayload, user: NudgeUser, rawValue: string | undefined) {
  let value: DismissValue;
  try {
    value = JSON.parse(rawValue || "{}");
  } catch {
    return;
  }
  const userId = user.slackUserId;
  const kind: FollowUpKind = value.k === "incoming" ? "incoming" : "outgoing";
  const channel = value.c ?? value.channel;
  const timestamps = value.t ?? (value.threadTs ? [value.threadTs] : []);
  if (!channel || timestamps.length === 0) return;

  // Remove the whole group and remember it so the next poll doesn't bring it back. Items
  // already resolved (or a retried click) skip the writes but still refresh the message,
  // so a stale digest row never looks like a broken button.
  const existing = await Promise.all(timestamps.map((ts) => getFollowUp(kind, userId, channel, ts)));
  await Promise.all(
    timestamps.map(async (ts, i) => {
      if (!existing[i]) return;
      await removeFollowUp(kind, userId, channel, ts);
      await markSeen(userId, itemId(kind, channel, ts), existing[i]!.createdAt);
    })
  );

  const [visible, teamUrl] = await Promise.all([loadVisible(user), teamUrlFor(user)]);
  // The /nudge list view shows more rows than the scheduled digest
  const isEphemeral = payload.container?.is_ephemeral === true;
  const prefix = payload.channel?.id === user.botDmChannel ? DM_PREFIX : SLASH_PREFIX;
  const blocks = buildDigestBlocks(visible, teamUrl, {
    maxPerSection: isEphemeral ? 20 : 10,
    isList: isEphemeral,
    prefix,
  });
  await updateOriginal(payload, user, { text: digestFallbackText(visible), blocks });
}

async function handleInteraction(payload: BlockActionsPayload) {
  const action = payload.actions?.[0];
  const userId = payload.user?.id;
  if (!action?.action_id || !userId) return;

  const user = await getUser(userId);
  if (!user) return;

  if (Object.values(QUICK_ACTIONS).includes(action.action_id as (typeof QUICK_ACTIONS)[keyof typeof QUICK_ACTIONS])) {
    await handleQuickAction(payload, user, action.action_id);
  } else if (action.action_id.startsWith("dismiss_")) {
    await handleDismiss(payload, user, action.value);
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-slack-signature");
  const timestamp = req.headers.get("x-slack-request-timestamp");

  if (!verifySlackRequest(signature, timestamp, body)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const params = new URLSearchParams(body);
  let payload: { type?: string } & BlockActionsPayload;
  try {
    payload = JSON.parse(params.get("payload") || "{}");
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  if (payload.type === "block_actions") {
    waitUntil(handleInteraction(payload).catch((err) => console.error("interaction failed:", err)));
  }

  return NextResponse.json({ ok: true });
}
