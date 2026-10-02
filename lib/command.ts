// Pure /nudge argument parser — relative imports only so it can be unit-tested with plain node.
import { DEFAULT_DAILY_HOUR, DEFAULT_WINDOW, normalizeTimezone, uniqueSorted, type Schedule } from "./schedule.ts";

export interface ScheduleUpdate {
  daily?: boolean; // "하루 한 번" with no explicit time → once a day (keeps a single current time)
  hours?: number[];
  every?: number;
  window?: { start: number; end: number };
  weekdaysOnly?: boolean;
}

export type Command =
  | { type: "status" }
  | { type: "help" }
  | { type: "list" }
  | { type: "refresh" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "track"; incoming?: boolean; outgoing?: boolean }
  | { type: "timezone"; tz: string } // IANA name or "auto"
  | { type: "schedule"; update: ScheduleUpdate }
  | { type: "thanks" } // "넵", "감사합니다" typed in the Nudge DM
  | { type: "error"; message: string };

const MAX_TIMES = 12;

function is(text: string, words: string[]): boolean {
  return words.includes(text);
}

function normalize(raw: string): string {
  return raw
    .normalize("NFC")
    .toLowerCase()
    .replace(/[，、]/g, ",")
    .replace(/\s+/g, " ")
    .replace(/받은\s?질문/g, "받은질문")
    .replace(/보낸\s?질문/g, "보낸질문")
    .replace(/내\s?질문/g, "보낸질문")
    .replace(/주말\s?(포함|도|에도)/g, "주말포함")
    .replace(/매\s?시간/g, "매시간")
    .replace(/한\s?시간/g, "1시간")
    .replace(/두\s?시간/g, "2시간")
    .replace(/세\s?시간/g, "3시간")
    .replace(/네\s?시간/g, "4시간")
    .replace(/시간\s?(마다|간격|씩)/g, "시간$1")
    .replace(/하루\s?(에\s?)?(한\s?번|1\s?회|1\s?번)|1일\s?1회|once a day/g, "하루1회")
    .trim();
}

export function parseCommand(raw: string): Command {
  const text = normalize(raw);

  if (is(text, ["", "status", "settings", "setting", "설정", "상태", "내설정", "내 설정"])) return { type: "status" };
  if (is(text, ["help", "h", "?", "도움말", "도움", "사용법", "명령어", "헬프", "가이드"])) return { type: "help" };
  if (is(text, ["list", "ls", "all", "show", "목록", "리스트", "보기", "전체"])) return { type: "list" };
  if (is(text, ["refresh", "now", "check", "sync", "지금", "새로고침", "확인", "지금 확인", "갱신"])) return { type: "refresh" };
  if (is(text, ["off", "stop", "disable", "pause", "끄기", "꺼", "꺼줘", "중지", "중단", "그만", "알림끄기", "알림 끄기"]))
    return { type: "pause" };
  if (is(text, ["on", "start", "enable", "resume", "켜기", "켜", "켜줘", "재개", "다시", "알림켜기", "알림 켜기"]))
    return { type: "resume" };

  // Tracking toggles: "받은질문 끄기", "incoming off", "보낸질문 on"
  const track = text.match(/^(?:track\s+)?(받은질문|받은|incoming|received|보낸질문|보낸|outgoing|sent)\s*(켜기|켜|on|끄기|꺼|off)$/);
  if (track) {
    const value = ["켜기", "켜", "on"].includes(track[2]);
    const isIncoming = ["받은질문", "받은", "incoming", "received"].includes(track[1]);
    return isIncoming ? { type: "track", incoming: value } : { type: "track", outgoing: value };
  }

  const tz = text.match(/^(?:tz|timezone|time zone|시간대|타임존)\s+(.+)$/);
  if (tz) {
    // Lowercased is fine: normalizeTimezone canonicalizes case through Intl
    const arg = tz[1].trim();
    if (["auto", "자동", "slack", "슬랙"].includes(arg)) return { type: "timezone", tz: "auto" };
    const iana = normalizeTimezone(arg);
    if (!iana) return { type: "error", message: `알 수 없는 시간대예요: \`${arg}\`. 예: \`/nudge tz Asia/Seoul\`, \`/nudge tz auto\`` };
    return { type: "timezone", tz: iana };
  }

  return parseSchedule(text);
}

function to24h(hour: number, meridiem: "am" | "pm" | null): number | null {
  if (meridiem === "am") return hour === 12 ? 0 : hour <= 12 ? hour : null;
  if (meridiem === "pm") return hour === 12 ? 12 : hour < 12 ? hour + 12 : hour <= 23 ? hour : null;
  if (hour > 23) return null;
  // Work-hours guess when 오전/오후 is omitted: "5시" → 17시, "9시" → 9시
  if (hour >= 1 && hour <= 6) return hour + 12;
  return hour;
}

function meridiemOf(token: string | undefined): "am" | "pm" | null {
  if (!token) return null;
  if (/^(오전|am|a\.m\.|아침|새벽)$/.test(token)) return "am";
  if (/^(오후|pm|p\.m\.|저녁|밤)$/.test(token)) return "pm";
  return null;
}

// "밤 12시" / "저녁 12시" mean midnight, unlike "오후 12시" (noon); "밤 1시"~"밤 4시" are after midnight
function clockHour(hour: number, prefix: string | undefined, suffix: string | undefined, hasMinutes: boolean): number | null {
  if (hour === 12 && prefix && /^(밤|저녁)$/.test(prefix)) return 0;
  if (prefix === "밤" && hour >= 1 && hour <= 4) return hour;
  const meridiem = meridiemOf(prefix) ?? meridiemOf(suffix);
  if (meridiem) return to24h(hour, meridiem);
  // "17:00" / "0시" / "13" are 24h; "5시"/"5" without 오전·오후 gets the work-hours guess
  if (hasMinutes || hour === 0 || hour >= 13) return hour <= 23 ? hour : null;
  return to24h(hour, null);
}

// Window ends follow the same 오전/오후 rules as single times, as long as start < end holds:
// "9-6" → 9~18, "1-5" → 13~17, "오후 1시-5시" → 13~17, "1-5pm" → 13~17, "10-19" and "6-9" stay.
function parseWindow(
  startRaw: number,
  startMer: "am" | "pm" | null,
  endRaw: number,
  endMer: "am" | "pm" | null
): { start: number; end: number } | null {
  const valid = (s: number | null, e: number | null) => s !== null && e !== null && s < e;
  const startMerEff = startMer ?? endMer;
  const endMerEff = endMer ?? startMer;

  let start = startMer ? to24h(startRaw, startMer) : startRaw <= 23 ? startRaw : null;
  let end = endMer ? to24h(endRaw, endMer) : endRaw <= 23 ? endRaw : null;

  // Only one side said 오전/오후: let the bare side borrow it when that keeps the order
  if (!startMer && startMerEff) {
    const borrowed = to24h(startRaw, startMerEff);
    if (valid(borrowed, end)) start = borrowed;
  }
  if (!endMer && endMerEff) {
    const borrowed = to24h(endRaw, endMerEff);
    if (valid(start, borrowed)) end = borrowed;
  }
  if (start !== null && end !== null) {
    if (!startMer && !endMer && start >= 1 && end <= 6 && start < end) {
      // "1-5" → afternoon
      start += 12;
      end += 12;
    } else if (!endMer && end <= start && start <= 12 && endRaw <= 12 && endRaw + 12 > start) {
      // "9-6", "오전 9시~6시" → 9시~18시
      end = endRaw + 12;
    }
  }
  return valid(start, end) ? { start: start!, end: end! } : null;
}

function parseSchedule(input: string): Command {
  let text = ` ${input} `;
  const update: ScheduleUpdate = {};
  let recognized = false;

  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    text = text.replace(re, (...args) => {
      fn(args as unknown as RegExpMatchArray);
      recognized = true;
      return " ";
    });
  };

  // Day filters
  take(/(평일만?|weekdays?|주중|월\s?~\s?금)/g, () => (update.weekdaysOnly = true));
  take(/(주말포함|weekends?|주7일|all ?week|7 ?days)/g, () => (update.weekdaysOnly = false));

  // Window: "9-18", "9시~18시", "9시부터 18시까지", "9am-6pm", "오전 9시~오후 6시", "9-6"
  let badWindow: string | null = null;
  take(
    /(오전|오후|am|pm)?\s*(\d{1,2})\s*(시|am|pm)?\s*(?:부터|[-~])\s*(오전|오후|am|pm)?\s*(\d{1,2})\s*(시|am|pm)?\s*(?:까지)?/g,
    (m) => {
      const window = parseWindow(
        parseInt(m[2]),
        meridiemOf(m[1]) ?? meridiemOf(m[3]),
        parseInt(m[5]),
        meridiemOf(m[4]) ?? meridiemOf(m[6])
      );
      if (window) update.window = window;
      else badWindow = m[0].trim();
    }
  );

  // Intervals ("1시간마다" is covered by the numeric pattern below)
  take(/(매시간|hourly|every ?hour|매 ?시(?!\d))/g, () => (update.every = 1));
  take(/(?:every\s*|매\s*)?(\d{1,2})\s*(?:h|hr|hrs|hours?|시간)(?:마다|간격|씩)?(?![a-z])/g, (m) => {
    update.every = parseInt(m[1]);
  });

  // "매일"/"daily" = all seven days, frequency unchanged (an explicit 평일, parsed above, still wins);
  // "하루 한 번" = once a day without touching the day filter
  take(/(매일|daily|every ?day|everyday)/g, () => (update.weekdaysOnly ??= false));
  take(/하루1회/g, () => (update.daily = true));

  // Named times
  take(/(정오|noon)/g, () => (update.hours = [...(update.hours || []), 12]));
  take(/(자정|midnight)/g, () => (update.hours = [...(update.hours || []), 0]));

  // Clock times: "9am", "오후 5시", "17:00", "9시 반", bare "9"
  let badTime: string | null = null;
  take(
    /(오전|오후|아침|저녁|새벽|밤|am|pm|a\.m\.|p\.m\.)?\s*(\d{1,2})(?::(\d{2}))?\s*(시|am|pm|a\.m\.|p\.m\.)?\s*(반|정각)?(?=[\s,]|에|만|마다|로|으로|$)/g,
    (m) => {
      const h24 = clockHour(parseInt(m[2]), m[1], m[4], m[3] !== undefined);
      if (h24 === null) badTime = m[0].trim();
      else update.hours = [...(update.hours || []), h24];
    }
  );

  // Filler words that carry no meaning on their own
  const leftover = text
    .replace(/(에만|에|마다|으로|로|설정|알림|받기|받을래|보내줘|해줘|씩|한번|한 번|쯤|그리고|and|at|,|\/|만)/g, " ")
    .trim();

  if (badTime) return { type: "error", message: `시간을 이해하지 못했어요: \`${badTime}\`` };
  if (badWindow) return { type: "error", message: `시간 범위를 이해하지 못했어요: \`${badWindow}\`` };
  if (!recognized || leftover) {
    return {
      type: "error",
      // "부분" only when something else in the message was understood
      message: recognized
        ? `\`${leftover}\` 부분은 이해하지 못했어요.`
        : `이해하지 못한 명령이에요: \`${input.trim()}\``,
    };
  }

  if (update.hours && update.every) {
    return { type: "error", message: "시각 지정과 간격 지정은 함께 쓸 수 없어요. 예: `/nudge 매시간 9-18` 또는 `/nudge 9시 18시`" };
  }
  if (update.hours && update.window) {
    return { type: "error", message: "시간 범위(9-18)는 `매시간`/`2시간마다`와 함께 써 주세요. 예: `/nudge 매시간 9-18`" };
  }
  if (update.every !== undefined && (update.every < 1 || update.every > 12)) {
    return { type: "error", message: "간격은 1~12시간 사이로 정해 주세요. 예: `/nudge 2시간마다`" };
  }
  if (update.window) {
    const { start, end } = update.window;
    if (start > 23 || end > 23 || start >= end) {
      return { type: "error", message: "시간 범위는 0~23시 사이, 시작이 끝보다 앞서야 해요. 예: `/nudge 매시간 9-18`" };
    }
  }
  if (update.hours) {
    update.hours = uniqueSorted(update.hours);
    if (update.hours.length > MAX_TIMES) {
      return { type: "error", message: `알림 시각은 최대 ${MAX_TIMES}개까지 정할 수 있어요.` };
    }
  }

  return { type: "schedule", update };
}

// Merge a parsed update into the user's current schedule.
export function applyScheduleUpdate(current: Schedule, update: ScheduleUpdate): Schedule {
  const weekdaysOnly = update.weekdaysOnly ?? current.weekdaysOnly;

  if (update.hours) return { kind: "times", hours: update.hours, weekdaysOnly };

  if (update.every !== undefined || update.window) {
    const window =
      update.window ??
      (current.kind === "interval" ? { start: current.start, end: current.end } : DEFAULT_WINDOW);
    const every = update.every ?? (current.kind === "interval" ? current.every : 1);
    return { kind: "interval", every, start: window.start, end: window.end, weekdaysOnly };
  }

  if (update.daily) {
    const hours = current.kind === "times" && current.hours.length === 1 ? current.hours : [DEFAULT_DAILY_HOUR];
    return { kind: "times", hours: hours.slice(), weekdaysOnly };
  }

  // Only a day filter changed
  return { ...current, weekdaysOnly };
}
