// Gemini on Vertex AI, called directly (generateContent) as the runtime service account.
// gemini-3.8-flash lives on the "global" location only.
import { gcpFetch, PROJECT_ID } from "@/lib/gcp";

const LOCATION = process.env.VERTEX_LOCATION || "global";

interface GenerateResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
}

// Classification and 2-5 word topics need almost no reasoning: Gemini 3's default thinking takes
// 25-60 s a call, "LOW" about 1.5 s (MINIMAL is rejected). 2.5 models take a budget instead.
function thinkingConfig(model: string) {
  return model.startsWith("gemini-2.") ? { thinkingBudget: 0 } : { thinkingLevel: "LOW" };
}

export async function generateText({
  model,
  prompt,
  temperature = 0,
  timeoutMs = 20_000,
}: {
  model: string;
  prompt: string;
  temperature?: number;
  timeoutMs?: number;
}): Promise<{ text: string }> {
  const host = LOCATION === "global" ? "aiplatform.googleapis.com" : `${LOCATION}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${model}:generateContent`;
  const res = await gcpFetch<GenerateResponse>(url, {
    body: {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature, thinkingConfig: thinkingConfig(model) },
    },
    timeoutMs,
  });
  const candidate = res.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error(`empty answer from ${model} (${candidate?.finishReason ?? "no candidate"})`);
  return { text };
}
