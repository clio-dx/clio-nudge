#!/usr/bin/env bash
# Email alerts for Nudge (Cloud Monitoring). Safe to re-run: existing pieces are kept.
#   deploy/gcp/monitoring.sh [email]      (default yoonchul@clio.co.kr)
#  - "Nudge 예약 실행 멈춤": no scheduler tick logged for 20 minutes
#  - "Nudge 오류": more than 3 ERROR log lines (app errors, 5xx responses) within 10 minutes
set -euo pipefail
P=clio-nudge
EMAIL=${1:-yoonchul@clio.co.kr}
DIR=$(mktemp -d)

channel=$(gcloud beta monitoring channels list --project $P --filter="labels.email_address=\"$EMAIL\"" --format="value(name)" | head -1)
if [ -z "$channel" ]; then
  channel=$(gcloud beta monitoring channels create --project $P --type=email --display-name="Nudge 알림 ($EMAIL)" \
    --channel-labels=email_address="$EMAIL" --format="value(name)")
fi
echo "channel: $channel"

metric() { # name, description, filter
  if ! gcloud logging metrics describe "$1" --project $P >/dev/null 2>&1; then
    gcloud logging metrics create "$1" --project $P --description="$2" --log-filter="$3"
  fi
}
metric nudge_ticks "Nudge scheduler ticks (one per 5 minutes)" \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="nudge" AND textPayload=~"^tick \{"'
metric nudge_errors "ERROR log lines from the Nudge services" \
  'resource.type="cloud_run_revision" AND resource.labels.service_name=("nudge" OR "nudge-admin") AND severity>=ERROR'

cat > "$DIR/ticks.json" <<EOF
{
  "displayName": "Nudge 예약 실행 멈춤",
  "documentation": {
    "content": "20분 넘게 Nudge 예약 실행(tick)이 없어요. 알림이 나가지 않을 수 있어요.\n확인: gcloud scheduler jobs describe nudge-tick --location asia-northeast3 --project clio-nudge, 관리자 페이지 최근 실행.",
    "mimeType": "text/markdown"
  },
  "combiner": "OR",
  "conditions": [{
    "displayName": "tick 20분 없음",
    "conditionAbsent": {
      "filter": "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/nudge_ticks\"",
      "duration": "1200s",
      "aggregations": [{ "alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_SUM", "crossSeriesReducer": "REDUCE_SUM" }]
    }
  }],
  "alertStrategy": { "autoClose": "86400s" },
  "notificationChannels": ["$channel"]
}
EOF
cat > "$DIR/errors.json" <<EOF
{
  "displayName": "Nudge 오류",
  "documentation": {
    "content": "10분 동안 Nudge 오류 로그가 3건을 넘었어요. 관리자 페이지 → 로그(ERROR 이상)에서 확인하세요.",
    "mimeType": "text/markdown"
  },
  "combiner": "OR",
  "conditions": [{
    "displayName": "ERROR 로그 10분에 3건 초과",
    "conditionThreshold": {
      "filter": "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/nudge_errors\"",
      "comparison": "COMPARISON_GT",
      "thresholdValue": 3,
      "duration": "0s",
      "aggregations": [{ "alignmentPeriod": "600s", "perSeriesAligner": "ALIGN_SUM", "crossSeriesReducer": "REDUCE_SUM" }]
    }
  }],
  "alertStrategy": { "autoClose": "86400s" },
  "notificationChannels": ["$channel"]
}
EOF

for f in ticks errors; do
  name=$(python -c "import json,sys;print(json.load(open(sys.argv[1],encoding='utf-8'))['displayName'])" "$DIR/$f.json")
  if [ -z "$(gcloud alpha monitoring policies list --project $P --filter="displayName=\"$name\"" --format="value(name)")" ]; then
    gcloud alpha monitoring policies create --project $P --policy-from-file="$DIR/$f.json" --format="value(name)"
  else
    echo "exists: $name"
  fi
done
rm -rf "$DIR"
