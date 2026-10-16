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
    try {
      await enqueue({ type: "slack-actions", payload }, { queue: "slack" });
    } catch (err) {
      console.error("could not queue interaction:", String(err).slice(0, 300));
      if (payload.response_url) {
        await fetch(payload.response_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text: "😵 처리하다가 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요." }),
        }).catch(() => {});
      }
    }
  }

  return NextResponse.json({ ok: true });
}
