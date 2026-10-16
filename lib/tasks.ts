// Background work: Slack wants an answer within 3 seconds, so routes acknowledge and hand the
// rest to a Cloud Tasks queue, which calls /api/tasks/run (signed as nudge-runtime). With
// NUDGE_TASKS unset (tests, local runs) the job just runs in place.
import { GcpError, gcpFetch, PROJECT_ID, REGION, RUNTIME_SA } from "@/lib/gcp";
import type { Job } from "@/lib/jobs";

export type Queue = "slack" | "work";

// Where the jobs run: the public service (the admin service enqueues there too)
export const selfUrl = () => process.env.NUDGE_SELF_URL || process.env.APP_URL || "http://localhost:3000";

// Cloud Tasks names allow [A-Za-z0-9_-]
const taskId = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 400);

export interface EnqueueOptions {
  queue?: Queue;
  // Same name twice → the second is dropped (Cloud Tasks keeps names for about an hour after a task ran)
  name?: string;
  delaySeconds?: number;
  deadlineSeconds?: number;
}

// True when queued (or run), false when a task with that name already exists
export async function enqueue(job: Job, opts: EnqueueOptions = {}): Promise<boolean> {
  if (process.env.NUDGE_TASKS !== "cloud") {
    // Like /api/tasks/run: a failing job is logged, it doesn't fail whoever queued it
    const { runJob } = await import("@/lib/jobs");
    await runJob(job).catch((err) => console.error(`job ${job.type} failed:`, String(err).slice(0, 300)));
    return true;
  }
  const queue = opts.queue ?? "work";
  const parent = `projects/${PROJECT_ID}/locations/${REGION}/queues/nudge-${queue}`;
  const url = selfUrl();
  const task: Record<string, unknown> = {
    dispatchDeadline: `${opts.deadlineSeconds ?? (queue === "slack" ? 300 : 1800)}s`,
    httpRequest: {
      httpMethod: "POST",
      url: `${url}/api/tasks/run`,
      headers: { "Content-Type": "application/json" },
      body: Buffer.from(JSON.stringify(job), "utf8").toString("base64"),
      oidcToken: { serviceAccountEmail: RUNTIME_SA, audience: url },
    },
  };
  if (opts.name) task.name = `${parent}/tasks/${taskId(opts.name)}`;
  if (opts.delaySeconds) task.scheduleTime = new Date(Date.now() + opts.delaySeconds * 1000).toISOString();
  try {
    // Slack routes call this inside Slack's 3 seconds
    await gcpFetch(`https://cloudtasks.googleapis.com/v2/${parent}/tasks`, { body: { task }, timeoutMs: queue === "slack" ? 2500 : 15_000 });
    return true;
  } catch (err) {
    if (err instanceof GcpError && err.status === 409) return false; // already queued under that name
    throw err;
  }
}
