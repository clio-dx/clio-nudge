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
  // Pointing to someone else: "채널이나 @박상구 님께 문의 부탁드립니다" — they'll ask them, not me
  /\S*(님께|님에게|에게|한테|채널에|채널로|팀에|팀으로)\s?(직접\s?)?(문의|연락|말씀|요청|물어)\S*\s?(해\s?)?(주\S*|부탁\S*|바랍니다|하세요|해\s?보세요)/g,
];

// "~할지 모르겠어요", "~할지가 고민이겠네요" — thinking out loud, not asking
const UNCERTAIN_STATEMENT = /\S지가?\s?(잘\s?)?(모르겠|고민)/;

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
// ("~고민이겠네요", "~하더라고요", "~잖아요" are remarks, not questions)
const STATEMENT_YO = /(드려요|게요|께요|그래요|네요|군요|거든요|잖아요|더라고요)$/;

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

// Replies that put the answer off ("확인해볼게요", "보고 말씀드릴게요", "잠시만요", "let me check").
// A reply written straight back is the answer unless it looks like one of these, so the net is
// wide on purpose: a false match only costs an AI call, a miss would close the question.
const DEFERRALS = [
  // ~해볼게요 / ~보겠습니다 / ~봐야: 확인해볼게요, 알아보겠습니다, 찾아볼께요, 제가 볼게요
  /(볼\s?[게께]|보겠|봐야|볼\s?예정|봐\s?드릴)/,
  // checking + later / in progress / not yet: 확인하고, 검토 후, 확인할게요, 확인 좀 할게요,
  // 확인중입니다, 확인이 필요해요, 아직 확인 못했어요, 확인 전이에요
  /(확인|체크|검토|파악|조회|문의|알아보|찾아보|살펴보|여쭤보|물어보)\s?(을\s|를\s|좀\s|이\s|가\s)?(해\s?|하여\s?)?(하고|하구|보고|해서\s?(알려|말씀|공유|회신|연락)|한\s?(후|뒤|다음)|후|뒤|중|하겠|할\s?[게께]|해\s?드릴|드릴|해드리겠|하는\s?중|필요|못|전|안)/,
  // not yet / busy right now: 아직요, 잠만요, 기다려 주세요, 회의 중이에요, 외근 중이라
  /아직|잠만|기다려/,
  /(회의|미팅|외근|통화|운전|휴가|출장|이동|외출|식사)\s?중/,
  // looking at it: 보고 있어요, 찾고 있어요, 알아보고 있어요
  /(보|찾|알아보|살펴보|확인하|검토하|체크하)고\s?있/,
  // needs someone's sign-off first: 팀장님 컨펌 받아야 해요, 승인 받고 드릴게요
  /(컨펌|승인|결재)\s?(을\s|를\s)?받(아야|고)/,
  /\b(not yet|haven'?t|not sure|sec)\b/i,
  // "I'll tell you" = no answer yet: 말씀드릴게요, 알려드리겠습니다, 회신드릴게요, 공유해 드릴게요
  /(말씀|알려|연락|회신|답변|답장|답|공유|전달|업데이트)\s?(을\s|를\s)?(해\s?)?(드릴\s?[게께]|드리겠|드릴\s?예정|줄\s?[게께]|할\s?[게께]|하겠)/,
  // waiting / later: 잠시만요, 조금만 기다려 주세요, 나중에 볼게요, 이따 볼게요, 회의 끝나고
  /(잠시|잠깐|조금만|좀만|이따|나중|추후|끝나고|끝난\s?(후|뒤|다음))/,
  // in progress: 보는 중, 처리 중이에요, 진행중입니다, 고민 중이에요
  /(보는|처리|진행|작업|찾는|알아보는|고민|생각|대기|기다리는)\s?중/,
  // waiting on someone else: 담당자한테 물어봤어요, 요청해 뒀어요
  /(물어봤|여쭤봤|문의했|문의해\s?뒀|요청했|요청해\s?뒀|전달했|넘겼)/,
  /\b(let me|lemme|i'?ll|i will|will|gonna|going to|need to|have to)\s+(\w+\s+){0,2}?(check|look|see|ask|find out|confirm|verify|review|get back|circle back|follow up|dig|investigate|think|revert|update|respond|reply)\b/i,
  /\b(looking|checking|digging)\s+(into|on|in)\b/i,
  /\b(on it|one sec|a sec|one moment|a moment|one min|a min|give me|gimme|hold on|hang on|bear with|brb|in a bit|later|tbd|not sure yet|checking|looking|asking|waiting|let you know|\d+\s?(sec|min)s?)\b/i,
];

// Does a reply need the AI to tell whether it answers the question? Only when it may be putting
// the answer off, or carries nothing but a laugh/emoji/"?" ("ㅋㅋ", ":joy:"). Casual answers
// ("그냥요.. 누가 보내길래", "몰라요", "넵") don't.
export function needsAnswerCheck(text: string): boolean {
  const cleaned = stripNoise(text);
  if (DEFERRALS.some((re) => re.test(cleaned))) return true;
  const hasLink = /<https?:|https?:\/\//.test(text); // sharing a link is an answer
  return !hasLink && cleaned.replace(/[\s\p{P}\p{S}ㅋㅎㅠㅜ]/gu, "").length === 0;
}

// Reactions that mean "seen, not done yet" (or just a laugh). Any other reaction from the person
// who owes the reply counts as an acknowledgement — workspaces use all kinds of custom emoji
// for "넵/확인/감사", so a deny-list works better than a fixed allow-list.
const NOT_AN_ANSWER_REACTIONS = new Set([
  "eyes", "eyes_shaking", "hourglass", "hourglass_flowing_sand", "loading", "thinking_face", "face_with_monocle",
  "question", "grey_question", "exclamation", "joy", "rolling_on_the_floor_laughing", "sweat_smile",
  "확인중", "검토중", "보는중", "고민중", "진행중",
]);

export function isAckReaction(name: string): boolean {
  return !NOT_AN_ANSWER_REACTIONS.has(name.split("::")[0]); // "+1::skin-tone-2" → "+1"
}
