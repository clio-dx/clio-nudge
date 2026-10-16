# One-time IAM setup for Nudge on GCP (project clio-nudge, Seoul). Run it yourself, once:
#   powershell -ExecutionPolicy Bypass -File deploy\gcp\bootstrap.ps1
# It grants roles and creates a deployer key, so it isn't run by automation.
#
#  - nudge-deployer: deploys tonight's migration. Its key lives outside the repo and is deleted
#    after the migration (gcloud iam service-accounts keys delete ...).
#  - nudge-runtime: what the Cloud Run services run as.
#  - nudge (public, Slack calls it): the org blocks allUsers, so the invoker IAM check is turned
#    off instead and the app verifies every request itself (Slack signatures, Google OIDC tokens).
#  - nudge-admin (admin page): behind IAP, only team-dx@ and yoonchul@ can open it.

$P = "clio-nudge"
$R = "asia-northeast3"
$NUM = (gcloud projects describe $P --format="value(projectNumber)")
$DEPLOYER = "nudge-deployer@$P.iam.gserviceaccount.com"
$RUNTIME = "nudge-runtime@$P.iam.gserviceaccount.com"
$KEYDIR = Join-Path $env:USERPROFILE ".config\clio-nudge"
$KEY = Join-Path $KEYDIR "nudge-deployer.json"
$PLACEHOLDER = "us-docker.pkg.dev/cloudrun/container/hello"

Write-Host "== service accounts"
gcloud iam service-accounts create nudge-deployer --project $P --display-name "Nudge deployer (temporary key, delete after migration)"
gcloud iam service-accounts create nudge-runtime --project $P --display-name "Nudge runtime (Cloud Run)"

Write-Host "== deployer: owner of this project only"
gcloud projects add-iam-policy-binding $P --member "serviceAccount:$DEPLOYER" --role roles/owner --condition None --format none

Write-Host "== runtime roles"
# secretVersionAdder: the one-off migration copies the Slack app secrets from Vercel into Secret Manager
foreach ($role in "roles/datastore.user", "roles/aiplatform.user", "roles/secretmanager.secretAccessor", "roles/secretmanager.secretVersionAdder",
                  "roles/cloudtasks.enqueuer", "roles/logging.viewer", "roles/logging.logWriter", "roles/monitoring.metricWriter") {
  gcloud projects add-iam-policy-binding $P --member "serviceAccount:$RUNTIME" --role $role --condition None --format none
}
# Cloud Tasks / Scheduler sign their OIDC tokens as the runtime account
gcloud iam service-accounts add-iam-policy-binding $RUNTIME --project $P --member "serviceAccount:$RUNTIME" --role roles/iam.serviceAccountUser --format none

Write-Host "== placeholder services (tonight's deploys replace the image, settings stay)"
gcloud run deploy nudge --project $P --region $R --image $PLACEHOLDER --service-account $RUNTIME --no-invoker-iam-check --quiet
gcloud beta services identity create --service iap.googleapis.com --project $P
gcloud beta run deploy nudge-admin --project $P --region $R --image $PLACEHOLDER --service-account $RUNTIME --no-allow-unauthenticated --iap --quiet
gcloud run services add-iam-policy-binding nudge-admin --project $P --region $R --member "serviceAccount:service-$NUM@gcp-sa-iap.iam.gserviceaccount.com" --role roles/run.invoker --format none

Write-Host "== who may open the admin page"
gcloud beta iap web add-iam-policy-binding --project $P --region $R --resource-type cloud-run --service nudge-admin --member "user:yoonchul@clio.co.kr" --role roles/iap.httpsResourceAccessor
# Fails harmlessly if team-dx@ isn't a Google Group
gcloud beta iap web add-iam-policy-binding --project $P --region $R --resource-type cloud-run --service nudge-admin --member "group:team-dx@clio.co.kr" --role roles/iap.httpsResourceAccessor

Write-Host "== deployer key + its own gcloud configuration (your default login is untouched)"
New-Item -ItemType Directory -Force $KEYDIR | Out-Null
gcloud iam service-accounts keys create $KEY --iam-account $DEPLOYER --project $P
gcloud config configurations create nudge-deployer --no-activate
gcloud auth activate-service-account $DEPLOYER --key-file $KEY --project $P --configuration nudge-deployer
gcloud config set project $P --configuration nudge-deployer
gcloud config set run/region $R --configuration nudge-deployer

Write-Host "== check"
gcloud run services list --project $P --configuration nudge-deployer --format "table(metadata.name,status.url)"
Write-Host "DONE"
