// Runs the store against real Firestore (database nudge-test):
//   GOOGLE_APPLICATION_CREDENTIALS=<deployer key> npm run test:firestore
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { backend } from "../../lib/store/backend.ts";
import {
  acquireLock,
  addFollowUp,
  firstTime,
  getFollowUp,
  getSeen,
  getSeenEntries,
  getUserFollowUps,
  hasMarker,
  markSeen,
  recentTickHours,
  recordTick,
  releaseLock,
  removeFollowUp,
  setMarker,
  updateFollowUp,
  clearUserFollowUps,
} from "../../lib/store.ts";
import { getAllUsers, getUser, removeUser, saveUser, updateUser } from "../../lib/db.ts";
import { recentRuns, recordRun } from "../../lib/runs.ts";

assert.equal(process.env.FIRESTORE_DATABASE, "nudge-test");
const U = `UTEST${process.pid}`;

after(async () => {
  await clearUserFollowUps(U);
  await removeUser(U);
});

test("users: merge on save, undefined removes a field, nested objects are replaced whole", async () => {
  await saveUser({ slackUserId: U, slackTeamId: "T", botToken: "b", userToken: "u", installedAt: 1, reminderHours: [9], schedule: { kind: "times", hours: [8], weekdaysOnly: true } });
  await saveUser({ slackUserId: U, slackTeamId: "T", botToken: "b2", userToken: "u2", installedAt: 1 });
  let u = await getUser(U);
  assert.equal(u!.botToken, "b2");
  assert.deepEqual(u!.reminderHours, [9], "reinstall keeps preferences");
  u = await updateUser(U, { reminderHours: undefined, schedule: { kind: "interval", every: 2, start: 9, end: 18, weekdaysOnly: true } });
  const stored = await getUser(U);
  assert.equal("reminderHours" in stored!, false);
  assert.equal("hours" in (stored!.schedule as object), false, "no leftovers from the old schedule");
  assert.ok((await getAllUsers()).some((x) => x.slackUserId === U));
  assert.equal(await updateUser("UNOBODY", { paused: true }), null);
});

test("follow-ups: per kind, oldest first, update merges, remove", async () => {
  const f = (ts: string, createdAt: number, kind: "incoming" | "outgoing") => ({
    kind, userId: U, channel: "C1", threadTs: ts, originalMessage: "q?", createdAt, lastRemindedAt: null, lastActivityAt: 0,
  });
  await addFollowUp(f("1790000000.000300", 3, "incoming"));
  await addFollowUp(f("1790000000.000100", 1, "incoming"));
  await addFollowUp(f("1790000000.000200", 2, "outgoing"));
  assert.deepEqual((await getUserFollowUps(U, "incoming")).map((x) => x.createdAt), [1, 3]);
  assert.equal((await getUserFollowUps(U, "outgoing")).length, 1);
  await updateFollowUp("incoming", U, "C1", "1790000000.000100", { summary: "주제", promised: true });
  const got = await getFollowUp("incoming", U, "C1", "1790000000.000100");
  assert.equal(got!.summary, "주제");
  assert.equal(got!.originalMessage, "q?");
  await updateFollowUp("incoming", U, "C1", "1790000000.999999", { summary: "x" }); // missing: no-op
  assert.equal(await getFollowUp("incoming", U, "C1", "1790000000.999999"), null);
  await removeFollowUp("incoming", U, "C1", "1790000000.000300");
  assert.equal((await getUserFollowUps(U, "incoming")).length, 1);
});

test("seen ids with dots and colons; old ones are pruned", async () => {
  const fresh = "incoming:C1:1790000000.000100";
  const old = "outgoing:D1:1600000000.000100";
  await Promise.all([markSeen(U, fresh, Date.now()), markSeen(U, old, Date.now() - 40 * 86400_000)]);
  const seen = await getSeen(U);
  assert.ok(seen.has(fresh));
  assert.ok(!seen.has(old));
  assert.equal(old in (await getSeenEntries(U)), false, "pruned from the document");
});

test("locks: one winner under contention, free again after release or expiry", async () => {
  const key = `nudge:lock:test:${U}`;
  const results = await Promise.all(Array.from({ length: 5 }, () => acquireLock(key, 60)));
  assert.equal(results.filter(Boolean).length, 1);
  await releaseLock(key);
  assert.equal(await acquireLock(key, 1), true);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await acquireLock(key, 60), true, "expired lock can be taken");
  await releaseLock(key);
});

test("markers expire, flags are one-time", async () => {
  await setMarker(`nudge:sent:${U}:1`, 1);
  assert.equal(await hasMarker(`nudge:sent:${U}:1`), true);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await hasMarker(`nudge:sent:${U}:1`), false);
  assert.equal(await firstTime(`nudge:onboarded:${U}`), true);
  assert.equal(await firstTime(`nudge:onboarded:${U}`), false);
  await backend.delete(`flags/nudge:onboarded:${U}`);
  await backend.delete(`markers/nudge:sent:${U}:1`);
});

test("ticks and runs", async () => {
  await recordTick(500000, "test");
  await recordTick(500001, "test");
  assert.equal(await recentTickHours(500001, 6), 2);
  await recordRun("test-run", { ok: true, n: 1, nested: { a: undefined, b: 2 } }, U, 5);
  const runs = await recentRuns(5, "test-run");
  assert.ok(runs.length >= 1);
  assert.ok(runs[0].data.at instanceof Date, "Timestamps come back as Dates");
  for (const r of runs) await backend.delete(`runs/${r.id}`);
  await backend.delete("meta/ticks");
});
