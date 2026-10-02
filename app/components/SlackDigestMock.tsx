import Image from "next/image";
import { SECTION_NAMES } from "@/lib/messages";

// A static "screenshot" of a Nudge digest DM, mirroring lib/digest.ts blocks

function Marker({ n, className = "" }: { n: number; className?: string }) {
  return (
    <span
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#e11d48] align-middle text-[11px] font-bold text-white shadow ${className}`}
    >
      {n}
    </span>
  );
}

function Row({ label, meta, marker }: { label: string; meta: string; marker?: number }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <p className="min-w-0 leading-6">
        • <span className="text-[#1264a3] hover:underline">{label}</span>{" "}
        <span className="text-[13px] italic text-zinc-500">{meta}</span>
        {marker === 1 && <Marker n={1} className="ml-1.5" />}
      </p>
      {/* The ② badge overlaps the button corner so every 완료 button stays aligned */}
      <span className="relative shrink-0 rounded border border-zinc-300 bg-white px-3 py-1 text-[13px] font-semibold text-[#1d1c1d] shadow-sm">
        완료
        {marker === 2 && <Marker n={2} className="absolute -right-2.5 -top-2.5" />}
      </span>
    </div>
  );
}

export function SlackDigestMock() {
  return (
    <div
      className="overflow-hidden rounded-xl border border-zinc-300 bg-white text-[15px] text-[#1d1c1d] shadow-sm"
      role="img"
      aria-label="Nudge가 보내는 알림 DM 예시"
    >
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5">
        <Image src="/nudge-bell.png" alt="" width={20} height={20} className="h-5 w-5" />
        <span className="font-bold">Nudge</span>
        <span className="text-xs text-zinc-500">앱 · 다이렉트 메시지</span>
      </div>

      <div className="flex gap-2 px-4 py-4">
        <Image
          src="/nudge-bell.png"
          alt=""
          width={36}
          height={36}
          className="h-9 w-9 shrink-0 rounded-md border border-zinc-200 bg-white p-0.5"
        />
        <div className="min-w-0 flex-1">
          <p className="leading-5">
            <span className="font-bold">Nudge</span>
            <span className="ml-1 rounded bg-zinc-200 px-1 py-px align-middle text-[10px] font-semibold text-zinc-600">앱</span>
            <span className="ml-1.5 text-xs text-zinc-500">오전 8:00</span>
          </p>

          <p className="mt-1 font-bold">🔔 확인할 질문이 4개 있어요</p>

          <div className="mt-2">
            <p className="font-bold">{SECTION_NAMES.incoming} · 2</p>
            <Row label="김민지 - 견적서 회신 일정" meta="5시간 전" marker={1} />
            <Row label="박서준 (#마케팅) - 캠페인 예산 승인" meta="1일 전 · 질문 2개" marker={2} />
          </div>

          <hr className="my-3 border-zinc-200" />

          <div>
            <p className="font-bold">{SECTION_NAMES.outgoing} · 2</p>
            <Row label="#개발 - 배포 일정 확인" meta="2일 전" />
            <Row label="이하은 - 회의록 공유" meta="1일 전" />
          </div>

          <p className="mt-3 text-[13px] text-zinc-500">
            답장했거나 신경 쓰지 않아도 되면 <b>완료</b>를 눌러 주세요.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {["⚙️ 내 설정", "🔄 지금 다시 확인", "📖 사용법"].map((label) => (
              <span
                key={label}
                className="rounded border border-zinc-300 bg-white px-3 py-1 text-[13px] font-semibold text-[#1d1c1d] shadow-sm"
              >
                {label}
              </span>
            ))}
            <Marker n={3} />
          </div>
        </div>
      </div>
    </div>
  );
}

export const DIGEST_CALLOUTS = [
  "질문을 누르면 원래 메시지(DM·스레드)로 바로 이동해요.",
  "답장할 필요가 없으면 완료를 눌러 정리해요. 같은 DM·스레드에서 연달아 온 질문은 한 줄로 묶이고 함께 지워져요.",
  "버튼 한 번으로 내 설정을 보거나, 지금 바로 다시 확인하거나, 사용법을 볼 수 있어요.",
];
