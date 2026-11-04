#!/usr/bin/env bash
# Builds the image locally, pushes it to Artifact Registry and deploys both Cloud Run services:
# nudge (project clio-nudge) and nudge-admin (project clio-dx, behind the DX load balancer).
#   deploy/gcp/deploy.sh [public|admin|all]   (as whoever gcloud is logged in as)
# Deploy both (the default) unless they already run the same build: on nudge.dx.clio.co.kr the
# admin pages load their JS/CSS (/_next/static) through the public service.
set -euo pipefail
# Git Bash on Windows would turn the "/projects/..." audience into a Windows path
export MSYS2_ARG_CONV_EXCL="NUDGE_ROLE="
cd "$(dirname "$0")/../.."

P=clio-nudge
R=asia-northeast3
# What people see (landing page, Add to Slack, links in DMs, admin pages), on the DX load balancer (lb.sh)
URL=https://nudge.dx.clio.co.kr
# Cloud Run itself: Slack, Cloud Tasks and Cloud Scheduler call it directly (also the tasks' token audience)
RUN_URL=https://nudge-233887047351.asia-northeast3.run.app
RUNTIME=nudge-runtime@$P.iam.gserviceaccount.com
# Admin pages: in clio-dx next to the load balancer, reading clio-nudge's Firestore and logs (lb.sh)
ADMIN_P=clio-dx
ADMIN_RUNTIME=nudge-admin-runtime@$ADMIN_P.iam.gserviceaccount.com
TAG=$(git rev-parse --short HEAD)$( [ -n "$(git status --porcelain)" ] && echo "-dirty$(date +%H%M%S)" || true )
IMG=$R-docker.pkg.dev/$P/nudge/app:$TAG
WHICH=${1:-all}

if [ "$WHICH" = all ] || [ "$WHICH" = admin ]; then
  # IAP on the load balancer's nudge-admin-backend signs admin requests for this audience. Looked
  # up (before anything is built or deployed) because the id changes if lb.sh recreates it.
  IAP_AUDIENCE=/projects/191157507185/global/backendServices/$(gcloud compute backend-services describe \
    nudge-admin-backend --global --project $ADMIN_P --format="value(id)")
fi

gcloud auth configure-docker $R-docker.pkg.dev --quiet >/dev/null
docker build --build-arg NEXT_PUBLIC_APP_URL=$URL -t "$IMG" .
docker push "$IMG"

COMMON_ENV="NUDGE_TASKS=cloud,NUDGE_SECRETS=gcp,GOOGLE_CLOUD_PROJECT=$P,APP_URL=$URL,NUDGE_SELF_URL=$RUN_URL,NEXT_PUBLIC_APP_URL=$URL"

if [ "$WHICH" = all ] || [ "$WHICH" = public ]; then
  # min 1 instance: no cold start inside Slack's 3-second window (request billing, so it idles cheaply)
  gcloud run deploy nudge --project $P --region $R --image "$IMG" --service-account $RUNTIME \
    --cpu 1 --memory 1Gi --concurrency 40 --min-instances 1 --max-instances 10 --timeout 1800 \
    --cpu-boost --update-env-vars "NUDGE_ROLE=public,$COMMON_ENV" --quiet
fi
if [ "$WHICH" = all ] || [ "$WHICH" = admin ]; then
  # Only the load balancer reaches it, and only IAP may invoke it (lb.sh), like ai-store
  gcloud run deploy nudge-admin --project $ADMIN_P --region $R --image "$IMG" --service-account $ADMIN_RUNTIME \
    --cpu 1 --memory 1Gi --concurrency 20 --min-instances 0 --max-instances 2 --timeout 300 \
    --ingress internal-and-cloud-load-balancing --no-allow-unauthenticated \
    --update-env-vars "NUDGE_ROLE=admin,NUDGE_IAP_AUDIENCE=$IAP_AUDIENCE,$COMMON_ENV" --quiet
fi
echo "deployed $IMG"
[ "$WHICH" = all ] || echo "only $WHICH was deployed: the admin pages need both services on the same build" >&2
