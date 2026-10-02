<img src="public/nudge-bell.png" alt="" width="96" height="96">

# Nudge

Slack에서 놓친 질문을 챙겨서 DM으로 알려주는 개인 Slack 에이전트예요.

- 📥 **내가 답장해야 할 질문** — 누가 1:1 DM, @멘션, 내가 시작한 스레드에서 나에게 물어봤는데 아직 답하지 않은 질문 (2시간이 지나면 알려줘요)
- 📤 **상대에게 답장 받아야 할 질문** — 내가 물어봤는데 아직 답을 못 받은 질문 (24시간이 지나면 알려줘요)

[![Add to Slack](https://platform.slack-edge.com/img/add_to_slack.png)](https://clio-nudge.vercel.app/api/slack/oauth)

설치하면 안내 DM이 오고, 지난 7일 치 메시지를 바로 확인해요. 기본값은 **평일 오전 8시에 하루 한 번**(Slack 프로필 시간대 기준)이고, 확인할 질문이 있을 때만 DM을 보내요.

---

## 사용법

- **Nudge DM 창**에서는 `/nudge` 없이 `설정`, `목록`, `9시`처럼 그냥 입력하면 돼요.
- **다른 채널이나 DM**에서는 앞에 `/nudge`를 붙여요. 예: `/nudge 목록` (답은 나에게만 보여요)
- 알림 아래의 **⚙️ 내 설정 · 🔄 지금 다시 확인 · 📖 사용법** 버튼을 눌러도 돼요.

### 확인하기

| 명령어 | 하는 일 |
| --- | --- |
| `/nudge 설정` (`/nudge`만 입력해도 돼요) | 내 설정, 다음 알림 시간, 지금 확인할 질문 수 보기 |
| `/nudge 목록` | 지금 확인할 질문 보기 |
| `/nudge 새로고침` | Slack을 지금 바로 다시 확인하고 목록 보기 |
| `/nudge 도움말` | 전체 사용법 |

### 알림 시간 정하기 — 매일? 매시간?

| 명령어 | 알림 시각 |
| --- | --- |
| `/nudge 9시` | 오전 9시에 하루 한 번 (요일 설정은 그대로) |
| `/nudge 9시 13시 18시` | 하루 여러 번, 지정한 시각마다 |
| `/nudge 매시간` | 근무시간(9~18시) 동안 매시간 |
| `/nudge 2시간마다` | 근무시간 동안 2시간 간격 |
| `/nudge 매시간 10-19` | 매시간 받을 시간대 직접 지정 |
| `/nudge 평일` | 주말 제외 (기본값) |
| `/nudge 매일` | 주말에도 받기 |
| `/nudge 끄기` · `/nudge 켜기` | 알림 끄기 / 다시 켜기 |

조합도 돼요: `/nudge 매일 9시`(주말 포함 매일 오전 9시), `/nudge 평일 매시간 10-19`.

- **정해진 시간** 모드는 그 시간에 확인할 질문이 있으면 전체 목록을 보내요.
- **매시간/간격** 모드는 하루 첫 알림에는 전체 목록을 보내고, 그 뒤로는 **새 질문이 생겼을 때만** 보내요.
- 오전/오후 없이 `5시`처럼 쓰면 1~6시는 오후, 7~11시는 오전으로 알아들어요.

### 한 가지만 받기

| 명령어 | 하는 일 |
| --- | --- |
| `/nudge 받은질문 끄기` · `/nudge 받은질문 켜기` | 📥 내가 답장해야 할 질문 알림 끄기 / 다시 켜기 |
| `/nudge 보낸질문 끄기` · `/nudge 보낸질문 켜기` | 📤 상대에게 답장 받아야 할 질문 알림 끄기 / 다시 켜기 |

### 자동으로 정리되는 경우

- **📥 내가 답장해야 할 질문**: 내가 답장하거나 파일을 보냈을 때(“확인해볼게요”처럼 미루는 답은 제외), 질문에 👍·✅·넵 같은 리액션을 달았을 때, 나를 cc·참조로만 넣은 질문에 다른 사람이 답했을 때, 질문한 사람이 “해결됐어요”라고 했을 때, 14일이 지났을 때
- **📤 상대에게 답장 받아야 할 질문**: 상대가 실질적인 답이나 파일을 줬을 때(“알아볼게요”는 아직 답이 아님), 상대가 내 메시지에 👍·✅ 같은 리액션을 달았을 때, 스레드나 1:1 DM에서 봇이 답했을 때, 내가 “해결했어요”라고 남겼을 때
- 원래 메시지가 삭제됐거나 내가 채널에서 나간 경우
- 👀·⏳·🤔처럼 “보는 중”을 뜻하는 리액션은 답으로 보지 않아요.
- 알림의 **완료** 버튼으로 지운 질문은 다시 나오지 않아요. 같은 DM/스레드에서 연달아 온 질문은 한 줄로 묶이고, 완료를 누르면 함께 지워져요.

### 무엇을 질문으로 보나요?

물음표(`?`)가 있거나 `~할까요`, `~인가요`, `~되나요`, `~부탁드립니다`, `~해 주세요` 같은 질문·요청 표현이 있는 메시지예요. “잘 부탁드립니다”, “참고 부탁드립니다” 같은 인사·공지는 질문으로 보지 않아요. 답이 왔는지는 AI가 대화 흐름을 보고 판단해요.

📥 내가 답장해야 할 질문은 **1:1 DM**, **나를 @멘션한 메시지**, **내가 시작한 스레드의 답글**(다른 사람을 @멘션하지 않은 것)만 봐요. 멘션 없이 그룹 DM·채널에 던진 질문은 누구에게 한 건지 알 수 없어서 제외하고, 봇·앱이 보낸 메시지와 Nudge DM도 제외해요.

---

## 동작 방식

1. `/api/cron/tick`이 실행될 때마다, 알림 시각이 된 사용자에 대해
2. Slack 검색으로 최근 메시지를 찾고 (`from:<@나>`, `<@나>`, `with:<@나>`) — 오래된 것부터 읽고 읽은 위치를 기억해서, 메시지가 많아도 다음 확인 때 이어서 읽어요
3. 스레드·DM 흐름을 끝까지 읽어 이미 답이 왔는지 AI로 판단한 뒤
4. 답이 없는 질문만 DM으로 보내요. 한 번 판단한 메시지는 다시 분류하지 않아요.
5. 남는 시간에는 알림 시각이 아닌 사용자도 미리 확인해 둬서, 알림이 항상 최신 상태로 가요.

같은 시각에 tick이 여러 번 와도(Vercel Cron + GitHub Actions) 사용자별로 한 번만 보내고, tick이 늦게 와도 2시간 안이면 놓친 알림을 이어서 보내요. Slack 확인이 오래 걸려도(속도 제한 등) 알림은 제시간에 직전 데이터로 먼저 보내고, 남은 확인은 다음 실행 때 이어서 해요.

### 실행 주기 (중요)

Vercel **Hobby** 플랜은 cron을 **하루 한 번**만 돌릴 수 있어요. 그래서 실행 경로가 두 개예요.

| 트리거 | 주기 | 설정 |
| --- | --- | --- |
| Vercel Cron (`vercel.json`) | 매일 23:00 UTC = 오전 8시 KST | 자동 |
| GitHub Actions (`.github/workflows/nudge-tick.yml`) | 매시간 | 이 저장소의 `main`에 있으면 자동. 시크릿 불필요 |

- GitHub Actions 쪽은 GitHub OIDC 토큰으로 인증해요. 앱은 토큰이 `clio-dx/clio-nudge` 저장소의 `main` 브랜치, `nudge-tick.yml` 워크플로에서 발급된 것인지 확인해요. 저장소 이름이 바뀌면 Vercel 환경변수 `NUDGE_GITHUB_REPOSITORY`를 설정하세요.
- 앱 주소가 `https://clio-nudge.vercel.app`이 아니면 GitHub 저장소 변수(Settings → Variables) `NUDGE_APP_URL`을 설정하세요.
- 공개 저장소는 60일 동안 활동이 없으면 GitHub가 예약 워크플로를 꺼요. 그러면 Actions 탭에서 다시 켜 주세요.
- 시간별 실행이 꺼져 있으면 `/nudge` 설정 화면과 일정 변경 응답에 경고가 떠요. 그동안에는 **한국 시간 오전 8시에 맞춘 일정**만 알림이 오고(다른 시간대 사용자는 해당 없음), `/nudge 새로고침`은 언제든 동작해요.
- 바로 실행해 보려면 GitHub Actions 탭에서 **Nudge hourly tick → Run workflow**를 누르거나, Vercel 대시보드 **Settings → Cron Jobs → Run**을 누르세요.

---

## 직접 배포하기

### 1. Slack 앱

[api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From an app manifest**에 [`slack-app-manifest.json`](slack-app-manifest.json)을 붙여 넣으세요(도메인은 본인 배포 주소로 바꾸기). App Home에서 **Home Tab**, **Messages Tab**, "Allow users to send Slash commands and messages from the messages tab"을 켜야 해요. 홈 탭에는 연결 전이면 시작 방법과 **Nudge 연결하기** 버튼이, 연결 후면 내 설정이 보이고, Nudge DM에서는 명령어를 바로 입력할 수 있어요. 이미 만든 앱이면 **App Manifest**에 이 파일을 다시 붙여 넣고 Save하세요(스코프가 그대로면 다시 설치할 필요 없어요).

- User scopes: `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `im:read`, `mpim:history`, `mpim:read`, `search:read`, `users:read`
- Bot scopes: `chat:write`, `im:write`, `im:history`, `commands` (`im:history`는 Nudge DM에 입력한 `설정`, `목록` 같은 말을 받기 위해 필요해요)
- Event Subscriptions: Request URL `https://<배포 주소>/api/slack/events`, bot events `app_home_opened`(홈 탭·첫 안내), `message.im`(DM 명령어)
- 스코프를 바꾼 뒤에는 사용자가 한 번 다시 설치(Add to Slack)해야 새 권한이 적용돼요.

### 2. 환경변수 (Vercel)

| 이름 | 설명 |
| --- | --- |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` | Slack 앱 Basic Information |
| `NEXT_PUBLIC_APP_URL` | 배포 주소 (예: `https://clio-nudge.vercel.app`) |
| `CRON_SECRET` | Vercel Cron 인증용 임의 문자열 |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis (Vercel Marketplace 연동 시 자동) |
| `AI_MODEL` | 선택. 기본값 `anthropic/claude-haiku-4.5` (Vercel AI Gateway) |
| `NUDGE_GITHUB_REPOSITORY` | 선택. 시간별 tick을 보내는 저장소 (기본값 `clio-dx/clio-nudge`) |

### 3. 개발

```bash
npm install
npm run dev     # 로컬 실행
npm test        # 일정 계산·명령어 해석·질문 판별 단위 테스트
npm run lint
```

### 관리용 엔드포인트

- `GET /api/cron/tick` — `Authorization: Bearer $CRON_SECRET`. 알림 시각이 된 사용자를 처리하고 결과 요약(JSON)을 돌려줘요.
- `POST /api/admin/clear-user` — `Authorization: Bearer $CRON_SECRET`, body `{"userId": "U..."}`. 사용자의 추적 항목을 모두 지워요.

### 한계

- 한 tick은 최대 5분 동안 돌아요. 같은 시각에 알림 받는 사용자가 많으면 일부는 직전에 확인해 둔 데이터로 알림을 보내고, 남은 확인은 다음 실행 때 이어서 해요.
- Slack 검색 API(`search.messages`)는 Tier 2(분당 약 20회) 제한이 있어서 사용자 수가 많아지면 느려질 수 있어요.

## 기술 스택

- [Next.js](https://nextjs.org) App Router
- [Vercel AI SDK](https://sdk.vercel.ai) + AI Gateway
- [Upstash Redis](https://upstash.com)
- [Slack Web API](https://api.slack.com)
