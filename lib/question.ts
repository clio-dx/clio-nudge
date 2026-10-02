// Pure heuristics for spotting questions/requests — no imports so they can be
// unit-tested with plain node.

// Final consonant (jongseong) index of a Hangul syllable, or -1
function finalConsonant(ch: string | undefined): number {
  if (!ch) return -1;
  const code = ch.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return -1;
  return (code - 0xac00) % 28;
}
const JONG_RIEUL = 8; // ㄹ  (할까, 될까, 먹을까)
const JONG_BIEUP = 17; // ㅂ (합니까, 됩니까, 있습니까)

// 나다-verbs where "~나요" is a statement, not a question (생각나요, 화나요 ...)
const NA_YO_STATEMENTS = /(생각|화|기억|짜증|신|난리|티|소리|냄새|땀|눈물|탈|싫증|겁|열|빛|맛|멋|힘|살|흠|금|구멍|불|끝)나요$/;

const POLITE_QUESTION_ENDINGS = [
  "까요", "인가요", "는가요", "한가요", "던가요", "은가요", "신가요", "건가요", "는지요", "을지요", "인지요",
  "은지요", "한지요", "맞죠", "맞나요", "어때요", "어떠세요", "언제죠", "뭐죠", "어디죠", "누구죠", "되죠",
  "뭐예요", "언제예요", "어디예요", "누구예요", "얼마예요", "뭔가요", "뭘까요", "실래요", "주실래요",
  "주시겠어요", "있으세요", "없으세요", "보셨어요",
  // Deliberately absent: "하세요/계세요/하셨어요" — "수고하세요", "안녕히 계세요", "고생하셨어요" are sign-offs
];

// Polite closings nobody has to answer ("잘 부탁드립니다", "참고 바랍니다", "궁금한 점 있으면 연락 주세요").
// Only the phrase itself is removed, so a real request in the same sentence still counts.
const SIGN_OFFS = [
  /(앞으로도\s?)?잘\s?부탁\S*/g,
  /많은\s?(참여|관심|협조|성원|양해)\s?(부탁|바랍)\S*/g,
  /(참고|양해|숙지|이해|유의|주의|감안)\s?(해\s?|하여\s?)?(부탁|주세요|주십시오|바랍니다)\S*/g,
  /(궁금|문의|질문|문제|이슈|요청)\S*\s?(사항|점|게|것)?\S*\s?(있으면|있으시면|생기면|생기시면|있을\s?경우)[^.!?]*?(연락|말씀|문의|물어|말)\S*\s?(해\s?)?주\S*/g,
  /(편하게|언제든지?|부담\s?없이)\s?(연락|말씀|문의|물어|말)\S*\s?(해\s?)?(주\S*|하세요|보세요)/g,
];

// "~할지 모르겠어요", "~할지 고민 중이에요" — thinking out loud, not asking
const UNCERTAIN_STATEMENT = /\S지\s?(잘\s?)?(모르겠|고민)/;

// Requests that expect a response or action from the recipient
const REQUEST_PATTERNS = [
  /(?<!참고|양해|숙지|이해|유의|주의)\s?(해|하여|봐|보내|알려|공유해|검토해|확인해|전달해|회신해|답해|말해|체크해|넣어|올려|정리해)\s?주(세요|십시오|실 수|시면|시기 바랍니다|시겠어요|실래요)/,
  /(회신|연락|답장|의견|피드백|답변|컨펌)\s?(좀\s?)?주(세요|십시오|시기 바랍니다)/,
  /(확인|검토|회신|제출|참석|답변|공유|컨펌)\s?(후\s?\S+\s?)?바랍니다/,
  /부탁\s?(드려요|드립니다|드릴게요|해요|합니다|드려도 될까요)/,
  /(확인|검토|회신|답변|공유|피드백|리뷰|승인|컨펌)\s?(좀\s?)?(부탁|요청)/,
  /(알려|보내|해|봐|줘|확인해)\s?줘$/,
  /줄\s?(래|수 있어)$/,
];

// Question words — but not their indefinite forms ("언제든", "뭐든", "누구나", "어떻게든").
// "얼마나" stays a question word ("얼마나 걸려요").
const WH_WORDS =
  /(^|\s)((뭐|뭘|무슨|무엇|언제|어디|누가|누구|어떻게|어떤|왜(?!냐))(?!든|나\s|나$|라도|이든)|얼마(?!든)|몇)/;
// Polite endings that are statements even after a question word ("어떻게 됐는지 공유드려요", "제가 할게요")
const STATEMENT_YO = /(드려요|게요|께요|그래요)$/;

function stripNoise(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // code blocks
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/^(?:>|&gt;).*$/gm, " ") // quoted lines (Slack sends ">" as "&gt;")
    .replace(/<(?:https?:\/\/|mailto:)[^>]*>/g, " ") // slack-formatted links
    .replace(/https?:\/\/\S+/g, " ") // raw urls (query strings contain "?")
    .replace(/<[@#!][^>]*>/g, " ") // mentions, channels, special tokens
    .replace(/:[a-z0-9_+'-]+:/g, " "); // emoji shortcodes
}

function sentences(text: string): string[] {
  return text
    .split(/[.!。\n]+/)
    .map((s) => s.replace(/[\s~…^ㅠㅜㅎㅋ;:)(]+$/u, "").trim())
    .filter(Boolean);
}

function isKoreanQuestionSentence(sentence: string): boolean {
  let s = sentence;
  for (const re of SIGN_OFFS) s = s.replace(re, " ");
  s = s.replace(/[\s,~…]+$/u, "").trim();
  if (!s || UNCERTAIN_STATEMENT.test(s)) return false;

  if (POLITE_QUESTION_ENDINGS.some((e) => s.endsWith(e))) return true;
  if (s.endsWith("나요") && !NA_YO_STATEMENTS.test(s)) return true;
  // ~ㄹ까 (casual "할까", "될까") — excludes "아까", "그러니까"
  if (s.endsWith("까") && finalConsonant(s.at(-2)) === JONG_RIEUL) return true;
  // ~ㅂ니까 (formal "합니까", "있습니까")
  if (s.endsWith("니까") && finalConsonant(s.at(-3)) === JONG_BIEUP) return true;
  // Wh-word + polite ending: "언제 오세요", "왜 안 됐어요", "몇 시예요", "얼마나 걸려요"
  if (WH_WORDS.test(s) && (/요$/.test(s) || s.endsWith("죠")) && !STATEMENT_YO.test(s)) return true;
  return REQUEST_PATTERNS.some((re) => re.test(s));
}

export function isLikelyQuestion(text: string): boolean {
  if (!text) return false;
  const cleaned = stripNoise(text);
  if (cleaned.replace(/\s/g, "").length < 3) return false;

  // Any real question mark outside of URLs/code
  if (/[?？]/.test(cleaned)) return true;

  return sentences(cleaned).some(isKoreanQuestionSentence);
}

export function mentionsUser(text: string, userId: string): boolean {
  return text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`);
}

// "<@A> 견적 확인 부탁드려요 cc <@ME>" — I'm only copied in, so someone else's answer settles it.
// Not for "<@A> <@ME> 각자 일정 알려주세요", where everyone owes their own reply.
export function isCcMention(text: string, userId: string): boolean {
  const idx = text.search(new RegExp(`<@${userId}(\\|[^>]*)?>`));
  if (idx < 0) return false;
  return /(^|[\s(\[/])(cc|참조|fyi)\s*[:：]?\s*(<@[^>]+>[\s,]*)*$/i.test(text.slice(0, idx));
}

// Other users explicitly @mentioned in the message (excluding `selfId`)
export function otherMentions(text: string, selfId: string): string[] {
  const ids = [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
  return [...new Set(ids)].filter((id) => id !== selfId);
}

// Reactions that mean "handled" when the recipient adds them to a question.
// 👀 is intentionally absent — "I saw it" isn't an answer.
export const DONE_REACTIONS = new Set([
  "white_check_mark", "heavy_check_mark", "ballot_box_with_check", "check", "done", "+1", "thumbsup",
  "ok_hand", "ok", "ok_woman", "ok_man", "raised_hands", "확인", "완료",
]);
