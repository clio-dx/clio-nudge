import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createSlackClient, verifySlackRequest } from "@/lib/slack";
import { getFollowUp, itemId, markSeen, removeFollowUp, type FollowUpKind } from "@/lib/redis";
import { getUser } from "@/lib/db";
import { buildDigestBlocks, digestFallbackText, loadVisible } from "@/lib/digest";
import { teamUrlFor } from "@/lib/tick";

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

async function handleInteraction(payload: BlockActionsPayload) {
  const action = payload.actions?.[0];
  const userId = payload.user?.id;
  if (!action?.action_id?.startsWith("dismiss_") || !userId) return;

  let value: DismissValue;
  try {
    value = JSON.parse(action.value || "{}");
  } catch {
    return;
  }
  const kind: FollowUpKind = value.k === "incoming" ? "incoming" : "outgoing";
  const channel = value.c ?? value.channel;
  const timestamps = value.t ?? (value.threadTs ? [value.threadTs] : []);
  if (!channel || timestamps.length === 0) return;

  const user = await getUser(userId);
  if (!user) return;

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
  const blocks = buildDigestBlocks(visible, teamUrl, { maxPerSection: isEphemeral ? 20 : 10, isList: isEphemeral });

  if (isEphemeral && payload.response_url) {
    await fetch(payload.response_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replace_original: true, blocks, text: digestFallbackText(visible) }),
    });
  } else if (payload.channel?.id && payload.message?.ts) {
    await createSlackClient(user.botToken).chat.update({
      channel: payload.channel.id,
      ts: payload.message.ts,
      text: digestFallbackText(visible),
      blocks,
    });
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
