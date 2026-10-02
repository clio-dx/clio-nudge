import { NextResponse } from "next/server";

// Keep in sync with slack-app-manifest.json
const BOT_SCOPES = ["chat:write", "im:write", "commands"];
const USER_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "search:read",
  "users:read",
];

export async function GET() {
  const clientId = process.env.SLACK_CLIENT_ID;
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/slack/oauth/callback`;

  // Request both bot and user scopes
  const slackUrl = new URL("https://slack.com/oauth/v2/authorize");
  slackUrl.searchParams.set("client_id", clientId!);
  slackUrl.searchParams.set("scope", BOT_SCOPES.join(","));
  slackUrl.searchParams.set("user_scope", USER_SCOPES.join(","));
  slackUrl.searchParams.set("redirect_uri", redirectUri);

  return NextResponse.redirect(slackUrl.toString());
}
