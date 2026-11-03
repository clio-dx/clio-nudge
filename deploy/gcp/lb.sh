#!/usr/bin/env bash
# nudge.dx.clio.co.kr on the DX team's shared load balancer (project clio-dx: classic Application
# Load Balancer, IP 136.68.100.213, certificate map with *.dx.clio.co.kr). Set up on 2026-11-03;
# safe to re-run (existing pieces are left alone). Needs rights in clio-dx and clio-nudge, and
# grants roles, so run it yourself.   deploy/gcp/lb.sh
#
#   nudge.dx.clio.co.kr/*               -> nudge-backend       -> Cloud Run nudge (clio-nudge), internet NEG
#   nudge.dx.clio.co.kr/admin, /admin/* -> nudge-admin-backend -> Cloud Run nudge-admin (clio-dx), serverless NEG + IAP
# The public service lives in clio-nudge, out of reach of a serverless NEG, so like email-tracker
# it is an internet NEG to its run.app host, sent with that Host header. The admin pages can't go
# that way (Cloud Run drops the x-goog-iap-jwt-assertion header IAP adds, so the app couldn't tell
# who signed in), so nudge-admin runs in clio-dx like ai-store and reads clio-nudge with its own
# service account. IAP's own paths (/_gcp_gatekeeper: the sign-in callback, /_gcp_iap: sign-out)
# go to the IAP backend too. Slack, Cloud Tasks and Cloud Scheduler keep calling the public
# service's run.app URL directly.
set -euo pipefail
DX=clio-dx
DX_NUM=191157507185
R=asia-northeast3
HOST=nudge.dx.clio.co.kr
RUN_HOST=nudge-233887047351.asia-northeast3.run.app
ADMIN=nudge-admin-backend
ADMIN_SA=nudge-admin-runtime@$DX.iam.gserviceaccount.com

# Public service. Each step checks its own result, so a run that stopped halfway gets finished.
gcloud compute network-endpoint-groups describe nudge-neg --global --project $DX >/dev/null 2>&1 ||
  gcloud compute network-endpoint-groups create nudge-neg --global --network-endpoint-type=internet-fqdn-port \
    --default-port=443 --project $DX
if [[ $(gcloud compute network-endpoint-groups list-network-endpoints nudge-neg --global --project $DX \
    --format="value(networkEndpoint.fqdn)") != *"$RUN_HOST"* ]]; then
  gcloud compute network-endpoint-groups update nudge-neg --global --add-endpoint="fqdn=$RUN_HOST,port=443" --project $DX
fi
gcloud compute backend-services describe nudge-backend --global --project $DX >/dev/null 2>&1 ||
  gcloud compute backend-services create nudge-backend --global --load-balancing-scheme=EXTERNAL --protocol=HTTPS \
    --timeout=60s --custom-request-header="Host: $RUN_HOST" --project $DX
if [[ $(gcloud compute backend-services describe nudge-backend --global --project $DX \
    --format="value(backends[].group)") != *"/nudge-neg"* ]]; then
  gcloud compute backend-services add-backend nudge-backend --global --network-endpoint-group=nudge-neg \
    --global-network-endpoint-group --project $DX
fi

# Admin pages: their own service account, which may only read clio-nudge's Firestore and logs
gcloud iam service-accounts describe $ADMIN_SA --project $DX >/dev/null 2>&1 ||
  gcloud iam service-accounts create nudge-admin-runtime --project $DX \
    --display-name "Nudge admin pages (Cloud Run nudge-admin, reads clio-nudge)"
for role in roles/datastore.viewer roles/logging.viewer; do
  gcloud projects add-iam-policy-binding clio-nudge --member "serviceAccount:$ADMIN_SA" --role $role \
    --condition None --format none
done
# Cloud Run in clio-dx pulls the image deploy.sh pushes to clio-nudge's registry
gcloud artifacts repositories add-iam-policy-binding nudge --location $R --project clio-nudge --format none \
  --member "serviceAccount:service-$DX_NUM@serverless-robot-prod.iam.gserviceaccount.com" --role roles/artifactregistry.reader
# The service (deploy.sh replaces the placeholder image, the settings stay): only the load balancer
# reaches it, and only IAP may invoke it
gcloud run services describe nudge-admin --project $DX --region $R >/dev/null 2>&1 ||
  gcloud run deploy nudge-admin --project $DX --region $R --image us-docker.pkg.dev/cloudrun/container/hello \
    --service-account $ADMIN_SA --ingress internal-and-cloud-load-balancing --no-allow-unauthenticated --quiet
gcloud beta services identity create --service iap.googleapis.com --project $DX >/dev/null
gcloud run services add-iam-policy-binding nudge-admin --project $DX --region $R --format none \
  --member "serviceAccount:service-$DX_NUM@gcp-sa-iap.iam.gserviceaccount.com" --role roles/run.invoker
gcloud compute network-endpoint-groups describe nudge-admin-neg --region $R --project $DX >/dev/null 2>&1 ||
  gcloud compute network-endpoint-groups create nudge-admin-neg --region $R --network-endpoint-type=serverless \
    --cloud-run-service=nudge-admin --project $DX
gcloud compute backend-services describe $ADMIN --global --project $DX >/dev/null 2>&1 ||
  gcloud compute backend-services create $ADMIN --global --load-balancing-scheme=EXTERNAL --protocol=HTTP --project $DX
if [[ $(gcloud compute backend-services describe $ADMIN --global --project $DX \
    --format="value(backends[].group)") != *"/nudge-admin-neg"* ]]; then
  gcloud compute backend-services add-backend $ADMIN --global --network-endpoint-group=nudge-admin-neg \
    --network-endpoint-group-region=$R --project $DX
fi
# Google sign-in on the load balancer, then only these people
gcloud compute backend-services update $ADMIN --global --iap=enabled --project $DX
for m in group:team-dx@clio.co.kr user:yoonchul@clio.co.kr; do
  gcloud iap web add-iam-policy-binding --project $DX --resource-type=backend-services --service=$ADMIN \
    --member=$m --role=roles/iap.httpsResourceAccessor --format=none
done

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
- defaultService: {services}/nudge-backend
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
# The app accepts IAP's signed header only for this audience: IAP_AUDIENCE in deploy.sh
echo "audience: /projects/$DX_NUM/global/backendServices/$(
  gcloud compute backend-services describe $ADMIN --global --project $DX --format='value(id)')"
