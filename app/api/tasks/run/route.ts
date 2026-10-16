import { NextRequest, NextResponse } from "next/server";
import { bearerIsGoogleCaller } from "@/lib/google-id-token";
import { RUNTIME_SA } from "@/lib/gcp";
import { runJob, type Job } from "@/lib/jobs";
import { selfUrl } from "@/lib/tasks";

// Cloud Tasks delivers queued jobs here, signed as nudge-runtime. Errors are logged, not
// retried: most jobs post Slack messages, and a retry would post them twice.
export const maxDuration = 1800;

export async function POST(req: NextRequest) {
  const caller = { audience: selfUrl(), email: RUNTIME_SA };
  if (!(await bearerIsGoogleCaller(req.headers.get("authorization"), caller))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let job: Job;
  try {
    job = (await req.json()) as Job;
  } catch {
    return NextResponse.json({ error: "Invalid job" }, { status: 400 });
  }
  try {
    const result = await runJob(job);
    return NextResponse.json({ ok: true, type: job.type, result: result ?? null });
  } catch (err) {
    console.error(`job ${job.type} failed:`, err);
    return NextResponse.json({ ok: false, type: job.type, error: String(err).slice(0, 500) });
  }
}
