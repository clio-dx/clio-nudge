<img src="public/nudge-bell.png" alt="" width="96" height="96">

# Nudge

Slack에서 놓친 질문을 챙겨서 DM으로 알려주는 개인 Slack 에이전트예요.

- 📥 **받은 질문** — 누군가 1:1 DM, @멘션, 내가 시작한 스레드에서 나에게 물어봤는데 아직 답하지 않은 질문 (2시간 지나면 표시)
- 📤 **보낸 질문** — 내가 물어봤는데 아직 답을 못 받은 질문 (24시간 지나면 표시)

[![Add to Slack](https://platform.slack-edge.com/img/add_to_slack.png)](https://clio-nudge.vercel.app/api/slack/oauth)

설치하면 안내 DM이 오고, 지난 7일 치 메시지를 바로 확인해요. 기본값은 **평일 오전 8시에 하루 한 번**(Slack 프로필 시간대 기준)이고, 확인할 게 있을 때만 DM을 보내요.

---

## 사용법

Slack 아무 곳에서나 `/nudge`를 입력하세요. 한국어·영어 명령어 모두 알아들어요. Slack 안에서는 `/nudge help`로 같은 내용을 볼 수 있어요.

### 확인하기

| 명령어 | 하는 일 |
| --- | --- |
| `/nudge` | 내 설정, 다음 알림 시각, 지금 확인할 항목 수 보기 |
| `/nudge list` (`목록`) | 지금 쌓여 있는 항목 보기 (받은/보낸 질문 각각 최대 20줄, 완료로 정리하면 나머지가 이어서 보여요) |
| `/nudge refresh` (`지금`, `새로고침`) | Slack을 지금 바로 다시 확인하고 목록 보기 |
| `/nudge help` (`도움말`, `사용법`) | 전체 사용법 |

### 알림 주기 정하기 — 매일? 매시간?

기본값은 **평일 오전 8시에 하루 한 번**이에요.

| 명령어 | 알림 시각 |
| --- | --- |
| `/nudge 9시` · `/nudge 9am` | 오전 9시에 하루 한 번 (요일 설정은 그대로) |
| `/nudge 9시 13시 18시` · `/nudge 9am 1pm 6pm` | 하루 여러 번, 지정한 시각마다 |
| `/nudge 매시간` · `/nudge hourly` | 근무시간(9~18시) 동안 매시간 |
| `/nudge 2시간마다` · `/nudge every 2h` | 근무시간 동안 2시간 간격 |
| `/nudge 매시간 10-19` · `/nudge 9시부터 18시까지 매시간` | 매시간 받을 시간대 직접 지정 |
| `/nudge 평일` | 주말 제외 (기본값) |
| `/nudge 매일` · `/nudge 주말포함` | 주말에도 받기 |
| `/nudge 하루 한 번` | 하루 한 번으로 되돌리기 (시각은 그대로, 여러 개였다면 오전 8시) |
| `/nudge off` (`끄기`) · `/nudge on` (`켜기`) | 알림 끄기 / 다시 켜기 |

조합도 돼요: `/nudge 매일 9시`(주말 포함 매일 오전 9시), `/nudge 평일 매시간 10-19`, `/nudge 주말포함 오전 9시 오후 6시`.

- **매일/지정 시각** 모드는 그 시각에 확인할 항목이 있으면 전체 목록을 보내요.
- **매시간/간격** 모드는 하루 첫 알림에 전체 목록을 보내고, 그 뒤로는 **새 항목이 생겼을 때만** 보내요. 같은 목록이 매시간 반복되지 않아요.
- 확인할 항목이 없으면 아무 메시지도 보내지 않아요.
- 오전/오후 없이 `5시`, `1-5`처럼 쓰면 1~6시는 오후, 7~11시는 오전으로 해석해요(`9-6`은 9시~18시). `17:00`, `오전 5시`, `밤 12시`처럼 쓰면 그대로예요.
- 설정을 바꾸면 응답에 **다음 알림 시각**이 같이 나와요. 이미 지난 오늘 시각은 건너뛰고 다음 시각부터 보내요.

### 추적 대상 고르기

| 명령어 | 하는 일 |
| --- | --- |
| `/nudge 받은질문 끄기` / `켜기` | 받은 질문 추적 끄기 / 켜기 |
| `/nudge 보낸질문 끄기` / `켜기` | 보낸 질문 추적 끄기 / 켜기 |
| `/nudge tz Asia/Seoul` · `/nudge tz auto` | 시간대 직접 지정 / Slack 프로필과 맞추기 |

### 자동으로 정리되는 경우

- **받은 질문**: 내가 답장하거나 파일을 보냈을 때(“확인해볼게요” 같은 보류성 답장은 제외), 질문에 ✅·👍 리액션을 달았을 때(피부색 상관없음), 나를 cc·참조로만 넣은 질문에 다른 사람이 답했을 때, 질문한 사람이 “해결됐어요”라고 했을 때(“감사합니다”만으로는 정리되지 않아요), 14일이 지났을 때
- **보낸 질문**: 상대가 실질적인 답이나 파일을 줬을 때(“알아볼게요”는 아직 답이 아님), 스레드나 1:1 DM에서 봇이 답했을 때, 내가 “해결했어요”라고 남겼을 때
- 원래 메시지가 삭제됐거나 내가 채널에서 나간 경우
- 채널에서는 스레드 답글과, 질문 뒤 6시간 안의 채널 메시지만 답 후보로 봐요.
- 알림의 **완료** 버튼으로 지운 항목은 다시 나타나지 않아요. 같은 DM/스레드에서 연달아 온 질문은 한 줄로 묶이고, 완료를 누르면 함께 지워져요.

### 무엇을 질문으로 보나요?

물음표(`?`)가 있거나 `~할까요`, `~인가요`, `~되나요`, `~합니까`, `몇 시예요`, `~부탁드립니다`, `~해 주세요`, `~회신 바랍니다` 같은 질문·요청 표현이 있는 메시지예요. 코드 블록, 인용(`>`), URL 속 `?`는 무시하고, “수고하세요”, “잘 부탁드립니다”, “참고 부탁드립니다” 같은 인사·공지는 질문으로 보지 않아요. 답이 왔는지는 AI(Vercel AI Gateway)가 대화 흐름을 보고 판단해요.

받은 질문은 **1:1 DM**, **나를 @멘션한 메시지**, **내가 시작한 스레드의 답글**(다른 사람을 @멘션하지 않은 것)만 봐요. 멘션 없이 그룹 DM·채널에 던진 질문은 누구에게 한 건지 알 수 없어서 제외하고, 봇·앱이 보낸 메시지와 Nudge DM도 제외해요.

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
- 시간별 실행이 꺼져 있으면 `/nudge` 설정 화면과 일정 변경 응답에 경고가 떠요. 그동안에는 **한국 시간 오전 8시에 맞춘 일정**만 알림이 오고(다른 시간대 사용자는 해당 없음), `/nudge refresh`는 언제든 동작해요.
- 바로 실행해 보려면 GitHub Actions 탭에서 **Nudge hourly tick → Run workflow**를 누르거나, Vercel 대시보드 **Settings → Cron Jobs → Run**을 누르세요.

---

## 직접 배포하기

### 1. Slack 앱

[api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From an app manifest**에 [`slack-app-manifest.json`](slack-app-manifest.json)을 붙여 넣으세요(도메인은 본인 배포 주소로 바꾸기). App Home에서 **Messages Tab**을 켜야 Nudge의 DM이 보여요.

- User scopes: `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `im:read`, `mpim:history`, `mpim:read`, `search:read`, `users:read`
- Bot scopes: `chat:write`, `im:write`, `commands`

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
