// End-to-end poll → digest flow against a fake Slack workspace, in-memory Redis and
// keyword-based AI (see tests/mocks). Run with: npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetSlack, workspace, type FakeMessage } from "./mocks/slack-web-api.ts";
import { resetMemoryStore } from "../lib/store/backend.ts";
import { aiCalls, aiFailures, aiVerdicts, modelsUsed, temperatures } from "./mocks/ai.ts";
import { classifyResponse, classifyUserMessage, resumeAi } from "../lib/ai.ts";
import { dmResponder, parseDmText, runCommand } from "../lib/nudge-command.ts";
import { firstReport } from "../lib/first-report.ts";
import { applyExport } from "../lib/migration.ts";
import { runJob } from "../lib/jobs.ts";
import { dismissGroup } from "../lib/dismiss.ts";
import { DM_PREFIX, SLASH_PREFIX } from "../lib/messages.ts";
import { JUDGE_VERSION, pollUser } from "../lib/poll.ts";
import { handleAppHomeOpened } from "../lib/home.ts";
import { CONNECT_URL } from "../lib/messages.ts";
import { hourlyTriggerActive, runTick } from "../lib/tick.ts";
import { getUser, saveUser, updateUser, type NudgeUser } from "../lib/db.ts";
import { acquireLock, acquireOwnedLock, addFollowUp, firstTime, getSeen, getSeenEntries, getUserFollowUps, itemId, markSeen, recordTick, releaseLock, removeFollowUp } from "../lib/store.ts";
import { buildDigestBlocks, loadVisible, PROMISED_LABEL, QUICK_ACTIONS, visibleIds, welcomeBlocks } from "../lib/digest.ts";
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
  resetMemoryStore();
  aiCalls.length = 0;
  aiFailures.rateLimited = 0;
  aiFailures.delayAborted = 0;
  aiFailures.paidOnly.clear();
  modelsUsed.length = 0;
  temperatures.length = 0;
  aiVerdicts.clear();
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
      `DA:${T.tooFresh}`, // tracked, but younger than 2h → not in digests yet
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
  assert.equal(first.queued.deliver, 1);
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

test("a brief 429 is retried; a lasting one postpones work instead of failing it, and nothing is lost", async () => {
  const user = await install();
  aiFailures.rateLimited = 2; // two 429s in a row: the retries get through
  const brief = await pollUser(user);
  assert.deepEqual(brief.errors, []);
  assert.ok(!brief.incomplete.some((r) => r.startsWith("AI rate limit")), JSON.stringify(brief.incomplete));

  resetMemoryStore(); // start over: nothing judged yet
  await install();
  aiCalls.length = 0;
  aiFailures.rateLimited = 1000; // out of capacity for a while
  const first = await pollUser((await getUser(ME))!);
  assert.deepEqual(first.errors, [], "rate limits are not reported as errors");
  assert.ok(first.incomplete.some((r) => r.startsWith("AI rate limit")), JSON.stringify(first.incomplete));
  assert.equal(aiCalls.length, 0, "no answers while out of capacity");
  const tried = 1000 - aiFailures.rateLimited;
  assert.ok(tried <= 4 * 4, `only the calls already running retry, then the AI pauses (${tried})`);

  // Pause over → the next poll picks everything up
  aiFailures.rateLimited = 0;
  resumeAi();
  await pollUser((await getUser(ME))!);
  const incoming = ids(await getUserFollowUps(ME, "incoming"));
  assert.ok(incoming.includes(`DA:${T.unanswered}`));
  assert.ok(incoming.includes(`DB:${T.deferredByMe}`));
  assert.equal((await getUserFollowUps(ME, "outgoing")).length, 2);
});

test("model calls that keep timing out pause the AI like a rate limit, not as errors", async () => {
  const user = await install();
  aiFailures.delayAborted = 1000; // every call runs past AI_TIMEOUT_MS
  const first = await pollUser(user);
  assert.deepEqual(first.errors, []);
  assert.ok(first.incomplete.some((r) => r.startsWith("AI rate limit")), JSON.stringify(first.incomplete));
  assert.ok(aiCalls.length === 0, "no more model calls while paused");
});

test("my casual reply in a group-DM thread settles the question, whatever the AI would say", async () => {
  const user = await install();
  const root = msg({ channel: "GMP", user: ME, text: "구매하겠냐구요", hoursAgo: 27 });
  const asked = msg({ channel: "GMP", user: "UA", text: "그래서 가방은 왜여!?", thread_ts: root, hoursAgo: 26 });
  const reply = "그냥요.. 누가 보내길래 뭔 브랜든가해서";
  msg({ channel: "GMP", user: ME, text: reply, thread_ts: root, hoursAgo: 25.99 });
  aiVerdicts.set(reply, "non-committal"); // what the model answered in production
  const deferred = msg({ channel: "GMP", user: "UB", text: "회식 장소 어디예요?", thread_ts: root, hoursAgo: 25 });
  msg({ channel: "GMP", user: ME, text: "확인해볼게요", thread_ts: root, hoursAgo: 24.9 });

  await pollUser(user);
  const incoming = ids(await getUserFollowUps(ME, "incoming"));
  assert.ok(!incoming.includes(`GMP:${asked}`), "answered in the thread");
  assert.ok(!aiCalls.includes(`classify:${reply}`), "a direct casual reply needs no AI");
  assert.ok(incoming.includes(`GMP:${deferred}`), "'확인해볼게요' still isn't an answer");
  assert.ok(temperatures.length > 0 && temperatures.every((t) => t === 0), "verdicts are deterministic");
});

test("an item pinned by an older misjudgment gets one more look, then keeps its checkpoint", async () => {
  const user = await install();
  const root = msg({ channel: "GMP", user: ME, text: "점심 메뉴 공유드려요", hoursAgo: 27 });
  const asked = msg({ channel: "GMP", user: "UA", text: "그래서 가방은 왜여!?", thread_ts: root, hoursAgo: 26 });
  const casual = msg({ channel: "GMP", user: ME, text: "그냥요.. 누가 보내길래 뭔 브랜든가해서", thread_ts: root, hoursAgo: 25.99 });
  const open = msg({ channel: "GMP", user: "UB", text: "회식 장소 어디예요?", thread_ts: root, hoursAgo: 25 });
  const deferral = msg({ channel: "GMP", user: ME, text: "확인해볼게요", thread_ts: root, hoursAgo: 24.9 });
  // Stored by the previous version: each reply was judged "not an answer" and checkedTs moved past it
  const pinned = (threadTs: string, askerId: string, text: string, checkedTs: string) =>
    addFollowUp({
      kind: "incoming", userId: ME, channel: "GMP", threadTs, parentThreadTs: root, originalMessage: text,
      convType: "mpim", askerId, checkedTs, createdAt: parseFloat(threadTs) * 1000, lastRemindedAt: null, lastActivityAt: 0,
    });
  await pinned(asked, "UA", "그래서 가방은 왜여!?", casual);
  await pinned(open, "UB", "회식 장소 어디예요?", deferral);

  await pollUser(user);
  const incoming = await getUserFollowUps(ME, "incoming");
  assert.ok(!ids(incoming).includes(`GMP:${asked}`), "re-read from the question and resolved");
  assert.ok((await getSeen(ME)).has(itemId("incoming", "GMP", asked)), "and never comes back");
  const still = incoming.find((f) => f.threadTs === open);
  assert.ok(still, "a real deferral stays open");
  assert.equal(still.judgeVersion, JUDGE_VERSION);
  assert.equal(still.checkedTs, deferral);

  const before = aiCalls.filter((c) => c.startsWith("classify:")).length;
  await pollUser((await getUser(ME))!);
  assert.equal(aiCalls.filter((c) => c.startsWith("classify:")).length, before, "not re-judged once stamped");
});

test("a reply split over two messages is read as one; a bystander's 'me too' isn't an answer", async () => {
  const user = await install();
  // "넵" then "확인해볼게요" right after: still waiting on me
  channel("DS", "im", [ME, "UC"]);
  const split = msg({ channel: "DS", user: "UC", text: "견적서 언제 받을 수 있을까요?", hoursAgo: 5 });
  msg({ channel: "DS", user: ME, text: "넵", hoursAgo: 4.5 });
  msg({ channel: "DS", user: ME, text: "확인해볼게요", hoursAgo: 4.499 });
  // My question to UB; UC chimes in on the thread
  const toUB = msg({ channel: "CGEN", user: ME, text: "<@UB> 배포 언제 되나요?", hoursAgo: 30 });
  msg({ channel: "CGEN", user: "UC", text: "저도 궁금하네요", thread_ts: toUB, hoursAgo: 29 });
  aiVerdicts.set("저도 궁금하네요", "non-committal");

  await pollUser(user);
  assert.ok(ids(await getUserFollowUps(ME, "incoming")).includes(`DS:${split}`), "'넵 확인해볼게요' is a deferral");
  assert.ok(aiCalls.includes("classify:넵 확인해볼게요"), "the AI sees both messages together");
  assert.ok(ids(await getUserFollowUps(ME, "outgoing")).includes(`CGEN:${toUB}`), "UB hasn't answered");
});

test("re-reading an item judged under older rules spends no AI on what was judged then", async () => {
  const user = await install();
  channel("DQ", "im", [ME, "UA"]);
  const asked = msg({ channel: "DQ", user: "UA", text: "다음 주 일정 공유 가능할까요?", hoursAgo: 30 });
  msg({ channel: "DQ", user: ME, text: "일정 확인하고 알려드릴게요", hoursAgo: 29 });
  const last = msg({ channel: "DQ", user: "UA", text: "넵 감사합니다", hoursAgo: 28 });
  await addFollowUp({
    kind: "incoming", userId: ME, channel: "DQ", threadTs: asked, originalMessage: "다음 주 일정 공유 가능할까요?",
    convType: "im", askerId: "UA", checkedTs: last, createdAt: parseFloat(asked) * 1000, lastRemindedAt: null, lastActivityAt: 0,
  });

  await pollUser(user);
  const item = (await getUserFollowUps(ME, "incoming")).find((f) => f.threadTs === asked);
  assert.ok(item, "still waiting on me");
  assert.equal(item.judgeVersion, JUDGE_VERSION);
  assert.equal(item.checkedTs, last, "checkpoint kept");
  const reJudged = aiCalls.filter((c) => c === "classify:일정 확인하고 알려드릴게요" || c === "user:넵 감사합니다");
  assert.equal(reJudged.length, 0, "messages judged before aren't sent to the AI again");
});

test("the classifier's verdict is read from the start of the model's answer", async () => {
  aiVerdicts.set("내일 드릴게요", "answer\n\n(not non-committal)");
  aiVerdicts.set("알아볼게요", "**Non-committal**");
  aiVerdicts.set("이거 어떻게 됐나요", "follow-up, not self-resolved");
  assert.equal(await classifyResponse("자료 언제 받을 수 있나요?", "내일 드릴게요"), "answer");
  assert.equal(await classifyResponse("자료 언제 받을 수 있나요?", "알아볼게요"), "non-committal");
  assert.equal(await classifyUserMessage("자료 언제 받을 수 있나요?", "이거 어떻게 됐나요"), "follow-up");
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
  // Slack sends "&" in message text as "&amp;"
  const ampText = "인사팀 Q&amp;A 챗봇 등록됐나요?";
  const amp = msg({ channel: "DG", user: ME, text: ampText, hoursAgo: 29 });
  await addFollowUp({
    kind: "outgoing",
    userId: ME,
    channel: "DG",
    threadTs: amp,
    originalMessage: ampText,
    convType: "im",
    createdAt: parseFloat(amp) * 1000,
    lastRemindedAt: null,
    lastActivityAt: 0,
  });
  aiFailures.rateLimited = 1000; // model unavailable for this poll
  await pollUser(user);
  const rows = await getUserFollowUps(ME, "outgoing");
  const row = rows.find((f) => f.threadTs === q)!;
  assert.match(row.summary!, /^하은 - @박상구\(부장\)_DX팀 님 일정 확인해 주실 수 있나요\?$/);
  assert.equal(row.summaryVersion, 0, "the AI topic is retried later");
  assert.equal(rows.find((f) => f.threadTs === amp)!.summary, "하은 - 인사팀 Q&A 챗봇 등록됐나요?", "shown as &, not &amp;");
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
  await acquireLock(`nudge:lock:poll:${ME}`, 300); // another poll in progress
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

test("🔄 and 목록 list questions the digest is still giving time to; the digest keeps waiting", async () => {
  await install({ botDmChannel: "DNUDGE" });
  const freshIn = msg({ channel: "DC", user: "UC", text: "오늘 회의 몇 시예요?", hoursAgo: 0.5 });
  const freshOut = msg({ channel: "DE", user: ME, text: "내일 회의실 어디인가요?", hoursAgo: 3 });
  const shown: { text?: string; blocks?: unknown[] }[] = [];
  const inPlace = {
    prefix: DM_PREFIX,
    send: async (r: { text?: string; blocks?: unknown[] }) => void shown.push(r),
    replace: async (r: { text?: string; blocks?: unknown[] }) => void shown.push(r),
  };

  await runCommand((await getUser(ME))!, { type: "refresh" }, inPlace);
  const refreshed = JSON.stringify(shown.at(-1));
  assert.ok(refreshed.includes(freshIn) && refreshed.includes(freshOut), "found just now → listed right away");
  assert.match(refreshed, /📥 내가 답장해야 할 질문 · 5/);
  assert.match(refreshed, /📤 상대에게 답장 받아야 할 질문 · 3/);
  assert.doesNotMatch(refreshed, /방금 확인했어요|다 보지 못한/, "no routine status lines");
  assert.match(refreshed, /완료\*를 눌러 주세요/, "the list's own hint instead");
  assert.doesNotMatch(refreshed, /알림 전|조금 뒤에/, "nothing is held back for later");
  assert.match(refreshed, /최신 질문까지 확인/);
  assert.match(refreshed, /\\"l\\":1/, "완료 on these rows rebuilds a list, keeping the fresh rows");

  await runCommand((await getUser(ME))!, { type: "refresh" }, inPlace);
  assert.ok(JSON.stringify(shown.at(-1)).includes(freshIn), "a second 🔄 keeps them listed");

  await runCommand((await getUser(ME))!, { type: "list" }, inPlace);
  assert.ok(JSON.stringify(shown.at(-1)).includes(freshIn), "목록 shows them too");

  // The scheduled digest still gives people 2h / 24h to reply first
  const hour = localParts(Date.now(), "Asia/Seoul").hour;
  await updateUser(ME, { schedule: { kind: "times", hours: [hour], weekdaysOnly: false } });
  await runTick("digest");
  const digest = JSON.stringify(workspace.posted.at(-1)?.blocks);
  assert.match(digest, /📥 내가 답장해야 할 질문 · 4/);
  assert.ok(!digest.includes(freshIn) && !digest.includes(freshOut));
  assert.doesNotMatch(digest, /\\"l\\":1/, "완료 on a digest keeps it a digest");
});

test("완료 on a digest's last row shows the questions still inside the wait, as 홈 and 목록 count them", async () => {
  const user = await install({ botDmChannel: "DNUDGE" });
  const freshIn = msg({ channel: "DC", user: "UC", text: "오늘 회의 몇 시예요?", hoursAgo: 0.5 });
  await pollUser(user);
  // Left: one question past the digest's 2h wait, one still inside it
  for (const kind of ["incoming", "outgoing"] as const) {
    for (const f of await getUserFollowUps(ME, kind)) {
      if (f.threadTs !== T.unanswered && f.threadTs !== freshIn) await removeFollowUp(kind, ME, f.channel, f.threadTs);
    }
  }
  assert.equal((await getUserFollowUps(ME, "incoming")).length, 2);

  // The digest only showed the older one; 완료 on it
  const reply = await dismissGroup((await getUser(ME))!, { k: "incoming", c: "DA", t: [T.unanswered] }, false, DM_PREFIX);
  const shown = JSON.stringify(reply);
  assert.doesNotMatch(shown, /모두 처리했어요/, "the 홈 tab still counts one");
  assert.match(shown, /확인할 질문이 1개 있어요/);
  assert.ok(shown.includes(freshIn) && !shown.includes(T.unanswered));
  assert.doesNotMatch(shown, /\\"l\\":1/, "still a digest");
});

test("🔄 that couldn't read some messages says so instead of 모두 처리했어요, and reads them next time", async () => {
  await install({ botDmChannel: "DNUDGE" });
  for (const id of workspace.channels.keys()) workspace.failing.add(id); // Slack hiccup on every read
  const shown: { text?: string; blocks?: unknown[] }[] = [];
  const inPlace = {
    prefix: DM_PREFIX,
    send: async (r: { text?: string; blocks?: unknown[] }) => void shown.push(r),
    replace: async (r: { text?: string; blocks?: unknown[] }) => void shown.push(r),
  };

  await runCommand((await getUser(ME))!, { type: "refresh" }, inPlace);
  const failed = JSON.stringify(shown.at(-1));
  assert.doesNotMatch(failed, /모두 처리했어요/);
  assert.match(failed, /아직 찾은 질문은 없어요/);
  assert.match(failed, /메시지 \d+개는 일시적인 오류로 읽지 못했어요/);
  assert.doesNotMatch(failed, /건\)/, "no bare count that reads like a number of questions");

  workspace.failing.clear();
  await runCommand((await getUser(ME))!, { type: "refresh" }, inPlace);
  const retried = JSON.stringify(shown.at(-1));
  assert.match(retried, /확인할 질문이 \d+개 있어요/, "the messages that failed are read on the next check");
  assert.doesNotMatch(retried, /오류/);
});

test("an unreachable model falls back to the other Gemini model instead of failing", async () => {
  const user = await install();
  aiFailures.paidOnly.add("gemini-3.8-flash"); // the configured default
  const stats = await pollUser(user);
  assert.deepEqual(stats.errors, []);
  assert.ok(modelsUsed.includes("gemini-2.5-flash"), "switched to the fallback model");
  // Calls run 4 at a time, so at most the first parallel batch hits the blocked model
  assert.ok(modelsUsed.filter((m) => m === "gemini-3.8-flash").length <= 4, "the blocked model isn't retried");
  assert.equal((await getUserFollowUps(ME, "incoming")).length, 5, "detection still works");
});

test("opening Nudge before connecting shows how to start; after connecting, the 홈 tab shows my settings", async () => {
  await install({ botDmChannel: "DNUDGE" });
  const urls = (blocks: unknown): string[] => JSON.stringify(blocks).match(/https:[^"]+/g) ?? [];

  // A coworker who never connected opens the 홈 tab, then the 메시지 tab twice
  await handleAppHomeOpened({ type: "app_home_opened", user: "UA", channel: "DUA", tab: "home" }, "T1", "A1");
  const start = workspace.published.at(-1)!;
  assert.equal(start.user_id, "UA");
  assert.match(JSON.stringify(start.view.blocks), /Nudge 시작하기/);
  assert.ok(urls(start.view.blocks).includes(CONNECT_URL), "one tap to connect");

  await handleAppHomeOpened({ type: "app_home_opened", user: "UA", channel: "DUA", tab: "messages" }, "T1", "A1");
  await handleAppHomeOpened({ type: "app_home_opened", user: "UA", channel: "DUA", tab: "messages" }, "T1", "A1");
  const guides = workspace.posted.filter((p) => p.channel === "DUA");
  assert.equal(guides.length, 1, "the connect guide is sent once, not on every visit");
  assert.ok(urls(guides[0].blocks).includes(CONNECT_URL));

  // I'm connected: settings, what to type, and a button to the Nudge DM
  await handleAppHomeOpened({ type: "app_home_opened", user: ME, channel: "DNUDGE", tab: "home" }, "T1", "A1");
  const homeBlocks = (workspace.published.at(-1)!.view.blocks ?? []) as { fields?: { text?: string }[] }[];
  const cells = homeBlocks.flatMap((b) => b.fields ?? []);
  assert.ok(cells.length > 0 && cells.every((f) => f.text?.trim()), "Slack rejects the whole view over an empty field");
  const home = JSON.stringify(homeBlocks);
  assert.match(home, /내 Nudge 설정/);
  assert.match(home, /app_redirect\?app=A1&team=T1/);
  assert.equal(workspace.posted.filter((p) => p.channel === "DNUDGE").length, 0, "no greeting for connected users");
});

test("the welcome DM is short and promises the result; the list says so while the first check runs", async () => {
  const welcome = JSON.stringify(welcomeBlocks());
  assert.match(welcome, /결과를 보내드릴게요/);
  assert.ok(!welcome.includes(QUICK_ACTIONS.list), "no button that only says 'still checking' during the first check");
  assert.ok(!/매시간|9시 13시|받은질문/.test(welcome), "no full usage guide up front");

  // 목록 typed right after connecting, before the first check finished
  const user = await install({ botDmChannel: "DNUDGE" });
  await runCommand(user, { type: "list" }, dmResponder(user.botToken, "DNUDGE"));
  const early = JSON.stringify(workspace.posted.at(-1)!.blocks);
  assert.match(early, /확인하고 있어요/);
  assert.ok(!early.includes("모두 처리했어요"), "not 'all done' before anything was checked");

  // A first scan cut short (e.g. by the AI limit) with nothing found yet still says so
  await updateUser(ME, { firstScanPending: true, lastPolledAt: Date.now() });
  await runCommand((await getUser(ME))!, { type: "list" }, dmResponder(user.botToken, "DNUDGE"));
  assert.match(JSON.stringify(workspace.posted.at(-1)!.blocks), /확인하고 있어요/);

  await pollUser((await getUser(ME))!);
  assert.equal((await getUser(ME))!.firstScanPending, false, "a poll that read everything ends the first scan");
  await runCommand((await getUser(ME))!, { type: "list" }, dmResponder(user.botToken, "DNUDGE"));
  const after = JSON.stringify(workspace.posted.at(-1)!.blocks);
  assert.match(after, /확인할 질문이 \d+개 있어요/);
  assert.equal(workspace.posted.at(-1)!.channel, "DNUDGE", "posted in the Nudge DM like a typed 목록");
});

test("the first check's result DM lists what it found, and says when it couldn't read everything", async () => {
  await install({ botDmChannel: "DNUDGE", firstScanPending: true });
  channel("DQ", "im", [ME, "UC"]);
  msg({ channel: "DQ", user: "UC", text: "견적서 언제 받을 수 있을까요?", hoursAgo: 0.5 });

  const stats = await pollUser((await getUser(ME))!);
  const done = JSON.stringify((await firstReport((await getUser(ME))!, stats)).blocks);
  assert.match(done, /다 확인했어요/);
  assert.match(done, /archives\/DQ\/.*30분 전/, "includes a question still inside the digest's 2h wait");
  assert.match(done, /평일 오전 8시/, "says when the next ones come");
  assert.ok(!done.includes("확인하고 있어요"));

  // Cut short (e.g. by the AI limit): what was found so far, without "all done"
  await updateUser(ME, { firstScanPending: true });
  const partial = JSON.stringify((await firstReport((await getUser(ME))!, stats)).blocks);
  assert.match(partial, /일부를 먼저 확인했어요/);
  assert.match(partial, /다음 확인 때 이어서/);
  assert.ok(!partial.includes("다 확인했어요"));

  // Nothing found and not done: never "모두 처리했어요"
  for (const kind of ["incoming", "outgoing"] as const) {
    for (const f of await getUserFollowUps(ME, kind)) await removeFollowUp(kind, ME, f.channel, f.threadTs);
  }
  const empty = JSON.stringify((await firstReport((await getUser(ME))!, stats)).blocks);
  assert.ok(!empty.includes("모두 처리했어요"));
  assert.match(empty, /아직 찾은 질문은 없어요/);
});

test("the tick sends the first check's result to new users who never got it, once", async () => {
  // Connected before the result DM existed: welcome only, still waiting
  await install({ installedAt: Date.now() - HOUR * 1000, firstScanPending: true, lastSlot: currentSlot(Date.now()) });
  const first = await runTick("catch-up");
  assert.equal(first.queued.firstReport, 1);
  assert.equal(workspace.posted.length, 1);
  assert.match(JSON.stringify(workspace.posted[0].blocks), /지난 7일 치 Slack/);
  assert.ok((await getUser(ME))!.firstReportAt);

  await runTick("catch-up-again");
  assert.equal(workspace.posted.length, 1, "only once");
});

test("the tick leaves the first result to the callback right after connecting, and skips old installs", async () => {
  await install({ installedAt: Date.now() - 2 * 60 * 1000, lastSlot: currentSlot(Date.now()) });
  assert.equal((await runTick("just-connected")).queued.firstReport, 0);
  await updateUser(ME, { installedAt: Date.now() - 3 * 24 * HOUR * 1000 });
  assert.equal((await runTick("long-ago")).queued.firstReport, 0);
  assert.equal(workspace.posted.length, 0);
});

test("a promise to get back is labelled in the list, also on items judged before the label existed", async () => {
  const user = await install();
  // I promised to check and reply; the asker only said thanks
  channel("DP", "im", [ME, "UC"]);
  const promisedToMe = msg({ channel: "DP", user: "UC", text: "동의서 수정 가능 여부만 확인 부탁 드립니다", hoursAgo: 30 });
  msg({ channel: "DP", user: ME, text: "네 이해했습니다. CNS 측에 확인 후 회신드리겠습니다.", hoursAgo: 29.9 });
  aiVerdicts.set("네 이해했습니다. CNS 측에 확인 후 회신드리겠습니다.", "non-committal");
  msg({ channel: "DP", user: "UC", text: "네 감사합니다~", hoursAgo: 29.8 });
  // Tracked by the previous version: checkpoint already past my promise, no label yet
  channel("DR", "im", [ME, "UE"]);
  const older = msg({ channel: "DR", user: "UE", text: "견적서 공유 가능할까요?", hoursAgo: 40 });
  const later = msg({ channel: "DR", user: ME, text: "알아보고 말씀드릴게요", hoursAgo: 39 });
  await addFollowUp({
    kind: "incoming", userId: ME, channel: "DR", threadTs: older, originalMessage: "견적서 공유 가능할까요?", convType: "im",
    askerId: "UE", checkedTs: later, judgeVersion: 1, createdAt: parseFloat(older) * 1000, lastRemindedAt: null, lastActivityAt: 0,
  });

  await pollUser(user);
  const incoming = await getUserFollowUps(ME, "incoming");
  assert.equal(incoming.find((f) => f.threadTs === promisedToMe)?.promised, true, "'확인 후 회신드리겠습니다' is a promise");
  assert.equal(incoming.find((f) => f.threadTs === older)?.promised, true, "older items get the label on their re-read");
  assert.ok(!aiCalls.includes("classify:알아보고 말씀드릴게요"), "…without asking the AI again");
  assert.equal(incoming.find((f) => f.threadTs === T.unanswered)?.promised, undefined, "no reply, no label");
  assert.equal((await getUserFollowUps(ME, "outgoing")).find((f) => f.threadTs === T.outDeferred)?.promised, true, "their '알아볼게요'");

  const visible = await loadVisible((await getUser(ME))!);
  const rows = JSON.stringify(buildDigestBlocks(visible, "https://clio.slack.com", { maxPerSection: 20 }));
  assert.ok(rows.includes(PROMISED_LABEL.incoming) && rows.includes(PROMISED_LABEL.outgoing));

  // A second poll keeps the label without re-reading anything
  const before = aiCalls.length;
  await pollUser((await getUser(ME))!);
  assert.equal((await getUserFollowUps(ME, "incoming")).find((f) => f.threadTs === promisedToMe)?.promised, true);
  assert.equal(aiCalls.filter((c) => c !== "summary").length, aiCalls.slice(0, before).filter((c) => c !== "summary").length);
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
  // …and the stored data is older than a pre-poll would leave it, so this digest polls first
  await updateUser(ME, { lastSlot: prevSlot, lastDigestIds: visible, lastSentDate, lastGoodPollAt: Date.now() - 2 * HOUR * 1000 });
  await releaseLock(`nudge:lock:digest:${ME}:${currentSlot(Date.now())}`);
  await runTick("hourly-2");
  assert.equal(workspace.posted.length, sameDay ? 1 : 2, "new item → digest");
});

test("someone's promise to get back to me is tracked as a reply I'm waiting for", async () => {
  const user = await install();
  // I answered their question; they promised a review — nothing of mine is a question
  channel("DQ", "im", [ME, "UC"]);
  msg({ channel: "DQ", user: "UC", text: "동의서 문구 수정 가능할까요?", hoursAgo: 40 });
  msg({ channel: "DQ", user: ME, text: "Google 측 확인 결과 문구 수정은 불가하고 조항 추가는 가능하다고 합니다.", hoursAgo: 30 });
  const promise = msg({
    channel: "DQ", user: "UC", text: "안녕하세요 부장님~\n네 내용 참고하여 검토 의견 드리겠습니다.\n감사합니다.", hoursAgo: 29.9,
  });
  msg({ channel: "DQ", user: "UC", text: "좋은 하루 되세요", hoursAgo: 29.89 }); // sent along with it
  msg({ channel: "DQ", user: ME, text: "네 알겠습니다.", hoursAgo: 29.8 });
  msg({ channel: "DQ", user: "UC", text: "넵", hoursAgo: 20 });

  await pollUser(user);
  const item = (await getUserFollowUps(ME, "outgoing")).find((f) => f.channel === "DQ");
  assert.equal(item?.threadTs, promise);
  assert.equal(item?.promiserId, "UC");
  assert.equal(item?.promised, true);
  assert.match(item?.about ?? "", /Google 측 확인 결과/, "my message it replies to, for the topic");
  assert.ok(!aiCalls.some((c) => c.startsWith("promise:")), "a plain promise needs no AI");
  assert.ok(!aiCalls.some((c) => c.includes("넵") || c.includes("네 알겠습니다")), "acks need no AI either");

  const rows = JSON.stringify(buildDigestBlocks(await loadVisible((await getUser(ME))!), "https://clio.slack.com", { maxPerSection: 20 }));
  assert.ok(rows.includes(PROMISED_LABEL.outgoing));

  // Their actual review closes it
  msg({ channel: "DQ", user: "UC", text: "검토해보니 조항 추가 방식으로 진행 가능할 것 같습니다", hoursAgo: 1 });
  await pollUser((await getUser(ME))!);
  assert.ok(!(await getUserFollowUps(ME, "outgoing")).some((f) => f.channel === "DQ"));
  assert.ok((await getSeen(ME)).has(itemId("outgoing", "DQ", promise)), "and it doesn't come back");
});

test("a promise in reply to my own question stays one item: the question, labelled", async () => {
  const user = await install();
  channel("DQ", "im", [ME, "UC"]);
  const question = msg({ channel: "DQ", user: ME, text: "견적서 최종본 공유 부탁드립니다", hoursAgo: 30 });
  const promise = msg({ channel: "DQ", user: "UC", text: "확인 후 공유드리겠습니다", hoursAgo: 29.9 });
  aiVerdicts.set("확인 후 공유드리겠습니다", "non-committal");

  await pollUser(user);
  const outgoing = (await getUserFollowUps(ME, "outgoing")).filter((f) => f.channel === "DQ");
  assert.deepEqual(outgoing.map((f) => f.threadTs), [question]);
  assert.equal(outgoing[0].promised, true);
  assert.ok((await getSeen(ME)).has(itemId("outgoing", "DQ", promise)));
});

test("promises made to someone else, thanks, and unclear ones the AI turns down aren't tracked", async () => {
  const user = await install();
  // Group DM: a promise to someone else, by @mention or right after their message
  msg({ channel: "GMP", user: ME, text: "이번 주 일정 정리했습니다", hoursAgo: 30 });
  const toOther = msg({ channel: "GMP", user: "UB", text: "<@UA> 내일 회신드리겠습니다", hoursAgo: 29.9 });
  msg({ channel: "GMP", user: "UA", text: "견적 정리했어요", hoursAgo: 29 });
  const afterOther = msg({ channel: "GMP", user: "UB", text: "확인해서 알려드릴게요", hoursAgo: 28.9 });
  // DMs: thanks, a maybe-promise to a third party (AI says no), and one the AI confirms
  channel("DQ", "im", [ME, "UC"]);
  msg({ channel: "DQ", user: ME, text: "요청하신 자료 보냈습니다", hoursAgo: 30 });
  msg({ channel: "DQ", user: "UC", text: "감사드리겠습니다", hoursAgo: 29.9 });
  const thirdParty = msg({ channel: "DQ", user: "UC", text: "팀장님께 전달드리겠습니다", hoursAgo: 29 });
  channel("DR", "im", [ME, "UE"]);
  msg({ channel: "DR", user: ME, text: "계약서 초안 첨부했습니다", hoursAgo: 30 });
  const loose = msg({ channel: "DR", user: "UE", text: "내일까지 드리겠습니다", hoursAgo: 29.9 });

  aiFailures.rateLimited = 1000; // the AI stays out of capacity: postponed, not dropped
  await pollUser(user);
  aiFailures.rateLimited = 0;
  resumeAi();
  await pollUser((await getUser(ME))!);

  const outgoing = (await getUserFollowUps(ME, "outgoing")).map((f) => `${f.channel}:${f.threadTs}`);
  assert.ok(outgoing.includes(`DR:${loose}`), "the AI confirmed it, once the limit passed");
  for (const ts of [toOther, afterOther]) assert.ok(!outgoing.includes(`GMP:${ts}`));
  assert.ok(!outgoing.some((id) => id.startsWith("DQ:")));
  assert.ok(aiCalls.includes(`promise:팀장님께 전달드리겠습니다`) && aiCalls.includes(`promise:내일까지 드리겠습니다`));
  assert.ok(!aiCalls.some((c) => c.includes("감사드리겠습니다")), "thanks are never candidates");
  assert.ok((await getSeen(ME)).has(itemId("outgoing", "DQ", thirdParty)));
});

test("the GCP import writes users, questions, seen ids and one-time flags, and a re-run follows Vercel", async () => {
  const base = { slackTeamId: "T1", botToken: "xoxb-test", userToken: "xoxp-test", installedAt: 1, tz: "Asia/Seoul" };
  const q = (threadTs: string) => ({
    kind: "incoming" as const,
    userId: ME,
    channel: "DA",
    threadTs,
    originalMessage: "견적서 언제 받을 수 있을까요?",
    createdAt: 1_790_000_000_000,
    lastRemindedAt: null,
    lastActivityAt: 0,
  });
  const data = {
    version: 1 as const,
    exportedAt: 1,
    users: [{ slackUserId: ME, ...base, schedule: { kind: "times" as const, hours: [9], weekdaysOnly: true } }],
    // A record from before incoming tracking had no kind: outgoing
    followups: [q("1790000000.000100"), { ...q("1790000000.000200"), kind: undefined, channel: "DB" }],
    seen: { [ME]: { "incoming:DX:1700000000.000100": 1_700_000_000_000 } },
    flags: ["nudge:onboarded:U_NEW"],
    slack: {},
  };
  const counts = await applyExport(data);
  assert.equal(counts.users, 1);
  assert.equal(counts.followups, 2);
  assert.equal((await getUser(ME))!.schedule?.kind, "times");
  assert.equal((await getUserFollowUps(ME, "incoming")).length, 1);
  assert.equal((await getUserFollowUps(ME, "outgoing"))[0].channel, "DB");
  assert.equal((await getSeenEntries(ME))["incoming:DX:1700000000.000100"], 1_700_000_000_000);
  assert.equal(await firstTime("nudge:onboarded:U_NEW"), false, "the greeting isn't sent again");

  // Answered on Vercel before the cutover: gone here too after a second run
  const again = await applyExport({ ...data, followups: [data.followups[1]] });
  assert.equal(again.removedFollowups, 1);
  assert.equal((await getUserFollowUps(ME, "incoming")).length, 0);
});

test("a digest that fails to send frees its slot, so the next tick sends it", async () => {
  const hour = localParts(Date.now(), "Asia/Seoul").hour;
  await install({ schedule: { kind: "times", hours: [hour], weekdaysOnly: false } });
  workspace.postFailures = 1; // Slack is down for the first attempt
  const first = await runTick("tick-1");
  assert.equal(first.queued.deliver, 1);
  assert.equal(workspace.posted.length, 0);
  assert.notEqual((await getUser(ME))!.lastSlot, currentSlot(Date.now()), "the slot isn't marked as handled");

  await runTick("tick-2"); // 5 minutes later
  assert.equal(workspace.posted.length, 1, "sent on the retry");
  await runTick("tick-3");
  assert.equal(workspace.posted.length, 1, "and only once");
});

test("a late lock holder can't release someone else's lock", async () => {
  const mine = await acquireOwnedLock("nudge:lock:poll:UX", 1);
  assert.ok(mine);
  await new Promise((r) => setTimeout(r, 1100)); // expired
  const theirs = await acquireOwnedLock("nudge:lock:poll:UX", 60);
  assert.ok(theirs);
  await releaseLock("nudge:lock:poll:UX", mine!); // the old poll finishing late
  assert.equal(await acquireLock("nudge:lock:poll:UX", 60), false, "the newer lock still holds");
  await releaseLock("nudge:lock:poll:UX", theirs!);
  assert.equal(await acquireLock("nudge:lock:poll:UX", 60), true);
});

test("the scheduler counts as running once a tick landed in the last 20 minutes", async () => {
  assert.equal(await hourlyTriggerActive(), false, "no tick yet");
  await recordTick(currentSlot(Date.now()), "cloud-scheduler");
  assert.equal(await hourlyTriggerActive(), true, "right after the first tick — no '알림이 늦을 수 있어요' warning");
  assert.equal(await hourlyTriggerActive(Date.now() + 25 * 60_000), false, "silent for 25 minutes");
});

test("the tick's first-report catch-up leaves a user to onboarding while its poll runs", async () => {
  await install({ installedAt: Date.now() - 30 * 60_000, firstScanPending: true, lastSlot: currentSlot(Date.now()) });
  await acquireLock(`nudge:lock:poll:${ME}`, 300); // onboarding's poll
  assert.deepEqual(await runJob({ type: "first-report", userId: ME }), { sent: false });
  assert.equal(workspace.posted.length, 0);
  assert.equal((await getUser(ME))!.firstReportAt, undefined, "onboarding still sends it");
});

test("a poll whose searches failed doesn't count as fresh data for the next digest", async () => {
  const user = await install();
  await pollUser(user);
  const good = (await getUser(ME))!.lastGoodPollAt;
  assert.ok(good);
  workspace.failSearch = true;
  await pollUser((await getUser(ME))!);
  workspace.failSearch = false;
  const after = (await getUser(ME))!;
  assert.ok(after.lastPolledAt! >= good!);
  assert.equal(after.lastGoodPollAt, good, "only a poll that read everything counts");
});
