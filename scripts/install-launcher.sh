#!/usr/bin/env bash
set -euo pipefail

# ─── Install Meeting Launcher on GCE host ───
#
# Run this ON the GCE instance (not locally).
# It installs Node.js deps and creates a systemd service.
#
# Usage:
#   gcloud compute ssh scopio-demo-agent --zone=us-central1-a --project=scopio-lab-bpa-demo
#   cd /opt/scopio/services/meeting-launcher
#   bash ../../scripts/install-launcher.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LAUNCHER_DIR="$PROJECT_DIR/services/meeting-launcher"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }

bold "Installing Meeting Launcher..."

# Credentials: never bake a well-known default into the unit. Pass
# LAUNCHER_USER/LAUNCHER_PASS in the environment, or a password is generated
# and printed once.
LAUNCHER_USER="${LAUNCHER_USER:-scopio}"
if [ -z "${LAUNCHER_PASS:-}" ]; then
  LAUNCHER_PASS="$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  bold "Generated launcher password: $LAUNCHER_PASS"
  echo "  (set LAUNCHER_PASS before running this script to choose your own)"
fi

# Install deps
cd "$LAUNCHER_DIR"
npm install --omit=dev

# Create systemd unit
cat > /tmp/meeting-launcher.service <<EOF
[Unit]
Description=Scopio Meeting Launcher
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
WorkingDirectory=$LAUNCHER_DIR
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=LAUNCHER_USER=$LAUNCHER_USER
Environment=LAUNCHER_PASS=$LAUNCHER_PASS
Environment=LAUNCHER_PORT=8080

[Install]
WantedBy=multi-user.target
EOF

sudo mv /tmp/meeting-launcher.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable meeting-launcher
sudo systemctl restart meeting-launcher

green "Meeting Launcher installed and running on port 8080"
echo ""
echo "  Status:  sudo systemctl status meeting-launcher"
echo "  Logs:    sudo journalctl -u meeting-launcher -f"
echo "  Stop:    sudo systemctl stop meeting-launcher"
echo ""

# Check if firewall rule exists
bold "Checking firewall rule..."
if command -v gcloud >/dev/null 2>&1 && gcloud compute firewall-rules describe allow-scopio-launcher --project=scopio-lab-bpa-demo &>/dev/null 2>&1; then
  green "Firewall rule 'allow-scopio-launcher' already exists"
else
  echo "Creating firewall rule for port 8080..."
  echo "Run this from your LOCAL machine (not GCE):"
  echo ""
  echo "  gcloud compute firewall-rules create allow-scopio-launcher \\"
  echo "    --project=scopio-lab-bpa-demo \\"
  echo "    --allow=tcp:8080 \\"
  echo "    --target-tags=scopio-demo \\"
  echo "    --description='Meeting launcher web UI'"
  echo ""
fi
