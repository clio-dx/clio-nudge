import { NextRequest, NextResponse } from "next/server";
import { bearerIsGoogleCaller } from "@/lib/google-id-token";
import { RUNTIME_SA } from "@/lib/gcp";
import { runTick } from "@/lib/tick";
import { selfUrl } from "@/lib/tasks";

// Cloud Scheduler, every 5 minutes (signed as nudge-runtime): queues digests and polls that are
// due. Safe to call more often — each user's slot is delivered at most once.
export async function POST(req: NextRequest) {
  if (!(await bearerIsGoogleCaller(req.headers.get("authorization"), { audience: selfUrl(), email: RUNTIME_SA }))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runTick("cloud-scheduler"));
}

export const GET = POST;
