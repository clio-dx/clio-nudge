#!/usr/bin/env bash
# nudge.dx.clio.co.kr on the DX team's shared load balancer (project clio-dx: classic Application
# Load Balancer, IP 136.68.100.213, certificate map with *.dx.clio.co.kr). Set up on 2026-11-03;
# safe to re-run (existing pieces are left alone). Needs rights in clio-dx.   deploy/gcp/lb.sh
#
#   nudge.dx.clio.co.kr/*                -> nudge-backend -> Cloud Run nudge (project clio-nudge)
#   nudge.dx.clio.co.kr/admin, /admin/*  -> 302 to the nudge-admin run.app URL (Cloud Run IAP)
# The service lives in another project, out of reach of a serverless NEG, so like email-tracker it
# is an internet NEG to its run.app host, sent with that Host header. The admin pages can't go the
# same way: Cloud Run drops the x-goog-iap-jwt-assertion header that IAP on the load balancer adds,
# so the app could never tell who signed in. Slack, Cloud Tasks and Cloud Scheduler keep calling
# run.app directly.
set -euo pipefail
DX=clio-dx
HOST=nudge.dx.clio.co.kr
RUN_HOST=nudge-233887047351.asia-northeast3.run.app
ADMIN_HOST=nudge-admin-233887047351.asia-northeast3.run.app

# Each step checks its own result, so a run that stopped halfway gets finished
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

# The host rule goes in through export/import: add-path-matcher can't add a redirect rule
if [[ $(gcloud compute url-maps describe dx-lb-urlmap --global --project $DX --format="value(hostRules[].hosts)") != *"$HOST"* ]]; then
  map=$(mktemp)
  gcloud compute url-maps export dx-lb-urlmap --global --project $DX --destination="$map"
  python - "$map" "$HOST" "$ADMIN_HOST" <<'EOF'
import sys
path, host, admin_host = sys.argv[1:]
text = open(path, encoding="utf-8").read().replace("\r\n", "\n")
backend = "https://www.googleapis.com/compute/v1/projects/clio-dx/global/backendServices/nudge-backend"
text = text.replace("hostRules:\n", f"hostRules:\n- hosts:\n  - {host}\n  pathMatcher: nudge-matcher\n", 1)
text = text.replace("pathMatchers:\n", f"""pathMatchers:
- defaultService: {backend}
  name: nudge-matcher
  pathRules:
  - paths:
    - /admin
    - /admin/*
    urlRedirect:
      hostRedirect: {admin_host}
      httpsRedirect: true
      redirectResponseCode: FOUND
      stripQuery: false
""", 1)
open(path, "w", encoding="utf-8", newline="\n").write(text)
EOF
  gcloud compute url-maps validate --global --project $DX --source="$map"
  gcloud compute url-maps import dx-lb-urlmap --global --project $DX --source="$map" --quiet
  rm -f "$map"
fi
gcloud compute url-maps describe dx-lb-urlmap --global --project $DX \
  --format="yaml(pathMatchers.filter(name:nudge-matcher))"
