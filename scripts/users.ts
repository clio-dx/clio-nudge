// Who is connected: Slack id, name, install date, last poll (no tokens printed)
import { getAllUsers } from "../lib/db.ts";
import { createBoundedClient } from "../lib/slack.ts";
import { getUserFollowUps } from "../lib/store.ts";

for (const u of await getAllUsers()) {
  const info = await createBoundedClient(u.userToken).users.info({ user: u.slackUserId }).catch(() => null);
  const name = (info?.user as { real_name?: string } | undefined)?.real_name ?? "?";
  const counts = [(await getUserFollowUps(u.slackUserId, "incoming")).length, (await getUserFollowUps(u.slackUserId, "outgoing")).length];
  console.log(
    u.slackUserId,
    name,
    "installed", new Date(u.installedAt).toISOString().slice(0, 16),
    "polled", u.lastPolledAt ? new Date(u.lastPolledAt).toISOString().slice(0, 16) : "-",
    "firstScanPending", !!u.firstScanPending,
    "items in/out", counts.join("/"),
    "schedule", JSON.stringify(u.schedule ?? u.reminderHours ?? "default")
  );
}
