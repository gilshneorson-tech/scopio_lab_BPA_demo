#!/usr/bin/env bash
set -euo pipefail

# ─── Deploy ScopioLabs BPA Demo Agent to GCP Compute Engine ───
#
# Prerequisites:
#   - gcloud CLI authenticated
#   - GCP project: scopio-lab-bpa-demo (billing enabled)
#   - Service account: scopio-demo-agent@scopio-lab-bpa-demo.iam.gserviceaccount.com
#   - Secrets stored in Secret Manager
#   - Firestore database created
#
# Usage: bash scripts/deploy-gcp.sh

PROJECT="scopio-lab-bpa-demo"
ZONE="us-central1-a"
INSTANCE_NAME="scopio-demo-agent"
MACHINE_TYPE="n2-standard-8"
SA="scopio-demo-agent@${PROJECT}.iam.gserviceaccount.com"
REPO_URL="https://github.com/gilshneorson-tech/scopio_lab_BPA_demo.git"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }

bold "═══════════════════════════════════════════"
bold "  ScopioLabs BPA Demo — GCP Deployment"
bold "═══════════════════════════════════════════"
echo ""

# ─── 1. Create firewall rule ───
bold "1. Configuring firewall"
gcloud compute firewall-rules create allow-scopio-dashboard \
  --project="$PROJECT" \
  --allow=tcp:3000 \
  --target-tags=scopio-demo \
  --description="Allow HTTP access to Scopio demo dashboard" \
  2>/dev/null || echo "   Firewall rule already exists"
green "   Done"
echo ""

# ─── 2. Create GCE instance ───
bold "2. Creating Compute Engine instance"

# Check if instance already exists
if gcloud compute instances describe "$INSTANCE_NAME" --zone="$ZONE" --project="$PROJECT" &>/dev/null; then
  echo "   Instance already exists. Delete it first with:"
  echo "   gcloud compute instances delete $INSTANCE_NAME --zone=$ZONE --project=$PROJECT"
  echo ""
  read -p "   Delete and recreate? (y/N) " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    gcloud compute instances delete "$INSTANCE_NAME" --zone="$ZONE" --project="$PROJECT" --quiet
  else
    echo "   Skipping instance creation"
  fi
fi

gcloud compute instances create "$INSTANCE_NAME" \
  --project="$PROJECT" \
  --zone="$ZONE" \
  --machine-type="$MACHINE_TYPE" \
  --boot-disk-size=100GB \
  --boot-disk-type=pd-ssd \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --service-account="$SA" \
  --scopes=cloud-platform \
  --tags=scopio-demo \
  --metadata-from-file=startup-script=scripts/gce-startup.sh \
  2>&1

green "   Instance created"
echo ""

# ─── 3. Wait for instance to be ready ───
bold "3. Waiting for instance to boot"
sleep 10

for i in $(seq 1 30); do
  STATUS=$(gcloud compute instances describe "$INSTANCE_NAME" \
    --zone="$ZONE" --project="$PROJECT" \
    --format="get(status)" 2>/dev/null || echo "UNKNOWN")
  if [ "$STATUS" = "RUNNING" ]; then
    break
  fi
  echo "   Status: $STATUS (attempt $i/30)"
  sleep 5
done

EXTERNAL_IP=$(gcloud compute instances describe "$INSTANCE_NAME" \
  --zone="$ZONE" --project="$PROJECT" \
  --format="get(networkInterfaces[0].accessConfigs[0].natIP)")

green "   Instance running at $EXTERNAL_IP"
echo ""

# ─── 4. Wait for Docker Compose to start ───
bold "4. Waiting for services to start (this takes 3-5 minutes on first deploy)"
echo "   The startup script installs Docker, clones the repo, and runs docker compose."
echo "   Monitor progress with:"
echo "   gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT -- tail -f /var/log/syslog"
echo ""

for i in $(seq 1 60); do
  if curl -sf "http://${EXTERNAL_IP}:3000/health" &>/dev/null; then
    green "   Services are up!"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "   Timeout waiting for services. SSH in to debug:"
    echo "   gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT"
    exit 1
  fi
  printf "   Waiting... (%d/60)\r" "$i"
  sleep 10
done
echo ""

# ─── 5. Summary ───
bold "═══════════════════════════════════════════"
bold "  Deployment Complete"
bold "═══════════════════════════════════════════"
echo ""
echo "  Dashboard:  http://${EXTERNAL_IP}:3000"
echo "  Health:     http://${EXTERNAL_IP}:3000/health"
echo ""
echo "  SSH:        gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT"
echo "  Logs:       gcloud compute ssh $INSTANCE_NAME --zone=$ZONE --project=$PROJECT -- docker compose -f /opt/scopio/docker-compose.yml logs -f"
echo "  Stop:       gcloud compute instances stop $INSTANCE_NAME --zone=$ZONE --project=$PROJECT"
echo "  Delete:     gcloud compute instances delete $INSTANCE_NAME --zone=$ZONE --project=$PROJECT"
echo ""
