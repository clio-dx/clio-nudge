import { NextRequest, NextResponse } from "next/server";
import { verifySlackRequest } from "@/lib/slack";
import type { BlockActionsPayload } from "@/lib/slack-handlers";
import { FEEDBACK_ACTION, FEEDBACK_VIEW, MISSED_SHORTCUT, openFeedbackModal, thanksView, type FeedbackButtonPayload } from "@/lib/feedback-ui";
import { enqueue } from "@/lib/tasks";

const FAILED = "😵 처리하다가 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.";

interface InteractionPayload extends BlockActionsPayload {
  type?: string;
  trigger_id?: string;
  callback_id?: string; // message shortcut
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string; user?: string; text?: string };
  team?: { id?: string };
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, unknown>> };
  };
}

async function tellFailed(responseUrl: string | undefined): Promise<void> {
  if (!responseUrl) return;
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text: FAILED }),
  }).catch(() => {});
}

// Buttons on digests and lists (완료, 🔄, 설정, 사용법, 🙋), the feedback modal, and the
// "Nudge가 놓친 질문" message shortcut. Answers Slack right away; tasks do the work — except
// opening the modal, whose trigger_id is only good for 3 seconds.
export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-slack-signature");
  const timestamp = req.headers.get("x-slack-request-timestamp");

  if (!(await verifySlackRequest(signature, timestamp, body))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const params = new URLSearchParams(body);
  let payload: InteractionPayload;
  try {
    payload = JSON.parse(params.get("payload") || "{}");
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  if (payload.type === "block_actions" && payload.actions?.[0]?.action_id === FEEDBACK_ACTION) {
    await openFeedbackModal(payload as FeedbackButtonPayload).catch(async (err) => {
      console.error("feedback modal failed:", String(err).slice(0, 300));
      await tellFailed(payload.response_url);
    });
    return NextResponse.json({ ok: true });
  }

  if (payload.type === "view_submission" && payload.view?.callback_id === FEEDBACK_VIEW && payload.user?.id) {
    try {
      await enqueue(
        {
          type: "feedback-submit",
          submission: {
            userId: payload.user.id,
            values: (payload.view.state?.values ?? {}) as never,
            meta: payload.view.private_metadata ?? "{}",
          },
        },
        { queue: "slack" }
      );
    } catch (err) {
      console.error("could not queue feedback:", String(err).slice(0, 300));
      return NextResponse.json({ response_action: "update", view: thanksView(FAILED) });
    }
    return NextResponse.json({
      response_action: "update",
      view: thanksView("💌 알려주셔서 고마워요! 다음부터 더 정확하게 찾을게요."),
    });
  }

  if (payload.type === "message_action" && payload.callback_id === MISSED_SHORTCUT && payload.user?.id) {
    const m = payload.message;
    if (payload.channel?.id && m?.ts) {
      try {
        await enqueue(
          {
            type: "missed-question",
            missed: {
              userId: payload.user.id,
              teamId: payload.team?.id,
              channel: payload.channel.id,
              responseUrl: payload.response_url,
              message: { ts: m.ts, thread_ts: m.thread_ts, user: m.user, text: m.text },
            },
          },
          { queue: "slack" }
        );
      } catch (err) {
        console.error("could not queue missed question:", String(err).slice(0, 300));
        await tellFailed(payload.response_url);
      }
    }
    return new NextResponse(null, { status: 200 });
  }

  if (payload.type === "block_actions") {
    try {
      await enqueue({ type: "slack-actions", payload }, { queue: "slack" });
    } catch (err) {
      console.error("could not queue interaction:", String(err).slice(0, 300));
      await tellFailed(payload.response_url);
    }
  }

  return NextResponse.json({ ok: true });
}
