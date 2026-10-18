<img src="public/nudge-bell.png" alt="" width="96" height="96">

# Nudge

Slack에서 놓친 질문을 챙겨서 DM으로 알려주는 개인 Slack 에이전트예요.

- 📥 **내가 답장해야 할 질문** — 누가 1:1 DM, @멘션, 내가 시작한 스레드에서 나에게 물어봤는데 아직 답하지 않은 질문 (2시간이 지나면 알려줘요)
- 📤 **상대에게 답장 받아야 할 질문** — 내가 물어봤는데 아직 답을 못 받은 질문 (24시간이 지나면 알려줘요)

[![Add to Slack](https://platform.slack-edge.com/img/add_to_slack.png)](https://nudge-233887047351.asia-northeast3.run.app/api/slack/oauth)

설치하면 안내 DM이 오고, 지난 7일 치 메시지를 바로 확인해서 몇 분 안에 찾은 질문을 DM으로 보내요. 기본값은 **평일 오전 8시에 하루 한 번**(Slack 프로필 시간대 기준)이고, 확인할 질문이 있을 때만 DM을 보내요.

---

## 사용법

- **Nudge DM 창**에서는 `/nudge` 없이 `설정`, `목록`, `9시`처럼 그냥 입력하면 돼요.
- **다른 채널이나 DM**에서는 앞에 `/nudge`를 붙여요. 예: `/nudge 목록` (답은 나에게만 보여요)
- 알림 아래의 **⚙️ 내 설정 · 🔄 최신 질문까지 확인 · 📖 사용법** 버튼을 눌러도 돼요.
- 자동 알림은 답할 시간(📥 2시간, 📤 24시간)을 드린 뒤 보내지만, `목록`·`새로고침`과 🔄 버튼에는 방금 온 질문도 바로 나와요.

### 확인하기

| 명령어 | 하는 일 |
| --- | --- |
| `/nudge 설정` (`/nudge`만 입력해도 돼요) | 내 설정, 다음 알림 시간, 지금 확인할 질문 수 보기 |
| `/nudge 목록` | 지금 확인할 질문 보기 |
| `/nudge 새로고침` | Slack을 지금 바로 다시 확인하고 방금 온 질문까지 보기 |
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

### 피드백 보내기

- 알림·목록 아래 **🙋 잘못 찾은 질문 알려주기**를 누르면, 잘못 찾은 질문을 고르고 이유(질문이 아니에요 / 나와 상관없어요 / 이미 답했어요)를 알려줄 수 있어요. 고른 질문은 목록에서 바로 지울 수도 있어요.
- Nudge가 놓친 질문은 그 메시지의 **⋯ → Nudge가 놓친 질문**을 누르면 목록에 추가되고 기록돼요.
- Nudge DM에 `의견 …`이라고 입력하면 자유 의견으로 저장돼요.
- 모은 피드백은 판단 정확도를 확인하고 나중에 AI를 다듬는(파인튜닝) 데 써요.

---

## 동작 방식 (GCP)

설계와 이전 기록은 [docs/gcp-migration.md](docs/gcp-migration.md)에 있어요.

| 구성 | 하는 일 |
| --- | --- |
| Cloud Run `nudge` | Slack 이벤트·명령·버튼, OAuth, 예약 실행, 백그라운드 작업. Slack 요청은 서명을 확인한 뒤 바로 응답하고 실제 처리는 Cloud Tasks로 넘겨요 |
| Cloud Run `nudge-admin` | 관리자 페이지(IAP 로그인, team-dx@·yoonchul@만) — 사용자 수, 실행 기록, AI 호출 통계, 로그, 피드백 내보내기 |
| Cloud Scheduler | 5분마다 `/api/cron/tick` 호출 → 알림 시각이 된 사용자·미리 확인할 사용자를 Cloud Tasks에 넣어요 |
| Cloud Tasks | `nudge-slack`(Slack 응답), `nudge-work`(수집·알림, 동시 2개). 작업 이름으로 사용자·시각별 한 번만 실행해요 |
| Firestore (서울) | 사용자, 추적 중 질문, 확인 기록, 잠금, 실행 기록, AI 호출 기록, 피드백 |
| Vertex AI | Gemini 3.8 Flash(생각 수준 LOW)로 답이 왔는지 판단하고 주제를 요약해요. 응답이 늦거나 429가 나면 재시도하고, 세 번째부터는 Gemini 2.5 Flash로 넘겨요 |
| Secret Manager | Slack Client ID·Secret·Signing Secret |

1. 알림 20분 전에 미리 Slack을 확인해 두고(검색 `from:<@나>`, `<@나>`, `with:<@나>` — 오래된 것부터 읽고 위치를 기억해요)
2. 스레드·DM 흐름을 읽어 이미 답이 왔는지 AI로 판단한 뒤
3. 알림 시각에는 저장된 데이터로 바로 보내요. 한 번 판단한 메시지는 다시 분류하지 않아요.
4. 처음 연결하면 최대 12분 동안 지난 7일 치를 끝까지 확인하고 결과를 DM으로 보내요.

## 운영

```bash
# 배포 (로컬 Docker로 빌드 → Artifact Registry → Cloud Run 두 서비스)
deploy/gcp/deploy.sh   # gcloud 로그인 계정으로 실행

# 테스트
npm test                 # 단위·흐름 테스트 (메모리 저장소)
npm run test:firestore   # 실제 Firestore(nudge-test DB)로 저장소 동작 확인 — GOOGLE_APPLICATION_CREDENTIALS 필요
npm run lint
```

- 처음 한 번의 IAM 설정은 [deploy/gcp/bootstrap.ps1](deploy/gcp/bootstrap.ps1), 그 밖의 리소스(Firestore·큐·시크릿·TTL)는 [deploy/gcp/infra.sh](deploy/gcp/infra.sh), 예약 실행은 [deploy/gcp/scheduler.sh](deploy/gcp/scheduler.sh)에 있어요.
- **알림 메일**([deploy/gcp/monitoring.sh](deploy/gcp/monitoring.sh)): 예약 실행(tick)이 20분 넘게 없거나, 10분 안에 오류 로그가 3건을 넘으면 yoonchul@clio.co.kr로 메일이 가요.
- **백업**: Firestore PITR(지난 7일 안의 어느 시점으로든 되돌리기)이 켜져 있어요.
- 배포용 서비스 계정 키는 이전이 끝난 뒤 지웠어요. 다시 배포하려면 키를 새로 만들거나 본인 계정으로 `deploy.sh`의 gcloud 명령을 실행하세요.
- 환경변수(배포 스크립트가 설정): `NUDGE_ROLE`(public/admin), `NUDGE_TASKS=cloud`, `NUDGE_SECRETS=gcp`, `APP_URL`·`NUDGE_SELF_URL`·`NEXT_PUBLIC_APP_URL`(공개 서비스 주소), 선택 `AI_MODEL`(기본 `gemini-3.8-flash`), `AI_FALLBACK_MODEL`(기본 `gemini-2.5-flash`), `NUDGE_IAP_AUDIENCE`.
- 내부 엔드포인트 `/api/cron/tick`, `/api/tasks/run`은 `nudge-runtime@` 서비스 계정의 Google ID 토큰만 받아요.

### Slack 앱

[`slack-app-manifest.json`](slack-app-manifest.json)을 Slack 앱 설정의 **App Manifest**에 붙여 넣고 Save하세요(스코프가 그대로면 다시 설치할 필요 없어요). 스코프를 바꾸면 사용자가 한 번 다시 설치(Add to Slack)해야 해요.

- User scopes: `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `im:read`, `mpim:history`, `mpim:read`, `search:read`, `users:read`
- Bot scopes: `chat:write`, `im:write`, `im:history`, `commands`
- Event Subscriptions: `app_home_opened`, `message.im` · Interactivity: 버튼·모달·메시지 단축키 `nudge_missed`

### 한계

- Slack 검색 API(`search.messages`)는 Tier 2(분당 약 20회) 제한이 있어서, 사용자가 많아지면 `nudge-work` 큐의 동시 실행 수를 함께 조절해야 해요.

## 기술 스택

- [Next.js](https://nextjs.org) App Router (standalone, Cloud Run)
- Google Cloud: Cloud Run, Firestore, Cloud Tasks, Cloud Scheduler, Vertex AI(Gemini), Secret Manager, IAP
- [Slack Web API](https://api.slack.com)
