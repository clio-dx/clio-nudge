import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createBoundedClient, verifySlackRequest } from "@/lib/slack";
import { getUser, updateUser } from "@/lib/db";
import { parseDmText, runCommand, type Responder } from "@/lib/nudge-command";
import { DM_PREFIX, notInstalledReply } from "@/lib/messages";
import { handleAppHomeOpened, workspaceBotToken, type AppHomeOpenedEvent } from "@/lib/home";

// Lets people type "설정", "목록", "매일 9시" straight into the Nudge DM (bot event message.im),
// and shows the 홈 tab / first-run guide when they open Nudge (app_home_opened).
// "새로고침" polls Slack inside waitUntil.
export const maxDuration = 300;

interface MessageEvent {
  type?: string;
  channel_type?: string;
  channel?: string;
  user?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
}

// Replies in the DM as new messages (inside the thread if the command was typed in one);
// "replace" edits the last reply (progress → result)
function dmResponder(botToken: string, channel: string, threadTs?: string): Responder {
  const client = createBoundedClient(botToken);
  let lastTs: string | undefined;
  return {
    prefix: DM_PREFIX,
    async send(reply) {
      const res = await client.chat.postMessage({
        channel,
        text: reply.text ?? "Nudge",
        blocks: reply.blocks,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      lastTs = res.ts;
    },
    async replace(reply) {
      if (!lastTs) return this.send(reply);
      await client.chat.update({ channel, ts: lastTs, text: reply.text ?? "Nudge", blocks: reply.blocks ?? [] });
    },
  };
}

async function handleDmMessage(event: MessageEvent, teamId: string | undefined) {
  const { user: userId, channel, text } = event;
  if (!userId || !channel || !text) return;

  const user = await getUser(userId);
  if (!user) {
    // Typed in the Nudge DM before connecting: explain how to start
    const token = await workspaceBotToken(teamId);
    if (token) await createBoundedClient(token).chat.postMessage({ channel, ...notInstalledReply() });
    return;
  }
  if (user.botDmChannel !== channel) await updateUser(userId, { botDmChannel: channel });

  const out = dmResponder(user.botToken, channel, event.thread_ts);
  try {
    await runCommand(user, parseDmText(text), out);
  } catch (err) {
    console.error("DM command failed:", err);
    await out.send({ text: "😵 처리하다가 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요." }).catch(() => {});
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-slack-signature");
  const timestamp = req.headers.get("x-slack-request-timestamp");

  if (!verifySlackRequest(signature, timestamp, body)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: { type?: string; challenge?: string; team_id?: string; api_app_id?: string; event?: MessageEvent };
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  // Slack checks the Request URL once when it's saved
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  // Slack retries when we're slow to answer; the first delivery is already being handled
  if (req.headers.get("x-slack-retry-num")) {
    return NextResponse.json({ ok: true });
  }

  const event = payload.event;
  const isPersonTypingInNudgeDm =
    payload.type === "event_callback" &&
    event?.type === "message" &&
    event.channel_type === "im" &&
    !event.bot_id &&
    !event.subtype &&
    !!event.user;

  if (isPersonTypingInNudgeDm) {
    waitUntil(
      handleDmMessage(event!, payload.team_id).catch((err) => console.error("DM command failed:", err))
    );
  } else if (payload.type === "event_callback" && event?.type === "app_home_opened") {
    waitUntil(
      handleAppHomeOpened(event as AppHomeOpenedEvent, payload.team_id, payload.api_app_id).catch((err) =>
        console.error("app home failed:", err)
      )
    );
  }

  return NextResponse.json({ ok: true });
}
