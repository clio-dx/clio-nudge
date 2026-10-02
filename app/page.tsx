import Image from "next/image";
import { ScheduleGuide } from "./components/ScheduleGuide";
import { DIGEST_CALLOUTS, SlackDigestMock } from "./components/SlackDigestMock";

const SLACK_LOGO = (
  <svg width="20" height="20" viewBox="0 0 54 54" fill="none" aria-hidden>
    <path d="M19.712.133a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386h5.376V5.52A5.381 5.381 0 0 0 19.712.133m0 14.365H5.376A5.381 5.381 0 0 0 0 19.884a5.381 5.381 0 0 0 5.376 5.387h14.336a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386" fill="#36C5F0"/>
    <path d="M53.76 19.884a5.381 5.381 0 0 0-5.376-5.386 5.381 5.381 0 0 0-5.376 5.386v5.387h5.376a5.381 5.381 0 0 0 5.376-5.387m-14.336 0V5.52A5.381 5.381 0 0 0 34.048.133a5.381 5.381 0 0 0-5.376 5.387v14.364a5.381 5.381 0 0 0 5.376 5.387 5.381 5.381 0 0 0 5.376-5.387" fill="#2EB67D"/>
    <path d="M34.048 54a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386h-5.376v5.386A5.381 5.381 0 0 0 34.048 54m0-14.365h14.336a5.381 5.381 0 0 0 5.376-5.386 5.381 5.381 0 0 0-5.376-5.387H34.048a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386" fill="#ECB22E"/>
    <path d="M0 34.249a5.381 5.381 0 0 0 5.376 5.386 5.381 5.381 0 0 0 5.376-5.386v-5.387H5.376A5.381 5.381 0 0 0 0 34.25m14.336-.001v14.364A5.381 5.381 0 0 0 19.712 54a5.381 5.381 0 0 0 5.376-5.387V34.25a5.381 5.381 0 0 0-5.376-5.387 5.381 5.381 0 0 0-5.376 5.386" fill="#E01E5A"/>
  </svg>
);

const SCHEDULE_COMMANDS: [string, string][] = [
  ["/nudge 9시  ·  /nudge 9am", "오전 9시에 하루 한 번"],
  ["/nudge 9시 13시 18시", "하루에 여러 번, 지정한 시각마다"],
  ["/nudge 매시간  ·  /nudge hourly", "근무시간(9~18시) 동안 매시간"],
  ["/nudge 2시간마다", "근무시간 동안 2시간 간격"],
  ["/nudge 매시간 10-19", "매시간 받을 시간대를 직접 지정"],
  ["/nudge 평일", "주말 제외 (기본값)"],
  ["/nudge 매일  ·  /nudge 주말포함", "주말에도 받기 — /nudge 매일 9시처럼 함께 써도 돼요"],
  ["/nudge off  ·  /nudge on", "알림 끄기 / 다시 켜기"],
];

const OTHER_COMMANDS: [string, string][] = [
  ["/nudge", "내 설정과 다음 알림 시각 보기"],
  ["/nudge list", "지금 쌓여 있는 항목 보기 (종류별 최대 20줄)"],
  ["/nudge refresh", "Slack을 지금 바로 다시 확인하고 목록 보기"],
  ["/nudge 받은질문 끄기 / 켜기", "받은 질문 추적 끄고 켜기"],
  ["/nudge 보낸질문 끄기 / 켜기", "보낸 질문 추적 끄고 켜기"],
  ["/nudge tz Asia/Seoul  ·  /nudge tz auto", "시간대 직접 지정 / Slack 프로필과 맞추기"],
  ["/nudge help", "Slack 안에서 전체 사용법 보기"],
];

function CommandTable({ rows }: { rows: [string, string][] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
      {rows.map(([cmd, desc]) => (
        <div
          key={cmd}
          className="flex flex-col gap-1 border-b border-zinc-200 px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 dark:border-zinc-800"
        >
          <code className="shrink-0 font-mono text-sm text-[#4A154B] sm:w-72 dark:text-purple-300">{cmd}</code>
          <span className="text-sm text-zinc-600 dark:text-zinc-400">{desc}</span>
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold text-black dark:text-zinc-50">{title}</h2>
      {children}
    </section>
  );
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ installed?: string; team?: string; error?: string }>;
}) {
  const { installed, team, error } = await searchParams;
  const slackUrl = team ? `https://app.slack.com/client/${encodeURIComponent(team)}` : "https://app.slack.com/client";

  return (
    <div className="flex min-h-screen justify-center bg-zinc-50 font-sans dark:bg-black">
      {/* break-keep: Korean wraps between words, never mid-word */}
      <main className="flex w-full max-w-2xl flex-col gap-14 break-keep bg-white px-6 py-16 sm:px-10 dark:bg-black">
        <header className="flex flex-col items-center gap-6 text-center">
          <Image src="/nudge-bell.png" alt="" width={96} height={96} priority />
          <h1 className="-mt-2 text-5xl font-bold tracking-tight text-black dark:text-zinc-50">Nudge</h1>
          <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">
            Slack에서 놓친 질문을 챙겨서
            <br />
            DM으로 알려주는 개인 비서예요.
          </p>

          {installed ? (
            <div className="flex w-full flex-col items-center gap-3 rounded-lg bg-green-50 p-6 dark:bg-green-900/20">
              <p className="font-medium text-green-700 dark:text-green-400">
                {installed === "updated" ? "✓ Nudge 연결을 새로 고쳤어요!" : "✓ Nudge가 설치됐어요!"}
              </p>
              <p className="text-sm text-green-700 dark:text-green-500">
                {installed === "updated"
                  ? "알림 주기와 추적 설정은 그대로 유지했어요. 잠시 뒤 "
                  : "Slack DM으로 안내 메시지를 보냈어요. 지난 7일 치 메시지를 확인하는 중이니, 잠시 뒤 "}
                <code className="rounded bg-green-100 px-1 dark:bg-green-800">/nudge list</code>로 확인해 보세요.
              </p>
              <a
                href={slackUrl}
                className="mt-2 flex h-11 items-center gap-3 rounded-lg bg-[#4A154B] px-5 font-medium text-white transition-colors hover:bg-[#611f64]"
              >
                {SLACK_LOGO}
                Slack으로 돌아가기
              </a>
            </div>
          ) : error ? (
            <div className="flex w-full flex-col items-center gap-3 rounded-lg bg-red-50 p-6 dark:bg-red-900/20">
              <p className="font-medium text-red-700 dark:text-red-400">설치 중에 문제가 생겼어요</p>
              <p className="text-sm text-red-600 dark:text-red-500">오류: {error}</p>
              <a href="/api/slack/oauth" className="text-sm underline text-red-700 dark:text-red-400">
                다시 시도하기
              </a>
            </div>
          ) : (
            <a
              href="/api/slack/oauth"
              className="flex h-12 items-center justify-center gap-3 rounded-lg bg-[#4A154B] px-6 font-medium text-white transition-colors hover:bg-[#611f64]"
            >
              {SLACK_LOGO}
              Add to Slack
            </a>
          )}
        </header>

        <Section title="이런 메시지가 와요">
          <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            여기저기 흩어진 DM, 스레드, 멘션을 뒤질 필요 없이, 정해 둔 시간에 Nudge DM 하나로 모아서 보내드려요.
          </p>
          <SlackDigestMock />
          <ol className="flex flex-col gap-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            {DIGEST_CALLOUTS.map((text, i) => (
              <li key={text} className="flex gap-2">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#e11d48] text-[11px] font-bold text-white">
                  {i + 1}
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ol>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["🧠", "알아서 지워져요", "답장하면 AI가 판단해서 다음 확인 때 목록에서 빼요. “확인해볼게요”는 아직 안 끝난 걸로 봐요."],
              ["🔕", "조용해요", "확인할 게 없으면 아무 메시지도 오지 않고, 매시간 모드도 새 항목이 있을 때만 와요."],
              ["🔒", "나만 봐요", "알림과 명령어 답장은 나에게만 보여요. 상대방에게는 아무것도 가지 않아요."],
            ].map(([emoji, title, body]) => (
              <div key={title} className="rounded-lg bg-zinc-50 p-4 dark:bg-zinc-900">
                <p className="font-semibold text-black dark:text-zinc-50">
                  <span aria-hidden>{emoji}</span> {title}
                </p>
                <p className="mt-1 text-xs leading-5 text-zinc-600 dark:text-zinc-400">{body}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section title="무엇을 알려주나요?">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
              <p className="font-semibold text-black dark:text-zinc-50">📥 받은 질문</p>
              <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                누군가 1:1 DM이나 @멘션, 내가 시작한 스레드에서 나에게 물어봤는데 아직 답하지 않은 질문.
                2시간이 지나면 알려드려요.
              </p>
            </div>
            <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
              <p className="font-semibold text-black dark:text-zinc-50">📤 보낸 질문</p>
              <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                내가 채널·DM·스레드에서 물어봤는데 아직 답을 못 받은 질문. 상대에게 하루의 여유를 주고 24시간이
                지나면 알려드려요.
              </p>
            </div>
          </div>
          <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            알림 메시지의 항목을 누르면 해당 메시지로 바로 이동하고, <b>완료</b>를 누르면 목록에서 지워져요. 확인할
            게 없을 때는 아무 메시지도 보내지 않아요.
          </p>
        </Section>

        <Section title="알림은 언제 받나요?">
          <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            기본은 <b>평일 오전 8시에 하루 한 번</b>(Slack 프로필 시간대 기준)이에요. 일하는 방식에 맞는 추천 설정을
            골라 Slack에 붙여넣기만 하면 바로 바뀌어요.
          </p>
          <h3 className="font-semibold text-black dark:text-zinc-50">역할별 추천 설정</h3>
          <ScheduleGuide />
          <h3 className="mt-4 font-semibold text-black dark:text-zinc-50">직접 정하기</h3>
          <p className="text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            <code>/nudge</code> 뒤에 원하는 시간을 적으면 돼요. 한국어·영어 둘 다 알아들어요.
          </p>
          <CommandTable rows={SCHEDULE_COMMANDS} />
          <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <b>매일/지정 시각</b>: 그 시각에 확인할 항목이 있으면 전체 목록을 보내요.
            </li>
            <li>
              <b>매시간/간격</b>: 하루 첫 알림에 전체 목록을 보내고, 그 뒤로는 <b>새 항목이 생겼을 때만</b> 보내요.
              같은 목록이 매시간 반복되지 않아요.
            </li>
            <li>
              오전/오후 없이 <code>5시</code>, <code>1-5</code>처럼 쓰면 1~6시는 오후, 7~11시는 오전으로 알아들어요.{" "}
              <code>17:00</code>, <code>오전 5시</code>처럼 쓰면 그대로예요.
            </li>
          </ul>
        </Section>

        <Section title="그 밖의 명령어">
          <CommandTable rows={OTHER_COMMANDS} />
        </Section>

        <Section title="자동으로 정리되는 경우">
          <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            <li>
              <b>받은 질문</b>: 내가 답장하거나 파일을 보냈을 때 (&ldquo;확인해볼게요&rdquo; 같은 보류성 답장은 제외),
              질문에 ✅·👍 리액션을 달았을 때, 나를 cc·참조로만 넣은 질문에 다른 사람이 답했을 때, 질문한 사람이
              &ldquo;해결됐어요&rdquo;라고 했을 때, 14일이 지났을 때
            </li>
            <li>
              <b>보낸 질문</b>: 상대가 실질적인 답이나 파일을 줬을 때 (&ldquo;알아볼게요&rdquo;는 아직 답이 아니에요),
              봇이 답했을 때, 내가 &ldquo;해결했어요&rdquo;라고 남겼을 때
            </li>
            <li>원래 메시지가 삭제됐거나 내가 채널에서 나갔을 때</li>
            <li>
              <b>완료</b> 버튼으로 지운 항목은 다시 나타나지 않아요. 같은 DM·스레드에서 연달아 온 질문은 한 줄로
              묶이고 함께 지워져요.
            </li>
          </ul>
        </Section>

        <Section title="자주 묻는 질문">
          <div className="flex flex-col gap-4 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
            <div>
              <p className="font-medium text-black dark:text-zinc-50">어떤 메시지를 질문으로 보나요?</p>
              <p>
                물음표(?)가 있거나 &ldquo;~할까요&rdquo;, &ldquo;~인가요&rdquo;, &ldquo;~되나요&rdquo;,
                &ldquo;~부탁드립니다&rdquo;, &ldquo;~해 주세요&rdquo; 같은 질문·요청 표현이 있는 메시지예요.
                &ldquo;잘 부탁드립니다&rdquo;, &ldquo;참고 부탁드립니다&rdquo; 같은 인사·공지와 봇 메시지는 빼요. 답이
                왔는지는 AI가 대화 흐름을 보고 판단해요.
              </p>
            </div>
            <div>
              <p className="font-medium text-black dark:text-zinc-50">단체 DM이나 채널의 질문도 잡아주나요?</p>
              <p>
                나를 @멘션했거나 내가 시작한 스레드의 답글이면 잡아요. 멘션 없이 여러 명에게 던진 질문은 누구에게
                한 건지 알 수 없어서 제외해요.
              </p>
            </div>
            <div>
              <p className="font-medium text-black dark:text-zinc-50">내 메시지를 어디에 저장하나요?</p>
              <p>
                아직 답이 없는 질문의 본문과 짧은 요약만 Nudge 서버(Upstash Redis)에 저장하고, 답이 오거나 완료하면
                지워요. 답변 판단과 요약에는 Vercel AI Gateway를 써요.
              </p>
            </div>
            <div>
              <p className="font-medium text-black dark:text-zinc-50">지금 바로 확인하고 싶어요.</p>
              <p>
                <code>/nudge refresh</code>를 입력하면 그 자리에서 Slack을 다시 확인하고 목록을 보여줘요.
              </p>
            </div>
          </div>
        </Section>

        <footer className="border-t border-zinc-200 pt-6 text-center text-sm text-zinc-500 dark:border-zinc-800">
          <a href="https://github.com/clio-dx/clio-nudge" className="underline hover:text-zinc-700 dark:hover:text-zinc-300">
            GitHub에서 보기
          </a>
        </footer>
      </main>
    </div>
  );
}
