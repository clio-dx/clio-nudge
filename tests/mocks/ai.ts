// Deterministic stand-in for the AI SDK: keyword rules instead of a model.

export const aiCalls: string[] = [];

function quoted(prompt: string, label: string): string {
  return prompt.match(new RegExp(`${label}: "([\\s\\S]*?)"\\n`))?.[1] ?? "";
}

export async function generateText({ prompt }: { prompt: string }): Promise<{ text: string }> {
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
