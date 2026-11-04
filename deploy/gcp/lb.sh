#!/usr/bin/env bash
# Nudge on the DX team's shared load balancer (project clio-dx: classic Application Load Balancer,
# IP 136.68.100.213, certificate map with *.dx.clio.co.kr). Set up on 2026-11-03/04; safe to re-run
# (existing pieces are left alone). Needs rights in clio-dx and clio-nudge, and grants roles, so
# run it yourself.   deploy/gcp/lb.sh
#
#   nudge.dx.clio.co.kr/*               -> nudge-run-backend   -> Cloud Run nudge (clio-dx)
#   nudge.dx.clio.co.kr/admin, /admin/* -> nudge-admin-backend -> Cloud Run nudge-admin (clio-dx), IAP
# Both services run in clio-dx like ai-store, behind serverless NEGs, so the load balancer is the
# only way in. Their data stays in clio-nudge: Firestore, the task queues and the scheduler (their
# calls stay signed as nudge-runtime@clio-nudge), secrets, Vertex AI and the image registry. Each
# service has its own account here with what it needs there (the org doesn't allow attaching
# clio-nudge's accounts to services in other projects). IAP's own paths (/_gcp_gatekeeper: the
# sign-in callback, /_gcp_iap: sign-out) go to the IAP backend too. A log sink copies both
# services' lines into clio-nudge, where the admin logs page reads them.
set -euo pipefail
DX=clio-dx
DX_NUM=191157507185
R=asia-northeast3
HOST=nudge.dx.clio.co.kr
PUBLIC=nudge-run-backend
ADMIN=nudge-admin-backend
PUBLIC_SA=nudge-runtime@$DX.iam.gserviceaccount.com
ADMIN_SA=nudge-admin-runtime@$DX.iam.gserviceaccount.com
PLACEHOLDER=us-docker.pkg.dev/cloudrun/container/hello

grant() { # member, role on clio-nudge
  gcloud projects add-iam-policy-binding clio-nudge --member "$1" --role "$2" --condition None --format none
}

# Accounts: the public service uses clio-nudge's data, the admin pages may only read it
gcloud iam service-accounts describe $PUBLIC_SA --project $DX >/dev/null 2>&1 ||
  gcloud iam service-accounts create nudge-runtime --project $DX \
    --display-name "Nudge public service (Cloud Run nudge, uses clio-nudge data)"
gcloud iam service-accounts describe $ADMIN_SA --project $DX >/dev/null 2>&1 ||
  gcloud iam service-accounts create nudge-admin-runtime --project $DX \
    --display-name "Nudge admin pages (Cloud Run nudge-admin, reads clio-nudge)"
for role in roles/datastore.user roles/secretmanager.secretAccessor roles/aiplatform.user roles/cloudtasks.enqueuer; do
  grant "serviceAccount:$PUBLIC_SA" $role
done
# Tasks stay signed as nudge-runtime@clio-nudge, so the public service has to be able to act as it
gcloud iam service-accounts add-iam-policy-binding nudge-runtime@clio-nudge.iam.gserviceaccount.com \
  --project clio-nudge --member "serviceAccount:$PUBLIC_SA" --role roles/iam.serviceAccountUser --format none
for role in roles/datastore.viewer roles/logging.viewer; do
  grant "serviceAccount:$ADMIN_SA" $role
done
# Cloud Run here pulls the image deploy.sh pushes to clio-nudge's registry
gcloud artifacts repositories add-iam-policy-binding nudge --location $R --project clio-nudge --format none \
  --member "serviceAccount:service-$DX_NUM@serverless-robot-prod.iam.gserviceaccount.com" --role roles/artifactregistry.reader
gcloud services enable cloudtasks.googleapis.com --project $DX

# The services (deploy.sh replaces the placeholder image, the settings stay). Slack can't sign in
# to Google, so the public one has no invoker check; only IAP may invoke the admin one.
gcloud run services describe nudge --project $DX --region $R >/dev/null 2>&1 ||
  gcloud run deploy nudge --project $DX --region $R --image $PLACEHOLDER --service-account $PUBLIC_SA \
    --ingress internal-and-cloud-load-balancing --no-invoker-iam-check --quiet
gcloud run services describe nudge-admin --project $DX --region $R >/dev/null 2>&1 ||
  gcloud run deploy nudge-admin --project $DX --region $R --image $PLACEHOLDER --service-account $ADMIN_SA \
    --ingress internal-and-cloud-load-balancing --no-allow-unauthenticated --quiet
gcloud beta services identity create --service iap.googleapis.com --project $DX >/dev/null
gcloud run services add-iam-policy-binding nudge-admin --project $DX --region $R --format none \
  --member "serviceAccount:service-$DX_NUM@gcp-sa-iap.iam.gserviceaccount.com" --role roles/run.invoker

# Serverless NEGs and backends. Each step checks its own result, so a run that stopped halfway gets finished.
backend() { # backend service, NEG, Cloud Run service
  gcloud compute network-endpoint-groups describe $2 --region $R --project $DX >/dev/null 2>&1 ||
    gcloud compute network-endpoint-groups create $2 --region $R --network-endpoint-type=serverless \
      --cloud-run-service=$3 --project $DX
  gcloud compute backend-services describe $1 --global --project $DX >/dev/null 2>&1 ||
    gcloud compute backend-services create $1 --global --load-balancing-scheme=EXTERNAL --protocol=HTTP --project $DX
  if [[ $(gcloud compute backend-services describe $1 --global --project $DX \
      --format="value(backends[].group)") != *"/$2"* ]]; then
    gcloud compute backend-services add-backend $1 --global --network-endpoint-group=$2 \
      --network-endpoint-group-region=$R --project $DX
  fi
}
backend $PUBLIC nudge-run-neg nudge
backend $ADMIN nudge-admin-neg nudge-admin
# Admin pages: Google sign-in on the load balancer, then only these people
gcloud compute backend-services update $ADMIN --global --iap=enabled --project $DX
for m in group:team-dx@clio.co.kr user:yoonchul@clio.co.kr; do
  gcloud iap web add-iam-policy-binding --project $DX --resource-type=backend-services --service=$ADMIN \
    --member=$m --role=roles/iap.httpsResourceAccessor --format=none
done

# Copy both services' log lines into clio-nudge's _Default bucket for the admin logs page
gcloud logging sinks describe nudge-logs --project $DX >/dev/null 2>&1 ||
  gcloud logging sinks create nudge-logs logging.googleapis.com/projects/clio-nudge/locations/global/buckets/_Default \
    --project $DX --log-filter='resource.type="cloud_run_revision" AND resource.labels.service_name=("nudge" OR "nudge-admin")'
grant "$(gcloud logging sinks describe nudge-logs --project $DX --format='value(writerIdentity)')" roles/logging.bucketWriter

# Host rule, through export/import so the shared map is validated before it changes
if [[ $(gcloud compute url-maps describe dx-lb-urlmap --global --project $DX --format="value(hostRules[].hosts)") != *"$HOST"* ]]; then
  map=$(mktemp)
  gcloud compute url-maps export dx-lb-urlmap --global --project $DX --destination="$map"
  python - "$map" "$HOST" <<'EOF'
import sys
path, host = sys.argv[1:]
text = open(path, encoding="utf-8").read().replace("\r\n", "\n")
services = "https://www.googleapis.com/compute/v1/projects/clio-dx/global/backendServices"
text = text.replace("hostRules:\n", f"hostRules:\n- hosts:\n  - {host}\n  pathMatcher: nudge-matcher\n", 1)
text = text.replace("pathMatchers:\n", f"""pathMatchers:
- defaultService: {services}/nudge-run-backend
  name: nudge-matcher
  pathRules:
  - paths:
    - /admin
    - /admin/*
    - /_gcp_gatekeeper/*
    - /_gcp_iap/*
    service: {services}/nudge-admin-backend
""", 1)
open(path, "w", encoding="utf-8", newline="\n").write(text)
EOF
  gcloud compute url-maps validate --global --project $DX --source="$map"
  gcloud compute url-maps import dx-lb-urlmap --global --project $DX --source="$map" --quiet
  rm -f "$map"
fi
gcloud compute url-maps describe dx-lb-urlmap --global --project $DX \
  --format="yaml(pathMatchers.filter(name:nudge-matcher))"
# The app accepts IAP's signed header only for this audience (deploy.sh looks it up)
echo "audience: /projects/$DX_NUM/global/backendServices/$(
  gcloud compute backend-services describe $ADMIN --global --project $DX --format='value(id)')"
