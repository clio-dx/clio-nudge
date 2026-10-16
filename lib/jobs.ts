// Every kind of background work, run by /api/tasks/run (Cloud Tasks) or in place (tests, local).
import { handleBlockActions, handleEvent, handleSlashCommand, onboard, type BlockActionsPayload, type EventPayload, type SlashCommand } from "@/lib/slack-handlers";
import { deliverJob, pollJob } from "@/lib/tick";
import { getUser } from "@/lib/db";
import { pollUser } from "@/lib/poll";
import { sendFirstReport } from "@/lib/first-report";
import { importFromVercel, setVercelState } from "@/lib/migration";
import { recordRun } from "@/lib/runs";

export type Job =
  | { type: "slack-event"; payload: EventPayload }
  | { type: "slack-command"; command: SlashCommand }
  | { type: "slack-actions"; payload: BlockActionsPayload }
  | { type: "onboard"; userId: string; isNew: boolean; appId?: string }
  | { type: "deliver"; userId: string }
  | { type: "poll"; userId: string }
  | { type: "first-report"; userId: string }
  | { type: "migrate"; freeze?: boolean }
  | { type: "vercel-state"; action: "freeze" | "unfreeze" | "lock" };

// New users the OAuth callback didn't send the first check's result to: one more poll, then that DM
async function firstReportJob(userId: string): Promise<boolean> {
  const user = await getUser(userId);
  if (!user) return false;
  const stats = await pollUser(user, Date.now() + 300_000);
  return sendFirstReport((await getUser(userId)) ?? user, stats.skipped ? undefined : stats);
}

// Slack work is chatty and frequent: only the heavier jobs leave a run record
const RECORDED = new Set<Job["type"]>(["onboard", "poll", "first-report", "migrate", "vercel-state"]);

export async function runJob(job: Job): Promise<unknown> {
  const started = Date.now();
  let result: unknown;
  switch (job.type) {
    case "slack-event":
      result = await handleEvent(job.payload);
      break;
    case "slack-command":
      result = await handleSlashCommand(job.command);
      break;
    case "slack-actions":
      result = await handleBlockActions(job.payload);
      break;
    case "onboard":
      result = await onboard(job.userId, job.isNew, job.appId);
      break;
    case "deliver":
      result = await deliverJob(job.userId);
      break;
    case "poll":
      result = await pollJob(job.userId);
      break;
    case "first-report":
      result = { sent: await firstReportJob(job.userId) };
      break;
    case "migrate":
      result = await importFromVercel({ freeze: job.freeze });
      break;
    case "vercel-state":
      result = await setVercelState(job.action);
      break;
  }
  if (RECORDED.has(job.type)) {
    const userId = "userId" in job ? job.userId : undefined;
    await recordRun(`job:${job.type}`, { ...(result && typeof result === "object" ? result : {}) }, userId, Date.now() - started);
  }
  return result;
}
