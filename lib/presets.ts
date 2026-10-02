// Recommended /nudge schedules by role, shown on the landing page;
// tests/pure.test.ts checks every command parses to `schedule`.

export interface Preset {
  id: string;
  emoji: string;
  role: string;
  title: string;
  command: string;
  description: string;
  schedule: string; // formatSchedule() of the result, starting from the default schedule
}

export const PRESETS: Preset[] = [
  {
    id: "leader",
    emoji: "👔",
    role: "임원·팀장",
    title: "하루 세 번 몰아서 정리",
    command: "/nudge 9시 13시 17시",
    description: "결재·의사결정 요청이 많다면 업무 흐름을 끊지 않고 출근, 점심 뒤, 퇴근 전에 한 번씩 몰아서 확인해요.",
    schedule: "평일 오전 9시, 오후 1시, 오후 5시",
  },
  {
    id: "member",
    emoji: "🧑‍💻",
    role: "사원·대리",
    title: "근무시간 매시간, 새 질문만",
    command: "/nudge 매시간 9-18",
    description: "요청에 빨리 답해야 한다면 근무시간 동안 새 질문이 생길 때만 알려드려요.",
    schedule: "평일 9시~18시 매시간",
  },
  {
    id: "focus",
    emoji: "🎧",
    role: "집중 업무형",
    title: "아침에 한 번만",
    command: "/nudge 9시",
    description: "개발·디자인처럼 몰입이 중요하다면 하루 한 번, 아침에만 정리해서 받아요.",
    schedule: "평일 오전 9시",
  },
  {
    id: "field",
    emoji: "📞",
    role: "영업·CS",
    title: "주말 포함 2시간마다",
    command: "/nudge 매일 2시간마다 9-21",
    description: "고객 응대처럼 주말에도 놓치면 안 된다면 9시~21시에 2시간 간격으로 새 질문을 알려드려요.",
    schedule: "매일 9시~21시 2시간마다",
  },
];
