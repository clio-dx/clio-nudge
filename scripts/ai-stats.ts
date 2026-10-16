// AI calls in the last hours: count, failures, latency by task and model
import { backend } from "../lib/store/backend.ts";
import type { AiCall } from "../lib/ai-log.ts";

const since = new Date(Date.now() - Number(process.argv[2] ?? 6) * 3600_000);
const rows = (await backend.query<AiCall>("ai_calls", { where: [["at", ">=", since]] })).map((r) => r.data);
const by = new Map<string, number[]>();
let failed = 0;
for (const r of rows) {
  if (!r.ok) failed++;
  const k = `${r.task} ${r.model} ${r.ok ? "ok" : "fail"}`;
  by.set(k, [...(by.get(k) ?? []), r.ms]);
}
console.log(`calls ${rows.length}, failed ${failed}`);
for (const [k, ms] of by) {
  ms.sort((a, b) => a - b);
  console.log(k, "n", ms.length, "p50", ms[Math.floor(ms.length / 2)], "max", ms.at(-1));
}
for (const r of rows.filter((x) => !x.ok).slice(0, 5)) console.log("error:", r.error?.slice(0, 160));
