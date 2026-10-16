#!/usr/bin/env bash
# Cloud Scheduler → /api/cron/tick every 5 minutes, signed as nudge-runtime.
# Create it only after the Vercel deployment is frozen, or both would send digests.
#   CLOUDSDK_ACTIVE_CONFIG_NAME=nudge-deployer deploy/gcp/scheduler.sh
set -euo pipefail
P=clio-nudge
R=asia-northeast3
URL=https://nudge-233887047351.asia-northeast3.run.app
RUNTIME=nudge-runtime@$P.iam.gserviceaccount.com

args=(--project $P --location $R --schedule "*/5 * * * *" --time-zone "Asia/Seoul"
  --uri "$URL/api/cron/tick" --http-method POST --message-body "{}"
  --oidc-service-account-email $RUNTIME --oidc-token-audience "$URL"
  --attempt-deadline 60s --max-retry-attempts 0)

if gcloud scheduler jobs describe nudge-tick --project $P --location $R >/dev/null 2>&1; then
  gcloud scheduler jobs update http nudge-tick "${args[@]}" --update-headers "Content-Type=application/json"
else
  gcloud scheduler jobs create http nudge-tick "${args[@]}" --headers "Content-Type=application/json"
fi
gcloud scheduler jobs describe nudge-tick --project $P --location $R --format="value(state,schedule)"
