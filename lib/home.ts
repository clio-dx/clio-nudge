// What people see when they open Nudge in Slack (bot event app_home_opened): the 홈 tab is
// rebuilt on every visit, and someone who opens the Nudge DM before connecting gets a one-time
// "connect first" message — otherwise a new user lands on an empty screen.
import { createBoundedClient } from "@/lib/slack";
import { getAllUsers, getUser, type NudgeUser } from "@/lib/db";
import { firstTime } from "@/lib/redis";
import { homeView } from "@/lib/nudge-command";
import { notInstalledReply } from "@/lib/messages";

export interface AppHomeOpenedEvent {
  type?: string;
  user?: string;
  channel?: string; // the person's DM with Nudge
  tab?: string; // "home" | "messages"
}

// Bot tokens are per workspace, so anyone's install can talk to someone who hasn't connected yet
export async function workspaceBotToken(teamId: string | undefined): Promise<string | undefined> {
  return (await getAllUsers()).find((u) => !teamId || u.slackTeamId === teamId)?.botToken;
}

// Opens the person's DM with Nudge ("메시지" tab)
function messagesUrl(teamId: string | undefined, appId: string | undefined, dmChannel: string | undefined): string {
  const team = teamId ? `&team=${teamId}` : "";
  if (appId) return `https://slack.com/app_redirect?app=${appId}${team}`;
  return `https://slack.com/app_redirect?channel=${dmChannel ?? ""}${team}`;
}

// Right after connecting: the 홈 tab may still be open on "연결이 필요해요", and Slack only sends
// app_home_opened when someone enters it again
export async function publishHome(user: NudgeUser, appId?: string): Promise<void> {
  await createBoundedClient(user.botToken).views.publish({
    user_id: user.slackUserId,
    view: await homeView(user, messagesUrl(user.slackTeamId, appId, user.botDmChannel)),
  });
}

export async function handleAppHomeOpened(
  event: AppHomeOpenedEvent,
  teamId: string | undefined,
  appId: string | undefined
): Promise<void> {
  const userId = event.user;
  if (!userId) return;
  const user = await getUser(userId);
  const token = user?.botToken ?? (await workspaceBotToken(teamId));
  if (!token) return;
  const client = createBoundedClient(token);

  if (event.tab === "messages") {
    if (!user && event.channel && (await firstTime(`nudge:onboarded:${userId}`))) {
      await client.chat.postMessage({ channel: event.channel, ...notInstalledReply() });
    }
    return;
  }

  const dm = user?.botDmChannel ?? event.channel;
  await client.views.publish({ user_id: userId, view: await homeView(user, messagesUrl(teamId, appId, dm)) });
}
