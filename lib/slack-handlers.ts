// What happens after Slack got its quick answer: the routes verify the request, acknowledge, and
// queue one of these (lib/tasks.ts). The work is the same as when it ran inside Vercel's waitUntil.
import { createBoundedClient, createSlackClient } from "@/lib/slack";
import { getUser, updateUser, type NudgeUser } from "@/lib/db";
import { dmResponder, parseDmText, runCommand, type Reply, type Responder } from "@/lib/nudge-command";
import { parseCommand } from "@/lib/command";
import { DM_PREFIX, notInstalledReply, SLASH_PREFIX } from "@/lib/messages";
import { handleAppHomeOpened, publishHome, workspaceBotToken, type AppHomeOpenedEvent } from "@/lib/home";
import { QUICK_ACTIONS, firstCheckFailedBlocks } from "@/lib/digest";
import { dismissGroup, type DismissValue } from "@/lib/dismiss";
import { pollUser, type PollStats } from "@/lib/poll";
import { postDM } from "@/lib/tick";
import { sendFirstReport } from "@/lib/first-report";

const FAILED = "😵 처리하다가 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.";

// ---------------------------------------------------------------------------
// Events: people typing in the Nudge DM (message.im), opening Nudge (app_home_opened)

export interface MessageEvent {
  type?: string;
  channel_type?: string;
  channel?: string;
  user?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
}

export interface EventPayload {
  type?: string;
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event?: MessageEvent;
}

export function isPersonTypingInNudgeDm(payload: EventPayload): boolean {
  const event = payload.event;
  return (
    payload.type === "event_callback" &&
    event?.type === "message" &&
    event.channel_type === "im" &&
    !event.bot_id &&
    !event.subtype &&
    !!event.user
  );
}

async function handleDmMessage(event: MessageEvent, teamId: string | undefined) {
  const { user: userId, channel, text } = event;
  if (!userId || !channel || !text) return;

  const user = await getUser(userId);
  if (!user) {
    // Typed in the Nudge DM before connecting: explain how to start
    const token = await workspaceBotToken(teamId);
    if (token) await createBoundedClient(token).chat.postMessage({ channel, ...notInstalledReply() });
    return;
  }
  if (user.botDmChannel !== channel) await updateUser(userId, { botDmChannel: channel });

  const out = dmResponder(user.botToken, channel, event.thread_ts);
  try {
    await runCommand(user, parseDmText(text), out);
  } catch (err) {
    console.error("DM command failed:", err);
    await out.send({ text: FAILED }).catch(() => {});
  }
}

export async function handleEvent(payload: EventPayload): Promise<void> {
  if (isPersonTypingInNudgeDm(payload)) {
    await handleDmMessage(payload.event!, payload.team_id);
  } else if (payload.type === "event_callback" && payload.event?.type === "app_home_opened") {
    await handleAppHomeOpened(payload.event as AppHomeOpenedEvent, payload.team_id, payload.api_app_id);
  }
}

// ---------------------------------------------------------------------------
// /nudge

async function respond(responseUrl: string, reply: Reply & { replace_original?: boolean }): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", ...reply }),
  });
}

// Slash-command replies are ephemeral messages posted through the response_url
function slashResponder(responseUrl: string, prefix: string): Responder {
  return {
    prefix,
    send: (reply) => respond(responseUrl, reply),
    replace: (reply) => respond(responseUrl, { replace_original: true, ...reply }),
  };
}

export interface SlashCommand {
  command: string;
  userId: string;
  responseUrl: string;
  channelId: string | null;
  text: string;
}

export async function handleSlashCommand({ userId, responseUrl, channelId, text }: SlashCommand): Promise<void> {
  try {
    const user = await getUser(userId);
    if (!user) {
      await respond(responseUrl, notInstalledReply());
      return;
    }
    // Typed inside the Nudge DM: show commands without "/nudge", like the DM's own replies and buttons
    const prefix = channelId && channelId === user.botDmChannel ? DM_PREFIX : SLASH_PREFIX;
    await runCommand(user, parseCommand(text), slashResponder(responseUrl, prefix));
  } catch (err) {
    console.error("/nudge failed:", err);
    await respond(responseUrl, { text: FAILED }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Buttons

export interface BlockActionsPayload {
  type?: string;
  user?: { id?: string };
  actions?: { action_id?: string; value?: string }[];
  container?: { is_ephemeral?: boolean };
  response_url?: string;
  channel?: { id?: string };
  message?: { ts?: string; blocks?: { type?: string }[] };
}

async function postToResponseUrl(url: string, body: Record<string, unknown>): Promise<void> {
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// Rewrites the message the button sits on: an ephemeral /nudge list via its response_url,
// a digest DM via chat.update
async function updateOriginal(payload: BlockActionsPayload, user: NudgeUser, reply: Reply): Promise<void> {
  const text = reply.text ?? "Nudge";
  if (payload.container?.is_ephemeral && payload.response_url) {
    await postToResponseUrl(payload.response_url, { replace_original: true, text, blocks: reply.blocks ?? [] });
  } else if (payload.channel?.id && payload.message?.ts) {
    await createSlackClient(user.botToken).chat.update({
      channel: payload.channel.id,
      ts: payload.message.ts,
      text,
      blocks: reply.blocks ?? [],
    });
  }
}

async function handleQuickAction(payload: BlockActionsPayload, user: NudgeUser, actionId: string) {
  // Commands in the reply are written the way they're typed where the button was clicked
  const prefix = payload.channel?.id && payload.channel.id === user.botDmChannel ? DM_PREFIX : SLASH_PREFIX;

  if (actionId === QUICK_ACTIONS.refresh) {
    // Show progress in place, then replace the same message with the fresh list
    const inPlace: Responder = {
      prefix,
      send: (reply) => updateOriginal(payload, user, reply),
      replace: (reply) => updateOriginal(payload, user, reply),
    };
    await runCommand(user, { type: "refresh" }, inPlace);
    return;
  }

  // 📋 목록 보기: the list as a new message below, as if they had typed 목록
  if (actionId === QUICK_ACTIONS.list && payload.channel?.id && !payload.container?.is_ephemeral) {
    const out = dmResponder(user.botToken, payload.channel.id);
    try {
      await runCommand(user, { type: "list" }, { ...out, prefix });
    } catch (err) {
      console.error("list button failed:", err);
      await out.send({ text: FAILED }).catch(() => {});
    }
    return;
  }

  // Settings / help: a separate message only the clicker sees, the digest stays as it is
  const ephemeral: Responder = {
    prefix,
    send: async (reply) => {
      if (payload.response_url) {
        await postToResponseUrl(payload.response_url, {
          response_type: "ephemeral",
          replace_original: false,
          text: reply.text ?? "Nudge",
          ...(reply.blocks ? { blocks: reply.blocks } : {}),
        });
      }
    },
    replace: async (reply) => ephemeral.send(reply),
  };
  try {
    const command = actionId === QUICK_ACTIONS.help ? "도움말" : actionId === QUICK_ACTIONS.list ? "목록" : "설정";
    await runCommand(user, parseCommand(command), ephemeral);
  } catch (err) {
    console.error("quick action failed:", err);
    await ephemeral.send({ text: FAILED }).catch(() => {});
  }
}

async function handleDismiss(payload: BlockActionsPayload, user: NudgeUser, rawValue: string | undefined) {
  let value: DismissValue;
  try {
    value = JSON.parse(rawValue || "{}");
  } catch {
    return;
  }
  // A list (also a digest rewritten by 🔄) stays a list. Ephemeral messages are always
  // /nudge lists (buttons from before `l` too).
  const isList = value.l === 1 || payload.container?.is_ephemeral === true;
  const prefix = payload.channel?.id === user.botDmChannel ? DM_PREFIX : SLASH_PREFIX;
  const reply = await dismissGroup(user, value, isList, prefix);
  if (reply) await updateOriginal(payload, user, reply);
}

export async function handleBlockActions(payload: BlockActionsPayload): Promise<void> {
  const action = payload.actions?.[0];
  const userId = payload.user?.id;
  if (!action?.action_id || !userId) return;

  const user = await getUser(userId);
  if (!user) return;

  if (Object.values(QUICK_ACTIONS).includes(action.action_id as (typeof QUICK_ACTIONS)[keyof typeof QUICK_ACTIONS])) {
    await handleQuickAction(payload, user, action.action_id);
  } else if (action.action_id.startsWith("dismiss_")) {
    await handleDismiss(payload, user, action.value);
  }
}

// ---------------------------------------------------------------------------
// Connecting (after the OAuth callback stored the tokens and sent the welcome DM)

// Without Vercel's 5-minute limit the first check gets several polls to read the whole 7 days
const ONBOARD_BUDGET_MS = 12 * 60_000;
const MAX_FIRST_POLLS = 4;

export async function onboard(userId: string, isNew: boolean, appId?: string): Promise<void> {
  const user = await getUser(userId);
  if (!user) return;
  try {
    await publishHome(user, appId);
  } catch (err) {
    console.error("home tab publish failed:", err);
  }

  const until = Date.now() + ONBOARD_BUDGET_MS;
  let stats: PollStats | undefined;
  try {
    for (let i = 0; i < MAX_FIRST_POLLS && Date.now() < until - 60_000; i++) {
      const current = (await getUser(userId)) ?? user;
      if (i > 0 && !current.firstScanPending) break;
      stats = await pollUser(current, Math.min(until - 30_000, Date.now() + 300_000));
      console.log("first poll", userId, i, JSON.stringify({ ...stats, errors: stats.errors.length }));
      if (stats.skipped) break;
    }
  } catch (err) {
    console.error("first poll failed:", err);
    // The welcome DM promised a result: say it didn't work out rather than going quiet
    if (isNew) await postDM(user, firstCheckFailedBlocks(), "Nudge: 첫 확인 중 문제가 생겼어요").catch(() => {});
    return;
  }
  if (!isNew || !stats) return; // reinstalls keep their usual digests
  if (stats.skipped) {
    // "poll already running": 🔄 is already showing the list
    await updateUser(userId, { firstReportAt: Date.now() }).catch(() => {});
    return;
  }
  try {
    await sendFirstReport((await getUser(userId)) ?? user, stats);
  } catch (err) {
    console.error("first report DM failed:", err);
  }
}
