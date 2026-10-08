import type { WebClient } from "@slack/web-api";
import { createBoundedClient, getConversationLabel, getUserName, isDMOrMPIM, slackErrorCode } from "@/lib/slack";
import {
  acquireLock,
  addFollowUp,
  getSeen,
  getUserFollowUps,
  itemId,
  markSeen,
  releaseLock,
  removeFollowUp,
  updateFollowUp,
  type ConvType,
  type FollowUp,
  type FollowUpKind,
} from "@/lib/redis";
import { AiUnavailableError, aiAvailable, classifyResponse, classifyUserMessage, summarizeQuestion } from "@/lib/ai";
import { updateUser, type NudgeUser } from "@/lib/db";
import {
  isAckReaction,
  isCcMention,
  isLikelyQuestion,
  looksLikeDeferral,
  mentionsUser,
  needsAnswerCheck,
  otherMentions,
} from "@/lib/question";
import { localParts, resolveTimezone } from "@/lib/schedule";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LOOKBACK_DAYS = 7;              // how far back new questions are discovered
const HISTORY_PAGES = 3;              // x100 messages of flat history per conversation
const REPLY_PAGES = 5;                // x200 replies per thread
const CHANNEL_FLAT_WINDOW_MS = 6 * HOUR_MS; // in channels, only nearby non-thread messages can be the answer
const MAX_NEW_PER_KIND = 60;          // new candidates examined per poll (rest continue next poll)
const MAX_AI_CALLS_PER_STREAM = 6;    // per item, separately for thread replies and flat history
const INCOMING_EXPIRE_MS = 14 * DAY_MS;
const CONCURRENCY = 4;
export const SUMMARY_VERSION = 5; // 5: topics always in Korean
// Bump when the answer rules change: tracked items judged under older rules are read again
// from the question once, so a reply misjudged back then gets another look
export const JUDGE_VERSION = 2; // 1: a direct reply answers unless it only puts it off; 2: remember promises

// Search queries and how many 100-result pages each may read per poll
type QueryKey = "outgoing" | "mentions" | "with";
const SEARCH_PAGES: Record<QueryKey, number> = { outgoing: 3, mentions: 2, with: 4 };

// Errors that mean the tracked message is gone for good — drop it instead of retrying forever
const GONE_ERRORS = new Set([
  "thread_not_found",
  "message_not_found",
  "channel_not_found",
  "not_in_channel",
  "no_permission",
  "is_archived",
]);

interface SlackMessage {
  ts?: string;
  user?: string;
  text?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
  files?: { name?: string; title?: string }[];
  reactions?: { name?: string; users?: string[] }[];
}

interface SearchMatch {
  ts?: string;
  text?: string;
  user?: string;
  type?: string;
  permalink?: string;
  channel?: { id?: string; name?: string; is_mpim?: boolean; is_im?: boolean };
}

export interface PollStats {
  skipped?: string;
  outgoing: { searched: number; candidates: number; tracked: number; resolved: number; deferred: number };
  incoming: {
    searched: { mentions: number; with: number };
    candidates: number;
    tracked: number;
    resolved: number;
    expired: number;
    notDirected: number;
    deferred: number;
  };
  incomplete: string[]; // what continues on the next poll
  errors: string[];
  ms: number;
}

interface Ctx {
  user: NudgeUser;
  me: string;
  tz: string;
  slack: WebClient;
  seen: Set<string>;
  stats: PollStats;
  convTypes: Map<string, ConvType>;
  excluded: Set<string>; // channels never tracked (the Nudge DM itself)
  cursors: NonNullable<NudgeUser["searchCursors"]>;
  deadline: number; // stop starting new Slack/AI work after this (function time limit)
}

function emptyStats(): PollStats {
  return {
    outgoing: { searched: 0, candidates: 0, tracked: 0, resolved: 0, deferred: 0 },
    incoming: {
      searched: { mentions: 0, with: 0 },
      candidates: 0,
      tracked: 0,
      resolved: 0,
      expired: 0,
      notDirected: 0,
      deferred: 0,
    },
    incomplete: [],
    errors: [],
    ms: 0,
  };
}

const tsNum = (ts: string) => parseFloat(ts);
const byTs = (a: SlackMessage, b: SlackMessage) => tsNum(a.ts!) - tsNum(b.ts!);

// Real conversation messages (not joins, topic changes, ...), from people or bots
const MESSAGE_SUBTYPES = new Set([undefined, "thread_broadcast", "file_share", "bot_message", "me_message"]);

function isRealMessage(m: SlackMessage): boolean {
  return MESSAGE_SUBTYPES.has(m.subtype) && (!!m.user || !!m.bot_id) && m.user !== "USLACKBOT";
}

function isBot(m: SlackMessage): boolean {
  return !!m.bot_id || m.subtype === "bot_message";
}

function isHuman(m: SlackMessage): boolean {
  return isRealMessage(m) && !!m.user && !isBot(m);
}

const hasFiles = (m: SlackMessage) => (m.files?.length ?? 0) > 0;

// Text for classification; file-only messages become "[파일: name]"
function contentOf(m: SlackMessage): string {
  const files = (m.files ?? []).map((f) => f.title || f.name).filter(Boolean);
  return [m.text?.trim(), files.length > 0 ? `[파일: ${files.join(", ")}]` : ""].filter(Boolean).join(" ");
}

// Runs fn over items with bounded concurrency, in order; returns how many items were
// started (the rest were skipped because the deadline passed).
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  deadline = Infinity
): Promise<number> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && Date.now() < deadline) await fn(items[next++]);
  });
  await Promise.all(workers);
  return next;
}

function parentFromPermalink(permalink?: string): string | undefined {
  return permalink?.match(/thread_ts=([0-9.]+)/)?.[1];
}

function convTypeFromMatch(m: SearchMatch): ConvType | undefined {
  if (m.type === "im" || m.channel?.is_im || m.channel?.id?.startsWith("D")) return "im";
  if (m.channel?.is_mpim || m.channel?.name?.startsWith("mpdm-")) return "mpim";
  if (m.type === "message") return "channel";
  return undefined; // "group" can be a private channel or an old-style group DM
}

// For DMs, search puts the other person's user ID in channel.name. My self-DM (notes, drafts)
// and the Slackbot DM never hold real questions between people.
function isPrivateNoteDM(ctx: Ctx, m: SearchMatch): boolean {
  if (convTypeFromMatch(m) !== "im") return false;
  const partner = m.channel?.name;
  return partner === ctx.me || partner === "USLACKBOT";
}

async function resolveConvType(ctx: Ctx, channel: string, known?: ConvType): Promise<ConvType> {
  if (known) return known;
  const cached = ctx.convTypes.get(channel);
  if (cached) return cached;
  let type: ConvType = "channel";
  if (channel.startsWith("D")) type = "im";
  else if (await isDMOrMPIM(ctx.slack, channel)) type = "mpim";
  ctx.convTypes.set(channel, type);
  return type;
}

// ---------------------------------------------------------------------------
// Resumable search. Results are read oldest-first, so pages already read never shift
// (new messages only append at the end) and the next poll continues where this one
// stopped — nothing in the window is skipped, however busy the user is.

interface Fetched {
  match: SearchMatch;
  page: number;
}

interface SearchRun {
  key: QueryKey;
  after: string;
  items: Fetched[];
  nextPage: number;   // first page not read yet
  reachedEnd: boolean;
}

function dateDaysAgo(ctx: Ctx, days: number): string {
  return localParts(Date.now() - days * DAY_MS, ctx.tz).dateKey;
}

async function runSearch(ctx: Ctx, key: QueryKey, base: string): Promise<SearchRun> {
  // `after:` is exclusive and day-granular (and Slack may read it in another timezone),
  // so windows start a day early; seen/tracked filters absorb the overlap.
  const oldest = dateDaysAgo(ctx, LOOKBACK_DAYS + 1);
  let cursor = ctx.cursors[key];
  if (!cursor || cursor.after < oldest) cursor = { after: oldest, page: 1 };

  const items: Fetched[] = [];
  let page = cursor.page;
  let reachedEnd = false;
  for (let n = 0; n < SEARCH_PAGES[key] && Date.now() < ctx.deadline; n++) {
    const res = await ctx.slack.search.messages({
      query: `${base} after:${cursor.after}`,
      sort: "timestamp",
      sort_dir: "asc",
      count: 100,
      page,
    });
    const batch = (res.messages?.matches ?? []) as SearchMatch[];
    const totalPages = Math.max(1, res.messages?.paging?.pages ?? 1);
    items.push(...batch.map((match) => ({ match, page })));
    if (page >= totalPages || batch.length < 100) {
      // Stay on the last, partly filled page: new messages land there next
      page = Math.min(page, totalPages);
      reachedEnd = true;
      break;
    }
    page++;
  }
  return { key, after: cursor.after, items, nextPage: page, reachedEnd };
}

// Where the next poll should resume. `firstOpenPage` = earliest page holding a candidate
// that wasn't fully handled (deferred or failed).
function saveCursor(ctx: Ctx, run: SearchRun, firstOpenPage: number | undefined): void {
  if (firstOpenPage !== undefined) {
    ctx.cursors[run.key] = { after: run.after, page: firstOpenPage };
    ctx.stats.incomplete.push(`${run.key}: continues at page ${firstOpenPage}`);
  } else if (!run.reachedEnd) {
    ctx.cursors[run.key] = { after: run.after, page: run.nextPage };
    ctx.stats.incomplete.push(`${run.key}: continues at page ${run.nextPage}`);
  } else if (run.after < dateDaysAgo(ctx, 3)) {
    // Caught up: move the window forward so searches stay small
    ctx.cursors[run.key] = { after: dateDaysAgo(ctx, 2), page: 1 };
  } else {
    ctx.cursors[run.key] = { after: run.after, page: run.nextPage };
  }
}

// ---------------------------------------------------------------------------
// Conversation context around a message

interface Context {
  question?: SlackMessage;
  parent?: SlackMessage;  // thread root, when the question is itself a thread reply
  thread: SlackMessage[]; // thread replies after `since`, oldest first
  flat: SlackMessage[];   // channel/DM messages after `since`, oldest first
  partial: boolean;       // more messages exist than we fetched
  gone: boolean;          // the question was deleted
}

// All replies of a thread from `fromTs` on (following the cursor), so long threads are read in full
async function threadFrom(
  ctx: Ctx,
  channel: string,
  rootTs: string,
  fromTs: string
): Promise<{ messages: SlackMessage[]; complete: boolean }> {
  const byKey = new Map<string, SlackMessage>();
  let cursor: string | undefined;
  for (let page = 0; page < REPLY_PAGES; page++) {
    const res = await ctx.slack.conversations.replies({
      channel,
      ts: rootTs,
      oldest: fromTs,
      inclusive: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const m of (res.messages ?? []) as SlackMessage[]) if (m.ts) byKey.set(m.ts, m);
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!res.has_more || !cursor) return { messages: [...byKey.values()].sort(byTs), complete: true };
  }
  return { messages: [...byKey.values()].sort(byTs), complete: false };
}

// conversations.history returns the *newest* messages in (oldest, latest] first, so page
// backwards until we reach `oldest` — otherwise a busy conversation hides the replies
// that came right after the question.
async function historyBetween(
  ctx: Ctx,
  channel: string,
  oldest: string,
  latest?: string
): Promise<{ messages: SlackMessage[]; partial: boolean }> {
  const messages: SlackMessage[] = [];
  let cursor = latest;
  for (let page = 0; page < HISTORY_PAGES; page++) {
    const res = await ctx.slack.conversations.history({
      channel,
      oldest,
      ...(cursor ? { latest: cursor } : {}),
      limit: 100,
      inclusive: false,
    });
    const batch = (res.messages ?? []) as SlackMessage[];
    messages.push(...batch);
    if (!res.has_more || batch.length === 0) return { messages, partial: false };
    cursor = batch[batch.length - 1].ts;
  }
  return { messages, partial: true };
}

async function loadContext(
  ctx: Ctx,
  f: Pick<FollowUp, "channel" | "threadTs" | "parentThreadTs">,
  convType: ConvType,
  since: string,
  needParent = false
): Promise<Context> {
  const { channel, threadTs: ts, parentThreadTs } = f;
  const after = (m: SlackMessage) => !!m.ts && tsNum(m.ts) > tsNum(since);
  const isGone = (complete: boolean, q?: SlackMessage) => complete && (!q || q.subtype === "tombstone");

  if (parentThreadTs && parentThreadTs !== ts) {
    // Read from the question itself so its presence (or deletion) is certain
    const thread = await threadFrom(ctx, channel, parentThreadTs, ts);
    const question = thread.messages.find((m) => m.ts === ts);
    let parent = thread.messages.find((m) => m.ts === parentThreadTs);
    if (needParent && !parent) {
      const res = await ctx.slack.conversations.replies({ channel, ts: parentThreadTs, limit: 1 });
      parent = (res.messages as SlackMessage[] | undefined)?.[0];
    }
    return {
      question,
      parent,
      thread: thread.messages.filter((m) => m !== question && after(m)),
      flat: [],
      partial: !thread.complete,
      gone: isGone(thread.complete, question),
    };
  }

  const thread = await threadFrom(ctx, channel, ts, ts);
  const question = thread.messages.find((m) => m.ts === ts);

  // In channels the conversation moves on quickly; only messages close to the question count
  const latestMs = convType === "channel" ? tsNum(ts) * 1000 + CHANNEL_FLAT_WINDOW_MS : Infinity;
  let flat: SlackMessage[] = [];
  let flatPartial = false;
  if (tsNum(since) * 1000 < Math.min(latestMs, Date.now())) {
    const latest = Number.isFinite(latestMs) && latestMs < Date.now() ? (latestMs / 1000).toFixed(6) : undefined;
    const history = await historyBetween(ctx, channel, since, latest);
    // Thread replies only appear in history when broadcast; the thread call covers them
    flat = history.messages.filter((m) => !(m.thread_ts && m.thread_ts !== m.ts)).sort(byTs);
    flatPartial = history.partial;
  }

  return {
    question,
    thread: thread.messages.filter((m) => m.ts !== ts && after(m)),
    flat: flat.filter(after),
    partial: flatPartial || !thread.complete,
    gone: isGone(thread.complete, question),
  };
}

interface Verdict {
  answered: boolean;
  gone?: boolean;
  checkedTs?: string; // newest message judged "not an answer" — later polls start after it
  promised?: boolean; // whoever owes the answer put it off with a promise ("확인 후 회신드릴게요")
}

type Step = "answered" | "skipped" | "judged";

// Walks one stream in order with its own AI budget. `through` = ts up to which every message
// was judged (undefined: the budget ran out before the first one).
async function walk(
  msgs: SlackMessage[],
  step: (m: SlackMessage, rest: SlackMessage[]) => Promise<Step>,
  needsAi: (m: SlackMessage) => boolean
): Promise<{ answered: boolean; complete: boolean; through?: string }> {
  let aiCalls = 0;
  let through: string | undefined;
  for (const [i, m] of msgs.entries()) {
    if (needsAi(m) && aiCalls++ >= MAX_AI_CALLS_PER_STREAM) return { answered: false, complete: false, through };
    if ((await step(m, msgs.slice(i + 1))) === "answered") return { answered: true, complete: true };
    through = m.ts;
  }
  return { answered: false, complete: true, through };
}

// "넵" + "확인해볼게요" sent back to back are one reply: read someone's consecutive messages
// (each within 5 minutes of the last) together
const BURST_MS = 5 * 60_000;
function burstOf(m: SlackMessage, rest: SlackMessage[]): string {
  const parts = [contentOf(m)];
  let last = m;
  for (const x of rest) {
    if (x.user !== m.user || (tsNum(x.ts!) - tsNum(last.ts!)) * 1000 > BURST_MS) break;
    parts.push(contentOf(x));
    last = x;
  }
  return parts.filter(Boolean).join(" ");
}

// Messages up to `judgedThrough` were already judged under older rules (see JUDGE_VERSION):
// only the no-AI rules get another look at them, so a re-read costs no AI calls
const judgedBefore = (judgedThrough?: string) => (m: SlackMessage) =>
  !!judgedThrough && tsNum(m.ts!) <= tsNum(judgedThrough);

// Thread replies get their own budget so a busy channel can't starve them. The checkpoint
// only moves to where *both* streams were fully judged, and never on partial data.
async function judgeStreams(
  f: FollowUp,
  c: Context,
  step: (m: SlackMessage, inThread: boolean, rest: SlackMessage[]) => Promise<Step>,
  needsAi: (m: SlackMessage) => boolean
): Promise<Verdict> {
  if (c.gone) return { answered: false, gone: true };
  const thread = await walk(c.thread, (m, rest) => step(m, true, rest), needsAi);
  if (thread.answered) return { answered: true };
  const flat = await walk(c.flat, (m, rest) => step(m, false, rest), needsAi);
  if (flat.answered) return { answered: true };
  if (c.partial) return { answered: false, checkedTs: f.checkedTs };

  const limits = [thread, flat].filter((s) => !s.complete).map((s) => s.through ?? f.checkedTs ?? f.threadTs);
  const checkpoint =
    limits.length > 0
      ? limits.reduce((a, b) => (tsNum(a) < tsNum(b) ? a : b))
      : [thread.through, flat.through, f.checkedTs].filter(Boolean).reduce<string | undefined>(
          (a, b) => (!a || tsNum(b!) > tsNum(a) ? b : a),
          undefined
        );
  return { answered: false, checkedTs: checkpoint };
}

// My question: answered when someone else replies substantively ("알아볼게요" doesn't count),
// a bot replies in the thread/DM, a file is shared back, or I say I sorted it out.
async function checkOutgoing(
  ctx: Ctx,
  f: FollowUp,
  convType: ConvType,
  c?: Context,
  judgedThrough?: string
): Promise<Verdict> {
  c ??= await loadContext(ctx, f, convType, f.checkedTs ?? f.threadTs);
  if (c.gone) return { answered: false, gone: true };

  // 👍/✅/"넵" from the other side on my message is their answer (👀 "보는 중" isn't)
  const acknowledged = c.question?.reactions?.some(
    (r) => r.name && isAckReaction(r.name) && r.users?.some((u) => u !== ctx.me)
  );
  if (acknowledged) return { answered: true };

  const relevant = (m: SlackMessage) => isRealMessage(m) && !isBot(m) && !!contentOf(m);
  const old = judgedBefore(judgedThrough);
  // Whoever I @mentioned owes the answer; a third party's "저도 궁금해요" isn't it
  const addressed = otherMentions(f.originalMessage, ctx.me);
  const owesAnswer = (m: SlackMessage) => convType === "im" || addressed.length === 0 || addressed.includes(m.user!);
  let promised = false;

  const verdict = await judgeStreams(
    f,
    c,
    async (msg, inThread, rest) => {
      if (!isRealMessage(msg)) return "skipped";
      const fromMe = msg.user === ctx.me;
      // A direct reply (thread or 1:1 DM) from a bot or with a file is the answer; in a busy
      // channel's flat history it's just noise
      const direct = inThread || convType === "im";
      if (!fromMe && direct && (isBot(msg) || hasFiles(msg))) return "answered";
      if (!relevant(msg)) return "skipped";
      const text = !fromMe && direct ? burstOf(msg, rest) : contentOf(msg);
      // Their direct reply is the answer unless it only puts it off ("알아볼게요") or is just "ㅋㅋ"
      if (!fromMe && direct && owesAnswer(msg) && !needsAnswerCheck(text)) return "answered";
      // "알아볼게요" from them: not the answer yet, but shown as "상대가 확인 중" in the list
      const promise = !fromMe && owesAnswer(msg) && looksLikeDeferral(text);
      if (old(msg)) {
        promised ||= promise;
        return "skipped";
      }
      if (!fromMe) {
        if ((await classifyResponse(f.originalMessage, text)) === "answer") return "answered";
        promised ||= promise;
        return "judged";
      }
      return (await classifyUserMessage(f.originalMessage, text)) === "self-resolved" ? "answered" : "judged";
    },
    (m) => !old(m) && relevant(m) && !(m.user !== ctx.me && hasFiles(m))
  );
  return promised ? { ...verdict, promised } : verdict;
}

// Someone's question to me: answered when I reply substantively (not "확인해볼게요"), send a
// file, react with ✅/👍, someone else answers a question I was only cc'd on, or the asker says
// it's sorted.
async function checkIncoming(
  ctx: Ctx,
  f: FollowUp,
  convType: ConvType,
  c?: Context,
  judgedThrough?: string
): Promise<Verdict> {
  c ??= await loadContext(ctx, f, convType, f.checkedTs ?? f.threadTs);
  if (c.gone) return { answered: false, gone: true };

  // My 👍/✅/"넵" on the question means handled (👀 "보는 중" doesn't)
  const reacted = c.question?.reactions?.some((r) => r.name && isAckReaction(r.name) && r.users?.includes(ctx.me));
  if (reacted) return { answered: true };

  const responders = new Set([ctx.me]);
  if (isCcMention(f.originalMessage, ctx.me)) otherMentions(f.originalMessage, ctx.me).forEach((u) => responders.add(u));
  const relevant = (m: SlackMessage) =>
    isHuman(m) && !!m.user && (responders.has(m.user) || m.user === f.askerId) && (!!contentOf(m) || hasFiles(m));
  const old = judgedBefore(judgedThrough);
  let promised = false;

  const verdict = await judgeStreams(
    f,
    c,
    async (msg, inThread, rest) => {
      if (!relevant(msg)) return "skipped";
      if (msg.user === ctx.me && hasFiles(msg)) return "answered";
      const mine = msg.user === ctx.me && (inThread || convType === "im");
      const content = mine ? burstOf(msg, rest) : contentOf(msg);
      // My reply in its thread or our 1:1 DM is the answer unless it only puts it off
      // ("확인해볼게요") or is just "ㅋㅋ" — casual answers like "그냥요.." need no AI
      if (mine && !needsAnswerCheck(content)) return "answered";
      // My "확인 후 회신드릴게요": not the answer yet, but shown as "회신 약속함" in the list
      const promise = msg.user === ctx.me && looksLikeDeferral(content);
      if (old(msg)) {
        promised ||= promise;
        return "skipped";
      }
      if (msg.user !== f.askerId) {
        if ((await classifyResponse(f.originalMessage, content)) === "answer") return "answered";
        promised ||= promise;
        return "judged";
      }
      return (await classifyUserMessage(f.originalMessage, content)) === "self-resolved" ? "answered" : "judged";
    },
    (m) => !old(m) && relevant(m) && !(m.user === ctx.me && hasFiles(m))
  );
  return promised ? { ...verdict, promised } : verdict;
}

// Is this message actually asking *me*?
function directedAtMe(ctx: Ctx, text: string, convType: ConvType, inThread: boolean, c: Context): boolean {
  if (convType === "im") return true;
  if (mentionsUser(text, ctx.me)) return true;
  // A reply in a thread I started that doesn't @ anyone else
  return inThread && c.parent?.user === ctx.me && otherMentions(text, ctx.me).length === 0;
}

// ---------------------------------------------------------------------------

async function recheckTracked(ctx: Ctx, kind: FollowUpKind): Promise<Set<string>> {
  const tracked = await getUserFollowUps(ctx.me, kind);
  const st = ctx.stats[kind];

  const drop = async (f: FollowUp) => {
    await removeFollowUp(kind, ctx.me, f.channel, f.threadTs);
    await markSeen(ctx.me, itemId(kind, f.channel, f.threadTs), f.createdAt);
  };

  // Least recently checked first, so a deadline cut-off rotates fairly between polls
  tracked.sort((a, b) => (a.lastActivityAt ?? 0) - (b.lastActivityAt ?? 0));
  let postponed = 0;
  const started = await mapLimit(
    tracked,
    CONCURRENCY,
    async (f) => {
      const id = itemId(kind, f.channel, f.threadTs);
      if (!aiAvailable()) {
        postponed++; // AI is rate-limited: leave it as is, re-check next poll
        return;
      }
      try {
        if (ctx.excluded.has(f.channel)) {
          await drop(f);
          return;
        }
        if (kind === "incoming" && Date.now() - f.createdAt > INCOMING_EXPIRE_MS) {
          await drop(f);
          ctx.stats.incoming.expired++;
          return;
        }
        const convType = await resolveConvType(ctx, f.channel, f.convType);
        // Judged under older rules: read again from the question (the new no-AI rules may settle
        // it), without spending AI again on what was judged back then
        const migrating = f.judgeVersion !== JUDGE_VERSION;
        const g = migrating ? { ...f, checkedTs: undefined } : f;
        const judgedThrough = migrating ? f.checkedTs : undefined;
        const verdict =
          kind === "incoming"
            ? await checkIncoming(ctx, g, convType, undefined, judgedThrough)
            : await checkOutgoing(ctx, g, convType, undefined, judgedThrough);
        if (verdict.answered || verdict.gone) {
          await drop(f);
          st.resolved++;
        } else {
          await updateFollowUp(kind, ctx.me, f.channel, f.threadTs, {
            // A partial re-read returns no checkpoint: keep the one we had
            checkedTs: verdict.checkedTs ?? f.checkedTs,
            judgeVersion: JUDGE_VERSION,
            ...(verdict.promised ? { promised: true } : {}),
            convType,
            lastActivityAt: Date.now(),
          });
        }
      } catch (err) {
        const code = slackErrorCode(err);
        if (code && GONE_ERRORS.has(code)) {
          // Deleted message, left channel, ... — nothing to remind about anymore
          await drop(f).catch(() => {});
          st.resolved++;
        } else if (err instanceof AiUnavailableError) {
          postponed++;
        } else {
          ctx.stats.errors.push(`recheck ${id}: ${err}`);
        }
      }
    },
    ctx.deadline
  );
  const left = tracked.length - started + postponed;
  if (left > 0) ctx.stats.incomplete.push(`${kind} recheck: ${left} left`);

  return new Set(tracked.map((f) => itemId(kind, f.channel, f.threadTs)));
}

interface Candidate {
  match: SearchMatch;
  pages: Partial<Record<QueryKey, number>>; // page per query it came from
}

// Merge runs into unique candidates, oldest first
function collect(runs: SearchRun[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const run of runs) {
    for (const { match, page } of run.items) {
      if (!match.ts || !match.channel?.id) continue;
      const key = `${match.channel.id}:${match.ts}`;
      const c = byId.get(key) ?? { match, pages: {} };
      c.pages[run.key] ??= page;
      byId.set(key, c);
    }
  }
  return [...byId.values()].sort((a, b) => tsNum(a.match.ts!) - tsNum(b.match.ts!));
}

// Process candidates (oldest first, bounded), then save each search's resume point at the
// earliest page that still holds an unprocessed or failed candidate.
async function processCandidates(
  ctx: Ctx,
  runs: SearchRun[],
  candidates: Candidate[],
  handle: (c: Candidate) => Promise<void>
): Promise<number> {
  const batch = candidates.slice(0, MAX_NEW_PER_KIND);
  const failed = new Set<Candidate>(); // retried next poll (the search cursor stays at their page)
  let postponed = 0;
  const started = await mapLimit(
    batch,
    CONCURRENCY,
    async (c) => {
      if (!aiAvailable()) {
        failed.add(c);
        postponed++;
        return;
      }
      try {
        await handle(c);
      } catch (err) {
        const code = slackErrorCode(err);
        if (err instanceof AiUnavailableError) {
          failed.add(c);
          postponed++;
          return;
        }
        if (code && GONE_ERRORS.has(code)) {
          // Deleted message / left channel: nothing to track, and don't hold the cursor back
          const kind = runs.some((r) => r.key === "outgoing") ? "outgoing" : "incoming";
          await markSeen(ctx.me, itemId(kind, c.match.channel!.id!, c.match.ts!), tsNum(c.match.ts!) * 1000).catch(() => {});
          return;
        }
        failed.add(c);
        ctx.stats.errors.push(`${c.match.channel?.id}:${c.match.ts}: ${err}`);
      }
    },
    ctx.deadline
  );
  const open = [...candidates.slice(started), ...failed];
  for (const run of runs) {
    const pages = open.map((c) => c.pages[run.key]).filter((p): p is number => p !== undefined);
    saveCursor(ctx, run, pages.length > 0 ? Math.min(...pages) : undefined);
  }
  if (postponed > 0) ctx.stats.incomplete.push(`AI rate limit: ${postponed} postponed`);
  return candidates.length - started + postponed;
}

async function pollOutgoing(ctx: Ctx): Promise<void> {
  const st = ctx.stats.outgoing;
  const trackedIds = await recheckTracked(ctx, "outgoing");
  if (Date.now() > ctx.deadline) {
    ctx.stats.incomplete.push("outgoing search: out of time");
    return;
  }

  const run = await runSearch(ctx, "outgoing", `from:<@${ctx.me}>`);
  st.searched = run.items.length;

  const candidates = collect([run]).filter(({ match: m }) => {
    const id = itemId("outgoing", m.channel!.id!, m.ts!);
    return (
      (!m.user || m.user === ctx.me) &&
      !ctx.excluded.has(m.channel!.id!) &&
      !isPrivateNoteDM(ctx, m) &&
      !trackedIds.has(id) &&
      !ctx.seen.has(id) &&
      isLikelyQuestion(m.text || "")
    );
  });
  st.candidates = candidates.length;

  st.deferred = await processCandidates(ctx, [run], candidates, async ({ match: m }) => {
    const channel = m.channel!.id!;
    const ts = m.ts!;
    const convType = await resolveConvType(ctx, channel, convTypeFromMatch(m));
    const f: FollowUp = {
      kind: "outgoing",
      userId: ctx.me,
      channel,
      threadTs: ts,
      parentThreadTs: parentFromPermalink(m.permalink),
      originalMessage: m.text || "",
      convType,
      createdAt: tsNum(ts) * 1000,
      lastRemindedAt: null,
      lastActivityAt: Date.now(),
    };
    const verdict = await checkOutgoing(ctx, f, convType);
    if (verdict.answered || verdict.gone) {
      await markSeen(ctx.me, itemId("outgoing", channel, ts), f.createdAt);
    } else {
      await addFollowUp({ ...f, checkedTs: verdict.checkedTs, judgeVersion: JUDGE_VERSION, promised: verdict.promised });
      st.tracked++;
    }
  });
}

async function pollIncoming(ctx: Ctx): Promise<void> {
  const st = ctx.stats.incoming;
  const trackedIds = await recheckTracked(ctx, "incoming");
  if (Date.now() > ctx.deadline) {
    ctx.stats.incomplete.push("incoming search: out of time");
    return;
  }

  // Mentions catch channels / group DMs / threads; `with:` catches 1:1 DMs and threads I'm in.
  const runs = [
    await runSearch(ctx, "mentions", `<@${ctx.me}>`),
    await runSearch(ctx, "with", `with:<@${ctx.me}>`),
  ];
  st.searched = { mentions: runs[0].items.length, with: runs[1].items.length };

  const candidates = collect(runs).filter(({ match: m }) => {
    const id = itemId("incoming", m.channel!.id!, m.ts!);
    if (
      !m.user ||
      m.user === ctx.me ||
      m.user === "USLACKBOT" ||
      ctx.excluded.has(m.channel!.id!) ||
      isPrivateNoteDM(ctx, m) ||
      trackedIds.has(id) ||
      ctx.seen.has(id) ||
      !isLikelyQuestion(m.text || "")
    ) {
      return false;
    }
    // Cheap pre-filter; thread-root ownership is checked once the thread is loaded
    const parent = parentFromPermalink(m.permalink);
    const plausible =
      convTypeFromMatch(m) === "im" || mentionsUser(m.text || "", ctx.me) || (!!parent && parent !== m.ts);
    if (!plausible) st.notDirected++;
    return plausible;
  });
  st.candidates = candidates.length;

  st.deferred = await processCandidates(ctx, runs, candidates, async ({ match: m }) => {
    const channel = m.channel!.id!;
    const ts = m.ts!;
    const id = itemId("incoming", channel, ts);
    const convType = await resolveConvType(ctx, channel, convTypeFromMatch(m));
    const parentThreadTs = parentFromPermalink(m.permalink);
    const inThread = !!parentThreadTs && parentThreadTs !== ts;
    const text = m.text || "";
    const f: FollowUp = {
      kind: "incoming",
      userId: ctx.me,
      channel,
      threadTs: ts,
      parentThreadTs,
      originalMessage: text,
      convType,
      askerId: m.user,
      createdAt: tsNum(ts) * 1000,
      lastRemindedAt: null,
      lastActivityAt: Date.now(),
    };
    const needParent = inThread && convType !== "im" && !mentionsUser(text, ctx.me);
    const c = await loadContext(ctx, f, convType, ts, needParent);

    // Deleted, posted by a bot/app (standups, Jira, ...), or aimed at someone else
    if (c.gone || !c.question || !isHuman(c.question) || !directedAtMe(ctx, text, convType, inThread, c)) {
      if (!c.gone && c.question && !c.partial) st.notDirected++;
      // A missing question on a partial read may just be on a page we didn't reach
      if (c.gone || c.question) await markSeen(ctx.me, id, f.createdAt);
      return;
    }

    const verdict = await checkIncoming(ctx, f, convType, c);
    if (verdict.answered || verdict.gone) {
      await markSeen(ctx.me, id, f.createdAt);
    } else {
      await addFollowUp({ ...f, checkedTs: verdict.checkedTs, judgeVersion: JUDGE_VERSION, promised: verdict.promised });
      st.tracked++;
    }
  });
}

// "#channel - topic" / "name - topic" / "asker (#channel) - topic"
async function fillSummaries(ctx: Ctx): Promise<void> {
  const all = [
    ...(await getUserFollowUps(ctx.me, "outgoing")),
    ...(await getUserFollowUps(ctx.me, "incoming")),
  ].filter((f) => !f.summary || f.summaryVersion !== SUMMARY_VERSION);

  const names = new Map<string, Promise<string>>();
  const nameOf = (id: string) => {
    if (!names.has(id)) names.set(id, getUserName(ctx.slack, id));
    return names.get(id)!;
  };

  // Message preview with mentions shown as names — used until the AI topic is available
  const preview = async (text: string) => {
    let out = text;
    const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))];
    for (const id of ids) {
      const name = (await nameOf(id)) || "사용자";
      out = out.replace(new RegExp(`<@${id}(\\|[^>]*)?>`, "g"), `@${name}`);
    }
    out = out
      .replace(/<#[A-Z0-9]+(?:\|([^>]+))?>/g, (_, n) => (n ? `#${n}` : "#채널"))
      .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
      .replace(/<([^>]+)>/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    return out.length > 50 ? `${out.slice(0, 50)}…` : out;
  };

  await mapLimit(
    all,
    CONCURRENCY,
    async (f) => {
      try {
        const label = await getConversationLabel(ctx.slack, f.channel);
        let prefix = label;
        if (f.kind === "incoming" && f.askerId && f.convType !== "im") {
          const asker = (await nameOf(f.askerId)).split(" ")[0];
          if (asker) prefix = `${asker} (${label})`;
        }
        let topic: string | null = null;
        if (aiAvailable()) topic = await summarizeQuestion(f.originalMessage).catch(() => null);
        await updateFollowUp(f.kind!, f.userId, f.channel, f.threadTs, topic
          ? { summary: `${prefix} - ${topic}`, summaryVersion: SUMMARY_VERSION }
          // version 0 → the AI topic is retried on a later poll
          : { summary: `${prefix} - ${await preview(f.originalMessage)}`, summaryVersion: 0 });
      } catch {
        // Non-critical, will retry next poll
      }
    },
    ctx.deadline
  );
}

// `deadline` (epoch ms) bounds the work so callers stay inside the function time limit;
// anything skipped is picked up by the next poll.
export async function pollUser(user: NudgeUser, deadline = Date.now() + 200_000): Promise<PollStats> {
  const started = Date.now();
  const stats = emptyStats();
  const lockKey = `nudge:lock:poll:${user.slackUserId}`;
  if (!(await acquireLock(lockKey, 300))) {
    stats.skipped = "poll already running";
    return stats;
  }

  try {
    const ctx: Ctx = {
      user,
      me: user.slackUserId,
      tz: resolveTimezone(user),
      slack: createBoundedClient(user.userToken),
      seen: await getSeen(user.slackUserId),
      stats,
      convTypes: new Map(),
      excluded: new Set(user.botDmChannel ? [user.botDmChannel] : []),
      cursors: { ...(user.searchCursors ?? {}) },
      deadline,
    };

    // Save search progress after each part, so a run cut short still moves forward.
    // Questions to me come first: they're the ones that need my action.
    const saveProgress = () => updateUser(user.slackUserId, { searchCursors: ctx.cursors });
    if (user.trackIncoming !== false) {
      try {
        await pollIncoming(ctx);
        await saveProgress();
      } catch (err) {
        stats.errors.push(`incoming: ${err}`);
      }
    }
    if (user.trackOutgoing !== false) {
      try {
        await pollOutgoing(ctx);
        await saveProgress();
      } catch (err) {
        stats.errors.push(`outgoing: ${err}`);
      }
    }
    await fillSummaries(ctx);
    // The first scan after installing is done once a poll read everything it found
    const caughtUp =
      stats.incomplete.length === 0 && stats.incoming.deferred === 0 && stats.outgoing.deferred === 0;
    await updateUser(user.slackUserId, {
      lastPolledAt: started,
      searchCursors: ctx.cursors,
      ...(user.firstScanPending && caughtUp ? { firstScanPending: false } : {}),
    });
  } finally {
    await releaseLock(lockKey);
    stats.ms = Date.now() - started;
    // Counts only (no message text) — e.g. searched.with shows whether DM discovery works
    console.log(
      "poll",
      user.slackUserId,
      JSON.stringify({ ...stats, errors: stats.errors.length, firstError: stats.errors[0]?.slice(0, 200) })
    );
  }
  return stats;
}
