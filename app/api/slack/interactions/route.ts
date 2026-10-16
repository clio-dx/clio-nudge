import { NextRequest, NextResponse } from "next/server";
import { verifySlackRequest } from "@/lib/slack";
import type { BlockActionsPayload } from "@/lib/slack-handlers";
import { enqueue } from "@/lib/tasks";

// Buttons on digests and lists (완료, 🔄, 설정, 사용법): answers Slack right away, a task does the work
export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-slack-signature");
  const timestamp = req.headers.get("x-slack-request-timestamp");

  if (!(await verifySlackRequest(signature, timestamp, body))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const params = new URLSearchParams(body);
  let payload: BlockActionsPayload;
  try {
    payload = JSON.parse(params.get("payload") || "{}");
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  if (payload.type === "block_actions") {
    await enqueue({ type: "slack-actions", payload }, { queue: "slack" }).catch((err) =>
      console.error("could not queue interaction:", err)
    );
  }

  return NextResponse.json({ ok: true });
}
