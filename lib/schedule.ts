// Pure scheduling helpers — no imports, so they can be unit-tested with plain node.

export type Schedule =
  | { kind: "times"; hours: number[]; weekdaysOnly: boolean }
  | { kind: "interval"; every: number; start: number; end: number; weekdaysOnly: boolean };

export const DEFAULT_TIMEZONE = "Asia/Seoul";
export const DEFAULT_DAILY_HOUR = 8;
export const DEFAULT_SCHEDULE: Schedule = { kind: "times", hours: [DEFAULT_DAILY_HOUR], weekdaysOnly: true };
export const DEFAULT_WINDOW = { start: 9, end: 18 };

// vercel.json runs the tick once a day at this UTC hour (Vercel Hobby limit).
// 23 UTC = 8am KST.
export const DAILY_CRON_UTC_HOUR = 23;

// A late tick may still deliver a slot up to this many hours after it was due.
export const CATCHUP_HOURS = 2;

const HOUR_MS = 60 * 60 * 1000;

// Legacy user records stored timezone as "KST"/"PT" and hours in UTC.
const LEGACY_TZ: Record<string, { iana: string; offset: number }> = {
  KST: { iana: "Asia/Seoul", offset: 9 },
  PT: { iana: "America/Los_Angeles", offset: -8 },
};

const TZ_ALIASES: Record<string, string> = {
  kst: "Asia/Seoul",
  seoul: "Asia/Seoul",
  서울: "Asia/Seoul",
  한국: "Asia/Seoul",
  jst: "Asia/Tokyo",
  pt: "America/Los_Angeles",
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  et: "America/New_York",
  est: "America/New_York",
  edt: "America/New_York",
  utc: "UTC",
  gmt: "UTC",
};

export interface ScheduleFields {
  schedule?: Schedule;
  paused?: boolean;
  tz?: string;
  // legacy
  reminderHours?: number[];
  reminderInterval?: number;
  timezone?: string;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimezone(input: string): string | null {
  const trimmed = input.trim();
  const alias = TZ_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  if (isValidTimezone(trimmed)) {
    // Intl canonicalizes case ("asia/seoul" -> "Asia/Seoul")
    return new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
  }
  return null;
}

export function resolveTimezone(user: ScheduleFields): string {
  if (user.tz && isValidTimezone(user.tz)) return user.tz;
  if (user.timezone && LEGACY_TZ[user.timezone]) return LEGACY_TZ[user.timezone].iana;
  return DEFAULT_TIMEZONE;
}

// Returns the effective schedule and whether reminders are paused,
// converting legacy (UTC hours / interval) records on the fly.
export function resolveSchedule(user: ScheduleFields): { schedule: Schedule; paused: boolean } {
  if (user.schedule) return { schedule: user.schedule, paused: user.paused === true };

  const offset = LEGACY_TZ[user.timezone || "KST"]?.offset ?? 9;
  const toLocal = (utcHour: number) => (((utcHour + offset) % 24) + 24) % 24;

  if (user.reminderInterval) {
    const every = user.reminderInterval;
    // Old "/nudge hourly" / "every N hours": the new interval mode within work hours, so it
    // only pings when something new shows up (a 24-slot fixed-time list would resend hourly).
    if (every < 12) {
      return {
        schedule: { kind: "interval", every, start: DEFAULT_WINDOW.start, end: DEFAULT_WINDOW.end, weekdaysOnly: false },
        paused: user.paused === true,
      };
    }
    // Long intervals fired when the UTC hour was divisible by N; keep those exact local hours
    const utcHours = Array.from({ length: 24 }, (_, h) => h).filter((h) => h % every === 0);
    return {
      schedule: { kind: "times", hours: uniqueSorted(utcHours.map(toLocal)), weekdaysOnly: false },
      paused: user.paused === true,
    };
  }

  if (user.reminderHours) {
    // Old "/nudge off" stored an empty list; an explicit paused:false (new "/nudge on") overrides it
    if (user.reminderHours.length === 0) return { schedule: DEFAULT_SCHEDULE, paused: user.paused !== false };
    const hours = uniqueSorted(user.reminderHours.map(toLocal));
    return { schedule: { kind: "times", hours, weekdaysOnly: false }, paused: user.paused === true };
  }

  return { schedule: DEFAULT_SCHEDULE, paused: user.paused === true };
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  weekday: number; // 0 = Sunday
  dateKey: string; // YYYY-MM-DD in the target timezone
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(ms: number, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  const year = parseInt(parts.year);
  const month = parseInt(parts.month);
  const day = parseInt(parts.day);
  return {
    year,
    month,
    day,
    hour: parseInt(parts.hour) % 24,
    weekday: WEEKDAYS[parts.weekday] ?? 0,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

export function scheduledHours(schedule: Schedule): number[] {
  if (schedule.kind === "times") return uniqueSorted(schedule.hours);
  const hours: number[] = [];
  for (let h = schedule.start; h <= schedule.end; h += schedule.every) hours.push(h);
  return hours;
}

export function isScheduledAt(schedule: Schedule, weekday: number, hour: number): boolean {
  if (schedule.weekdaysOnly && (weekday === 0 || weekday === 6)) return false;
  return scheduledHours(schedule).includes(hour);
}

export interface DueSlot {
  slot: number; // epoch hour (UTC hours since 1970) — unique id of this delivery
  localHour: number;
  dateKey: string;
  isFirstOfDay: boolean; // no digest was posted yet on this local day
}

export function currentSlot(nowMs: number): number {
  return Math.floor(nowMs / HOUR_MS);
}

// Finds the most recent scheduled slot in the catch-up window that hasn't been
// handled yet (slot > lastSlot). Returns null when nothing is due.
// `lastSentDate` is the local date of the last digest actually posted: the first
// delivery of a new day sends the full list even if a tick was late or dropped.
export function findDueSlot(
  schedule: Schedule,
  paused: boolean,
  tz: string,
  nowMs: number,
  lastSlot?: number,
  lastSentDate?: string
): DueSlot | null {
  if (paused) return null;
  const now = currentSlot(nowMs);
  const last = lastSlot !== undefined ? localParts(lastSlot * HOUR_MS, tz) : null;

  for (let i = 0; i <= CATCHUP_HOURS; i++) {
    const slot = now - i;
    if (lastSlot !== undefined && slot <= lastSlot) break;
    const p = localParts(slot * HOUR_MS, tz);
    // DST fall-back repeats a local hour; it was already delivered
    if (last && last.dateKey === p.dateKey && last.hour === p.hour) continue;
    if (isScheduledAt(schedule, p.weekday, p.hour)) {
      return { slot, localHour: p.hour, dateKey: p.dateKey, isFirstOfDay: lastSentDate !== p.dateKey };
    }
  }
  return null;
}

// Start (epoch ms) of the next scheduled slot strictly after `nowMs`, within 8 days
export function nextSlotTime(schedule: Schedule, tz: string, nowMs: number): number | null {
  const now = currentSlot(nowMs);
  for (let i = 1; i <= 8 * 24; i++) {
    const ms = (now + i) * HOUR_MS;
    const p = localParts(ms, tz);
    if (isScheduledAt(schedule, p.weekday, p.hour)) return ms;
  }
  return null;
}

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

// "10월 6일(화) 오전 9시"
export function formatSlotTime(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.month}월 ${p.day}일(${WEEKDAY_KO[p.weekday]}) ${formatHour(p.hour)}`;
}

// Whether every delivery of this schedule lines up with the once-a-day cron,
// i.e. the schedule works even without the hourly GitHub Actions trigger.
export function worksWithDailyCronOnly(schedule: Schedule, tz: string, nowMs: number): boolean {
  const hours = scheduledHours(schedule);
  if (hours.length !== 1) return false;
  // Local hour of the daily cron today (handles DST for zones that have it)
  const today = new Date(nowMs);
  const cronMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), DAILY_CRON_UTC_HOUR);
  return localParts(cronMs, tz).hour === hours[0];
}

export function formatHour(hour: number): string {
  if (hour === 0) return "자정";
  if (hour === 12) return "낮 12시";
  if (hour < 12) return `오전 ${hour}시`;
  return `오후 ${hour - 12}시`;
}

export function formatSchedule(schedule: Schedule): string {
  const days = schedule.weekdaysOnly ? "평일" : "매일";
  if (schedule.kind === "times") {
    return `${days} ${uniqueSorted(schedule.hours).map(formatHour).join(", ")}`;
  }
  const window =
    schedule.start === 0 && schedule.end === 23 ? "하루 종일" : `${schedule.start}시~${schedule.end}시`;
  const freq = schedule.every === 1 ? "매시간" : `${schedule.every}시간마다`;
  return `${days} ${window} ${freq}`;
}

export function formatTimezone(tz: string): string {
  if (tz === "Asia/Seoul") return "한국 시간";
  return tz;
}

export function uniqueSorted(nums: number[]): number[] {
  return [...new Set(nums)].sort((a, b) => a - b);
}
