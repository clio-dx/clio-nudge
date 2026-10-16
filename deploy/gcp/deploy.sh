#!/usr/bin/env bash
# Builds the image locally, pushes it to Artifact Registry and deploys both Cloud Run services.
#   CLOUDSDK_ACTIVE_CONFIG_NAME=nudge-deployer deploy/gcp/deploy.sh [public|admin|all]
set -euo pipefail
# Git Bash on Windows would turn the "/projects/..." audience into a Windows path
export MSYS2_ARG_CONV_EXCL="NUDGE_ROLE="
cd "$(dirname "$0")/../.."

P=clio-nudge
R=asia-northeast3
URL=https://nudge-233887047351.asia-northeast3.run.app
RUNTIME=nudge-runtime@$P.iam.gserviceaccount.com
TAG=$(git rev-parse --short HEAD)$( [ -n "$(git status --porcelain)" ] && echo "-dirty$(date +%H%M%S)" || true )
IMG=$R-docker.pkg.dev/$P/nudge/app:$TAG
WHICH=${1:-all}

gcloud auth configure-docker $R-docker.pkg.dev --quiet >/dev/null
docker build --build-arg NEXT_PUBLIC_APP_URL=$URL -t "$IMG" .
docker push "$IMG"

COMMON_ENV="NUDGE_TASKS=cloud,NUDGE_SECRETS=gcp,GOOGLE_CLOUD_PROJECT=$P,APP_URL=$URL,NUDGE_SELF_URL=$URL,NEXT_PUBLIC_APP_URL=$URL"

if [ "$WHICH" = all ] || [ "$WHICH" = public ]; then
  # min 1 instance: no cold start inside Slack's 3-second window (request billing, so it idles cheaply)
  gcloud run deploy nudge --project $P --region $R --image "$IMG" --service-account $RUNTIME \
    --cpu 1 --memory 1Gi --concurrency 40 --min-instances 1 --max-instances 10 --timeout 1800 \
    --cpu-boost --update-env-vars "NUDGE_ROLE=public,$COMMON_ENV" --quiet
fi
if [ "$WHICH" = all ] || [ "$WHICH" = admin ]; then
  gcloud run deploy nudge-admin --project $P --region $R --image "$IMG" --service-account $RUNTIME \
    --cpu 1 --memory 1Gi --concurrency 20 --min-instances 0 --max-instances 2 --timeout 300 \
    --update-env-vars "NUDGE_ROLE=admin,NUDGE_IAP_AUDIENCE=/projects/233887047351/locations/asia-northeast3/services/nudge-admin,$COMMON_ENV" --quiet
fi
echo "deployed $IMG"
