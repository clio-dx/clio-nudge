// Deterministic stand-in for lib/vertex.ts (Gemini): keyword rules instead of a model.

export const aiCalls: string[] = [];
// Set to make the next N calls fail like a provider rate limit, or a model unavailable on the plan
// delayAborted: a 429 whose retry-after wait the call timeout cut short
export const aiFailures = { rateLimited: 0, delayAborted: 0, paidOnly: new Set<string>() };
export const modelsUsed: string[] = [];
export const temperatures: (number | undefined)[] = [];
// Raw model output to return for a given reply / message text, ahead of the keyword rules
// (simulates a model that misjudges, or answers wordily)
export const aiVerdicts = new Map<string, string>();

function quoted(prompt: string, label: string): string {
  return prompt.match(new RegExp(`${label}: "([\\s\\S]*?)"\\n`))?.[1] ?? "";
}

export async function generateText({
  prompt,
  model,
  temperature,
}: {
  prompt: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
}): Promise<{ text: string }> {
  modelsUsed.push(model);
  temperatures.push(temperature);
  if (aiFailures.paidOnly.has(model)) {
    throw new Error(`POST https://aiplatform.googleapis.com/v1/... → 404: Publisher model ${model} was not found or your project does not have access to it`);
  }
  if (aiFailures.delayAborted > 0) {
    aiFailures.delayAborted--;
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  }
  if (aiFailures.rateLimited > 0) {
    aiFailures.rateLimited--;
    throw new Error("POST https://aiplatform.googleapis.com/v1/... → 429: RESOURCE_EXHAUSTED Resource exhausted. Please try again later.");
  }
  if (prompt.includes('"promise" or "other"')) {
    const message = quoted(prompt, "New message");
    aiCalls.push(`promise:${message}`);
    if (aiVerdicts.has(message)) return { text: aiVerdicts.get(message)! };
    return { text: /드리겠|드릴게|I'll/.test(message) && !/께 전달/.test(message) ? "promise" : "other" };
  }
  if (prompt.includes('"answer" or "non-committal"')) {
    const response = quoted(prompt, "Response received");
    aiCalls.push(`classify:${response}`);
    if (aiVerdicts.has(response)) return { text: aiVerdicts.get(response)! };
    return { text: /확인해볼게요|알아볼게요|잠시만|will check|looking into/.test(response) ? "non-committal" : "answer" };
  }
  if (prompt.includes('"follow-up" or "self-resolved"')) {
    const message = quoted(prompt, "New message");
    aiCalls.push(`user:${message}`);
    if (aiVerdicts.has(message)) return { text: aiVerdicts.get(message)! };
    return { text: /해결|nvm|figured it out/.test(message) ? "self-resolved" : "follow-up" };
  }
  aiCalls.push("summary");
  return { text: "테스트 주제" };
}
