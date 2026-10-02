// End-to-end poll → digest flow against a fake Slack workspace, in-memory Redis and
// keyword-based AI (see tests/mocks). Run with: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetSlack, workspace, type FakeMessage } from "./mocks/slack-web-api.ts";
import { resetRedis } from "./mocks/redis.ts";
import { aiCalls } from "./mocks/ai.ts";
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
  assert.match(text, /📥 답장이 필요한 질문 · 4/);
  assert.match(text, /📤 답을 기다리는 내 질문 · 2/);

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
