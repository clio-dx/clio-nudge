"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { applyScheduleUpdate, parseCommand } from "@/lib/command";
import { DEFAULT_SCHEDULE, formatSchedule, formatSlotTime, nextSlotTime } from "@/lib/schedule";
import { INTERVAL_NOTE } from "@/lib/messages";

const TZ = "Asia/Seoul";

interface DemoResponse {
  schedule: string;
  next: string | null;
  interval: boolean;
  time: string;
}

// The same text /nudge replies with, computed by the app's own parser
function responseFor(command: string, now: number): DemoResponse | null {
  const cmd = parseCommand(command.replace(/^\/nudge\s*/, ""));
  if (cmd.type !== "schedule") return null;
  const schedule = applyScheduleUpdate(DEFAULT_SCHEDULE, cmd.update);
  const next = nextSlotTime(schedule, TZ, now);
  return {
    schedule: formatSchedule(schedule),
    next: next ? formatSlotTime(next, TZ) : null,
    interval: schedule.kind === "interval",
    time: new Intl.DateTimeFormat("ko-KR", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(now),
  };
}

type Phase = "typing" | "enter" | "sent";

// An animated "screen recording" of running a /nudge command in Slack
export function SlackCommandDemo({ command }: { command: string }) {
  const [typed, setTyped] = useState(0);
  const [phase, setPhase] = useState<Phase>("typing");
  const [response, setResponse] = useState<DemoResponse | null>(null);

  useEffect(() => {
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const send = () => {
      setResponse(responseFor(command, Date.now()));
      setTyped(0);
      setPhase("sent");
    };

    if (reduceMotion) {
      at(0, send);
    } else {
      const run = () => {
        setPhase("typing");
        setTyped(0);
        setResponse(null);
        let t = 700;
        for (let i = 1; i <= command.length; i++) {
          at(t, () => setTyped(i));
          t += i <= "/nudge".length ? 110 : 75;
        }
        at(t + 500, () => setPhase("enter"));
        at(t + 1300, send);
        at(t + 6300, run);
      };
      at(0, run);
    }
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [command]);

  const text = command.slice(0, typed);
  const showSuggestions = phase !== "sent" && typed > 0;

  return (
    <div
      className="overflow-hidden rounded-xl border border-zinc-300 bg-white text-[15px] text-[#1d1c1d] shadow-sm"
      aria-label={`Slack에서 ${command} 를 입력하는 예시 화면`}
      role="img"
    >
      {/* Channel header */}
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5">
        <span className="font-bold"># 일반</span>
        <span className="text-xs text-zinc-500">아무 채널이나 DM에서 입력해도 돼요</span>
      </div>

      {/* Messages */}
      <div className="flex min-h-[148px] flex-col justify-end px-4 py-3">
        {phase === "sent" && response && (
          <div className="flex gap-2 rounded-md bg-[#f8f8f8] px-2 py-2">
            <Image src="/nudge-bell.png" alt="" width={36} height={36} className="h-9 w-9 rounded-md border border-zinc-200 bg-white p-0.5" />
            <div className="min-w-0">
              <p className="mb-0.5 flex items-center gap-1 text-xs text-zinc-500">
                <span aria-hidden>👁</span> 나에게만 보이는 메시지예요
              </p>
              <p className="leading-5">
                <span className="font-bold">Nudge</span>
                <span className="ml-1 rounded bg-zinc-200 px-1 py-px align-middle text-[10px] font-semibold text-zinc-600">앱</span>
                <span className="ml-1.5 text-xs text-zinc-500">{response.time}</span>
              </p>
              <p className="mt-0.5 leading-6">
                ✓ 알림 주기를 바꿨어요: <b>{response.schedule}</b> (한국 시간)
                {response.next ? ` · 다음 알림 ${response.next}` : ""}
              </p>
              {response.interval && (
                <p className="mt-0.5 text-xs italic text-zinc-500">{INTERVAL_NOTE.replace(/_/g, "")}</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="relative px-4 pb-4">
        {showSuggestions && (
          <div className="absolute inset-x-4 bottom-full mb-1 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg">
            <p className="px-3 pt-2 text-xs font-semibold text-zinc-500">Nudge</p>
            <div className="mx-1.5 my-1.5 rounded-md bg-[#1264a3] px-2.5 py-2 text-white">
              <p className="text-sm">
                <b>/nudge</b>{" "}
                <span className="opacity-80">list | refresh | 매일 9시 | 매시간 | 2시간마다 | 평일 | off | help</span>
              </p>
              <p className="text-xs opacity-80">미답변 질문 확인 · 알림 주기 설정 (help로 전체 사용법)</p>
            </div>
          </div>
        )}
        <div className="rounded-lg border border-zinc-300">
          <div className="flex gap-3 border-b border-zinc-100 px-3 py-1.5 text-xs font-bold text-zinc-300" aria-hidden>
            <span>B</span>
            <span className="italic">I</span>
            <span className="line-through">S</span>
            <span>🔗</span>
            <span>≡</span>
          </div>
          <div className="min-h-[40px] px-3 py-2 leading-6">
            {text ? <span>{text}</span> : <span className="text-zinc-400"># 일반에 메시지 보내기</span>}
            {phase !== "sent" && <span className="ml-px inline-block h-5 w-px translate-y-1 animate-pulse bg-zinc-800" />}
          </div>
          <div className="flex items-center justify-between px-2 pb-1.5" aria-hidden>
            <div className="flex gap-3 px-1 text-sm text-zinc-400">
              <span>＋</span>
              <span>Aa</span>
              <span>☺</span>
              <span>@</span>
            </div>
            <div className="relative flex items-center gap-2">
              {phase === "enter" && (
                <span className="animate-bounce rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 text-[11px] font-semibold text-zinc-600 shadow-sm">
                  Enter ↵
                </span>
              )}
              <span
                className={`rounded px-2 py-1 text-xs text-white transition-colors ${
                  text ? "bg-[#007a5a]" : "bg-zinc-300"
                }`}
              >
                ➤
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
