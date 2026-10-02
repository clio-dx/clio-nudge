"use client";

import { useState } from "react";
import { PRESETS } from "@/lib/presets";
import { CopyButton } from "./CopyButton";
import { SlackCommandDemo } from "./SlackCommandDemo";

const STEPS = [
  { title: "복사", body: "마음에 드는 추천 설정의 복사 버튼을 눌러요." },
  {
    title: "Slack 입력창에 붙여넣기",
    body: "Nudge DM 창이나 아무 채널의 메시지 입력란에 붙여넣어요(Ctrl+V / ⌘V). 입력창 위에 /nudge 안내가 뜨면 제대로 된 거예요.",
  },
  {
    title: "Enter",
    body: "바로 \"나에게만 보이는\" 답장으로 바뀐 설정과 다음 알림 시각을 알려줘요. 채널에 메시지가 올라가지 않아요.",
  },
];

export function ScheduleGuide() {
  const [selectedId, setSelectedId] = useState(PRESETS[0].id);
  const selected = PRESETS.find((p) => p.id === selectedId) ?? PRESETS[0];

  return (
    <div className="flex flex-col gap-8">
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">추천 설정</legend>
        {PRESETS.map((p) => {
          const active = p.id === selectedId;
          return (
            <label
              key={p.id}
              className={`flex cursor-pointer flex-col gap-3 rounded-xl border p-4 transition-colors ${
                active
                  ? "border-[#e11d48] bg-rose-50/60 ring-1 ring-[#e11d48] dark:bg-rose-950/30"
                  : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700"
              }`}
            >
              <input
                type="radio"
                name="preset"
                value={p.id}
                checked={active}
                onChange={() => setSelectedId(p.id)}
                className="sr-only"
              />
              <div className="flex items-center gap-2">
                <span className="text-xl" aria-hidden>
                  {p.emoji}
                </span>
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {p.role} 추천
                </span>
              </div>
              <div>
                <p className="font-semibold text-black dark:text-zinc-50">{p.title}</p>
                <p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{p.description}</p>
              </div>
              <div className="mt-auto flex items-center gap-2 rounded-lg bg-zinc-900 px-3 py-2 dark:bg-zinc-800">
                <code className="min-w-0 flex-1 font-mono text-sm leading-5 text-zinc-50">{p.command}</code>
                <CopyButton text={p.command} onCopy={() => setSelectedId(p.id)} />
              </div>
              <p className="text-xs text-zinc-500">→ {p.schedule}</p>
            </label>
          );
        })}
      </fieldset>

      <div className="flex flex-col gap-4">
        <h3 className="font-semibold text-black dark:text-zinc-50">이렇게 적용해요</h3>
        <ol className="flex flex-col gap-2">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex items-start gap-3 rounded-lg bg-zinc-50 px-4 py-3 dark:bg-zinc-900">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#e11d48] text-xs font-bold text-white">
                {i + 1}
              </span>
              <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                <b className="text-black dark:text-zinc-50">{s.title}</b> — {s.body}
              </p>
            </li>
          ))}
        </ol>

        <SlackCommandDemo key={selected.command} command={selected.command} />
        <p className="text-center text-xs text-zinc-500">
          ▲ <b>{selected.role}</b> 추천 설정을 적용하는 모습이에요. 위에서 다른 설정을 고르면 시연도 바뀌어요.
        </p>

        <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          <li>
            붙여넣었는데 <code>/nudge</code> 안내가 안 뜨면, 맨 앞의 공백을 지우고 <code>/</code>부터 시작하는지 확인해 주세요.
            안내 없이 Enter를 누르면 일반 메시지로 올라갈 수 있어요.
          </li>
          <li>
            지금 설정을 확인하려면 <code>/nudge 설정</code>, 기본값(평일 오전 8시)으로 되돌리려면{" "}
            <code>/nudge 평일 8시</code>를 입력하세요. Nudge DM 창에서는 앞의 <code>/nudge</code>를 빼도 돼요.
          </li>
        </ul>
      </div>
    </div>
  );
}
