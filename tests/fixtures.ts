// The fake Slack workspace most tests start from (tests/mocks/slack-web-api.ts holds the state)
import { workspace, type FakeMessage } from "./mocks/slack-web-api.ts";

export const ME = "UME";
export const HOUR = 3600;

// Slack ts values are unique per channel; add a per-message microsecond offset so messages
// created in the same millisecond don't collide
let seq = 0;
export const ago = (hours: number) => (Math.floor(Date.now() / 1000 - hours * HOUR) + ++seq / 1e6).toFixed(6);

export function channel(id: string, type: "im" | "mpim" | "channel", members: string[], name?: string) {
  workspace.channels.set(id, { id, type, members, name });
}

export function msg(m: Omit<FakeMessage, "ts"> & { hoursAgo: number; ts?: string }): string {
  const ts = m.ts ?? ago(m.hoursAgo);
  workspace.messages.push({ ...m, ts });
  return ts;
}

export const ids = (items: { channel: string; threadTs: string }[]) => items.map((f) => `${f.channel}:${f.threadTs}`).sort();

// Timestamps of the named messages, rebuilt by buildWorkspace()
export const T: Record<string, string> = {};

export function buildWorkspace() {
  for (const k of Object.keys(T)) delete T[k];
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

