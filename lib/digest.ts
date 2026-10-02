import { getUserFollowUps, itemId, type FollowUp, type FollowUpKind } from "@/lib/redis";
import { escapeSlackText, getThreadLink } from "@/lib/slack";
import type { NudgeUser } from "@/lib/db";

const HOUR_MS = 60 * 60 * 1000;
// Give people time to reply before nagging
export const MIN_AGE_MS: Record<FollowUpKind, number> = {
  incoming: 2 * HOUR_MS,  // a question to me: surface after 2h without my reply
  outgoing: 24 * HOUR_MS, // my question: give others a day to answer
};

export interface Visible {
  incoming: FollowUp[];
  outgoing: FollowUp[];
}

// Items old enough to show, oldest first, honoring the user's tracking toggles
export async function loadVisible(user: NudgeUser, now = Date.now()): Promise<Visible> {
  const load = async (kind: FollowUpKind, enabled: boolean) => {
    if (!enabled) return [];
    const items = await getUserFollowUps(user.slackUserId, kind);
    return items.filter((f) => now - f.createdAt >= MIN_AGE_MS[kind]).sort((a, b) => a.createdAt - b.createdAt);
  };
  const [incoming, outgoing] = await Promise.all([
    load("incoming", user.trackIncoming !== false),
    load("outgoing", user.trackOutgoing !== false),
  ]);
  return { incoming, outgoing };
}

export function visibleIds(v: Visible): string[] {
  return [...v.incoming, ...v.outgoing].map((f) => itemId(f.kind ?? "outgoing", f.channel, f.threadTs));
}

interface Group {
  kind: FollowUpKind;
  first: FollowUp;
  members: FollowUp[];
}

// Rapid-fire questions in the same DM or thread collapse into one row
function group(items: FollowUp[], kind: FollowUpKind): Group[] {
  const groups = new Map<string, Group>();
  for (const f of items) {
    const inThread = !!f.parentThreadTs && f.parentThreadTs !== f.threadTs;
    const groupable = inThread || f.convType === "im" || f.convType === "mpim";
    const key = groupable ? `${f.channel}|${inThread ? f.parentThreadTs : "top"}|${f.askerId ?? ""}` : f.threadTs;
    const g = groups.get(key);
    if (g) g.members.push(f);
    else groups.set(key, { kind, first: f, members: [f] });
  }
  return [...groups.values()];
}

export function formatAge(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 1) return "방금";
  if (hours < 48) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

function fallbackText(text: string): string {
  const plain = text
    .replace(/<@[A-Z0-9]+(?:\|([^>]+))?>/g, (_, name) => (name ? `@${name}` : "@"))
    .replace(/<#[A-Z0-9]+(?:\|([^>]+))?>/g, (_, name) => (name ? `#${name}` : "#"))
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1");
  return plain.length > 60 ? `${plain.slice(0, 60)}…` : plain;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = any;

const SECTION_TITLES: Record<FollowUpKind, { title: string; hint: string }> = {
  incoming: { title: "📥 답장이 필요한 질문", hint: "다른 사람이 나에게 물어봤는데 아직 답하지 않은 것" },
  outgoing: { title: "📤 답을 기다리는 내 질문", hint: "내가 물어봤는데 아직 답을 못 받은 것" },
};

function sectionBlocks(
  kind: FollowUpKind,
  items: FollowUp[],
  teamUrl: string,
  max: number,
  now: number,
  isList: boolean
): Block[] {
  const groups = group(items, kind);
  if (groups.length === 0) return [];

  const blocks: Block[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${SECTION_TITLES[kind].title} · ${groups.length}*\n_${SECTION_TITLES[kind].hint}_`,
      },
    },
  ];

  groups.slice(0, max).forEach((g, i) => {
    const f = g.first;
    const link = getThreadLink(teamUrl, f.channel, f.threadTs, f.parentThreadTs);
    const label = escapeSlackText(f.summary || fallbackText(f.originalMessage));
    const extra = g.members.length > 1 ? ` · 질문 ${g.members.length}개` : "";
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `• <${link}|${label}>  _${formatAge(now - f.createdAt)}${extra}_` },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "완료", emoji: true },
        action_id: `dismiss_${kind}_${i}`,
        value: JSON.stringify({ k: kind, c: f.channel, t: g.members.map((m) => m.threadTs).slice(0, 40) }),
      },
    });
  });

  const hidden = groups.length - max;
  if (hidden > 0) {
    const hint = isList ? "*완료*로 정리하면 나머지가 이어서 보여요" : "`/nudge list`로 더 보기";
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `_…외 ${hidden}개 더 있어요. ${hint}_` }],
    });
  }
  return blocks;
}

// Rows per section, as shown in digests (grouped)
export function groupCounts(v: Visible): { incoming: number; outgoing: number } {
  return { incoming: group(v.incoming, "incoming").length, outgoing: group(v.outgoing, "outgoing").length };
}

export function countGroups(v: Visible): number {
  const c = groupCounts(v);
  return c.incoming + c.outgoing;
}

// Slack allows 50 blocks per message: 1 header + 2×(title + items + more) + divider + footer
export function buildDigestBlocks(
  v: Visible,
  teamUrl: string,
  opts: { maxPerSection: number; now?: number; footer?: string; isList?: boolean }
): Block[] {
  const now = opts.now ?? Date.now();
  const total = countGroups(v);

  if (total === 0) {
    return [
      { type: "section", text: { type: "mrkdwn", text: "🎉 *모두 처리했어요!* 지금은 확인할 항목이 없어요." } },
      ...(opts.footer ? [{ type: "context", elements: [{ type: "mrkdwn", text: opts.footer }] }] : []),
    ];
  }

  const isList = opts.isList === true;
  const blocks: Block[] = [
    { type: "section", text: { type: "mrkdwn", text: `*🔔 확인할 항목이 ${total}개 있어요*` } },
    ...sectionBlocks("incoming", v.incoming, teamUrl, opts.maxPerSection, now, isList),
    ...(v.incoming.length > 0 && v.outgoing.length > 0 ? [{ type: "divider" }] : []),
    ...sectionBlocks("outgoing", v.outgoing, teamUrl, opts.maxPerSection, now, isList),
  ];

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: opts.footer ?? "답장했거나 신경 쓰지 않아도 되면 *완료*를 눌러 주세요 · `/nudge help` 사용법 · `/nudge` 설정",
      },
    ],
  });
  return blocks;
}

export function digestFallbackText(v: Visible): string {
  const total = countGroups(v);
  return total > 0 ? `Nudge: 확인할 항목이 ${total}개 있어요` : "Nudge: 확인할 항목이 없어요";
}
