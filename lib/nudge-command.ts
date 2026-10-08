// Runs a /nudge command for a user and sends the reply through a Responder, so the same
// logic serves the slash command, plain messages in the Nudge DM, and digest buttons.
import { createBoundedClient, createSlackClient, getUserTimezone } from "@/lib/slack";
import { getUser, updateUser, type NudgeUser } from "@/lib/db";
import { pollUser } from "@/lib/poll";
import { buildDigestBlocks, countGroups, firstCheckBlocks, formatAge, groupCounts, loadVisible, MIN_AGE_MS } from "@/lib/digest";
import { getUserFollowUps } from "@/lib/redis";
import { hourlyTriggerActive, settleBy, teamUrlFor } from "@/lib/tick";
import { applyScheduleUpdate, parseCommand, type Command } from "@/lib/command";
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
import {
  APP_URL,
  CONNECT_STEPS,
  connectActions,
  DM_PREFIX,
  helpText,
  hourlyInactiveWarning,
  INTERVAL_NOTE,
  linkButton,
  SECTION_NAMES,
} from "@/lib/messages";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = any;

export interface Reply {
  text?: string;
  blocks?: Block[];
}

export interface Responder {
  // How commands are written where the reply shows up: "" in the Nudge DM, "/nudge " elsewhere
  prefix: string;
  send(reply: Reply): Promise<void>;
  // Replace the message `send` posted last (falls back to sending a new one)
  replace(reply: Reply): Promise<void>;
}

// Replies in the Nudge DM as new messages (inside the thread if the command was typed in one);
// "replace" edits the last reply (progress → result)
export function dmResponder(botToken: string, channel: string, threadTs?: string): Responder {
  const client = createBoundedClient(botToken);
  let lastTs: string | undefined;
  return {
    prefix: DM_PREFIX,
    async send(reply) {
      const res = await client.chat.postMessage({
        channel,
        text: reply.text ?? "Nudge",
        blocks: reply.blocks,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      lastTs = res.ts;
    },
    async replace(reply) {
      if (!lastTs) return this.send(reply);
      await client.chat.update({ channel, ts: lastTs, text: reply.text ?? "Nudge", blocks: reply.blocks ?? [] });
    },
  };
}

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(text: string): Block {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

// Two-column grid of "*label*\nvalue" cells. One section per row: rows inside a single
// section's `fields` render with no gap between them.
function grid(cells: string[]): Block[] {
  const rows: Block[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    rows.push({ type: "section", fields: cells.slice(i, i + 2).map((text) => ({ type: "mrkdwn", text })) });
  }
  return rows;
}

// After a schedule/timezone change, start from the next slot instead of catching up on one
// that already passed (the reply announces "다음 알림 …").
function skipPastSlots(user: NudgeUser): Pick<NudgeUser, "lastSlot"> {
  return { lastSlot: Math.max(user.lastSlot ?? -Infinity, currentSlot(Date.now())) };
}

// Pick up the timezone from the Slack profile the first time we see the user
export async function ensureTimezone(user: NudgeUser): Promise<NudgeUser> {
  if (user.tz) return user;
  const tz = await getUserTimezone(createSlackClient(user.userToken), user.slackUserId);
  if (!tz || !isValidTimezone(tz)) return user;
  return (await updateUser(user.slackUserId, { tz, ...skipPastSlots(user) })) ?? user;
}

interface ScheduleSummary {
  line: string; // "*평일 오전 8시* (한국 시간) · 다음 알림 …", for one-line replies
  when: string; // "평일 오전 8시 (한국 시간)"
  next: string; // "10월 8일(목) 오후 6시"
  note?: Block; // how interval schedules deliver (small print)
  warning?: Block; // hourly delivery isn't running (full size, so it gets read)
}

const notesOf = (s: ScheduleSummary): Block[] => [s.note, s.warning].filter(Boolean);

async function scheduleSummary(user: NudgeUser, p: string): Promise<ScheduleSummary> {
  const { schedule, paused } = resolveSchedule(user);
  const tz = resolveTimezone(user);
  if (paused) {
    const hint = `\`${p}켜기\`로 다시 켤 수 있어요`;
    return { line: `*꺼짐* — ${hint}`, when: "*꺼짐*", next: hint };
  }

  const next = nextSlotTime(schedule, tz, Date.now());
  const nextText = next ? formatSlotTime(next, tz) : "";
  const hourlyMissing = !worksWithDailyCronOnly(schedule, tz, Date.now()) && !(await hourlyTriggerActive());
  return {
    line: `*${formatSchedule(schedule)}* (${formatTimezone(tz)})${nextText ? ` · 다음 알림 ${nextText}` : ""}`,
    when: `${formatSchedule(schedule)} (${formatTimezone(tz)})`,
    next: nextText || "—",
    note: schedule.kind === "interval" ? context(INTERVAL_NOTE) : undefined,
    warning: hourlyMissing ? section(hourlyInactiveWarning(p)) : undefined,
  };
}

function quickCommands(p: string): string {
  const c = (s: string) => `\`${p}${s}\``;
  // In the Nudge DM the commands above are already written without "/nudge"
  const tip = p === DM_PREFIX ? "" : "\n_Nudge와의 DM 창에서는 `/nudge` 없이 `설정`, `목록`처럼 입력해도 돼요._";
  return `${c("목록")} 질문 보기 · ${c("새로고침")} 지금 확인 · ${c("9시")} · ${c("매시간")} · ${c("끄기")} · ${c("도움말")} 전체 사용법${tip}`;
}

// After this, an unfinished first scan no longer holds the list back (e.g. the AI stays rate-limited)
const FIRST_SCAN_GRACE_MS = 24 * 60 * 60 * 1000;

// Schedule row, question counts row, then the warning if any — shared by the 설정 reply and the App Home tab
async function settingsBlocks(user: NudgeUser, p: string): Promise<Block[]> {
  const s = await scheduleSummary(user, p);
  const counts = groupCounts(await loadVisible(user));
  const tracked = (name: string, on: boolean | undefined, count: number, turnOn: string) => {
    if (on === false) return `*${name}*\n알림 꺼짐 · \`${p}${turnOn}\`로 켜요`;
    return `*${name}*\n${user.lastPolledAt ? `지금 *${count}개*` : "찾고 있어요"}`;
  };
  const lastCheck = user.lastPolledAt ? `마지막 확인 ${formatAge(Date.now() - user.lastPolledAt)}` : "아직 확인 전";
  return [
    ...grid([`*⏰ 알림 시간*\n${s.when}`, `*🔔 다음 알림*\n${s.next}`]),
    ...(s.note ? [s.note] : []),
    ...grid([
      tracked(SECTION_NAMES.incoming, user.trackIncoming, counts.incoming, "받은질문 켜기"),
      tracked(SECTION_NAMES.outgoing, user.trackOutgoing, counts.outgoing, "보낸질문 켜기"),
    ]),
    context(lastCheck),
    ...(s.warning ? [s.warning] : []),
  ];
}

async function statusReply(user: NudgeUser, p: string): Promise<Reply> {
  return {
    text: "내 Nudge 설정",
    blocks: [section("*⚙️ 내 Nudge 설정*"), ...(await settingsBlocks(user, p)), context(quickCommands(p))],
  };
}

const header = (text: string): Block => ({ type: "header", text: { type: "plain_text", text, emoji: true } });

// The App Home "홈" tab — what "앱 열기" shows. Not connected yet: what Nudge does and how to
// connect it. Connected: their settings and what to type in the Nudge DM (`messagesUrl`).
export async function homeView(user: NudgeUser | null, messagesUrl: string): Promise<Block> {
  if (!user) {
    return {
      type: "home",
      blocks: [
        header("👋 Nudge 시작하기"),
        section("Slack에서 놓친 질문을 모아 DM으로 알려줘요."),
        ...grid([
          `*${SECTION_NAMES.incoming}*\n누가 나에게 물어봤는데 아직 답하지 않은 질문`,
          `*${SECTION_NAMES.outgoing}*\n내가 물어봤는데 아직 답을 못 받은 질문`,
        ]),
        { type: "divider" },
        section(CONNECT_STEPS),
        connectActions(),
      ],
    };
  }
  // One command per line, grouped in a grid — long "·" chains were hard to scan
  const c = (s: string) => `\`${s}\``;
  return {
    type: "home",
    blocks: [
      header("⚙️ 내 Nudge 설정"),
      ...(await settingsBlocks(user, DM_PREFIX)),
      { type: "divider" },
      header("💬 이렇게 써요"),
      context("*메시지* 탭(Nudge DM)에 그대로 입력하세요. 다른 채널에서는 `/nudge 목록`처럼 앞에 `/nudge`를 붙여요."),
      ...grid([
        `*🔎 확인하기*\n${c("목록")} 지금 질문 보기\n${c("새로고침")} Slack 다시 확인\n${c("설정")} 내 설정 보기`,
        `*⏰ 알림 시간*\n${c("9시")} 하루 한 번\n${c("9시 13시 18시")} 하루 여러 번\n${c("매시간")} 근무시간에 매시간`,
        `*🔕 끄고 켜기*\n${c("끄기")} · ${c("켜기")} 모든 알림\n${c("받은질문 끄기")} 📥 알림만\n${c("보낸질문 끄기")} 📤 알림만`,
        `*📌 그 밖에*\n${c("평일")} 주말엔 쉬기\n${c("매일")} 주말에도 받기\n${c("도움말")} 전체 사용법`,
      ]),
      { type: "actions", elements: [linkButton("💬 메시지 탭 열기", messagesUrl, true), linkButton("📖 사용법 보기", APP_URL)] },
    ],
  };
}

async function listReply(user: NudgeUser, p: string, footer?: string): Promise<Reply> {
  const [visible, teamUrl] = await Promise.all([loadVisible(user), teamUrlFor(user)]);
  // The first scan after connecting hasn't got through the 7-day backlog yet (still running, or
  // cut short by the AI limit): an empty list there would wrongly say "모두 처리했어요"
  const firstScan =
    !user.lastPolledAt || (!!user.firstScanPending && Date.now() - user.installedAt < FIRST_SCAN_GRACE_MS);
  if (firstScan && countGroups(visible) === 0) {
    return { text: "아직 확인하고 있어요", blocks: [...firstCheckBlocks(), ...(footer ? [context(footer)] : [])] };
  }
  const lastCheck = !user.lastPolledAt
    ? "아직 확인하고 있어요 · 질문이 더 나올 수 있어요"
    : `마지막 확인 ${formatAge(Date.now() - user.lastPolledAt)}${firstScan ? " · 아직 다 보지 못해서 질문이 더 나올 수 있어요" : ""}`;
  return {
    text: "Nudge 질문 목록",
    blocks: buildDigestBlocks(visible, teamUrl, { maxPerSection: 20, footer: footer ?? lastCheck, isList: true, prefix: p }),
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

// Poll now, then replace the "확인 중" message with the list
async function refresh(out: Responder, user: NudgeUser): Promise<void> {
  const p = out.prefix;
  const userId = user.slackUserId;
  const started = Date.now();
  const stats = await settleBy(pollUser(user, started + 200_000), started + 240_000);
  if (!stats) {
    const stale = (await getUser(userId)) ?? user;
    await out.replace(await listReply(stale, p, `확인할 메시지가 많아 아직 확인하고 있어요. 몇 분 뒤 \`${p}목록\`으로 다시 봐 주세요.`));
    return;
  }
  if (stats.skipped) {
    // Keep the list (and its buttons) on screen — a refresh button rewrites the digest in place
    const current = (await getUser(userId)) ?? user;
    await out.replace(await listReply(current, p, `⏳ 이미 확인하고 있어요. 잠시 뒤 \`${p}목록\`으로 결과를 봐 주세요.`));
    return;
  }
  const found = stats.outgoing.tracked + stats.incoming.tracked;
  const resolved = stats.outgoing.resolved + stats.incoming.resolved + stats.incoming.expired;
  const deferred = stats.outgoing.deferred + stats.incoming.deferred;
  const fresh = (await getUser(userId)) ?? user;
  const waiting = await notYetVisible(fresh);
  const parts = [`방금 확인했어요 · 새로 찾은 질문 ${found}개 · 정리된 질문 ${resolved}개`];
  if (waiting > 0) parts.push(`아직 알림 전인 질문 ${waiting}개는 조금 뒤에 목록에 나와요 (📥 2시간, 📤 24시간 후)`);
  if (deferred > 0 || stats.incomplete.length > 0) parts.push("확인할 메시지가 많아 일부는 다음 확인 때 이어서 볼게요");
  if (stats.errors.length > 0) parts.push(`일부 대화는 확인하지 못했어요 (${stats.errors.length}건)`);
  await out.replace(await listReply(fresh, p, parts.join(" · ")));
}

export async function runCommand(stored: NudgeUser, cmd: Command, out: Responder): Promise<void> {
  const user = await ensureTimezone(stored);
  const userId = user.slackUserId;
  const p = out.prefix;

  switch (cmd.type) {
    case "status":
      await out.send(await statusReply(user, p));
      return;

    case "help":
      await out.send({ text: helpText(p) });
      return;

    case "list":
      await out.send(await listReply(user, p));
      return;

    case "refresh": {
      await out.send({ text: "🔍 Slack을 확인하고 있어요… 보통 1분 안에 끝나요." });
      try {
        await refresh(out, user);
      } catch (err) {
        console.error("nudge refresh failed:", err);
        const failed = "😵 확인하다가 문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.";
        // Prefer the current list with the error underneath, so nothing disappears from the screen
        await out
          .replace(await listReply(user, p, failed))
          .catch(() => out.replace({ text: failed }))
          .catch(() => {});
      }
      return;
    }

    case "thanks":
      await out.send({ text: `😊 천만에요! 필요할 때 \`${p}설정\`, \`${p}목록\`, \`${p}도움말\`을 입력해 보세요.` });
      return;

    case "pause":
      await updateUser(userId, { paused: true });
      await out.send({
        text: `🔕 알림을 껐어요. \`${p}새로고침\`으로 언제든 직접 확인할 수 있고, \`${p}켜기\`로 다시 켤 수 있어요.`,
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
      const summary = await scheduleSummary(updated, p);
      await out.send({ text: "알림을 다시 켰어요", blocks: [section(`🔔 알림을 다시 켰어요: ${summary.line}`), ...notesOf(summary)] });
      return;
    }

    case "track": {
      const updates: Partial<NudgeUser> = {};
      if (cmd.incoming !== undefined) updates.trackIncoming = cmd.incoming;
      if (cmd.outgoing !== undefined) updates.trackOutgoing = cmd.outgoing;
      const updated = (await updateUser(userId, updates)) ?? user;
      const what = cmd.incoming !== undefined ? SECTION_NAMES.incoming : SECTION_NAMES.outgoing;
      const value = (cmd.incoming ?? cmd.outgoing) ? "켰어요" : "껐어요";
      const lines = [`✓ ${what} 알림을 ${value}.`];
      if (updated.trackIncoming === false && updated.trackOutgoing === false) {
        lines.push("⚠️ 두 가지 알림이 모두 꺼져 있어서 아무 알림도 오지 않아요.");
      }
      await out.send({ text: lines.join("\n") });
      return;
    }

    case "timezone": {
      let tz: string | null = cmd.tz;
      if (tz === "auto") tz = await getUserTimezone(createSlackClient(user.userToken), userId);
      if (!tz || !isValidTimezone(tz)) {
        await out.send({ text: `Slack 프로필에서 시간대를 가져오지 못했어요. 예: \`${p}tz Asia/Seoul\`` });
        return;
      }
      const updated = (await updateUser(userId, { tz, ...skipPastSlots(user) })) ?? user;
      const summary = await scheduleSummary(updated, p);
      const label = formatTimezone(tz);
      await out.send({
        text: "시간대를 바꿨어요",
        blocks: [
          section(`🌏 시간대를 *${label}*${label === tz ? "" : ` (${tz})`}에 맞췄어요.\n⏰ 알림 시간: ${summary.line}`),
          ...notesOf(summary),
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
      const summary = await scheduleSummary(updated, p);
      await out.send({ text: "알림 시간을 바꿨어요", blocks: [section(`✓ 알림 시간을 바꿨어요: ${summary.line}`), ...notesOf(summary)] });
      return;
    }

    case "error": {
      // Parser examples are written as "/nudge …"; show them the way they're typed here
      const message = cmd.message.replace(/`\/nudge /g, `\`${p}`);
      const c = (s: string) => `\`${p}${s}\``;
      await out.send({
        text: `${message}\n\n이렇게 써 보세요: ${c("설정")} · ${c("목록")} · ${c("9시")} · ${c("매시간")} · ${c("2시간마다")} · ${c("끄기")}\n전체 사용법은 ${c("도움말")}로 볼 수 있어요.`,
      });
      return;
    }
  }
}

// Short acknowledgements people send back to a digest — answered kindly, not as an error
const THANKS = /^(넵+|네+|넹|예|응|ㅇㅇ|ㅇㅋ|오케이|ok|okay|좋아요|굿|감사합니다|감사해요|고마워요?|고맙습니다|thanks?|thank you|thx)?[\s!.~^ㅎㅋ]*$/iu;

// Text typed into the Nudge DM: "설정", "매일 9시", "/nudge 목록", "nudge list", a pasted
// "`목록`" (inline code copied from the help) or "목록." all work
export function parseDmText(text: string): Command {
  const cleaned = text
    .replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, " ") // "@Nudge 목록"
    .replace(/`/g, "")
    .replace(/^\s*\/?nudge\b\s*/i, "")
    .trim();
  if (cleaned === "?") return { type: "help" };
  // Slack sends emoji as ":+1:" shortcodes; a reply that's only emoji/thanks is a thank-you
  const withoutEmoji = cleaned.replace(/:[a-z0-9_+'-]+:/g, "").trim();
  if (cleaned && THANKS.test(withoutEmoji)) return { type: "thanks" };
  return parseCommand(cleaned.replace(/[.!?~]+$/, ""));
}
