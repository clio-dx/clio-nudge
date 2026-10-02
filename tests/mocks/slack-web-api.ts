// A tiny fake Slack workspace behind the subset of WebClient the app uses.
// Mirrors the real API's shapes closely enough for poll/digest flows:
// search matches with permalinks, newest-first history with has_more, threads via replies.

export interface FakeMessage {
  channel: string;
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  thread_ts?: string;
  files?: { name: string }[];
  reactions?: { name: string; users: string[] }[];
}

export interface FakeChannel {
  id: string;
  type: "im" | "mpim" | "channel";
  name?: string;
  members: string[];
}

export const workspace = {
  channels: new Map<string, FakeChannel>(),
  users: new Map<string, { name: string; tz?: string }>(),
  messages: [] as FakeMessage[],
  ghosts: [] as FakeMessage[], // deleted, but still in the search index
  posted: [] as { channel: string; text?: string; blocks?: unknown[] }[],
  updated: [] as { channel: string; ts: string; blocks?: unknown[] }[],
  published: [] as { user_id: string; view: { type?: string; blocks?: unknown[] } }[], // App Home views
  calls: [] as string[],
};

export function resetSlack(): void {
  workspace.channels.clear();
  workspace.users.clear();
  workspace.messages.length = 0;
  workspace.ghosts.length = 0;
  workspace.posted.length = 0;
  workspace.updated.length = 0;
  workspace.published.length = 0;
  workspace.calls.length = 0;
}

const n = (ts: string) => parseFloat(ts);
// The searching user (the Nudge user), used to name DM partners in search results
let searcher: string | undefined;

function slackError(code: string): Error {
  return Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } });
}

function inThreadWith(m: FakeMessage, user: string): boolean {
  if (!m.thread_ts) return false;
  return workspace.messages.some(
    (x) => x.channel === m.channel && (x.ts === m.thread_ts || x.thread_ts === m.thread_ts) && x.user === user
  );
}

function search(query: string): FakeMessage[] {
  searcher = query.match(/(?:from|with):<@(\w+)>|<@(\w+)>/)?.slice(1).find(Boolean);
  const from = query.match(/from:<@(\w+)>/)?.[1];
  const withUser = query.match(/with:<@(\w+)>/)?.[1];
  const mention = query.replace(/(from|with):<@\w+>/g, "").match(/<@(\w+)>/)?.[1];
  return [...workspace.messages, ...workspace.ghosts].filter((m) => {
    if (m.subtype && m.subtype !== "bot_message" && m.subtype !== "thread_broadcast") return false;
    const ch = workspace.channels.get(m.channel)!;
    if (from && m.user !== from) return false;
    if (mention && !(m.text ?? "").includes(`<@${mention}>`)) return false;
    if (withUser) {
      const dm = ch.type !== "channel" && ch.members.includes(withUser);
      if (!dm && !inThreadWith(m, withUser)) return false;
    }
    return true;
  });
}

export class WebClient {
  token?: string;
  constructor(token?: string) {
    this.token = token;
  }

  search = {
    messages: async ({
      query,
      count = 20,
      page = 1,
      sort_dir = "desc",
    }: {
      query: string;
      count?: number;
      page?: number;
      sort_dir?: string;
    }) => {
      workspace.calls.push(`search ${query} p${page}`);
      const all = search(query).sort((a, b) => (sort_dir === "asc" ? n(a.ts) - n(b.ts) : n(b.ts) - n(a.ts)));
      const matches = all.slice((page - 1) * count, page * count).map((m) => {
        const ch = workspace.channels.get(m.channel)!;
        const inThread = m.thread_ts && m.thread_ts !== m.ts;
        // Like real search: a DM's channel.name is the other person's user ID
        const name = ch.type === "im" ? ch.members.find((u) => u !== searcher) ?? ch.members[0] : ch.name ?? ch.id;
        return {
          ts: m.ts,
          text: m.text,
          user: m.user,
          type: ch.type === "im" ? "im" : ch.type === "mpim" ? "group" : "message",
          channel: { id: ch.id, name, is_mpim: ch.type === "mpim" },
          permalink: `https://clio.slack.com/archives/${ch.id}/p${m.ts.replace(".", "")}${
            inThread ? `?thread_ts=${m.thread_ts}&cid=${ch.id}` : ""
          }`,
        };
      });
      return { ok: true, messages: { matches, paging: { pages: Math.max(1, Math.ceil(all.length / count)) } } };
    },
  };

  conversations = {
    // Thread root first, then replies oldest-first; `oldest`/`inclusive` filter, `limit` + cursor page
    replies: async ({
      channel,
      ts,
      oldest,
      inclusive,
      limit = 1000,
      cursor,
    }: {
      channel: string;
      ts: string;
      oldest?: string;
      inclusive?: boolean;
      limit?: number;
      cursor?: string;
    }) => {
      workspace.calls.push(`replies ${channel} ${ts}`);
      const root = workspace.messages.find((m) => m.channel === channel && m.ts === ts);
      if (!root) throw slackError("thread_not_found");
      const thread =
        root.thread_ts && root.thread_ts !== root.ts
          ? [root]
          : [
              root,
              ...workspace.messages
                .filter((m) => m.channel === channel && m.thread_ts === ts && m.ts !== ts)
                .sort((a, b) => n(a.ts) - n(b.ts)),
            ];
      const inRange = thread.filter(
        (m) => !oldest || (inclusive ? n(m.ts) >= n(oldest) : n(m.ts) > n(oldest))
      );
      const start = cursor ? parseInt(cursor) : 0;
      const page = inRange.slice(start, start + limit);
      const hasMore = start + limit < inRange.length;
      return {
        ok: true,
        messages: page,
        has_more: hasMore,
        response_metadata: { next_cursor: hasMore ? String(start + limit) : "" },
      };
    },
    history: async ({
      channel,
      oldest,
      latest,
      limit = 100,
    }: {
      channel: string;
      oldest?: string;
      latest?: string;
      limit?: number;
    }) => {
      workspace.calls.push(`history ${channel}`);
      if (!workspace.channels.has(channel)) throw slackError("channel_not_found");
      const top = workspace.messages
        .filter(
          (m) =>
            m.channel === channel &&
            (!m.thread_ts || m.thread_ts === m.ts || m.subtype === "thread_broadcast") &&
            (!oldest || n(m.ts) > n(oldest)) &&
            (!latest || n(m.ts) < n(latest))
        )
        .sort((a, b) => n(b.ts) - n(a.ts));
      return { ok: true, messages: top.slice(0, limit), has_more: top.length > limit };
    },
    info: async ({ channel }: { channel: string }) => {
      const ch = workspace.channels.get(channel);
      if (!ch) throw slackError("channel_not_found");
      return {
        ok: true,
        channel: {
          id: ch.id,
          is_im: ch.type === "im",
          is_mpim: ch.type === "mpim",
          name: ch.name,
          user: ch.type === "im" ? ch.members[1] : undefined,
        },
      };
    },
  };

  users = {
    info: async ({ user }: { user: string }) => {
      const u = workspace.users.get(user);
      return { ok: true, user: { id: user, name: u?.name, real_name: u?.name, profile: { display_name: u?.name }, tz: u?.tz } };
    },
  };

  auth = {
    test: async () => ({ ok: true, url: "https://clio.slack.com/" }),
  };

  chat = {
    postMessage: async ({ channel, text, blocks }: { channel: string; text?: string; blocks?: unknown[] }) => {
      workspace.posted.push({ channel, text, blocks });
      return { ok: true, channel: "DNUDGE", ts: `${Date.now() / 1000}` };
    },
    update: async ({ channel, ts, blocks }: { channel: string; ts: string; blocks?: unknown[] }) => {
      workspace.updated.push({ channel, ts, blocks });
      return { ok: true };
    },
  };

  views = {
    publish: async ({ user_id, view }: { user_id: string; view: { type?: string; blocks?: unknown[] } }) => {
      workspace.published.push({ user_id, view });
      return { ok: true };
    },
  };
}
