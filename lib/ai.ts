import { generateText } from "ai";
import { gateway } from "@ai-sdk/gateway";

// Default model - uses Vercel AI Gateway format: provider/model
const MODEL = process.env.AI_MODEL || "anthropic/claude-haiku-4.5";
// Bounded so a slow model call can't push a cron run past its time limit
const AI_TIMEOUT_MS = 20_000;
// After a rate-limit error, stop calling the model for a while instead of failing every call
const RATE_LIMIT_PAUSE_MS = 60_000;

let pausedUntil = 0;

export class AiUnavailableError extends Error {}

export function aiAvailable(): boolean {
  return Date.now() >= pausedUntil;
}

// Clears a rate-limit pause (tests; also safe to call after changing AI_MODEL)
export function resumeAi(): void {
  pausedUntil = 0;
}

async function generate(prompt: string): Promise<string> {
  if (!aiAvailable()) throw new AiUnavailableError("AI rate limit — paused");
  try {
    const { text } = await generateText({
      model: gateway.languageModel(MODEL),
      timeout: AI_TIMEOUT_MS,
      maxRetries: 1,
      prompt,
    });
    return text;
  } catch (err) {
    if (/rate.?limit|429|quota/i.test(String(err))) {
      pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
      throw new AiUnavailableError(String(err).slice(0, 200));
    }
    throw err;
  }
}

export async function summarizeQuestion(originalMessage: string): Promise<string> {
  const text = await generate(`Extract the topic of this Slack message in 2-4 words. Output ONLY the topic, nothing else.
Write the topic in the same language as the message (Korean message → Korean topic).

Examples:
- "hey can you review the PR I tagged you on?" → "PR review"
- "what's the latest here?" → "status update"
- "can I get edit access to that exec summary doc?" → "doc access"
- "can we get a tax call set up?" → "tax call"
- "이번 주 배포 일정 언제인가요?" → "배포 일정"
- "견적서 최종본 공유 부탁드립니다" → "견적서 공유"
- "내일 미팅 몇 시로 할까요" → "미팅 시간"
- "혹시 이 데이터 어디서 뽑으셨어요?" → "데이터 출처"

If the message is vague or you can't determine a specific topic, use a generic label like "follow-up" / "확인 요청". NEVER explain your reasoning. Output ONLY the topic.

Message: "${originalMessage}"`);

  const cleaned = text.trim().toLowerCase().replace(/[.,"'!?]/g, "");
  // If the model returned something too long, it probably over-explained — use fallback
  if (cleaned.split(/\s+/).length > 5 || cleaned.length > 40) return "follow-up";
  return cleaned;
}

export type ResponseClassification = "answer" | "non-committal";
export type UserMessageClassification = "follow-up" | "self-resolved";

export async function classifyResponse(
  originalQuestion: string,
  response: string
): Promise<ResponseClassification> {
  const text = await generate(`You are analyzing a Slack conversation. Someone asked a question and received a response.
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

If the response contains acknowledgment WITH a next action or agreement, classify as "answer".
Only classify as "non-committal" if the person is purely deferring without substance.

Original question: "${originalQuestion}"

Response received: "${response}"

Reply with ONLY one word: "answer" or "non-committal"`);

  const cleaned = text.toLowerCase().trim();
  return cleaned.includes("non-committal") ? "non-committal" : "answer";
}

export async function classifyUserMessage(
  originalQuestion: string,
  newMessage: string
): Promise<UserMessageClassification> {
  const text = await generate(`You are analyzing a Slack conversation. Someone asked a question earlier and is now sending another message in the same conversation.
Messages may be in Korean or English.
Determine if their new message is:
- A FOLLOW-UP: they're still waiting for an answer (e.g., "bump", "any update?", "following up", "hey X, checking in on this", "혹시 확인되셨을까요?", "리마인드 드려요", "이거 어떻게 됐나요")
- SELF-RESOLVED: they figured it out themselves or no longer need help (e.g., "nvm", "figured it out", "never mind", "all good", "closing the loop - we went with X", "아 해결했어요", "찾았어요", "괜찮습니다 처리했어요", "이건 무시해주세요")

Short acknowledgements or thanks on their own ("thanks", "ok", "넵", "감사합니다", "네 알겠습니다") are FOLLOW-UP — they are usually a reply to "I'll check" and the question is still open. Only answer SELF-RESOLVED when the message says the issue is solved or no longer needed.

Original question: "${originalQuestion}"

New message: "${newMessage}"

Reply with ONLY one word: "follow-up" or "self-resolved"`);

  const cleaned = text.toLowerCase().trim();
  return cleaned.includes("self-resolved") ? "self-resolved" : "follow-up";
}
