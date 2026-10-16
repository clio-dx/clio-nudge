import { NextRequest, NextResponse } from "next/server";
import { verifySlackRequest } from "@/lib/slack";
import { isPersonTypingInNudgeDm, type EventPayload } from "@/lib/slack-handlers";
import { enqueue } from "@/lib/tasks";

// Lets people type "설정", "목록", "매일 9시" straight into the Nudge DM (bot event message.im),
// and shows the 홈 tab / first-run guide when they open Nudge (app_home_opened).
// Answers Slack right away; the work runs as a task (lib/slack-handlers.ts).
export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-slack-signature");
  const timestamp = req.headers.get("x-slack-request-timestamp");

  if (!(await verifySlackRequest(signature, timestamp, body))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: EventPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  // Slack checks the Request URL once when it's saved
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  // Slack retries when we were slow to answer: that first delivery is already being handled.
  // Retries after an error (http_error, e.g. the secret wasn't loaded yet) are processed.
  if (req.headers.get("x-slack-retry-num") && req.headers.get("x-slack-retry-reason") === "http_timeout") {
    return NextResponse.json({ ok: true });
  }

  const relevant =
    isPersonTypingInNudgeDm(payload) || (payload.type === "event_callback" && payload.event?.type === "app_home_opened");
  if (relevant) {
    try {
      await enqueue({ type: "slack-event", payload }, { queue: "slack" });
    } catch (err) {
      console.error("could not queue Slack event:", String(err).slice(0, 300));
      return NextResponse.json({ error: "busy" }, { status: 500 }); // Slack retries
    }
  }
  return NextResponse.json({ ok: true });
}
