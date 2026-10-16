# Nudge GCP 이전 설계 (2026-10-16)

Vercel Hobby + Upstash Redis + Vercel AI Gateway(무료, 분당 5회) → GCP `clio-nudge` 프로젝트(서울).

## 결정 요약

| 항목 | 결정 | 이유 |
|---|---|---|
| 실행 | Cloud Run `nudge`(Slack·크론·작업용, 공개) + `nudge-admin`(관리자, IAP) — 같은 이미지, `NUDGE_ROLE`로 구분 | 조직 정책상 allUsers 불가 → `nudge`는 invoker 확인을 끄고 앱이 모든 요청을 검증(Slack 서명, Google OIDC). 관리자는 IAP로 team-dx@·yoonchul@만 |
| DB | **Firestore (Native, asia-northeast3)** | SQLite는 Cloud Run 디스크가 휘발성이고 인스턴스가 여러 개라 맞지 않음. 팀 공용 DB는 찾지 못했고 묶이면 장애 범위가 커짐. Firestore는 서버리스·IAM 기반·서울 리전·무료 구간이 넉넉하고 나중에 BigQuery로 내보내기 쉬움 |
| AI | Vertex AI `gemini-3.8-flash` (global), `thinkingLevel: LOW`, 실패 시 `gemini-2.5-flash` | 분당 5회 제한이 없어짐. 기본 thinking은 호출당 25~60초라 LOW 필수(약 1.5초) |
| 백그라운드 작업 | **Cloud Tasks** (`nudge-slack`, `nudge-work` 큐) → `/api/tasks/run` | Vercel `waitUntil` 대체. 요청 기반 과금 + 최소 1 인스턴스로 싸고 콜드스타트 없이 Slack 3초 응답. 긴 작업(첫 수집, 새로고침, 알림)은 태스크라 인스턴스가 꺼져도 다시 시도 가능 |
| 예약 실행 | **Cloud Scheduler** 5분마다 `/api/cron/tick` (OIDC) | GitHub 시간별 실행(하루 3~5회만 돎)과 Vercel 하루 1회 크론 대체 |
| 8시 알림 몰림 | tick은 "할 일"만 태스크로 넣고(사용자·슬롯별 이름으로 중복 방지), 알림 1시간 전에 미리 수집, 알림 때는 저장된 데이터로 바로 보냄 | 사용자가 늘어도 240초 안에 다 못 돌던 문제 해결 (`nudge-scale-before-gcp` 메모) |
| 시크릿 | Secret Manager (`slack-client-id`, `slack-client-secret`, `slack-signing-secret`), 앱이 런타임에 읽음 | 마이그레이션 작업이 Vercel에서 직접 받아 넣음 → 사람이 시크릿을 복사하지 않음 |
| 로그 | stdout JSON(severity 포함) → Cloud Logging, 관리자 페이지에서 조회 | |

## 데이터 모델 (Firestore)

- `users/{slackUserId}` — 기존 NudgeUser 그대로. `undefined`로 지우던 필드는 `FieldValue.delete()`
- `users/{u}/followups/{kind}~{channel}~{threadTs}` — FollowUp (kind 항상 저장)
- `seen/{u}` — `{ ids: { [itemId]: messageMs } }` 한 문서(30일 지난 항목 정리). 문서 1번 읽기로 끝나서 폴링 비용이 적음
- `locks/{key}` `{ expiresAt }` — 트랜잭션으로 획득, TTL 정책으로 자동 삭제
- `markers/{key}` `{ expiresAt }` — 슬롯별 발송 기록 등 (TTL)
- `flags/{key}` — 한 번만 보내는 안내 등
- `meta/ticks` — 최근 tick 기록
- `runs/{id}` — tick·poll·작업 결과 요약(관리자 화면, TTL 30일)
- `ai_calls/{id}` — 모든 AI 호출의 입력·출력·모델·지연시간 + 어떤 질문(itemId)에 대한 것인지 → 파인튜닝 데이터
- `feedback/{id}` — 사용자 피드백(라벨, 메모, 질문 원문 스냅샷)

## 피드백 (파인튜닝 준비)

1. 알림·목록 아래 **"🙋 잘못 찾은 질문 알려주기"** 버튼 → 모달: 해당 질문 고르기 + 이유(질문이 아니에요 / 나와 상관없어요 / 이미 답했어요) + 의견, "목록에서 지우기" 기본 체크
2. 메시지 단축키 **"Nudge가 놓친 질문"** (메시지 ⋯ 메뉴) → 놓친 질문(false negative)으로 기록하고 목록에 추가
3. DM에 `의견 …` 입력 → 자유 의견 기록
4. **완료** 클릭도 "실제로 챙길 질문이었음"이라는 암묵적 라벨로 기록
5. 관리자 페이지에서 `feedback.jsonl`(원본+AI 판단 조인), `tuning.jsonl`(Vertex AI 지도 학습 형식: 정답이 분명한 것만) 내려받기

## 관리자 페이지 (`nudge-admin`, IAP)

개요(사용자 수·활성·첫 수집 중·오늘 보낸 알림·AI 호출/오류·피드백 수·마지막 tick) / 사용자 목록 / 최근 실행(runs) / 로그(Cloud Logging, 심각도·검색) / 피드백 목록·내보내기. IAP JWT를 앱에서도 검증.

## 이전 순서 (오늘 밤)

1. `main`에 **Vercel용 내보내기 엔드포인트**만 먼저 배포: `GET /api/admin/export`(Google ID 토큰 — `nudge-runtime@`만 허용)로 Upstash 전체 + Slack 시크릿 반환, `POST`로 freeze/unfreeze(freeze 시 Vercel tick 중지, OAuth 시작은 GCP로 리다이렉트)
2. GCP 코드는 `gcp-migration` 브랜치에서 개발(병합 전까지 Vercel 프로덕션 영향 없음)
3. GCP 배포 → 마이그레이션 작업 실행(데이터·시크릿 복사) → 검증
4. Slack 앱 매니페스트: Request URL·Redirect URL을 Cloud Run으로, 메시지 단축키 추가 → URL 검증
5. Vercel freeze, GitHub 시간별 워크플로 비활성화, `main` 병합(`vercel.json`에서 Git 배포 끔 → Vercel은 freeze된 버전으로 남아 롤백용)
6. 실사용 확인(Slack에서 목록/새로고침, 관리자 페이지)

롤백: Slack URL을 Vercel로 되돌리고 `POST /api/admin/export {action:"unfreeze"}`.

## 남는 일 (사용자)

- 배포용 서비스 계정 키 삭제(이전 완료 후)
- 원하면 커스텀 도메인(예: nudge.clio.co.kr) — DNS 필요
