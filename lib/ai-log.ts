// Every model call with its full prompt and answer, tagged with the question it was about — the
// raw material for checking the AI against people's feedback and for fine-tuning later
// (admin page → tuning.jsonl). ai_calls/{id}
import { AsyncLocalStorage } from "node:async_hooks";
import { backend } from "@/lib/store/backend";

export interface AiContext {
  userId?: string;
  itemId?: string; // lib/store itemId(): "incoming:C1:1700000000.000100"
}

export interface AiCall extends AiContext {
  task: string; // "summary" | "classify-response" | "classify-user-message" | "classify-promise"
  model: string;
  prompt: string;
  output?: string;
  ok: boolean;
  error?: string;
  ms: number;
  at: Date;
}

const context = new AsyncLocalStorage<AiContext>();

// Calls made inside `fn` are recorded as being about `ctx`
export function withAiContext<T>(ctx: AiContext, fn: () => Promise<T>): Promise<T> {
  return context.run({ ...context.getStore(), ...ctx }, fn);
}

// Never fails the call it describes
export async function logAiCall(call: Omit<AiCall, "at" | keyof AiContext>): Promise<void> {
  if (process.env.NUDGE_AI_LOG === "off") return;
  try {
    await backend.add("ai_calls", { ...context.getStore(), ...call, at: new Date() });
  } catch (err) {
    console.error("logAiCall failed:", String(err).slice(0, 200));
  }
}

export async function aiCallsFor(itemIds: string[]): Promise<AiCall[]> {
  const out: AiCall[] = [];
  for (const id of new Set(itemIds)) {
    out.push(...(await backend.query<AiCall>("ai_calls", { where: [["itemId", "==", id]] })).map((r) => r.data));
  }
  return out;
}
