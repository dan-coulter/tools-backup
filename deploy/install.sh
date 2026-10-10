#!/usr/bin/env bash
# One-time setup on plex.local. From the repo:
#   sudo bash deploy/install.sh
# Builds the app, then installs and starts the web UI (port 4760), the daily
# backup timer and the weekly restore-test timer. Everything runs as you, from
# this checkout. Re-run after pulling changes to rebuild and restart.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo: sudo bash deploy/install.sh" >&2
  exit 1
fi

OWNER="${SUDO_USER:?Run it with sudo from your own account}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -f "$SRC/.env.local" ]]; then
  echo "Missing $SRC/.env.local (AWS keys, see .env.example)" >&2
  exit 1
fi

echo "==> Build"
sudo -u "$OWNER" bash -c "cd '$SRC' && npm ci && npm run build"

echo "==> systemd units"
for unit in tools-backup.service tools-backup-run.service tools-backup-run.timer \
  tools-backup-verify.service tools-backup-verify.timer; do
  install -m 0644 "$SRC/deploy/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now tools-backup-run.timer tools-backup-verify.timer
systemctl enable tools-backup.service
systemctl restart tools-backup.service

echo "==> Done"
systemctl --no-pager status tools-backup.service | head -5
systemctl --no-pager list-timers 'tools-backup-*'
echo "UI: http://plex.local:4760"
