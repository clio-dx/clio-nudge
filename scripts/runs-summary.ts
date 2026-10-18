// Run counts per day and kind since N days ago, plus every failed run and every digest sent
import { runsSince } from "../lib/runs.ts";

const days = Number(process.argv[2] ?? 3);
const rows = (await runsSince(new Date(Date.now() - days * 86400_000), 20000)).map((r) => r.data).reverse();
const kst = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 16);
const by = new Map<string, { n: number; fail: number }>();
for (const r of rows) {
  const k = `${kst(r.at).slice(0, 10)} ${r.kind}`;
  const v = by.get(k) ?? { n: 0, fail: 0 };
  v.n++;
  if (r.ok === false) v.fail++;
  by.set(k, v);
}
for (const [k, v] of by) console.log(k.padEnd(28), "runs", String(v.n).padStart(4), "failed", v.fail);
console.log("--- digests sent (KST)");
for (const r of rows.filter((r) => r.kind === "deliver")) {
  const s = r.summary as Record<string, unknown>;
  console.log(kst(r.at), r.userId, s.sent ? `sent ${s.sent}` : s.skipped ?? s.error);
}
console.log("--- failures");
for (const r of rows.filter((r) => r.ok === false).slice(-15)) console.log(kst(r.at), r.kind, r.userId ?? "-", JSON.stringify(r.summary).slice(0, 200));
