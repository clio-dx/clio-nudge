import { NextRequest, NextResponse } from "next/server";
import { verifySlackRequest } from "@/lib/slack";
import { enqueue } from "@/lib/tasks";

// /nudge: answers Slack right away, replies through the response_url from a task
export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-slack-signature");
  const timestamp = req.headers.get("x-slack-request-timestamp");

  if (!(await verifySlackRequest(signature, timestamp, body))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const params = new URLSearchParams(body);
  const command = params.get("command");
  const userId = params.get("user_id");
  const responseUrl = params.get("response_url");

  if (command === "/nudge" && userId && responseUrl) {
    try {
      await enqueue(
        {
          type: "slack-command",
          command: { command, userId, responseUrl, channelId: params.get("channel_id"), text: params.get("text") || "" },
        },
        { queue: "slack" }
      );
    } catch (err) {
      console.error("could not queue /nudge:", err);
      return NextResponse.json({ response_type: "ephemeral", text: "😵 처리하다가 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요." });
    }
    return new NextResponse(null, { status: 200 });
  }

  return NextResponse.json({ ok: true });
}
