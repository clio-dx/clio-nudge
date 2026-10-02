// End-to-end poll → digest flow against a fake Slack workspace, in-memory Redis and
// keyword-based AI (see tests/mocks). Run with: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetSlack, workspace, type FakeMessage } from "./mocks/slack-web-api.ts";
import { resetRedis } from "./mocks/redis.ts";
import { aiCalls, aiFailures, modelsUsed } from "./mocks/ai.ts";
import { resumeAi } from "../lib/ai.ts";
import { parseDmText, runCommand } from "../lib/nudge-command.ts";
import { DM_PREFIX, SLASH_PREFIX } from "../lib/messages.ts";
import { pollUser } from "../lib/poll.ts";
import { runTick } from "../lib/tick.ts";
import { getUser, saveUser, updateUser, type NudgeUser } from "../lib/db.ts";
import { addFollowUp, getUserFollowUps, itemId, markSeen, redis, removeFollowUp } from "../lib/redis.ts";
import { loadVisible, visibleIds } from "../lib/digest.ts";
import { currentSlot, localParts } from "../lib/schedule.ts";

const ME = "UME";
const HOUR = 3600;

// Slack ts values are unique per channel; add a per-message microsecond offset so messages
// created in the same millisecond don't collide
let seq = 0;
const ago = (hours: number) => (Math.floor(Date.now() / 1000 - hours * HOUR) + ++seq / 1e6).toFixed(6);

function channel(id: string, type: "im" | "mpim" | "channel", members: string[], name?: string) {
  workspace.channels.set(id, { id, type, members, name });
}

function msg(m: Omit<FakeMessage, "ts"> & { hoursAgo: number; ts?: string }): string {
  const ts = m.ts ?? ago(m.hoursAgo);
  workspace.messages.push({ ...m, ts });
  return ts;
}

const ids = (items: { channel: string; threadTs: string }[]) => items.map((f) => `${f.channel}:${f.threadTs}`).sort();

let T: Record<string, string> = {};

function buildWorkspace() {
  for (const [id, name] of [[ME, "윤철"], ["UA", "민지"], ["UB", "서준"], ["UC", "하은"], ["UD", "지호"], ["UE", "도윤"]]) {
    workspace.users.set(id, { name, tz: "Asia/Seoul" });
  }
  channel("DA", "im", [ME, "UA"]);
  channel("DB", "im", [ME, "UB"]);
  channel("DC", "im", [ME, "UC"]);
  channel("DD", "im", [ME, "UD"]);
  channel("DE", "im", [ME, "UE"]);
  channel("DBOT", "im", [ME, "UBOT"]);
  channel("DNUDGE", "im", [ME, "UNUDGE"]);
  channel("CGEN", "channel", [ME, "UA", "UB", "UC"], "general");
  channel("GMP", "mpim", [ME, "UA", "UB"], "mpdm-me--a--b-1");

  // --- questions to me ---
  T.unanswered = msg({ channel: "DA", user: "UA", text: "견적서 언제 받을 수 있을까요?", hoursAgo: 5 });
  T.reacted = msg({
    channel: "DA", user: "UA", text: "내일 10시 회의 괜찮으세요?", hoursAgo: 3,
    reactions: [{ name: "+1::skin-tone-2", users: [ME] }],
  });
  T.tooFresh = msg({ channel: "DA", user: "UA", text: "오늘 저녁 시간 되세요?", hoursAgo: 0.5 });

  T.answered = msg({ channel: "DB", user: "UB", text: "자료 공유 부탁드립니다", hoursAgo: 6 });
  msg({ channel: "DB", user: ME, text: "네 내일 드릴게요", hoursAgo: 5.9 });
  T.deferredByMe = msg({ channel: "DB", user: "UB", text: "내일 회의 몇 시예요", hoursAgo: 4 });
  msg({ channel: "DB", user: ME, text: "확인해볼게요", hoursAgo: 3.5 });

  T.fileAnswer = msg({ channel: "DC", user: "UC", text: "파일 보내주실 수 있나요?", hoursAgo: 4 });
  msg({ channel: "DC", user: ME, text: "", files: [{ name: "estimate.pdf" }], subtype: "file_share", hoursAgo: 3.9 });

  T.botQuestion = msg({ channel: "DBOT", user: "UBOT", bot_id: "B1", text: "What did you do yesterday?", hoursAgo: 5 });

  T.mentionAnswered = msg({ channel: "CGEN", user: "UA", text: "<@UME> 배포 일정 언제인가요?", hoursAgo: 5 });
  msg({ channel: "CGEN", user: ME, text: "오늘 오후 3시에 합니다", thread_ts: T.mentionAnswered, hoursAgo: 4 });
  T.mentionOpen = msg({ channel: "CGEN", user: "UB", text: "<@UME> 이 PR 리뷰 가능할까요?", hoursAgo: 5 });
  T.cc = msg({ channel: "CGEN", user: "UA", text: "<@UB> 이 견적 확인 부탁드려요 cc <@UME>", hoursAgo: 5 });
  msg({ channel: "CGEN", user: "UB", text: "확인했어요 문제 없습니다", thread_ts: T.cc, hoursAgo: 4 });

  T.myThread = msg({ channel: "CGEN", user: ME, text: "배포 완료했습니다.", hoursAgo: 8 });
  T.threadQuestion = msg({ channel: "CGEN", user: "UA", text: "로그는 어디서 보나요?", thread_ts: T.myThread, hoursAgo: 7 });
  T.threadToOther = msg({
    channel: "CGEN", user: "UB", text: "<@UA> 그거 대시보드에 있나요?", thread_ts: T.myThread, hoursAgo: 6.5,
  });

  T.groupNoMention = msg({ channel: "GMP", user: "UA", text: "다들 점심 뭐 드실래요?", hoursAgo: 5 });

  // --- my questions ---
  T.outDeferred = msg({ channel: "DD", user: ME, text: "회의록 공유해 주실 수 있나요?", hoursAgo: 30 });
  msg({ channel: "DD", user: "UD", text: "알아볼게요", hoursAgo: 29 });
  T.outAnswered = msg({ channel: "DE", user: ME, text: "PR 머지해도 될까요?", hoursAgo: 30 });
  msg({ channel: "DE", user: "UE", text: "네 머지하세요", hoursAgo: 29 });
  T.outBot = msg({ channel: "DBOT", user: ME, text: "이 PR 요약해줄래?", hoursAgo: 30 });
  msg({ channel: "DBOT", user: "UBOT", bot_id: "B1", text: "요약: 버그 수정", hoursAgo: 29.9 });
  T.outChannel = msg({ channel: "CGEN", user: ME, text: "누가 이 대시보드 관리하나요?", hoursAgo: 30 });
}

async function install(extra: Partial<NudgeUser> = {}): Promise<NudgeUser> {
  return saveUser({
    slackUserId: ME,
    slackTeamId: "T1",
    botToken: "xoxb-test",
    userToken: "xoxp-test",
    installedAt: Date.now(),
    tz: "Asia/Seoul",
    ...extra,
  });
}

beforeEach(() => {
  resetSlack();
  resetRedis();
  aiCalls.length = 0;
  aiFailures.rateLimited = 0;
  aiFailures.paidOnly.clear();
  modelsUsed.length = 0;
  resumeAi();
  T = {};
  buildWorkspace();
});

test("first poll tracks exactly the unanswered questions in both directions", async () => {
  const user = await install();
  const stats = await pollUser(user);
  assert.deepEqual(stats.errors, []);

  const incoming = await getUserFollowUps(ME, "incoming");
  assert.deepEqual(
    ids(incoming),
    [
      `DA:${T.unanswered}`, // nobody answered
      `DA:${T.tooFresh}`, // tracked, but younger than 2h → not shown yet
      `DB:${T.deferredByMe}`, // I only said "확인해볼게요"
      `CGEN:${T.mentionOpen}`, // @mention without reply
      `CGEN:${T.threadQuestion}`, // reply in my own thread
    ].sort()
  );
  // Not tracked: answered (T.answered, T.mentionAnswered), ✅ with skin tone (T.reacted), file reply
  // (T.fileAnswer), bot (T.botQuestion), cc'd person answered (T.cc), aimed at someone else
  // (T.threadToOther), group DM without mention (T.groupNoMention)

  const outgoing = await getUserFollowUps(ME, "outgoing");
  assert.deepEqual(ids(outgoing), [`DD:${T.outDeferred}`, `CGEN:${T.outChannel}`].sort());
  // T.outAnswered (substantive reply) and T.outBot (bot replied in DM) are resolved

  const visible = await loadVisible((await getUser(ME))!);
  assert.equal(visible.incoming.length, 4, "the 30-minute-old question waits for the 2h grace period");
  assert.equal(visible.outgoing.length, 2);
});

test("second poll is idempotent and doesn't re-classify settled messages", async () => {
  const user = await install();
  await pollUser(user);
  const before = aiCalls.filter((c) => c !== "summary").length;
  const stats = await pollUser((await getUser(ME))!);
  assert.deepEqual(stats.errors, []);
  assert.equal(stats.incoming.tracked + stats.outgoing.tracked, 0);
  assert.equal(aiCalls.filter((c) => c !== "summary").length, before, "no AI calls for already-judged messages");
});

test("replying later resolves; dismissed items never come back", async () => {
  const user = await install();
  await pollUser(user);

  // I finally answer the deferred DM question
  msg({ channel: "DB", user: ME, text: "내일 10시예요", hoursAgo: 0.1 });
  // I dismiss the channel mention
  await removeFollowUp("incoming", ME, "CGEN", T.mentionOpen);
  await markSeen(ME, itemId("incoming", "CGEN", T.mentionOpen), Date.now());

  await pollUser((await getUser(ME))!);
  const incoming = ids(await getUserFollowUps(ME, "incoming"));
  assert.ok(!incoming.includes(`DB:${T.deferredByMe}`), "answered after '확인해볼게요'");
  assert.ok(!incoming.includes(`CGEN:${T.mentionOpen}`), "dismissed item stays dismissed");
  assert.ok(incoming.includes(`DA:${T.unanswered}`));
});

test("a plain 'thanks' from the asker doesn't close the question", async () => {
  const user = await install();
  await pollUser(user);
  msg({ channel: "DB", user: "UB", text: "넵 감사합니다!", hoursAgo: 0.1 });
  await pollUser((await getUser(ME))!);
  assert.ok(ids(await getUserFollowUps(ME, "incoming")).includes(`DB:${T.deferredByMe}`));
});

test("tracked message that was deleted is dropped instead of erroring forever", async () => {
  const user = await install();
  await addFollowUp({
    kind: "outgoing",
    userId: ME,
    channel: "CGEN",
    threadTs: "1700000000.000100",
    originalMessage: "지워진 질문?",
    convType: "channel",
    createdAt: Date.now() - 48 * HOUR * 1000,
    lastRemindedAt: null,
    lastActivityAt: 0,
  });
  const stats = await pollUser(user);
  assert.deepEqual(stats.errors, []);
  assert.ok(!ids(await getUserFollowUps(ME, "outgoing")).includes("CGEN:1700000000.000100"));
});

test("tick sends one digest per slot, records the Nudge DM and never tracks it", async () => {
  const hour = localParts(Date.now(), "Asia/Seoul").hour;
  await install({ schedule: { kind: "times", hours: [hour], weekdaysOnly: false } });

  const first = await runTick("test");
  assert.equal(first.usersNotified, 1);
  assert.equal(workspace.posted.length, 1);
  const text = JSON.stringify(workspace.posted[0].blocks);
  assert.match(text, /📥 내가 답장해야 할 질문 · 4/);
  assert.match(text, /📤 상대에게 답장 받아야 할 질문 · 2/);
  assert.match(text, /nudge_settings/, "quick buttons under the digest");

  // Vercel Cron + GitHub Actions in the same hour → still one message
  await runTick("test-again");
  assert.equal(workspace.posted.length, 1);

  const stored = (await getUser(ME))!;
  assert.equal(stored.botDmChannel, "DNUDGE");
  assert.equal(stored.lastSlot, currentSlot(Date.now()));

  // Typing a question into the Nudge DM must not become a tracked item
  msg({ channel: "DNUDGE", user: ME, text: "이거 어떻게 써요?", hoursAgo: 30 });
  await pollUser(stored);
  assert.ok(!ids(await getUserFollowUps(ME, "outgoing")).some((id) => id.startsWith("DNUDGE:")));
});

test("a busy inbox is read across polls: nothing in the window is skipped", async () => {
  const user = await install();
  channel("DX", "im", [ME, "UC"]);
  // 450 chatty DM messages, then a question at the very end (newest)
  for (let i = 0; i < 450; i++) msg({ channel: "DX", user: i % 2 ? ME : "UC", text: "ㅇㅋ", hoursAgo: 40 - i * 0.05 });
  const late = msg({ channel: "DX", user: "UC", text: "그럼 계약서는 언제 받을 수 있을까요?", hoursAgo: 5 });

  // Poll 1 reads the first 400 `with:` results (cap) and stops before the question
  const first = await pollUser(user);
  assert.ok(first.incomplete.some((r) => r.startsWith("with:")), JSON.stringify(first.incomplete));
  assert.ok(!ids(await getUserFollowUps(ME, "incoming")).includes(`DX:${late}`));

  // Poll 2 continues from the saved page and finds it
  await pollUser((await getUser(ME))!);
  assert.ok(ids(await getUserFollowUps(ME, "incoming")).includes(`DX:${late}`));
});

test("questions deep in a long thread are read, and deleted thread replies are dropped", async () => {
  const user = await install();
  const root = msg({ channel: "CGEN", user: "UB", text: "장애 대응 스레드", hoursAgo: 10 });
  for (let i = 0; i < 230; i++) msg({ channel: "CGEN", user: "UB", text: "로그 확인 중", thread_ts: root, hoursAgo: 9.9 - i * 0.01 });
  const deep = msg({ channel: "CGEN", user: "UA", text: "<@UME> 롤백 언제 하나요?", thread_ts: root, hoursAgo: 5 });
  // My question as the latest reply in someone else's thread
  const other = msg({ channel: "CGEN", user: "UB", text: "배포 후기 공유합니다", hoursAgo: 40 });
  const mine = msg({ channel: "CGEN", user: ME, text: "롤백 계획은 있나요?", thread_ts: other, hoursAgo: 30 });

  await pollUser(user);
  assert.ok(ids(await getUserFollowUps(ME, "incoming")).includes(`CGEN:${deep}`), "reply #230 is found");
  assert.ok(ids(await getUserFollowUps(ME, "outgoing")).includes(`CGEN:${mine}`));

  // I delete my thread reply → it disappears from the list
  workspace.messages.splice(workspace.messages.findIndex((m) => m.ts === mine), 1);
  await pollUser((await getUser(ME))!);
  assert.ok(!ids(await getUserFollowUps(ME, "outgoing")).includes(`CGEN:${mine}`));
});

test("someone else's answer settles a cc, but not a question asked to each of us", async () => {
  const user = await install();
  const both = msg({ channel: "CGEN", user: "UB", text: "<@UA> <@UME> 다음 주 회의 참석 가능하신가요?", hoursAgo: 5 });
  msg({ channel: "CGEN", user: "UA", text: "네 저는 참석합니다", thread_ts: both, hoursAgo: 4 });

  await pollUser(user);
  const incoming = ids(await getUserFollowUps(ME, "incoming"));
  assert.ok(incoming.includes(`CGEN:${both}`), "UA only answered for themselves");
  assert.ok(!incoming.includes(`CGEN:${T.cc}`), "cc'd question answered by the addressee");
});

test("a search hit whose message is gone doesn't stall later polls", async () => {
  const user = await install();
  const ghost = msg({ channel: "DA", user: "UA", text: "이거 확인 가능할까요?", hoursAgo: 4 });
  // Search still returns it (index lag), but the message was deleted before we could read it
  const real = workspace.messages.find((m) => m.ts === ghost)!;
  workspace.messages.splice(workspace.messages.indexOf(real), 1);
  workspace.ghosts.push(real);
  const stats = await pollUser(user);
  assert.deepEqual(stats.errors, []);
  assert.ok(!stats.incomplete.some((r) => r.startsWith("with:") || r.startsWith("mentions:")), JSON.stringify(stats.incomplete));
});

test("an AI rate limit postpones work instead of failing it, and nothing is lost", async () => {
  const user = await install();
  aiFailures.rateLimited = 1; // the first model call hits the provider limit
  const first = await pollUser(user);
  assert.deepEqual(first.errors, [], "rate limits are not reported as errors");
  assert.ok(first.incomplete.some((r) => r.startsWith("AI rate limit")), JSON.stringify(first.incomplete));
  const callsWhilePaused = aiCalls.length;
  assert.ok(callsWhilePaused <= 1, "no more model calls while paused");

  // Pause over → the next poll picks everything up
  resumeAi();
  await pollUser((await getUser(ME))!);
  const incoming = ids(await getUserFollowUps(ME, "incoming"));
  assert.ok(incoming.includes(`DA:${T.unanswered}`));
  assert.ok(incoming.includes(`DB:${T.deferredByMe}`));
  assert.equal((await getUserFollowUps(ME, "outgoing")).length, 2);
});

test("a reaction from the other side settles my request; 👀 doesn't", async () => {
  const user = await install();
  channel("DF", "im", [ME, "UC"]);
  const thumbs = msg({
    channel: "DF", user: ME, text: "견적서 검토 부탁드립니다", hoursAgo: 30,
    reactions: [{ name: "+1::skin-tone-3", users: ["UC"] }],
  });
  const custom = msg({
    channel: "DF", user: ME, text: "회의록 공유해 주실 수 있나요?", hoursAgo: 29,
    reactions: [{ name: "넵", users: ["UC"] }],
  });
  const looking = msg({
    channel: "DD", user: ME, text: "계약서 확인 부탁드립니다", hoursAgo: 31,
    reactions: [{ name: "eyes", users: ["UD"] }],
  });
  // My own reaction on my own message means nothing
  channel("DH", "im", [ME, "UE"]);
  const self = msg({
    channel: "DH", user: ME, text: "PR 리뷰 부탁드립니다", hoursAgo: 31,
    reactions: [{ name: "+1", users: [ME] }],
  });

  await pollUser(user);
  const outgoing = ids(await getUserFollowUps(ME, "outgoing"));
  assert.ok(!outgoing.includes(`DF:${thumbs}`), "👍 from the recipient");
  assert.ok(!outgoing.includes(`DF:${custom}`), "custom 넵 emoji from the recipient");
  assert.ok(outgoing.includes(`DD:${looking}`), "👀 is not an answer");
  assert.ok(outgoing.includes(`DH:${self}`), "my own reaction is not an answer");
});

test("without AI, list rows show a Korean preview with names instead of raw mentions", async () => {
  const user = await install();
  workspace.users.set("UP", { name: "박상구(부장)_DX팀" });
  channel("DG", "im", [ME, "UC"]);
  const q = msg({ channel: "DG", user: ME, text: "<@UP> 님 일정 확인해 주실 수 있나요?", hoursAgo: 30 });
  // Tracked by an old version, with an English topic
  await addFollowUp({
    kind: "outgoing",
    userId: ME,
    channel: "DG",
    threadTs: q,
    originalMessage: "<@UP> 님 일정 확인해 주실 수 있나요?",
    convType: "im",
    summary: "하은 - assignment discussion",
    summaryVersion: 3,
    createdAt: parseFloat(q) * 1000,
    lastRemindedAt: null,
    lastActivityAt: 0,
  });
  aiFailures.rateLimited = 1000; // model unavailable for this poll
  await pollUser(user);
  const row = (await getUserFollowUps(ME, "outgoing")).find((f) => f.threadTs === q)!;
  assert.match(row.summary!, /^하은 - @박상구\(부장\)_DX팀 님 일정 확인해 주실 수 있나요\?$/);
  assert.equal(row.summaryVersion, 0, "the AI topic is retried later");
});

test("commands typed in the Nudge DM work without /nudge, and replies show them that way", async () => {
  const user = await install({ botDmChannel: "DNUDGE" });
  const sent: { text?: string; blocks?: unknown[] }[] = [];
  const responder = (prefix: string) => ({
    prefix,
    send: async (r: { text?: string; blocks?: unknown[] }) => void sent.push(r),
    replace: async (r: { text?: string; blocks?: unknown[] }) => void sent.push(r),
  });

  assert.equal(parseDmText("설정").type, "status");
  assert.equal(parseDmText("/nudge 목록").type, "list");
  assert.equal(parseDmText("nudge list").type, "list");

  await runCommand(user, parseDmText("설정"), responder(DM_PREFIX));
  const dmStatus = JSON.stringify(sent.pop());
  assert.match(dmStatus, /내 Nudge 설정/);
  assert.match(dmStatus, /`목록`/);
  assert.doesNotMatch(dmStatus, /`\/nudge 목록`/, "no /nudge prefix inside the DM");

  await runCommand(user, parseDmText("설정"), responder(SLASH_PREFIX));
  assert.match(JSON.stringify(sent.pop()), /`\/nudge 목록`/, "slash replies keep the prefix");

  await runCommand(user, parseDmText("매일 9시"), responder(DM_PREFIX));
  assert.match(JSON.stringify(sent.pop()), /알림 시간을 바꿨어요: \*매일 오전 9시\*/);
  assert.deepEqual((await getUser(ME))!.schedule, { kind: "times", hours: [9], weekdaysOnly: false });

  await runCommand(user, parseDmText("고마워"), responder(DM_PREFIX));
  assert.match(JSON.stringify(sent.pop()), /천만에요/, "a thank-you gets a friendly reply, not an error");

  await runCommand(user, parseDmText("아무말대잔치"), responder(DM_PREFIX));
  const unknown = JSON.stringify(sent.pop());
  assert.match(unknown, /이해하지 못한 명령이에요/);
  assert.match(unknown, /`도움말`/, "unknown text points to the help");

  // Pasted from the help (inline code), with punctuation, or with a bot mention
  assert.equal(parseDmText("`목록`").type, "list");
  assert.equal(parseDmText("`매일 9시`").type, "schedule");
  assert.equal(parseDmText("목록.").type, "list");
  assert.equal(parseDmText("<@UNUDGE> 설정").type, "status");
  assert.equal(parseDmText("?").type, "help");
  for (const t of ["넵", "감사합니다!", "ㅇㅋ", ":+1:", "넵 :pray:"]) assert.equal(parseDmText(t).type, "thanks", t);
});

test("🔄 on a digest keeps the list on screen when a check is already running", async () => {
  const user = await install({ botDmChannel: "DNUDGE" });
  await pollUser(user);
  await redis.set(`nudge:lock:poll:${ME}`, 1, { nx: true, ex: 300 }); // another poll in progress
  const shown: { text?: string; blocks?: unknown[] }[] = [];
  const inPlace = {
    prefix: DM_PREFIX,
    send: async (r: { text?: string; blocks?: unknown[] }) => void shown.push(r),
    replace: async (r: { text?: string; blocks?: unknown[] }) => void shown.push(r),
  };
  await runCommand((await getUser(ME))!, { type: "refresh" }, inPlace);
  const last = JSON.stringify(shown.at(-1));
  assert.match(last, /dismiss_/, "rows and 완료 buttons are still there");
  assert.match(last, /nudge_refresh/, "quick buttons are still there");
  assert.match(last, /이미 확인하고 있어요/);
});

test("a paid-only model on the free plan falls back to the free model instead of failing", async () => {
  const user = await install();
  aiFailures.paidOnly.add("anthropic/claude-haiku-4.5"); // the configured default in tests
  const stats = await pollUser(user);
  assert.deepEqual(stats.errors, []);
  assert.ok(modelsUsed.includes("google/gemini-2.5-flash-lite"), "switched to the fallback model");
  // Calls run 4 at a time, so at most the first parallel batch hits the blocked model
  assert.ok(modelsUsed.filter((m) => m === "anthropic/claude-haiku-4.5").length <= 4, "the blocked model isn't retried");
  assert.equal((await getUserFollowUps(ME, "incoming")).length, 5, "detection still works");
});

test("notes in my self-DM are never tracked", async () => {
  const user = await install();
  channel("DSELF", "im", [ME, ME]);
  const note = msg({ channel: "DSELF", user: ME, text: "내일 회의 몇 시였지?", hoursAgo: 30 });
  await pollUser(user);
  assert.ok(!ids(await getUserFollowUps(ME, "outgoing")).includes(`DSELF:${note}`));
});

test("hourly mode only re-sends when something new shows up", async () => {
  const user = await install({ schedule: { kind: "interval", every: 1, start: 0, end: 23, weekdaysOnly: false } });
  await pollUser(user);
  const visible = visibleIds(await loadVisible((await getUser(ME))!));
  const prevSlot = currentSlot(Date.now()) - 1;
  const sameDay =
    localParts(prevSlot * HOUR * 1000, "Asia/Seoul").dateKey === localParts(Date.now(), "Asia/Seoul").dateKey;

  // Pretend the previous hour already delivered exactly these items
  const lastSentDate = localParts(prevSlot * HOUR * 1000, "Asia/Seoul").dateKey;
  await updateUser(ME, { lastSlot: prevSlot, lastDigestIds: visible, lastSentDate });
  await runTick("hourly");
  assert.equal(workspace.posted.length, sameDay ? 0 : 1, "no repeat of an unchanged list within the day");

  // A new question arrives (3h old so it's past the grace period). Re-running the same hour
  // needs the per-slot lock cleared; in production the next tick is a new slot.
  msg({ channel: "DC", user: "UC", text: "회의실 예약하셨나요?", hoursAgo: 3 });
  await updateUser(ME, { lastSlot: prevSlot, lastDigestIds: visible, lastSentDate });
  await redis.del(`nudge:lock:digest:${ME}:${currentSlot(Date.now())}`);
  await runTick("hourly-2");
  assert.equal(workspace.posted.length, sameDay ? 1 : 2, "new item → digest");
});
