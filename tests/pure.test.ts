// Run with: npm test  (node's built-in test runner + type stripping, no extra deps)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, applyScheduleUpdate, type Command } from "../lib/command.ts";
import {
  DEFAULT_SCHEDULE,
  findDueSlot,
  formatSchedule,
  formatSlotTime,
  localParts,
  nextSlotTime,
  resolveSchedule,
  worksWithDailyCronOnly,
  type Schedule,
} from "../lib/schedule.ts";
import { isCcMention, isLikelyQuestion, otherMentions } from "../lib/question.ts";
import { PRESETS } from "../lib/presets.ts";

const HOUR = 3600_000;
const SEOUL = "Asia/Seoul";
// 2026-10-05 is a Monday. KST = UTC+9.
const kst = (y: number, mo: number, d: number, h: number, min = 0) => Date.UTC(y, mo - 1, d, h - 9, min);

function schedule(cmd: Command, base: Schedule = DEFAULT_SCHEDULE): Schedule {
  assert.equal(cmd.type, "schedule", JSON.stringify(cmd));
  return applyScheduleUpdate(base, (cmd as Extract<Command, { type: "schedule" }>).update);
}

test("simple commands and aliases", () => {
  for (const [input, type] of [
    ["", "status"], ["설정", "status"], ["help", "help"], ["도움말", "help"], ["사용법", "help"],
    ["list", "list"], ["목록", "list"], ["refresh", "refresh"], ["지금", "refresh"], ["새로고침", "refresh"],
    ["off", "pause"], ["끄기", "pause"], ["on", "resume"], ["켜기", "resume"],
  ] as const) {
    assert.equal(parseCommand(input).type, type, input);
  }
});

test("tracking toggles", () => {
  assert.deepEqual(parseCommand("받은 질문 끄기"), { type: "track", incoming: false });
  assert.deepEqual(parseCommand("받은질문 켜기"), { type: "track", incoming: true });
  assert.deepEqual(parseCommand("incoming off"), { type: "track", incoming: false });
  assert.deepEqual(parseCommand("보낸 질문 off"), { type: "track", outgoing: false });
  assert.deepEqual(parseCommand("outgoing on"), { type: "track", outgoing: true });
});

test("timezone", () => {
  assert.deepEqual(parseCommand("tz Asia/Seoul"), { type: "timezone", tz: "Asia/Seoul" });
  assert.deepEqual(parseCommand("tz asia/tokyo"), { type: "timezone", tz: "Asia/Tokyo" });
  assert.deepEqual(parseCommand("시간대 KST"), { type: "timezone", tz: "Asia/Seoul" });
  assert.deepEqual(parseCommand("tz auto"), { type: "timezone", tz: "auto" });
  assert.deepEqual(parseCommand("time zone Asia/Tokyo"), { type: "timezone", tz: "Asia/Tokyo" });
  assert.deepEqual(parseCommand("time zone auto"), { type: "timezone", tz: "auto" });
  assert.equal(parseCommand("tz Mars/Base").type, "error");
});

test("daily / specific times", () => {
  // 매일/daily = all seven days; a bare time keeps the day filter (default 평일)
  assert.deepEqual(schedule(parseCommand("매일")), { kind: "times", hours: [8], weekdaysOnly: false });
  assert.deepEqual(schedule(parseCommand("daily 9am")), { kind: "times", hours: [9], weekdaysOnly: false });
  assert.deepEqual(schedule(parseCommand("매일 9시")), { kind: "times", hours: [9], weekdaysOnly: false });
  assert.deepEqual(schedule(parseCommand("평일 매일 9시")), { kind: "times", hours: [9], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("9시")), { kind: "times", hours: [9], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("밤 12시")), { kind: "times", hours: [0], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("저녁 7시")), { kind: "times", hours: [19], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("밤 1시")), { kind: "times", hours: [1], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("밤 11시")), { kind: "times", hours: [23], weekdaysOnly: true });
  // bare 매일 only adds weekends — frequency stays
  const three: Schedule = { kind: "times", hours: [9, 13, 18], weekdaysOnly: true };
  assert.deepEqual(schedule(parseCommand("매일"), three), { ...three, weekdaysOnly: false });
  const hourlyBase: Schedule = { kind: "interval", every: 1, start: 9, end: 18, weekdaysOnly: true };
  assert.deepEqual(schedule(parseCommand("매일"), hourlyBase), { ...hourlyBase, weekdaysOnly: false });
  assert.deepEqual(schedule(parseCommand("오후 12시")), { kind: "times", hours: [12], weekdaysOnly: true });
  // keeps a single current hour; several hours collapse to the default
  const nine: Schedule = { kind: "times", hours: [9], weekdaysOnly: true };
  assert.deepEqual(schedule(parseCommand("매일"), nine), { kind: "times", hours: [9], weekdaysOnly: false });
  assert.deepEqual(schedule(parseCommand("하루 한 번"), { ...nine, hours: [9, 18] }), {
    kind: "times", hours: [8], weekdaysOnly: true,
  });
  assert.deepEqual(schedule(parseCommand("9am 5pm")), { kind: "times", hours: [9, 17], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("오전 9시 오후 6시")), { kind: "times", hours: [9, 18], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("9시 13시 18시")), { kind: "times", hours: [9, 13, 18], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("5시")), { kind: "times", hours: [17], weekdaysOnly: true }, "5시 → 오후 5시");
  assert.deepEqual(schedule(parseCommand("오전 5시")), { kind: "times", hours: [5], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("17:00")), { kind: "times", hours: [17], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("5:30pm")), { kind: "times", hours: [17], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("9시로")), { kind: "times", hours: [9], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("12pm")), { kind: "times", hours: [12], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("12am")), { kind: "times", hours: [0], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("9, 17")), { kind: "times", hours: [9, 17], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("하루 한 번")), { kind: "times", hours: [8], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("daily at 9am")), { kind: "times", hours: [9], weekdaysOnly: false });
});

test("hourly / intervals / windows", () => {
  const hourly = { kind: "interval", every: 1, start: 9, end: 18, weekdaysOnly: true };
  assert.deepEqual(schedule(parseCommand("매시간")), hourly);
  assert.deepEqual(schedule(parseCommand("매 시간")), hourly);
  assert.deepEqual(schedule(parseCommand("hourly")), hourly);
  assert.deepEqual(schedule(parseCommand("every hour")), hourly);
  assert.deepEqual(schedule(parseCommand("2시간마다")), { ...hourly, every: 2 });
  assert.deepEqual(schedule(parseCommand("두 시간마다")), { ...hourly, every: 2 });
  assert.deepEqual(schedule(parseCommand("every 3 hours")), { ...hourly, every: 3 });
  assert.deepEqual(schedule(parseCommand("2h")), { ...hourly, every: 2 });
  assert.deepEqual(schedule(parseCommand("매시간 10-19")), { ...hourly, start: 10, end: 19 });
  assert.deepEqual(schedule(parseCommand("매시간 9시~18시")), hourly);
  assert.deepEqual(schedule(parseCommand("9시부터 18시까지 매시간")), hourly);
  assert.deepEqual(schedule(parseCommand("hourly 9am-6pm")), hourly);
  assert.deepEqual(schedule(parseCommand("매시간 9-6")), hourly, "9-6 → 9시~18시");
  assert.deepEqual(schedule(parseCommand("매시간 0-23")), { ...hourly, start: 0, end: 23 });
  // keeps existing window when only the interval changes
  const base: Schedule = { kind: "interval", every: 1, start: 10, end: 20, weekdaysOnly: false };
  assert.deepEqual(schedule(parseCommand("3시간마다"), base), { ...base, every: 3 });
  // window alone switches to hourly within it
  assert.deepEqual(schedule(parseCommand("10-17")), { ...hourly, start: 10, end: 17 });
  // 1~6 without 오전/오후 means afternoon, also in ranges
  const win = (input: string) => {
    const s = schedule(parseCommand(input));
    return s.kind === "interval" ? [s.start, s.end] : null;
  };
  assert.deepEqual(win("매시간 1-5"), [13, 17]);
  assert.deepEqual(win("매시간 1시-5시"), [13, 17]);
  assert.deepEqual(win("매시간 2-6"), [14, 18]);
  assert.deepEqual(win("매시간 오후 1시-5시"), [13, 17]);
  assert.deepEqual(win("매시간 오후 1시-6시"), [13, 18]);
  assert.deepEqual(win("매시간 1-5pm"), [13, 17]);
  assert.deepEqual(win("매시간 오전 9시~6시"), [9, 18]);
  assert.deepEqual(win("매시간 6-9"), [6, 9]);
  assert.deepEqual(win("매시간 7-11"), [7, 11]);
  assert.deepEqual(win("매시간 9-6pm"), [9, 18]);
  // "11시간마다" must not be eaten by the hourly alias
  assert.deepEqual(schedule(parseCommand("11시간마다")), { ...hourly, every: 11 });
});

test("weekday filters", () => {
  assert.deepEqual(schedule(parseCommand("주말포함")), { kind: "times", hours: [8], weekdaysOnly: false });
  assert.deepEqual(schedule(parseCommand("주말 포함 매시간")), {
    kind: "interval", every: 1, start: 9, end: 18, weekdaysOnly: false,
  });
  const weekend: Schedule = { kind: "times", hours: [9], weekdaysOnly: false };
  assert.deepEqual(schedule(parseCommand("평일만"), weekend), { ...weekend, weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("평일 9시"), weekend), { kind: "times", hours: [9], weekdaysOnly: true });
  assert.deepEqual(schedule(parseCommand("weekdays"), weekend), { ...weekend, weekdaysOnly: true });
});

test("invalid schedules produce errors", () => {
  for (const input of ["blah", "9시 매시간", "매시간 18-9", "25시", "13시간마다", "9시 10-12", "매시간 아무때나"]) {
    assert.equal(parseCommand(input).type, "error", input);
  }
});

test("formatSchedule", () => {
  assert.equal(formatSchedule(DEFAULT_SCHEDULE), "평일 오전 8시");
  assert.equal(formatSchedule({ kind: "times", hours: [18, 9], weekdaysOnly: false }), "매일 오전 9시, 오후 6시");
  assert.equal(formatSchedule({ kind: "interval", every: 1, start: 9, end: 18, weekdaysOnly: true }), "평일 9시~18시 매시간");
  assert.equal(formatSchedule({ kind: "interval", every: 2, start: 0, end: 23, weekdaysOnly: false }), "매일 하루 종일 2시간마다");
});

test("localParts in Seoul", () => {
  const p = localParts(kst(2026, 10, 5, 8), SEOUL);
  assert.equal(p.hour, 8);
  assert.equal(p.weekday, 1);
  assert.equal(p.dateKey, "2026-10-05");
});

test("findDueSlot: daily 8am delivers once, catches up, skips weekends", () => {
  const s = DEFAULT_SCHEDULE;
  // Monday 08:20 KST → due
  const due = findDueSlot(s, false, SEOUL, kst(2026, 10, 5, 8, 20));
  assert.ok(due);
  assert.equal(due!.localHour, 8);
  assert.equal(due!.isFirstOfDay, true);
  // Same slot already handled → not due again (Vercel cron + GitHub tick in same hour)
  assert.equal(findDueSlot(s, false, SEOUL, kst(2026, 10, 5, 8, 50), due!.slot), null);
  // Late tick at 10:10 still catches the 8am slot (catch-up window)
  assert.equal(findDueSlot(s, false, SEOUL, kst(2026, 10, 5, 10, 10))?.localHour, 8);
  // 11:10 is past the catch-up window
  assert.equal(findDueSlot(s, false, SEOUL, kst(2026, 10, 5, 11, 10)), null);
  // Saturday → nothing
  assert.equal(findDueSlot(s, false, SEOUL, kst(2026, 10, 10, 8, 5)), null);
  // weekends included
  assert.ok(findDueSlot({ ...s, weekdaysOnly: false }, false, SEOUL, kst(2026, 10, 10, 8, 5)));
  // paused
  assert.equal(findDueSlot(s, true, SEOUL, kst(2026, 10, 5, 8, 5)), null);
});

test("findDueSlot: hourly within window", () => {
  const s: Schedule = { kind: "interval", every: 1, start: 9, end: 18, weekdaysOnly: true };
  const at9 = findDueSlot(s, false, SEOUL, kst(2026, 10, 5, 9, 7));
  assert.equal(at9?.localHour, 9);
  assert.equal(at9?.isFirstOfDay, true);
  // The 9 o'clock digest went out → 10 o'clock is not the day's first
  const at10 = findDueSlot(s, false, SEOUL, kst(2026, 10, 5, 10, 7), at9!.slot, at9!.dateKey);
  assert.equal(at10?.localHour, 10);
  assert.equal(at10?.isFirstOfDay, false);
  // 9 o'clock had nothing to send (no digest posted) → 10 o'clock still sends the full list
  assert.equal(findDueSlot(s, false, SEOUL, kst(2026, 10, 5, 10, 7), at9!.slot, "2026-10-02")?.isFirstOfDay, true);
  assert.equal(findDueSlot(s, false, SEOUL, kst(2026, 10, 5, 22, 7)), null);
  // 7am: yesterday's 18h is out of the catch-up window
  assert.equal(findDueSlot(s, false, SEOUL, kst(2026, 10, 6, 7, 7)), null);
  // every 2h: 9, 11, 13 ... — 10 isn't a slot, but the 9 slot is still catchable
  const two: Schedule = { ...s, every: 2 };
  const t = findDueSlot(two, false, SEOUL, kst(2026, 10, 5, 10, 7));
  assert.equal(t?.localHour, 9);
  // The 9:07 tick was dropped: the 10 o'clock slot is the day's first delivery
  const yesterday18 = findDueSlot(s, false, SEOUL, kst(2026, 10, 2, 18, 7))!.slot;
  const late = findDueSlot(s, false, SEOUL, kst(2026, 10, 5, 10, 2), yesterday18, "2026-10-02");
  assert.equal(late?.localHour, 10);
  assert.equal(late?.isFirstOfDay, true);
});

test("findDueSlot: DST fall-back doesn't deliver the repeated hour twice", () => {
  const la = "America/Los_Angeles";
  const s: Schedule = { kind: "times", hours: [1], weekdaysOnly: false };
  // 2026-11-01: 01:00 PDT = 08:00Z, 01:00 PST = 09:00Z
  const first = findDueSlot(s, false, la, Date.UTC(2026, 10, 1, 8, 7));
  assert.equal(first?.localHour, 1);
  assert.equal(findDueSlot(s, false, la, Date.UTC(2026, 10, 1, 9, 7), first!.slot), null);
});

test("nextSlotTime / formatSlotTime", () => {
  // Friday 2026-10-09 10:00 KST, weekdays 8am → Monday 10/12 8am
  const next = nextSlotTime(DEFAULT_SCHEDULE, SEOUL, kst(2026, 10, 9, 10));
  assert.equal(next, kst(2026, 10, 12, 8));
  assert.equal(formatSlotTime(next!, SEOUL), "10월 12일(월) 오전 8시");
  // Exactly at a slot → the following one
  const hourly: Schedule = { kind: "interval", every: 1, start: 9, end: 18, weekdaysOnly: false };
  assert.equal(nextSlotTime(hourly, SEOUL, kst(2026, 10, 10, 9)), kst(2026, 10, 10, 10));
  assert.equal(formatSlotTime(kst(2026, 10, 10, 18), SEOUL), "10월 10일(토) 오후 6시");
});

test("worksWithDailyCronOnly", () => {
  const now = kst(2026, 10, 5, 12);
  assert.equal(worksWithDailyCronOnly(DEFAULT_SCHEDULE, SEOUL, now), true);
  assert.equal(worksWithDailyCronOnly({ kind: "times", hours: [9], weekdaysOnly: true }, SEOUL, now), false);
  assert.equal(worksWithDailyCronOnly({ kind: "interval", every: 1, start: 9, end: 18, weekdaysOnly: true }, SEOUL, now), false);
});

test("legacy user records", () => {
  assert.deepEqual(resolveSchedule({}), { schedule: DEFAULT_SCHEDULE, paused: false });
  assert.deepEqual(resolveSchedule({ reminderHours: [] }), { schedule: DEFAULT_SCHEDULE, paused: true });
  assert.deepEqual(resolveSchedule({ reminderHours: [23, 8], timezone: "KST" }), {
    schedule: { kind: "times", hours: [8, 17], weekdaysOnly: false },
    paused: false,
  });
  // old "every N hours" fired on UTC hours divisible by N — same local hours now
  assert.deepEqual(resolveSchedule({ reminderInterval: 24, timezone: "KST" }).schedule, {
    kind: "times", hours: [9], weekdaysOnly: false,
  });
  assert.deepEqual(resolveSchedule({ reminderInterval: 12 }).schedule, { kind: "times", hours: [9, 21], weekdaysOnly: false });
  // old "/nudge off" ({reminderHours: []}) can be turned back on
  assert.equal(resolveSchedule({ reminderHours: [], paused: false }).paused, false);
});

test("isLikelyQuestion: Korean and English", () => {
  const yes = [
    "이거 언제 배포되나요",
    "회의 몇 시에 할까요",
    "검토 부탁드립니다",
    "자료 공유해 주세요",
    "내일 시간 되세요?",
    "이 건 확인 좀 부탁드려요 :)",
    "혹시 이 문서 보셨어요",
    "가능할까요~~",
    "오늘 회의 몇 시 맞죠",
    "회의실 예약했습니까",
    "can you review this?",
    "<@U123> 이거 봐줄 수 있어?",
    "그럼 언제 오세요",
    "이거 같이 할까",
    "자료 좀 보내줘",
    "내일 회의 몇 시예요",
    "견적 검토 후 회신 바랍니다",
    "확인 바랍니다",
    "의견 주세요",
    "이거 어떻게 해요",
    "<@U1> 견적서 검토 부탁드립니다, 잘 부탁드려요",
    "자료 공유드립니다. 확인 부탁드리며 잘 부탁드립니다",
    "검토 부탁드리고 앞으로도 잘 부탁드립니다",
    "시간 있으시면 연락 주세요",
    "언제 오시는지 궁금해요",
    "얼마나 걸려요",
  ];
  const no = [
    "수고하세요",
    "안녕히 계세요",
    "고생하셨어요",
    "참고 부탁드립니다",
    "양해 부탁드립니다",
    "생각나요 그때",
    "아까",
    "그러니까",
    "https://example.com/page?x=1",
    "`select * from t where a = ?`",
    "오늘 배포 완료했습니다.",
    "네 알겠습니다",
    "ok",
    "> 이거 언제 되나요?\n네 확인했어요",
    "&gt; 배포 언제 되나요?\n내일 오전에 합니다",
    "이번 주 배포 일정 공유드립니다. 잘 부탁드립니다",
    "신입 김철수입니다. 잘 부탁드립니다!",
    "많은 참여 부탁드립니다",
    "참고 바랍니다",
    "좋은 하루 되세요",
    "언제든 말씀하세요",
    "궁금한 점은 언제든 물어보세요",
    "언제든지 편하게 연락하세요",
    "어디든 괜찮아요",
    "뭐든 좋아요",
    "누구나 참석 가능해요",
    "어떻게든 돼요",
    "어떻게 할지 고민 중이에요",
    "언제 끝날지 모르겠어요",
    "다음 주 배포 공지입니다. 궁금한 점 있으면 연락 주세요.",
    "문의 사항 있으시면 연락 주세요",
    "편하게 연락 주세요",
    "언제든 말씀해 주세요",
  ];
  for (const t of yes) assert.equal(isLikelyQuestion(t), true, `should be question: ${t}`);
  for (const t of no) assert.equal(isLikelyQuestion(t), false, `should not be question: ${t}`);
});

test("recommended presets parse to what the landing page promises", () => {
  for (const p of PRESETS) {
    assert.ok(p.command.startsWith("/nudge "), p.id);
    const result = schedule(parseCommand(p.command.slice("/nudge ".length)));
    assert.equal(formatSchedule(result), p.schedule, p.id);
  }
});

test("otherMentions / isCcMention", () => {
  assert.deepEqual(otherMentions("<@U1> <@U2|kim> <@U1> hi", "U1"), ["U2"]);
  assert.equal(isCcMention("<@UB> 이 견적 확인 부탁드려요 cc <@UME>", "UME"), true);
  assert.equal(isCcMention("<@UB> 확인 부탁드려요\ncc: <@UA>, <@UME>", "UME"), true);
  assert.equal(isCcMention("<@UB> 확인 부탁드려요 (참조 <@UME>)", "UME"), true);
  assert.equal(isCcMention("<@UA> <@UME> 다음 주 회의 참석 가능하신가요?", "UME"), false);
  assert.equal(isCcMention("<@UME> 이거 봐주세요 cc <@UA>", "UME"), false);
});

test("slot ids are hour-aligned and stable", () => {
  const a = findDueSlot(DEFAULT_SCHEDULE, false, SEOUL, kst(2026, 10, 5, 8, 1));
  const b = findDueSlot(DEFAULT_SCHEDULE, false, SEOUL, kst(2026, 10, 5, 8, 59));
  assert.equal(a!.slot, b!.slot);
  assert.equal(a!.slot * HOUR, kst(2026, 10, 5, 8));
});
