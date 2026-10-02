import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getUser, saveUser, type NudgeUser } from "@/lib/db";
import { createSlackClient, getUserTimezone } from "@/lib/slack";
import { pollUser } from "@/lib/poll";
import { postDM } from "@/lib/tick";
import { currentSlot } from "@/lib/schedule";
import { welcomeBlocks } from "@/lib/digest";
import { publishHome } from "@/lib/home";

// The first poll (7 days of history) runs in waitUntil
export const maxDuration = 300;

async function onboard(user: NudgeUser, isNew: boolean, appId?: string) {
  if (isNew) {
    try {
      await postDM(user, welcomeBlocks(), "Nudge가 연결됐어요! 잠시 뒤 목록을 한번 볼까요?");
    } catch (err) {
      console.error("welcome DM failed:", err);
    }
  }
  // Re-read so the poll and the 홈 tab know the Nudge DM channel recorded above
  const fresh = (await getUser(user.slackUserId)) ?? user;
  try {
    await publishHome(fresh, appId);
  } catch (err) {
    console.error("home tab publish failed:", err);
  }
  try {
    const stats = await pollUser(fresh, Date.now() + 240_000);
    console.log("first poll", user.slackUserId, JSON.stringify({ ...stats, errors: stats.errors.length }));
  } catch (err) {
    console.error("first poll failed:", err);
  }
}

export async function GET(req: NextRequest) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(`${appUrl}?error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return NextResponse.redirect(`${appUrl}?error=no_code`);
  }

  try {
    // Exchange code for tokens
    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID!,
        client_secret: process.env.SLACK_CLIENT_SECRET!,
        code,
        redirect_uri: `${appUrl}/api/slack/oauth/callback`,
      }),
    });

    const data = await response.json();

    if (!data.ok) {
      console.error("OAuth error:", data.error);
      return NextResponse.redirect(`${appUrl}?error=${encodeURIComponent(data.error)}`);
    }

    const slackUserId: string = data.authed_user.id;
    const userToken: string = data.authed_user.access_token;
    const existing = await getUser(slackUserId);

    // Reinstalling only refreshes credentials; schedule and tracking settings are kept
    const tz = existing?.tz ?? (await getUserTimezone(createSlackClient(userToken), slackUserId)) ?? undefined;
    const user = await saveUser({
      slackUserId,
      slackTeamId: data.team.id,
      botToken: data.access_token,
      userToken,
      installedAt: existing?.installedAt ?? Date.now(),
      ...(existing ? {} : { firstScanPending: true }),
      ...(tz ? { tz } : {}),
      // A new user's first digest is the next scheduled slot, not a catch-up of one that just
      // passed; same when a reinstall sets the timezone for the first time
      ...(!existing || (!existing.tz && tz)
        ? { lastSlot: Math.max(existing?.lastSlot ?? -Infinity, currentSlot(Date.now())) }
        : {}),
    });

    waitUntil(onboard(user, !existing, data.app_id));

    const installed = existing ? "updated" : "new";
    return NextResponse.redirect(`${appUrl}?installed=${installed}&team=${encodeURIComponent(data.team.id)}`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    return NextResponse.redirect(`${appUrl}?error=server_error`);
  }
}
