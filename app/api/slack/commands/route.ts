import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { verifySlackRequest } from "@/lib/slack";
import { getUser } from "@/lib/db";
import { parseCommand } from "@/lib/command";
import { runCommand, type Reply, type Responder } from "@/lib/nudge-command";
import { DM_PREFIX, notInstalledReply, SLASH_PREFIX } from "@/lib/messages";

// /nudge refresh polls Slack inside waitUntil
export const maxDuration = 300;

async function respond(responseUrl: string, reply: Reply & { replace_original?: boolean }): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", ...reply }),
  });
}

// Slash-command replies are ephemeral messages posted through the response_url
function slashResponder(responseUrl: string, prefix: string): Responder {
  return {
    prefix,
    send: (reply) => respond(responseUrl, reply),
    replace: (reply) => respond(responseUrl, { replace_original: true, ...reply }),
  };
}

async function handleNudgeCommand(responseUrl: string, userId: string, text: string, channelId: string | null) {
  const user = await getUser(userId);
  if (!user) {
    await respond(responseUrl, notInstalledReply());
    return;
  }
  // Typed inside the Nudge DM: show commands without "/nudge", like the DM's own replies and buttons
  const prefix = channelId && channelId === user.botDmChannel ? DM_PREFIX : SLASH_PREFIX;
  await runCommand(user, parseCommand(text), slashResponder(responseUrl, prefix));
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-slack-signature");
  const timestamp = req.headers.get("x-slack-request-timestamp");

  if (!verifySlackRequest(signature, timestamp, body)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const params = new URLSearchParams(body);
  const command = params.get("command");
  const userId = params.get("user_id");
  const responseUrl = params.get("response_url");
  const channelId = params.get("channel_id");
  const text = params.get("text") || "";

  if (command === "/nudge" && userId && responseUrl) {
    waitUntil(
      handleNudgeCommand(responseUrl, userId, text, channelId).catch(async (err) => {
        console.error("/nudge failed:", err);
        await respond(responseUrl, { text: "😵 처리하다가 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요." }).catch(() => {});
      })
    );
    return new NextResponse(null, { status: 200 });
  }

  return NextResponse.json({ ok: true });
}
