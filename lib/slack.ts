import { WebClient } from "@slack/web-api";
import crypto from "crypto";

// Create a WebClient with a specific token
export function createSlackClient(token: string): WebClient {
  return new WebClient(token);
}

// For cron work (polling, digests): bounded request time and retries, so a rate-limited or
// hung call can't hold a run for the client's default ~30 minutes of retries.
export function createBoundedClient(token: string): WebClient {
  return new WebClient(token, {
    timeout: 20_000,
    retryConfig: { retries: 2, maxRetryTime: 45_000 },
  });
}

// Slack platform error code ("thread_not_found", "channel_not_found", ...) if any
export function slackErrorCode(err: unknown): string | undefined {
  return (err as { data?: { error?: string } })?.data?.error;
}

export function verifySlackRequest(
  signature: string | null,
  timestamp: string | null,
  body: string
): boolean {
  if (!signature || !timestamp) return false;

  const signingSecret = process.env.SLACK_SIGNING_SECRET!;
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;

  if (parseInt(timestamp) < fiveMinutesAgo) return false;

  const sigBaseString = `v0:${timestamp}:${body}`;
  const mySignature =
    "v0=" +
    crypto.createHmac("sha256", signingSecret).update(sigBaseString).digest("hex");

  const a = Buffer.from(mySignature);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Cache workspace URLs so we only call auth.test once per token
const teamUrlCache = new Map<string, string>();

export async function getTeamUrl(client: WebClient): Promise<string> {
  const token = client.token;
  if (token && teamUrlCache.has(token)) {
    return teamUrlCache.get(token)!;
  }
  try {
    const auth = await client.auth.test();
    // auth.url is like "https://myworkspace.slack.com/"
    const url = (auth.url as string)?.replace(/\/$/, "") || "https://slack.com";
    if (token) teamUrlCache.set(token, url);
    return url;
  } catch {
    return "https://slack.com";
  }
}

export function getThreadLink(teamUrl: string, channel: string, messageTs: string, parentThreadTs?: string): string {
  // Convert timestamp to link format (remove the dot)
  const linkTs = messageTs.replace(".", "");

  // If message is in a thread, link directly to that message in the thread
  if (parentThreadTs && parentThreadTs !== messageTs) {
    return `${teamUrl}/archives/${channel}/p${linkTs}?thread_ts=${parentThreadTs}&cid=${channel}`;
  }

  // Standard link format (works for channels and DMs)
  return `${teamUrl}/archives/${channel}/p${linkTs}`;
}

interface ConversationInfo {
  is_im?: boolean;
  is_mpim?: boolean;
  user?: string;
  name?: string;
  name_normalized?: string;
}

async function conversationInfo(client: WebClient, channel: string): Promise<ConversationInfo | null> {
  try {
    const info = await client.conversations.info({ channel });
    return (info.channel as ConversationInfo) ?? null;
  } catch {
    return null;
  }
}

// Short display name for a user (display name → real name → handle)
export async function getUserName(client: WebClient, userId: string): Promise<string> {
  try {
    const userInfo = await client.users.info({ user: userId });
    const u = userInfo.user;
    return u?.profile?.display_name || u?.real_name || u?.name || "";
  } catch {
    return "";
  }
}

// IANA timezone from the user's Slack profile (users:read)
export async function getUserTimezone(client: WebClient, userId: string): Promise<string | null> {
  try {
    const userInfo = await client.users.info({ user: userId });
    return userInfo.user?.tz || null;
  } catch {
    return null;
  }
}

// Resolve a channel ID to a short label: name for DMs, #channel for channels
export async function getConversationLabel(client: WebClient, channel: string): Promise<string> {
  const ch = await conversationInfo(client, channel);
  if (!ch) return "대화";

  if (ch.is_im) {
    if (!ch.user) return "DM";
    const name = await getUserName(client, ch.user);
    // First word only keeps labels short ("Kim Minji" → "Kim"; Korean names stay whole)
    return name.split(" ")[0] || "DM";
  }

  if (ch.is_mpim) return "그룹 DM";

  const name = ch.name_normalized || ch.name;
  return name ? `#${name}` : "채널";
}

// Check if a channel is a DM or MPIM (group DM)
export async function isDMOrMPIM(client: WebClient, channel: string): Promise<boolean> {
  // D = direct message
  if (channel.startsWith("D")) return true;
  const ch = await conversationInfo(client, channel);
  return ch?.is_mpim === true || ch?.is_im === true;
}

export function escapeSlackText(text: string): string {
  // Escape special characters that break Slack mrkdwn links
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "│") // Replace pipe with similar unicode char
    .replace(/\n/g, " ") // Replace newlines with space
    .replace(/\r/g, ""); // Remove carriage returns
}
