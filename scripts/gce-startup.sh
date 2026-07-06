#!/usr/bin/env bash
set -euo pipefail

# ─── GCE Startup Script ───
# Runs on first boot and every reboot of the Compute Engine instance.
# Installs Docker, clones repo, pulls secrets, starts services.

LOG="/var/log/scopio-startup.log"
exec > >(tee -a "$LOG") 2>&1
echo "$(date) — Scopio startup script begin"

PROJECT="scopio-lab-bpa-demo"
REPO_URL="https://github.com/gilshneorson-tech/scopio_lab_BPA_demo.git"
DEPLOY_DIR="/opt/scopio"

# ─── 1. Install Docker ───
if ! command -v docker &>/dev/null; then
  echo "Installing Docker..."
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable docker
  systemctl start docker
  echo "Docker installed"
else
  echo "Docker already installed"
fi

# ─── 2. Install gcloud (if not present) ───
if ! command -v gcloud &>/dev/null; then
  echo "Installing gcloud CLI..."
  apt-get install -y apt-transport-https
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
  apt-get update -y
  apt-get install -y google-cloud-cli
  echo "gcloud installed"
fi

# ─── 3. Clone or update repo ───
# A dirty tree or diverged history must not abort the whole startup script
# (with set -e, a failed `git pull` used to mean nothing started on boot).
if [ -d "$DEPLOY_DIR/.git" ]; then
  echo "Updating repo..."
  cd "$DEPLOY_DIR"
  if git fetch origin main && git reset --hard origin/main; then
    echo "Repo updated to origin/main"
  else
    echo "WARNING: repo update failed — continuing with the existing checkout"
  fi
else
  echo "Cloning repo..."
  git clone "$REPO_URL" "$DEPLOY_DIR"
  cd "$DEPLOY_DIR"
fi

# ─── 3.5. Download Zoom SDK from GCS (if not already present) ───
SDK_DIR="$DEPLOY_DIR/services/zoom-bot/sdk/zoomsdk"
if [ ! -f "$SDK_DIR/libmeetingsdk.so" ]; then
  echo "Downloading Zoom SDK from GCS..."
  mkdir -p "$SDK_DIR"
  gsutil cp gs://scopio-lab-bpa-demo-sdk/zoom-meeting-sdk-linux_x86_64-7.0.0.tar.gz /tmp/zoomsdk.tar.gz
  tar xzf /tmp/zoomsdk.tar.gz -C "$DEPLOY_DIR/services/zoom-bot/sdk/"
  rm /tmp/zoomsdk.tar.gz
  echo "Zoom SDK extracted to $SDK_DIR"
else
  echo "Zoom SDK already present"
fi

# ─── 4. Pull secrets from Secret Manager → .env ───
# Secret Manager is the source of truth for API keys, but everything the
# operator sets by hand (ZOOM_MEETING_ID, BMA_URL, voice, language, …) MUST
# survive a reboot — regenerating the whole file used to wipe the meeting ID
# minutes before a call.
echo "Pulling secrets from Secret Manager..."

get_secret() {
  gcloud secrets versions access latest --secret="$1" --project="$PROJECT" 2>/dev/null || echo ""
}

ENV_FILE="$DEPLOY_DIR/.env"

# set_env_key KEY VALUE [overwrite]
# overwrite=true  → always replace (secrets from Secret Manager)
# overwrite=false → only append when the key is missing (operator-owned keys)
set_env_key() {
  local key="$1" value="$2" overwrite="${3:-false}"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    if [ "$overwrite" = "true" ] && [ -n "$value" ]; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    fi
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

touch "$ENV_FILE"

# Secrets: always refreshed from Secret Manager
set_env_key ANTHROPIC_API_KEY   "$(get_secret ANTHROPIC_API_KEY)"   true
set_env_key ELEVENLABS_API_KEY  "$(get_secret ELEVENLABS_API_KEY)"  true
set_env_key ZOOM_ACCOUNT_ID     "$(get_secret ZOOM_ACCOUNT_ID)"     true
set_env_key ZOOM_CLIENT_ID      "$(get_secret ZOOM_CLIENT_ID)"      true
set_env_key ZOOM_CLIENT_SECRET  "$(get_secret ZOOM_CLIENT_SECRET)"  true

# Operator-owned settings: seeded once, never overwritten on reboot
set_env_key ZOOM_MEETING_ID ""
set_env_key ZOOM_MEETING_PASSWORD ""
set_env_key ELEVENLABS_VOICE_ID "XrExE9yKIg1WjnnlVkGX"
set_env_key TTS_MODEL "eleven_turbo_v2"
set_env_key GOOGLE_CLOUD_PROJECT "$PROJECT"
set_env_key STT_LANGUAGE "en-US"
set_env_key DEMO_LANGUAGE "en"
set_env_key BMA_URL ""
set_env_key BMA_USERNAME ""
set_env_key BMA_PASSWORD ""
set_env_key AGENT_NAME "Alex"
set_env_key PROSPECT_NAME ""
set_env_key AUTO_DEMO "true"
set_env_key LOG_LEVEL "info"
set_env_key AUDIO_INPUT_FILE ""
set_env_key AUDIO_OUTPUT "file"

chmod 600 "$ENV_FILE"
echo "Secrets refreshed in .env (operator settings preserved)"

# ─── 4.5. Preflight external dependencies (non-fatal, logged) ───
echo "Running preflight checks..."
bash "$DEPLOY_DIR/scripts/preflight.sh" || echo "WARNING: preflight reported failures — check $LOG before the demo"

# ─── 5. Build and start services ───
echo "Starting Docker Compose..."
cd "$DEPLOY_DIR"
docker compose pull 2>/dev/null || true
docker compose up --build -d

echo "$(date) — Scopio startup script complete"
echo "Dashboard: http://$(curl -sf http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip -H 'Metadata-Flavor: Google'):3000"
