// What people tell Nudge about its picks (feedback/{id}), and the datasets built from it for
// checking the AI and fine-tuning later (admin page → feedback.jsonl / tuning.jsonl).
import { backend } from "@/lib/store/backend";
import { itemId, type FollowUp, type FollowUpKind } from "@/lib/store";
import { aiCallsFor, type AiCall } from "@/lib/ai-log";
import { looksLikeDeferral } from "@/lib/question";

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
  promise?: boolean; // the item was someone's promise to me, not a question
  note?: string;
  at: Date;
}

export const FEEDBACK_LABELS: Record<Exclude<FeedbackLabel, "done" | "comment" | "missed">, string> = {
  not_question: "질문이 아니에요",
  not_for_me: "나와 상관없어요",
  already_answered: "이미 답했어요 / 해결됐어요",
};

// Never fails what the person was doing. `id`: one record per id (a double click writes once).
export async function recordFeedback(f: Omit<Feedback, "at">, id?: string): Promise<void> {
  try {
    if (id) await backend.set(`feedback/${id.replace(/\//g, "_")}`, { ...f, at: new Date() });
    else await backend.add("feedback", { ...f, at: new Date() });
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
    ...(item.promiserId ? { promise: true } : {}),
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

const responseIn = (prompt: string) => prompt.match(/Response received: "([\s\S]*?)"\n/)?.[1] ?? "";

// Vertex AI supervised tuning format ({"contents":[user, model]}), only where the right answer is
// clear. 완료 isn't used: people also press it to clear things that weren't questions. A message
// whose feedback disagrees with itself is left out.
export async function tuningJsonl(): Promise<string> {
  const latest = new Map<string, Feedback>(); // newest explicit feedback per message
  const free: Feedback[] = [];
  for (const f of await allFeedback()) {
    if (f.source === "dismiss" || f.label === "comment") continue;
    if (!f.itemId) free.push(f);
    else if (!latest.has(f.itemId)) latest.set(f.itemId, f); // allFeedback is newest first
  }
  const rows = [...latest.values(), ...free];
  const calls = await aiCallsFor([...latest.keys()]);
  const answers = new Map<string, Set<string>>(); // prompt → answers given
  const add = (prompt: string, answer: string) => answers.set(prompt, (answers.get(prompt) ?? new Set()).add(answer));

  for (const f of rows) {
    // Only questions to me (not my own questions, not promises) say what I have to answer
    if (f.originalMessage && f.kind === "incoming" && !f.promise) {
      if (f.label === "not_question") add(DETECT_PROMPT(f.originalMessage), "no");
      if (f.label === "missed") add(DETECT_PROMPT(f.originalMessage), "yes");
    }
    if (f.label !== "already_answered" || !f.itemId) continue;
    // "이미 답했어요": the reply the AI called non-committal was the answer — only when there was
    // exactly one such call and that reply isn't itself a promise to answer later
    const judged = calls.filter((c) => c.itemId === f.itemId && c.ok && c.task === "classify-response");
    const nonCommittal = judged.filter((c) => c.output!.trim().toLowerCase().startsWith("non-committal"));
    if (judged.length === 1 && nonCommittal.length === 1 && !looksLikeDeferral(responseIn(nonCommittal[0].prompt))) {
      add(nonCommittal[0].prompt, "answer");
    }
  }
  return [...answers.entries()]
    .filter(([, a]) => a.size === 1)
    .map(([prompt, a]) => example(prompt, [...a][0]))
    .join("\n");
}
