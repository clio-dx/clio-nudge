#!/usr/bin/env bash
# Everything besides IAM (bootstrap.ps1) and the services (deploy.sh / scheduler.sh) that Nudge
# needs in project clio-nudge. Created by hand on 2026-10-16; safe to re-run (existing ones are
# left alone).   CLOUDSDK_ACTIVE_CONFIG_NAME=nudge-deployer deploy/gcp/infra.sh
set -uo pipefail
P=clio-nudge
R=asia-northeast3
export MSYS2_ARG_CONV_EXCL="*"  # Git Bash: keep "(default)" and paths as they are

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  aiplatform.googleapis.com cloudscheduler.googleapis.com cloudtasks.googleapis.com firestore.googleapis.com \
  secretmanager.googleapis.com iap.googleapis.com logging.googleapis.com monitoring.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com --project $P

# Firestore (Native, Seoul): production and the integration-test database
gcloud firestore databases create --project $P --location=$R --type=firestore-native --database="(default)" 2>/dev/null
gcloud firestore databases create --project $P --location=$R --type=firestore-native --database=nudge-test 2>/dev/null
# Expiring documents
for c in locks markers runs; do
  gcloud firestore fields ttls update expiresAt --project $P --collection-group=$c --enable-ttl --async --quiet
done
# Admin page queries on runs
for db in "(default)" nudge-test; do
  for f in kind userId; do
    gcloud firestore indexes composite create --project $P --database="$db" --collection-group=runs --query-scope=COLLECTION \
      --field-config=field-path=$f,order=ascending --field-config=field-path=at,order=descending --async 2>/dev/null
  done
done

# Background work: Slack replies (fast, many at once) and polls/digests (2 at a time — Slack search is ~20/min)
gcloud tasks queues create nudge-slack --project $P --location=$R --max-concurrent-dispatches=20 \
  --max-dispatches-per-second=20 --max-attempts=2 --min-backoff=2s --max-backoff=10s 2>/dev/null
gcloud tasks queues create nudge-work --project $P --location=$R --max-concurrent-dispatches=2 \
  --max-dispatches-per-second=1 --max-attempts=3 --min-backoff=30s --max-backoff=300s 2>/dev/null

# Slack app secrets (values were copied from the old Vercel deployment by the migrate job)
for s in slack-client-id slack-client-secret slack-signing-secret; do
  gcloud secrets create $s --project $P --replication-policy=user-managed --locations=$R 2>/dev/null
done

# Images
gcloud artifacts repositories create nudge --project $P --repository-format=docker --location=$R 2>/dev/null

echo "done"
