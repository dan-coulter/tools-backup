#!/usr/bin/env bash
# Nightly audit, from dan's crontab after the 04:30 backup:
#   15 5 * * * /opt/tools-backup/deploy/audit-cron.sh >> /home/dan/logs/tools-backup-audit.log 2>&1
# Reports to the Uptime Kuma push monitor in AUDIT_PUSH_URL (.env.local): up when the
# audit is clean, down with the first gap otherwise. A night with no push also alerts.
set -uo pipefail

cd "$(dirname "$0")/.."
PUSH_URL="$(grep -s '^AUDIT_PUSH_URL=' .env.local | cut -d= -f2-)"

echo "=== $(date -u '+%Y-%m-%d %H:%M:%S UTC') ==="
out="$(/usr/local/bin/npm run -s audit 2>&1)"
code=$?
echo "$out"

if [[ -z $PUSH_URL ]]; then
  echo "AUDIT_PUSH_URL is not set in .env.local; nothing pushed."
  exit "$code"
fi
if [[ $code -eq 0 ]]; then
  status=up msg=OK
else
  # Kuma shows one line; the log and `npm run -s audit` have the rest.
  status=down
  msg="$(echo "$out" | grep -m1 -E '^  - ' | sed 's/^  - //')"
  msg="$(echo "$out" | grep -cE '^  - ') gaps, e.g. ${msg:-see log}"
fi
/usr/bin/curl -fsS -m 30 -G "${PUSH_URL%%\?*}" \
  --data-urlencode "status=$status" --data-urlencode "msg=$msg" --data-urlencode "ping=" >/dev/null ||
  echo "Push to Uptime Kuma failed."
exit "$code"
