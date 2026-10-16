// Feedback in Slack (modal, message shortcut, 의견, 완료) and the datasets built from it
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetSlack, workspace } from "./mocks/slack-web-api.ts";
import { resetMemoryStore } from "../lib/store/backend.ts";
import { aiCalls } from "./mocks/ai.ts";
import { resumeAi } from "../lib/ai.ts";
import { saveUser, getUser } from "../lib/db.ts";
import { getUserFollowUps, getSeen, itemId } from "../lib/store.ts";
import { pollUser } from "../lib/poll.ts";
import { buildDigestBlocks, digestGroups, FEEDBACK_ACTION, loadVisible } from "../lib/digest.ts";
import { openFeedbackModal, handleFeedbackSubmission, handleMissedQuestion } from "../lib/feedback-ui.ts";
import { allFeedback, feedbackJsonl, tuningJsonl } from "../lib/feedback.ts";
import { dismissGroup } from "../lib/dismiss.ts";
import { dmResponder, runCommand } from "../lib/nudge-command.ts";
import { parseCommand } from "../lib/command.ts";
import { DM_PREFIX } from "../lib/messages.ts";
import { buildWorkspace, channel, ME, msg } from "./fixtures.ts";

async function install() {
  return saveUser({
    slackUserId: ME,
    slackTeamId: "T1",
    botToken: "xoxb-test",
    userToken: "xoxp-test",
    installedAt: Date.now(),
    tz: "Asia/Seoul",
    botDmChannel: "DNUDGE",
  });
}

beforeEach(() => {
  resetSlack();
  buildWorkspace();
  resetMemoryStore();
  aiCalls.length = 0;
  resumeAi();
});

test("lists and digests with questions offer the feedback button; an empty one doesn't", async () => {
  const user = await install();
  await pollUser(user);
  const visible = await loadVisible((await getUser(ME))!, Date.now(), { includeFresh: true });
  const withItems = JSON.stringify(buildDigestBlocks(visible, "https://clio.slack.com", { maxPerSection: 10, isList: true }));
  assert.ok(withItems.includes(FEEDBACK_ACTION));
  assert.ok(withItems.includes('"value":"list"'));
  const empty = JSON.stringify(buildDigestBlocks({ incoming: [], outgoing: [] }, "https://clio.slack.com", { maxPerSection: 10 }));
  assert.ok(!empty.includes(FEEDBACK_ACTION), "nothing to point at");
});

test("the modal lists the questions shown; a submission labels them, removes them and redraws the message", async () => {
  const user = await install();
  await pollUser(user);
  const fresh = (await getUser(ME))!;
  const groups = digestGroups(await loadVisible(fresh, Date.now(), { includeFresh: true }));
  assert.ok(groups.length >= 2);

  await openFeedbackModal({
    trigger_id: "trig",
    user: { id: ME },
    channel: { id: "DNUDGE" },
    message: { ts: "1790000000.000001" },
    actions: [{ value: "list" }],
  });
  assert.equal(workspace.opened.length, 1);
  const view = workspace.opened[0].view as { callback_id: string; private_metadata: string; blocks: { block_id?: string; element?: { options?: { text: { text: string } }[] } }[] };
  assert.equal(view.callback_id, "nudge_feedback_modal");
  const options = view.blocks.find((b) => b.block_id === "items")!.element!.options!;
  assert.equal(options.length, groups.length);
  assert.ok(options.every((o) => o.text.text.length <= 75));

  const target = groups[0];
  await handleFeedbackSubmission({
    userId: ME,
    meta: view.private_metadata,
    values: {
      items: { v: { selected_options: [{ value: "0" }] } },
      reason: { v: { selected_option: { value: "not_question" } } },
      note: { v: { value: "공지였어요" } },
      dismiss: { v: { selected_options: [{ value: "yes" }] } },
    },
  });

  const fb = await allFeedback();
  assert.equal(fb.length, target.threadTs.length);
  assert.ok(fb.every((f) => f.label === "not_question" && f.source === "modal" && f.note === "공지였어요" && f.originalMessage));
  const left = await getUserFollowUps(ME, target.kind);
  assert.ok(!left.some((f) => target.threadTs.includes(f.threadTs)), "removed from the list");
  assert.ok((await getSeen(ME)).has(itemId(target.kind, target.channel, target.threadTs[0])), "and it doesn't come back");
  assert.equal(workspace.updated.at(-1)?.ts, "1790000000.000001", "the list it was opened from is redrawn");
});

test("a note without picking a question is kept as a comment", async () => {
  await install();
  await handleFeedbackSubmission({ userId: ME, meta: JSON.stringify({ prefix: DM_PREFIX, groups: [] }), values: { note: { v: { value: "주말엔 쉬고 싶어요" } } } });
  const [fb] = await allFeedback();
  assert.equal(fb.label, "comment");
  assert.equal(fb.note, "주말엔 쉬고 싶어요");
});

test("'Nudge가 놓친 질문' starts tracking the message and records the miss", async () => {
  await install();
  await handleMissedQuestion({ userId: ME, channel: "C9", message: { ts: "1790000000.000500", user: "UB", text: "이거 언제까지 가능할까요" } });
  const [item] = await getUserFollowUps(ME, "incoming");
  assert.equal(item.threadTs, "1790000000.000500");
  assert.equal(item.askerId, "UB");
  await handleMissedQuestion({ userId: ME, channel: "C9", message: { ts: "1790000000.000600", user: ME, text: "자료 받을 수 있을까요?" } });
  assert.equal((await getUserFollowUps(ME, "outgoing"))[0].threadTs, "1790000000.000600", "my own question: waiting on someone");
  const fb = await allFeedback();
  assert.deepEqual(fb.map((f) => f.label).sort(), ["missed", "missed"]);
});

test("완료 records that it was a real question; 의견 records free text", async () => {
  const user = await install();
  await pollUser(user);
  const [first] = await getUserFollowUps(ME, "incoming");
  await dismissGroup((await getUser(ME))!, { k: "incoming", c: first.channel, t: [first.threadTs] }, true, DM_PREFIX);
  assert.ok((await allFeedback()).some((f) => f.label === "done" && f.source === "dismiss" && f.threadTs === first.threadTs));

  assert.deepEqual(parseCommand("의견 목록이 너무 길어요"), { type: "feedback", text: "목록이 너무 길어요" });
  assert.deepEqual(parseCommand("피드백: 좋아요"), { type: "feedback", text: "좋아요" });
  assert.equal(parseCommand("의견").type, "feedback");
  await runCommand((await getUser(ME))!, parseCommand("의견 주말 알림 끄고 싶어요"), dmResponder("xoxb-test", "DNUDGE"));
  assert.ok((await allFeedback()).some((f) => f.label === "comment" && f.note === "주말 알림 끄고 싶어요"));
  assert.match(workspace.posted.at(-1)!.text ?? "", /고마워요/);
});

test("the exports join feedback with the AI calls about the same message", async () => {
  const user = await install();
  await pollUser(user);
  // One the AI called non-committal that the person says was answered, and one marked 완료
  const items = await getUserFollowUps(ME, "incoming");
  const judged = items.find((f) => f.promised) ?? items[0];
  const meta = JSON.stringify({ prefix: DM_PREFIX, groups: [{ k: "incoming", c: judged.channel, t: [judged.threadTs] }] });
  await handleFeedbackSubmission({
    userId: ME,
    meta,
    values: { items: { v: { selected_options: [{ value: "0" }] } }, reason: { v: { selected_option: { value: "already_answered" } } } },
  });
  const raw = (await feedbackJsonl()).split("\n").map((l) => JSON.parse(l));
  assert.ok(raw.length >= 1);
  assert.ok(raw[0].aiCalls.length >= 1, "the AI calls about that message come along");
  for (const line of (await tuningJsonl()).split("\n").filter(Boolean)) {
    const ex = JSON.parse(line);
    assert.equal(ex.contents.length, 2);
    assert.equal(ex.contents[0].role, "user");
    assert.equal(ex.contents[1].role, "model");
  }
});

test("a question added by hand stays until something new answers it", async () => {
  const user = await install();
  channel("DQ1", "im", [ME, "UB"]);
  // Already 'answered' by Nudge's rules: my plain reply, my 👍, and one older than 14 days
  const replied = msg({ channel: "DQ1", user: "UB", text: "자료 공유 부탁드립니다", hoursAgo: 6 });
  msg({ channel: "DQ1", user: ME, text: "네 알겠습니다", hoursAgo: 5.9 });
  const reacted = msg({ channel: "DQ1", user: "UB", text: "회의 괜찮으세요?", hoursAgo: 5, reactions: [{ name: "+1", users: [ME] }] });
  const old = msg({ channel: "DQ1", user: "UB", text: "견적 언제 가능할까요?", hoursAgo: 20 * 24 });
  for (const ts of [replied, reacted, old]) {
    await handleMissedQuestion({ userId: ME, channel: "DQ1", message: { ts, user: "UB", text: "q" } });
  }
  await pollUser((await getUser(ME))!);
  const kept = (await getUserFollowUps(ME, "incoming")).filter((f) => f.channel === "DQ1").map((f) => f.threadTs).sort();
  assert.deepEqual(kept, [replied, reacted, old].sort(), "the next poll keeps all three");

  // A real answer afterwards settles it
  msg({ channel: "DQ1", user: ME, text: "자료는 드라이브에 올렸어요", hoursAgo: -0.01 }); // after it was flagged
  await pollUser((await getUser(ME))!);
  assert.ok(!(await getUserFollowUps(ME, "incoming")).some((f) => f.threadTs === replied), "answered after it was added");
  void user;
});

test("the shortcut on a question Nudge already tracks records nothing new", async () => {
  const user = await install();
  await pollUser(user);
  const [tracked] = await getUserFollowUps(ME, "incoming");
  await handleMissedQuestion({ userId: ME, channel: tracked.channel, message: { ts: tracked.threadTs, user: tracked.askerId, text: "x" } });
  assert.equal((await allFeedback()).length, 0);
});

test("a double click on 완료 writes one record", async () => {
  const user = await install();
  await pollUser(user);
  const [first] = await getUserFollowUps(ME, "incoming");
  const value = { k: "incoming" as const, c: first.channel, t: [first.threadTs] };
  await Promise.all([dismissGroup((await getUser(ME))!, value, true, DM_PREFIX), dismissGroup((await getUser(ME))!, value, true, DM_PREFIX)]);
  assert.equal((await allFeedback()).filter((f) => f.label === "done").length, 1);
});

test("tuning data leaves out 완료 and messages whose feedback disagrees", async () => {
  await install();
  await handleMissedQuestion({ userId: ME, channel: "C7", message: { ts: "1790000000.000700", user: "UB", text: "이거 가능할까요?" } });
  const { recordFeedback, feedbackFromItem } = await import("../lib/feedback.ts");
  const [item] = await getUserFollowUps(ME, "incoming");
  // Later the same person says it wasn't a question after all: only the newest counts
  await new Promise((r) => setTimeout(r, 5));
  await recordFeedback(feedbackFromItem(ME, item, "not_question", "modal"));
  await recordFeedback(feedbackFromItem(ME, item, "done", "dismiss"), "done~x");
  const lines = (await tuningJsonl()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].contents[1].parts[0].text, "no", "the newest explicit feedback wins; 완료 isn't used");
});
