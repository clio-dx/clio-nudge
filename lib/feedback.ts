// What people tell Nudge about its picks (feedback/{id}), and the datasets built from it for
// checking the AI and fine-tuning later (admin page → feedback.jsonl / tuning.jsonl).
import { backend } from "@/lib/store/backend";
import { itemId, type FollowUp, type FollowUpKind } from "@/lib/store";
import { aiCallsFor, type AiCall } from "@/lib/ai-log";

export type FeedbackLabel =
  | "not_question" // Nudge listed something that isn't a question or request
  | "not_for_me" // a question, but not one I need to handle
  | "already_answered" // it was answered and Nudge missed that
  | "missed" // a question Nudge didn't list (message shortcut)
  | "done" // 완료: a real question the person dealt with
  | "comment"; // free text (`의견 …`, or the modal's note)

export type FeedbackSource = "modal" | "shortcut" | "dm" | "dismiss";

export interface Feedback {
  userId: string;
  label: FeedbackLabel;
  source: FeedbackSource;
  kind?: FollowUpKind;
  channel?: string;
  threadTs?: string;
  itemId?: string;
  originalMessage?: string;
  summary?: string;
  note?: string;
  at: Date;
}

export const FEEDBACK_LABELS: Record<Exclude<FeedbackLabel, "done" | "comment" | "missed">, string> = {
  not_question: "질문이 아니에요",
  not_for_me: "나와 상관없어요",
  already_answered: "이미 답했어요 / 해결됐어요",
};

// Never fails what the person was doing
export async function recordFeedback(f: Omit<Feedback, "at">): Promise<void> {
  try {
    await backend.add("feedback", { ...f, at: new Date() });
  } catch (err) {
    console.error("recordFeedback failed:", String(err).slice(0, 200));
  }
}

export function feedbackFromItem(
  userId: string,
  item: FollowUp,
  label: FeedbackLabel,
  source: FeedbackSource,
  note?: string
): Omit<Feedback, "at"> {
  const kind = item.kind ?? "outgoing";
  return {
    userId,
    label,
    source,
    kind,
    channel: item.channel,
    threadTs: item.threadTs,
    itemId: itemId(kind, item.channel, item.threadTs),
    originalMessage: item.originalMessage,
    summary: item.summary,
    ...(note ? { note } : {}),
  };
}

// ---------------------------------------------------------------------------
// Exports

export async function allFeedback(): Promise<Feedback[]> {
  return (await backend.query<Feedback>("feedback", { orderBy: ["at", "desc"] })).map((r) => r.data);
}

// One line per feedback, with every AI call made about that message
export async function feedbackJsonl(): Promise<string> {
  const rows = await allFeedback();
  const calls = await aiCallsFor(rows.map((f) => f.itemId).filter((x): x is string => !!x));
  const byItem = new Map<string, AiCall[]>();
  for (const c of calls) if (c.itemId) byItem.set(c.itemId, [...(byItem.get(c.itemId) ?? []), c]);
  return rows
    .map((f) =>
      JSON.stringify({
        ...f,
        at: f.at.toISOString(),
        aiCalls: (f.itemId ? byItem.get(f.itemId) ?? [] : []).map((c) => ({ task: c.task, model: c.model, prompt: c.prompt, output: c.output, ok: c.ok })),
      })
    )
    .join("\n");
}

const example = (prompt: string, answer: string) =>
  JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }, { role: "model", parts: [{ text: answer }] }] });

// Is this message a question or request the reader has to handle? Nudge decides this with rules
// today; these examples are for a model that could take over.
export const DETECT_PROMPT = (message: string) =>
  `You are reading a Slack message sent to the reader. Is it a question or request the reader still has to answer or act on?\n\nMessage: "${message}"\n\nReply with ONLY one word: "yes" or "no"`;

// Vertex AI supervised tuning format ({"contents":[user, model]}), only where the right answer is clear
export async function tuningJsonl(): Promise<string> {
  const rows = await allFeedback();
  const calls = await aiCallsFor(rows.map((f) => f.itemId).filter((x): x is string => !!x));
  const lines: string[] = [];
  for (const f of rows) {
    if (f.originalMessage) {
      if (f.label === "not_question" || f.label === "not_for_me") lines.push(example(DETECT_PROMPT(f.originalMessage), "no"));
      if (f.label === "missed" || f.label === "done") lines.push(example(DETECT_PROMPT(f.originalMessage), "yes"));
    }
    if (!f.itemId) continue;
    for (const c of calls.filter((x) => x.itemId === f.itemId && x.ok && x.output)) {
      const said = c.output!.trim().toLowerCase();
      // "이미 답했어요": a reply the AI called non-committal was the answer
      if (f.label === "already_answered" && c.task === "classify-response" && said.startsWith("non-committal")) {
        lines.push(example(c.prompt, "answer"));
      }
      // 완료 on an open item: the AI was right that the replies so far didn't answer it
      if (f.label === "done" && c.task === "classify-response" && said.startsWith("non-committal")) {
        lines.push(example(c.prompt, "non-committal"));
      }
    }
  }
  return [...new Set(lines)].join("\n");
}
