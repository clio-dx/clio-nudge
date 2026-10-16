// What ran and how it went (ticks, polls, digests, jobs) — the admin page's history.
// runs/{id} expire after 30 days (Firestore TTL on expiresAt).
import { backend } from "@/lib/store/backend";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface Run {
  kind: string; // "tick" | "poll" | "deliver" | "job:<type>" …
  userId?: string;
  at: Date;
  ms?: number;
  ok?: boolean;
  summary: Record<string, unknown>;
  expiresAt: Date;
}

// Never fails the work it describes
export async function recordRun(kind: string, summary: Record<string, unknown>, userId?: string, ms?: number): Promise<void> {
  try {
    const ok = summary.ok === undefined ? !summary.error : summary.ok !== false;
    await backend.add("runs", {
      kind,
      userId,
      at: new Date(),
      ms,
      ok,
      // Firestore takes no undefined; keep it a plain object
      summary: JSON.parse(JSON.stringify(summary)),
      expiresAt: new Date(Date.now() + RETENTION_MS),
    } satisfies Run);
  } catch (err) {
    console.error("recordRun failed:", String(err).slice(0, 200));
  }
}

// Everything since `since` (one range filter on `at`, no extra index)
export async function runsSince(since: Date, limit = 5000) {
  return backend.query<Run>("runs", { where: [["at", ">=", since]], orderBy: ["at", "desc"], limit });
}

export async function recentRuns(limit = 100, kind?: string) {
  return backend.query<Run>("runs", {
    ...(kind ? { where: [["kind", "==", kind]] } : {}),
    orderBy: ["at", "desc"],
    limit,
  });
}
