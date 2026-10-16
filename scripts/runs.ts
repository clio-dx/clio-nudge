// Recent runs (ticks, polls, digests, jobs): node --import ./scripts/register-prod.mjs scripts/runs.ts [n]
import { recentRuns } from "../lib/runs.ts";

for (const { data: r } of (await recentRuns(Number(process.argv[2] ?? 20))).reverse()) {
  const s = r.summary as Record<string, unknown>;
  const brief = r.kind === "deliver" ? (s.sent ? `sent ${s.sent}` : s.skipped ?? s.error) : r.kind === "tick" ? JSON.stringify(s.queued) : r.kind === "poll" ? `errors ${s.errors} incomplete ${(s.incomplete as unknown[])?.length ?? 0}${s.skipped ? " " + s.skipped : ""}` : JSON.stringify(s).slice(0, 120);
  console.log(r.at.toISOString().slice(11, 19), r.kind.padEnd(16), (r.userId ?? "-").padEnd(12), r.ok === false ? "FAIL" : "ok  ", r.ms ? `${(r.ms / 1000).toFixed(1)}s` : "", brief);
}
