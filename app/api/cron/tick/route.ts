import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron-auth";
import { runTick } from "@/lib/tick";

// Polls Slack and sends digests for every user whose schedule is due this hour.
// Triggered daily by Vercel Cron (Hobby limit) and hourly by GitHub Actions; safe to
// call more often — each user's slot is delivered at most once.
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const source = await authorizeCron(req.headers.get("authorization"));
  if (!source) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const summary = await runTick(source, now, now + 240_000);
  return NextResponse.json(summary);
}
