// User-facing Slack copy (Korean). Kept in one place so the help text, welcome DM,
// README and landing page stay consistent.
//
// `p` is the command prefix for where the reply is shown: "" in the Nudge DM (people type
// "설정"), "/nudge " anywhere else (people type "/nudge 설정").

export const SECTION_NAMES = {
  incoming: "📥 내가 답장해야 할 질문",
  outgoing: "📤 상대에게 답장 받아야 할 질문",
} as const;

export const DM_PREFIX = "";
export const SLASH_PREFIX = "/nudge ";

const cmd = (p: string, s: string) => `\`${p}${s}\``;

export function helpText(p: string): string {
  const where =
    p === DM_PREFIX
      ? "• 이 창(Nudge DM)에는 그냥 `설정`, `목록`, `9시`처럼 입력하면 돼요.\n• 다른 채널이나 DM에서는 앞에 `/nudge`를 붙여요. 예: `/nudge 목록` _(나에게만 보여요)_"
      : "• 어느 채널에서든 `/nudge 목록`처럼 입력하면 돼요. 답은 나에게만 보여요.\n• Nudge와의 DM 창에서는 `/nudge` 없이 `목록`처럼 입력해도 돼요.";

  return `*📖 Nudge 사용법*

Nudge는 Slack에서 놓치기 쉬운 질문을 모아 DM으로 알려줘요.
• *${SECTION_NAMES.incoming}* — 누가 나에게 물어봤는데 아직 답하지 않은 질문 _(2시간이 지나면 알려줘요)_
• *${SECTION_NAMES.outgoing}* — 내가 물어봤는데 아직 답을 못 받은 질문 _(24시간이 지나면 알려줘요)_

*💬 어디에 입력하나요?*
${where}

*🔎 확인하기*
• ${cmd(p, "설정")} — 내 알림 설정과 다음 알림 시간
• ${cmd(p, "목록")} — 지금 확인할 질문 전체
• ${cmd(p, "새로고침")} — Slack을 지금 바로 다시 확인

*⏰ 알림 시간 정하기* _(기본: 평일 오전 8시)_
• ${cmd(p, "9시")} — 오전 9시에 하루 한 번
• ${cmd(p, "9시 13시 18시")} — 하루에 여러 번
• ${cmd(p, "매시간")} — 근무시간(9~18시)에 매시간, 새 질문이 있을 때만
• ${cmd(p, "2시간마다")} · ${cmd(p, "매시간 10-19")} — 간격이나 시간대를 직접 정하기
• ${cmd(p, "평일")} — 주말 빼고 받기 · ${cmd(p, "매일")} — 주말에도 받기
• ${cmd(p, "끄기")} · ${cmd(p, "켜기")} — 알림 끄고 켜기

*🎯 한 가지만 받고 싶을 때*
• ${cmd(p, "받은질문 끄기")} — ${SECTION_NAMES.incoming} 알림 끄기 (다시 켜려면 ${cmd(p, "받은질문 켜기")})
• ${cmd(p, "보낸질문 끄기")} — ${SECTION_NAMES.outgoing} 알림 끄기 (다시 켜려면 ${cmd(p, "보낸질문 켜기")})

*✅ 이럴 때 목록에서 저절로 빠져요*
• 📥 내가 답장하거나 질문에 👍·✅·넵 같은 리액션을 달았을 때, 14일이 지났을 때
• 📤 상대가 답하거나 내 메시지에 리액션을 달았을 때
_"확인해볼게요", "알아볼게요"처럼 미루는 답이나 👀(보는 중) 리액션은 아직 답으로 보지 않아요._
_알림의 *완료* 버튼으로 직접 지울 수도 있어요. 지운 질문은 다시 나오지 않아요._

*🧐 어떤 메시지를 질문으로 보나요?*
물음표(?)가 있거나 \`~할까요\`, \`~인가요\`, \`~부탁드립니다\`, \`~해 주세요\`처럼 질문이나 요청이 담긴 메시지예요. 📥는 1:1 DM, 나를 @멘션한 메시지, 내가 시작한 스레드의 답글만 보고, 봇 메시지는 빼요.`;
}

export const WELCOME_TEXT = `👋 *Nudge를 설치해 주셔서 고마워요!*

Slack에서 놓치기 쉬운 질문을 모아서 알려드릴게요.
• *${SECTION_NAMES.incoming}* — 누가 나에게 물어봤는데 아직 답하지 않은 질문
• *${SECTION_NAMES.outgoing}* — 내가 물어봤는데 아직 답을 못 받은 질문

*기본 설정*: 평일 오전 8시에 한 번, 확인할 질문이 있을 때만 DM을 보내요.

*이 창에 바로 입력해 보세요*
• \`설정\` — 내 알림 설정 보기
• \`목록\` — 지금 확인할 질문 보기
• \`9시\` — 평일 오전 9시에 받기
• \`매시간\` — 근무시간(9~18시)에 매시간, 새 질문이 있을 때만 받기
• \`도움말\` — 전체 사용법
_다른 채널에서는 \`/nudge 설정\`처럼 앞에 \`/nudge\`를 붙이면 돼요._

지금 지난 7일 치 메시지를 확인하고 있어요. 잠시 뒤 \`목록\`을 입력해 보세요.`;

export const NOT_INSTALLED_TEXT = (appUrl: string) =>
  `아직 Nudge가 연결되지 않았어요. ${appUrl} 에서 *Add to Slack*을 눌러 설치해 주세요.`;

export const hourlyInactiveWarning = (p: string) =>
  `⚠️ 지금은 알림이 *하루 한 번(오전 8시쯤)*만 나가고 있어서, 다른 시간이나 매시간 알림은 아직 오지 않아요. 관리자에게 알려 주세요. 그동안에도 ${cmd(p, "새로고침")}으로 언제든 직접 확인할 수 있어요.`;

export const INTERVAL_NOTE = "_하루 첫 알림에는 전체 목록을 보내고, 그 뒤로는 새 질문이 생겼을 때만 보내요._";
