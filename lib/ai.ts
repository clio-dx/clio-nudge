import { generateText } from "@/lib/vertex";
import { logAiCall } from "@/lib/ai-log";

// Gemini on Vertex AI (lib/vertex.ts)
const MODEL = process.env.AI_MODEL || "gemini-3.8-flash";
// Used when MODEL can't be reached at all (not enabled for the project, retired, …)
const FALLBACK_MODEL = process.env.AI_FALLBACK_MODEL || "gemini-2.5-flash";
// gemini-3.8-flash answers in ~2 s but now and then hangs for 40 s: cut it off early
const AI_TIMEOUT_MS = 10_000;
// Vertex answers 429 (or hangs) when shared capacity is briefly short: retry with jitter — from
// the third attempt on the fallback model — and only after that stop calling for a while
const RATE_LIMIT_RETRIES = 3;
const FALLBACK_FROM_ATTEMPT = 2;
const retryBaseMs = () => Number(process.env.AI_RETRY_BASE_MS ?? 1000);
const RATE_LIMIT_PAUSE_MS = 30_000;
// When no model is reachable at all (permission errors), wait longer before trying again
const NO_ACCESS_PAUSE_MS = 10 * 60_000;

let pausedUntil = 0;
// Set once the configured model turned out to be unreachable
let useFallback = false;

export class AiUnavailableError extends Error {}

export function aiAvailable(): boolean {
  return Date.now() >= pausedUntil;
}

// Clears a pause and the fallback switch (tests; also safe to call after changing AI_MODEL)
export function resumeAi(): void {
  pausedUntil = 0;
  useFallback = false;
}

// A call that ran out of time is treated the same: the model is busy, not wrong
const isRateLimit = (err: unknown) =>
  /rate.?limit|429|quota|resource.?exhausted|delay was aborted|timeout|timed out/i.test(String(err));
const isNoAccess = (err: unknown) =>
  /do(es)? not have access|free tier|upgrade to paid|403|404|forbidden|not allowed|permission|not found/i.test(String(err));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function generate(task: string, prompt: string): Promise<string> {
  if (!aiAvailable()) throw new AiUnavailableError("AI paused");
  const preferred = useFallback ? FALLBACK_MODEL : MODEL;
  for (let attempt = 0; ; attempt++) {
    const model = attempt >= FALLBACK_FROM_ATTEMPT ? FALLBACK_MODEL : preferred;
    const started = Date.now();
    try {
      // Verdicts are stored for good, so the same message must always get the same one
      const { text } = await generateText({ model, prompt, temperature: 0, timeoutMs: AI_TIMEOUT_MS });
      await logAiCall({ task, model, prompt, output: text, ms: Date.now() - started, ok: true });
      return text;
    } catch (err) {
      await logAiCall({ task, model, prompt, ms: Date.now() - started, ok: false, error: String(err).slice(0, 300) });
      if (isRateLimit(err) && attempt < RATE_LIMIT_RETRIES) {
        await sleep(retryBaseMs() * 2 ** attempt * (0.5 + Math.random()));
        continue;
      }
      if (!isRateLimit(err) && isNoAccess(err) && preferred !== FALLBACK_MODEL) {
        console.error(`AI model ${model} is not reachable; using ${FALLBACK_MODEL}:`, String(err).slice(0, 200));
        useFallback = true;
        return generate(task, prompt);
      }
      if (isRateLimit(err) || isNoAccess(err)) {
        pausedUntil = Date.now() + (isRateLimit(err) ? RATE_LIMIT_PAUSE_MS : NO_ACCESS_PAUSE_MS);
        throw new AiUnavailableError(String(err).slice(0, 200));
      }
      throw err;
    }
  }
}

export async function summarizeQuestion(originalMessage: string): Promise<string> {
  const text = await generate("summary", `Extract the topic of this Slack message in 2-5 words. Output ONLY the topic, nothing else.
ALWAYS write the topic in Korean, even when the message is in English. Keep product names, acronyms and code names as they are (PR, API, Jira, Notion).

Examples:
- "hey can you review the PR I tagged you on?" → "PR 리뷰"
- "what's the latest here?" → "진행 상황"
- "can I get edit access to that exec summary doc?" → "문서 편집 권한"
- "let's discuss the assignment" → "업무 배정 논의"
- "이번 주 배포 일정 언제인가요?" → "배포 일정"
- "견적서 최종본 공유 부탁드립니다" → "견적서 공유"
- "내일 미팅 몇 시로 할까요" → "미팅 시간"
- "혹시 이 데이터 어디서 뽑으셨어요?" → "데이터 출처"

If the message is vague or you can't determine a specific topic, use "확인 요청". NEVER explain your reasoning. Output ONLY the topic.

Message: "${originalMessage}"`);

  const cleaned = text.trim().replace(/[.,"'!?]/g, "");
  // Over-long or non-Korean output means the model explained itself — use a neutral label
  if (cleaned.split(/\s+/).length > 6 || cleaned.length > 40 || !/[가-힣]/.test(cleaned)) return "확인 요청";
  return cleaned;
}

export type ResponseClassification = "answer" | "non-committal";
export type UserMessageClassification = "follow-up" | "self-resolved";

export async function classifyResponse(
  originalQuestion: string,
  response: string
): Promise<ResponseClassification> {
  const text = await generate("classify-response", `You are analyzing a Slack conversation. Someone asked a question and received a response.
Determine if the response is a substantive answer OR a non-committal acknowledgment.
Messages may be in Korean or English.

Non-committal examples: "looking into it", "will check", "let me get back to you", "checking now", "one sec", "on it",
"확인해볼게요", "알아볼게요", "잠시만요", "체크해볼게요", "보고 말씀드릴게요", "나중에 볼게요", "회의 끝나고 볼게요", "넵 확인중입니다"
Answer examples:
- Actual information, solutions, explanations
- "yes", "no", "네", "아니요", direct responses to the question
- Agreement with a plan: "agree", "sounds good", "will do", "좋아요", "그렇게 하죠", "진행해주세요"
- Closure responses: "thanks for...", "perfect", "got it, I'll...", "감사합니다", "해결됐어요", "반영했습니다"
- Any response that indicates the conversation can move forward
- Links/URLs or files (sharing a resource IS a valid answer)
- Short, casual or vague answers and reasons: "그냥요", "그냥 궁금해서요", "몰라요", "글쎄요", "별거 아니에요", "ㅇㅇ"

If the response contains acknowledgment WITH a next action or agreement, classify as "answer".
A reason or fact about something that already happened ("~해서", "~길래", "~거든요", "~했어요") is an answer.
Trailing "..", "ㅋㅋ" or emoji don't change that.
Someone saying they want to know too ("저도 궁금해요", "+1") or only asking back is "non-committal".
Only classify as "non-committal" if the person is purely deferring without substance (promising to check or reply later). When unsure, choose "answer".

Original question: "${originalQuestion}"

Response received: "${response}"

Reply with ONLY one word: "answer" or "non-committal"`);

  // Read the verdict from the start: "answer (not non-committal)" is still an answer
  return /^\W*non-committal/.test(text.toLowerCase().trim()) ? "non-committal" : "answer";
}

export async function classifyUserMessage(
  originalQuestion: string,
  newMessage: string
): Promise<UserMessageClassification> {
  const text = await generate("classify-user-message", `You are analyzing a Slack conversation. Someone asked a question earlier and is now sending another message in the same conversation.
Messages may be in Korean or English.
Determine if their new message is:
- A FOLLOW-UP: they're still waiting for an answer (e.g., "bump", "any update?", "following up", "hey X, checking in on this", "혹시 확인되셨을까요?", "리마인드 드려요", "이거 어떻게 됐나요")
- SELF-RESOLVED: they figured it out themselves or no longer need help (e.g., "nvm", "figured it out", "never mind", "all good", "closing the loop - we went with X", "아 해결했어요", "찾았어요", "괜찮습니다 처리했어요", "이건 무시해주세요")

Short acknowledgements or thanks on their own ("thanks", "ok", "넵", "감사합니다", "네 알겠습니다") are FOLLOW-UP — they are usually a reply to "I'll check" and the question is still open. Only answer SELF-RESOLVED when the message says the issue is solved or no longer needed.

Original question: "${originalQuestion}"

New message: "${newMessage}"

Reply with ONLY one word: "follow-up" or "self-resolved"`);

  return /^\W*self-resolved/.test(text.toLowerCase().trim()) ? "self-resolved" : "follow-up";
}

// "검토 의견 드리겠습니다": does this message promise the reader something later (an answer,
// opinion, file, update)? `previous` is the reader's message it replies to, when there is one.
export async function classifyPromise(message: string, previous?: string): Promise<boolean> {
  const text = await generate("classify-promise", `You are analyzing a Slack conversation. Messages may be in Korean or English.
Determine if the new message PROMISES the reader something they will send or tell later — an answer, opinion,
review result, file, data or update — so the reader is now waiting on the sender.

Promise examples: "검토 의견 드리겠습니다", "확인해서 알려드릴게요", "내일까지 자료 보내드리겠습니다", "정리해서 공유드릴게요",
"I'll get back to you on this", "will send it over tomorrow"
Not a promise:
- Thanks, greetings or requests: "감사드립니다", "검토 부탁드리겠습니다", "잘 부탁드립니다"
- A promise made to someone else: "팀장님께 전달드리겠습니다" (when the reader is not that person)
- The message already delivers it: "결론부터 말씀드리겠습니다. 가능합니다", "공유드립니다 [link]"
- Doing something that sends nothing back to the reader: "회의실 예약해 두겠습니다"
When unsure, choose "other".
${previous ? `\nReader's previous message: "${previous}"\n` : ""}
New message: "${message}"

Reply with ONLY one word: "promise" or "other"`);

  return /^\W*promise/.test(text.toLowerCase().trim());
}
