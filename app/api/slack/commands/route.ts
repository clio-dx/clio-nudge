import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { createSlackClient, getUserTimezone, verifySlackRequest } from "@/lib/slack";
import { getUser, updateUser, type NudgeUser } from "@/lib/db";
import { pollUser } from "@/lib/poll";
import { buildDigestBlocks, formatAge, groupCounts, loadVisible, MIN_AGE_MS } from "@/lib/digest";
import { getUserFollowUps } from "@/lib/redis";
import { hourlyTriggerActive, settleBy, teamUrlFor } from "@/lib/tick";
import { applyScheduleUpdate, parseCommand } from "@/lib/command";
import {
  currentSlot,
  formatSchedule,
  formatSlotTime,
  formatTimezone,
  isValidTimezone,
  nextSlotTime,
  resolveSchedule,
  resolveTimezone,
  worksWithDailyCronOnly,
} from "@/lib/schedule";
import { HELP_TEXT, HOURLY_INACTIVE_WARNING, INTERVAL_NOTE, NOT_INSTALLED_TEXT } from "@/lib/messages";

// /nudge refresh polls Slack inside waitUntil
export const maxDuration = 300;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = any;

interface Reply {
  text?: string;
  blocks?: Block[];
  replace_original?: boolean;
}

async function respond(responseUrl: string, reply: Reply): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", ...reply }),
  });
}

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(text: string): Block {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

// After a schedule/timezone change, start from the next slot instead of catching up on one
// that already passed (the reply announces "다음 알림 …").
function skipPastSlots(user: NudgeUser): Pick<NudgeUser, "lastSlot"> {
  return { lastSlot: Math.max(user.lastSlot ?? -Infinity, currentSlot(Date.now())) };
}

// Pick up the timezone from the Slack profile the first time we see the user
async function ensureTimezone(user: NudgeUser): Promise<NudgeUser> {
  if (user.tz) return user;
  const tz = await getUserTimezone(createSlackClient(user.userToken), user.slackUserId);
  if (!tz || !isValidTimezone(tz)) return user;
  return (await updateUser(user.slackUserId, { tz, ...skipPastSlots(user) })) ?? user;
}

// "평일 오전 8시 (한국 시간)" + next delivery + warnings
async function scheduleSummary(user: NudgeUser): Promise<{ line: string; notes: string[] }> {
  const { schedule, paused } = resolveSchedule(user);
  const tz = resolveTimezone(user);
  if (paused) return { line: "*꺼짐* — `/nudge on`으로 다시 켤 수 있어요", notes: [] };

  const notes: string[] = [];
  const next = nextSlotTime(schedule, tz, Date.now());
  const nextText = next ? ` · 다음 알림 ${formatSlotTime(next, tz)}` : "";
  if (schedule.kind === "interval") notes.push(INTERVAL_NOTE);
  if (!worksWithDailyCronOnly(schedule, tz, Date.now()) && !(await hourlyTriggerActive())) {
    notes.push(HOURLY_INACTIVE_WARNING);
  }
  return { line: `*${formatSchedule(schedule)}* (${formatTimezone(tz)})${nextText}`, notes };
}

const QUICK_COMMANDS =
  "`/nudge list` 목록 · `/nudge refresh` 지금 확인 · `/nudge 매일 9시` · `/nudge 매시간` · `/nudge off` · `/nudge help` 전체 사용법";

async function statusReply(user: NudgeUser): Promise<Reply> {
  const { line, notes } = await scheduleSummary(user);
  const counts = groupCounts(await loadVisible(user));
  const onOff = (v: boolean | undefined) => (v === false ? "꺼짐" : "켜짐");
  const lastCheck = user.lastPolledAt ? `마지막 확인 ${formatAge(Date.now() - user.lastPolledAt)}` : "아직 확인 전";

  return {
    blocks: [
      section(
        [
          "*⚙️ 내 Nudge 설정*",
          `• ⏰ 알림: ${line}`,
          `• 🎯 추적: 📥 받은 질문 ${onOff(user.trackIncoming)} · 📤 보낸 질문 ${onOff(user.trackOutgoing)}`,
          `• 📋 지금 확인할 항목: 📥 ${counts.incoming}개 · 📤 ${counts.outgoing}개 _(${lastCheck})_`,
        ].join("\n")
      ),
      ...notes.map(context),
      context(QUICK_COMMANDS),
    ],
  };
}

async function listReply(user: NudgeUser, footer?: string): Promise<Reply> {
  const [visible, teamUrl] = await Promise.all([loadVisible(user), teamUrlFor(user)]);
  const lastCheck = user.lastPolledAt
    ? `마지막 확인 ${formatAge(Date.now() - user.lastPolledAt)} · 새로 확인하려면 \`/nudge refresh\``
    : "아직 Slack을 확인하기 전이에요 · `/nudge refresh`로 지금 확인해 보세요";
  return {
    blocks: buildDigestBlocks(visible, teamUrl, { maxPerSection: 20, footer: footer ?? lastCheck, isList: true }),
  };
}

// Tracked items still inside their grace period (2h / 24h), so not listed yet
async function notYetVisible(user: NudgeUser): Promise<number> {
  const now = Date.now();
  const [incoming, outgoing] = await Promise.all([
    user.trackIncoming !== false ? getUserFollowUps(user.slackUserId, "incoming") : [],
    user.trackOutgoing !== false ? getUserFollowUps(user.slackUserId, "outgoing") : [],
  ]);
  return [...incoming, ...outgoing].filter((f) => now - f.createdAt < MIN_AGE_MS[f.kind ?? "outgoing"]).length;
}

// /nudge refresh: poll now, then replace the "확인 중" message with the list
async function refresh(responseUrl: string, user: NudgeUser): Promise<void> {
  const userId = user.slackUserId;
  const started = Date.now();
  const stats = await settleBy(pollUser(user, started + 200_000), started + 240_000);
  if (!stats) {
    const stale = (await getUser(userId)) ?? user;
    await respond(responseUrl, {
      replace_original: true,
      ...(await listReply(stale, "확인할 메시지가 많아 아직 확인 중이에요. 몇 분 뒤 `/nudge list`로 다시 봐 주세요.")),
    });
    return;
  }
  if (stats.skipped) {
    await respond(responseUrl, {
      replace_original: true,
      text: "⏳ 이미 확인 중이에요. 잠시 뒤 `/nudge list`로 결과를 확인해 주세요.",
    });
    return;
  }
  const found = stats.outgoing.tracked + stats.incoming.tracked;
  const resolved = stats.outgoing.resolved + stats.incoming.resolved + stats.incoming.expired;
  const deferred = stats.outgoing.deferred + stats.incoming.deferred;
  const fresh = (await getUser(userId)) ?? user;
  const waiting = await notYetVisible(fresh);
  const parts = [`방금 확인했어요 · 새로 찾은 질문 ${found}개 · 정리된 항목 ${resolved}개`];
  if (waiting > 0) {
    parts.push(`대기 중인 질문 ${waiting}개는 받은 질문 2시간, 보낸 질문 24시간이 지나면 목록에 보여요`);
  }
  if (deferred > 0 || stats.incomplete.length > 0) parts.push("확인할 메시지가 많아 일부는 다음 확인 때 이어서 볼게요");
  if (stats.errors.length > 0) parts.push(`일부 대화는 확인하지 못했어요 (${stats.errors.length}건)`);
  await respond(responseUrl, { replace_original: true, ...(await listReply(fresh, parts.join(" · "))) });
}

async function handleNudgeCommand(responseUrl: string, userId: string, text: string) {
  const stored = await getUser(userId);
  if (!stored) {
    await respond(responseUrl, { text: NOT_INSTALLED_TEXT(process.env.NEXT_PUBLIC_APP_URL || "") });
    return;
  }
  const user = await ensureTimezone(stored);
  const cmd = parseCommand(text);

  switch (cmd.type) {
    case "status":
      await respond(responseUrl, await statusReply(user));
      return;

    case "help":
      await respond(responseUrl, { text: HELP_TEXT });
      return;

    case "list":
      await respond(responseUrl, await listReply(user));
      return;

    case "refresh": {
      await respond(responseUrl, { text: "🔍 Slack을 확인하고 있어요… 보통 1분 안에 끝나요." });
      try {
        await refresh(responseUrl, user);
      } catch (err) {
        console.error("/nudge refresh failed:", err);
        await respond(responseUrl, {
          replace_original: true,
          text: "😵 확인 중에 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.",
        }).catch(() => {});
      }
      return;
    }

    case "pause":
      await updateUser(userId, { paused: true });
      await respond(responseUrl, {
        text: "🔕 알림을 껐어요. `/nudge refresh`로 언제든 직접 확인할 수 있고, `/nudge on`으로 다시 켤 수 있어요.",
      });
      return;

    case "resume": {
      // Store the schedule explicitly so a legacy "off" record ({reminderHours: []}) can't keep it
      // paused. Only coming back from a real pause skips slots that already passed today;
      // a no-op "/nudge on" must not cancel today's pending digest.
      const wasPaused = resolveSchedule(user).paused;
      const updated =
        (await updateUser(userId, {
          schedule: resolveSchedule(user).schedule,
          paused: false,
          reminderHours: undefined,
          reminderInterval: undefined,
          ...(wasPaused ? skipPastSlots(user) : {}),
        })) ?? user;
      const { line, notes } = await scheduleSummary(updated);
      await respond(responseUrl, { blocks: [section(`🔔 알림을 다시 켰어요: ${line}`), ...notes.map(context)] });
      return;
    }

    case "track": {
      const updates: Partial<NudgeUser> = {};
      if (cmd.incoming !== undefined) updates.trackIncoming = cmd.incoming;
      if (cmd.outgoing !== undefined) updates.trackOutgoing = cmd.outgoing;
      const updated = (await updateUser(userId, updates)) ?? user;
      const what = cmd.incoming !== undefined ? "📥 받은 질문" : "📤 보낸 질문";
      const value = (cmd.incoming ?? cmd.outgoing) ? "켰어요" : "껐어요";
      const lines = [`✓ ${what} 추적을 ${value}.`];
      if (updated.trackIncoming === false && updated.trackOutgoing === false) {
        lines.push("⚠️ 받은 질문과 보낸 질문이 모두 꺼져 있어서 알림이 오지 않아요.");
      }
      await respond(responseUrl, { text: lines.join("\n") });
      return;
    }

    case "timezone": {
      let tz: string | null = cmd.tz;
      if (tz === "auto") tz = await getUserTimezone(createSlackClient(user.userToken), userId);
      if (!tz || !isValidTimezone(tz)) {
        await respond(responseUrl, { text: "Slack 프로필에서 시간대를 가져오지 못했어요. 예: `/nudge tz Asia/Seoul`" });
        return;
      }
      const updated = (await updateUser(userId, { tz, ...skipPastSlots(user) })) ?? user;
      const { line, notes } = await scheduleSummary(updated);
      await respond(responseUrl, {
        blocks: [
          section(`🌏 시간대를 *${formatTimezone(tz)}* (${tz})로 맞췄어요.\n⏰ 알림: ${line}`),
          ...notes.map(context),
        ],
      });
      return;
    }

    case "schedule": {
      const current = resolveSchedule(user).schedule;
      const schedule = applyScheduleUpdate(current, cmd.update);
      const updated =
        (await updateUser(userId, {
          schedule,
          paused: false,
          // Clear legacy fields so they can't shadow the new schedule
          reminderHours: undefined,
          reminderInterval: undefined,
          // The first delivery is the "다음 알림" we report, not a catch-up of an earlier slot
          ...skipPastSlots(user),
        })) ?? user;
      const { line, notes } = await scheduleSummary(updated);
      await respond(responseUrl, { blocks: [section(`✓ 알림 주기를 바꿨어요: ${line}`), ...notes.map(context)] });
      return;
    }

    case "error":
      await respond(responseUrl, {
        text: `${cmd.message}\n\n예시: \`/nudge 매일 9시\`, \`/nudge 매시간\`, \`/nudge 2시간마다\`, \`/nudge off\`\n전체 사용법은 \`/nudge help\`로 볼 수 있어요.`,
      });
      return;
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-slack-signature");
  const timestamp = req.headers.get("x-slack-request-timestamp");

  if (!verifySlackRequest(signature, timestamp, body)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const params = new URLSearchParams(body);
  const command = params.get("command");
  const userId = params.get("user_id");
  const responseUrl = params.get("response_url");
  const text = params.get("text") || "";

  if (command === "/nudge" && userId && responseUrl) {
    waitUntil(
      handleNudgeCommand(responseUrl, userId, text).catch(async (err) => {
        console.error("/nudge failed:", err);
        await respond(responseUrl, { text: "😵 처리 중에 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요." }).catch(() => {});
      })
    );
    return new NextResponse(null, { status: 200 });
  }

  return NextResponse.json({ ok: true });
}
