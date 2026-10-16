import { NextRequest, NextResponse } from "next/server";
import { getUser, saveUser } from "@/lib/db";
import { createSlackClient, getUserTimezone } from "@/lib/slack";
import { postDM } from "@/lib/tick";
import { currentSlot } from "@/lib/schedule";
import { welcomeBlocks } from "@/lib/digest";
import { APP_URL } from "@/lib/messages";
import { slackClientId, slackClientSecret } from "@/lib/gcp";
import { enqueue } from "@/lib/tasks";

// Stores the tokens, sends the welcome DM, and queues the first check (7 days of history) and
// the DM with its result (lib/slack-handlers.ts onboard)
export async function GET(req: NextRequest) {
  const appUrl = APP_URL;
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
        client_id: (await slackClientId()) ?? "",
        client_secret: (await slackClientSecret()) ?? "",
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
      revokedAt: undefined, // connected again
      ...(tz ? { tz } : {}),
      // A new user's first digest is the next scheduled slot, not a catch-up of one that just
      // passed; same when a reinstall sets the timezone for the first time
      ...(!existing || (!existing.tz && tz)
        ? { lastSlot: Math.max(existing?.lastSlot ?? -Infinity, currentSlot(Date.now())) }
        : {}),
    });

    if (!existing) {
      try {
        await postDM(user, welcomeBlocks(), "Nudge가 연결됐어요! 지난 7일 치 놓친 질문을 찾아 몇 분 안에 알려드릴게요");
      } catch (err) {
        console.error("welcome DM failed:", err);
      }
    }
    try {
      await enqueue({ type: "onboard", userId: slackUserId, isNew: !existing, appId: data.app_id }, { name: `onboard-${slackUserId}-${Date.now()}` });
    } catch (err) {
      // The tick's first-report catch-up covers a new user after 20 minutes
      console.error("could not queue onboarding:", String(err).slice(0, 300));
    }

    const installed = existing ? "updated" : "new";
    return NextResponse.redirect(`${appUrl}?installed=${installed}&team=${encodeURIComponent(data.team.id)}`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    return NextResponse.redirect(`${appUrl}?error=server_error`);
  }
}
