// Deterministic stand-in for the AI SDK: keyword rules instead of a model.

export const aiCalls: string[] = [];
// Set to make the next N calls fail like a provider rate limit
export const aiFailures = { rateLimited: 0 };

function quoted(prompt: string, label: string): string {
  return prompt.match(new RegExp(`${label}: "([\\s\\S]*?)"\\n`))?.[1] ?? "";
}

export async function generateText({ prompt }: { prompt: string }): Promise<{ text: string }> {
  if (aiFailures.rateLimited > 0) {
    aiFailures.rateLimited--;
    throw new Error("Rate limit exceeded for model: this team's limit of 5 requests per minute was reached");
  }
  if (prompt.includes('"answer" or "non-committal"')) {
    const response = quoted(prompt, "Response received");
    aiCalls.push(`classify:${response}`);
    return { text: /확인해볼게요|알아볼게요|잠시만|will check|looking into/.test(response) ? "non-committal" : "answer" };
  }
  if (prompt.includes('"follow-up" or "self-resolved"')) {
    const message = quoted(prompt, "New message");
    aiCalls.push(`user:${message}`);
    return { text: /해결|nvm|figured it out/.test(message) ? "self-resolved" : "follow-up" };
  }
  aiCalls.push("summary");
  return { text: "테스트 주제" };
}
