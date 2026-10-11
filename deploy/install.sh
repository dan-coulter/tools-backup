#!/usr/bin/env bash
# One-time setup on plex.local. From the development checkout:
#   sudo bash deploy/install.sh
# Clones the repo into /opt/tools-backup (owned by you) and moves production
# there: the database (data/tools-backup.db) and .env.local are copied from
# this checkout the first time. Installs the web UI (port 4760), the daily
# backup timer, the weekly restore-test timer and the path unit that lets
# deploys restart the UI without sudo, then deploys main. After this, deploys
# are `bash /opt/tools-backup/deploy/update.sh` or Jenkins. Safe to run again.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo: sudo bash deploy/install.sh" >&2
  exit 1
fi

OWNER="${SUDO_USER:?Run it with sudo from your own account}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/tools-backup
REPO=https://github.com/dan-coulter/tools-backup.git

if [[ $SRC == "$APP" ]]; then
  echo "Run this from the development checkout, not $APP." >&2
  exit 1
fi

echo "==> App checkout in $APP"
if [[ ! -d "$APP/.git" ]]; then
  install -d -o "$OWNER" -g "$OWNER" "$APP"
  sudo -u "$OWNER" -H git clone "$REPO" "$APP"
fi
install -d -o "$OWNER" -g "$OWNER" "$APP/.deploy" "$APP/data"
if [[ ! -f "$APP/.env.local" ]]; then
  if [[ ! -f "$SRC/.env.local" ]]; then
    echo "Missing $SRC/.env.local (AWS keys, see .env.example)" >&2
    exit 1
  fi
  install -m 0600 -o "$OWNER" -g "$OWNER" "$SRC/.env.local" "$APP/.env.local"
fi
if [[ ! -d "$APP/node_modules" ]]; then
  # The database copy below needs better-sqlite3.
  sudo -u "$OWNER" -H bash -c "cd '$APP' && npm ci --no-audit --no-fund"
fi

if [[ ! -f "$APP/data/tools-backup.db" && -f "$SRC/data/tools-backup.db" ]]; then
  echo "==> Move the database to $APP/data"
  # Nothing may write it while it's copied.
  systemctl stop tools-backup-run.timer tools-backup-verify.timer tools-backup.service 2>/dev/null || true
  while systemctl is-active --quiet tools-backup-run.service tools-backup-verify.service; do
    echo "    waiting for a backup run or restore test to finish"
    sleep 10
  done
  # SQLite's backup API folds in the WAL, so the copy is complete.
  sudo -u "$OWNER" node -e "
    const Database = require('$APP/node_modules/better-sqlite3');
    new Database('$SRC/data/tools-backup.db', { readonly: true })
      .backup('$APP/data/tools-backup.db')
      .then(() => console.log('    copied $SRC/data/tools-backup.db'));
  "
fi

echo "==> systemd units"
for unit in tools-backup.service tools-backup-run.service tools-backup-run.timer \
  tools-backup-verify.service tools-backup-verify.timer \
  tools-backup-restart.service tools-backup-restart.path; do
  install -m 0644 "$SRC/deploy/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable tools-backup.service
systemctl enable --now tools-backup-run.timer tools-backup-verify.timer tools-backup-restart.path

echo "==> Deploy main"
# This checkout's copy, so a rerun uses the current script even when
# /opt/tools-backup still has an older one.
sudo -u "$OWNER" -H bash "$SRC/deploy/update.sh"
# update.sh skips a commit that's already running; make sure the UI is up.
systemctl is-active --quiet tools-backup || systemctl start tools-backup

systemctl --no-pager list-timers 'tools-backup-*'
echo "UI: https://backup.home.danco.page"
