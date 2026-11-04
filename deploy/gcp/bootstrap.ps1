# One-time IAM setup for Nudge on GCP (project clio-nudge, Seoul). Run it yourself, once:
#   powershell -ExecutionPolicy Bypass -File deploy\gcp\bootstrap.ps1
# It grants roles and creates a deployer key, so it isn't run by automation.
#
#  - nudge-deployer: deploys tonight's migration. Its key lives outside the repo and is deleted
#    after the migration (gcloud iam service-accounts keys delete ...).
#  - nudge-runtime: what the Cloud Run services ran as. Since 2026-11-04 both services run in
#    project clio-dx behind the DX load balancer with their own accounts (deploy/gcp/lb.sh), so it
#    only signs the Cloud Tasks and Cloud Scheduler calls now, and no service is created here.

$P = "clio-nudge"
$R = "asia-northeast3"
$DEPLOYER = "nudge-deployer@$P.iam.gserviceaccount.com"
$RUNTIME = "nudge-runtime@$P.iam.gserviceaccount.com"
$KEYDIR = Join-Path $env:USERPROFILE ".config\clio-nudge"
$KEY = Join-Path $KEYDIR "nudge-deployer.json"

Write-Host "== service accounts"
gcloud iam service-accounts create nudge-deployer --project $P --display-name "Nudge deployer (temporary key, delete after migration)"
gcloud iam service-accounts create nudge-runtime --project $P --display-name "Nudge runtime (Cloud Run)"

Write-Host "== deployer: owner of this project only"
gcloud projects add-iam-policy-binding $P --member "serviceAccount:$DEPLOYER" --role roles/owner --condition None --format none

Write-Host "== runtime roles"
# (The one-off Vercel import also had roles/secretmanager.secretVersionAdder; removed after the cutover.)
foreach ($role in "roles/datastore.user", "roles/aiplatform.user", "roles/secretmanager.secretAccessor",
                  "roles/cloudtasks.enqueuer", "roles/logging.viewer", "roles/logging.logWriter", "roles/monitoring.metricWriter") {
  gcloud projects add-iam-policy-binding $P --member "serviceAccount:$RUNTIME" --role $role --condition None --format none
}
# Cloud Tasks / Scheduler sign their OIDC tokens as the runtime account
gcloud iam service-accounts add-iam-policy-binding $RUNTIME --project $P --member "serviceAccount:$RUNTIME" --role roles/iam.serviceAccountUser --format none

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
