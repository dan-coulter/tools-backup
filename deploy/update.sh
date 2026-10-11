#!/usr/bin/env bash
# Deploys a commit on main to production in /opt/tools-backup. As yourself:
#   bash /opt/tools-backup/deploy/update.sh [<commit>]   # default: newest main
# Jenkins runs it over SSH with a key that can run nothing else; the commit
# arrives in SSH_ORIGINAL_COMMAND. It waits for any backup or restore test to
# finish, checks out the commit, runs the typecheck and tests, builds, then
# writes the trigger file that tools-backup-restart.path watches, so no sudo.
# A failed build rolls back. The timers run the new code from their next run.
#
# The web UI runs `next start` from this checkout, so it can answer errors
# for the minute `npm ci` and the build take.

# Everything is in main() so bash has read the whole file before `git
# checkout` replaces it.
main() {
  set -euo pipefail

  local app=/opt/tools-backup
  local url=http://localhost:4760/api/status
  local target="${1:-${SSH_ORIGINAL_COMMAND:-}}"

  if [[ -n $target && ! $target =~ ^[0-9a-f]{7,40}$ ]]; then
    echo "Not a commit hash: $target" >&2
    exit 2
  fi

  cd "$app"
  exec 9>"$app/.deploy/lock"
  # Another deploy (Jenkins, or one by hand) may be running: wait for it,
  # then this one usually finds there's nothing left to do.
  if ! flock -n 9; then
    echo "==> Waiting for another deploy to finish"
    if ! flock -w 900 9; then
      echo "Still waiting after 15 minutes. Giving up." >&2
      exit 1
    fi
  fi

  echo "==> Fetch"
  git fetch --quiet origin main
  target=$(git rev-parse --verify "${target:-origin/main}^{commit}")
  if ! git merge-base --is-ancestor "$target" origin/main; then
    echo "$target isn't on main." >&2
    exit 2
  fi

  local previous deployed
  previous=$(git rev-parse HEAD)
  deployed=$(cat .deploy/deployed 2>/dev/null || true)
  if [[ $target == "$deployed" ]] && curl -fs -o /dev/null "$url"; then
    echo "Already running $(git log -1 --format='%h %s' "$target")."
    exit 0
  fi

  wait_for_runs

  echo "==> Build $(git log -1 --format='%h %s' "$target")"
  git checkout --quiet --detach "$target"
  if ! (npm ci --no-audit --no-fund && npm run check); then
    echo "==> Checks failed. Going back to ${previous:0:7}." >&2
    git checkout --quiet --detach "$previous"
    npm ci --no-audit --no-fund && npm run build
    restart "$url"
    exit 1
  fi
  if ! npm run build; then
    echo "==> Build failed. Rolling back to ${previous:0:7}" >&2
    git checkout --quiet --detach "$previous"
    npm ci --no-audit --no-fund && npm run build
    restart "$url"
    exit 1
  fi

  restart "$url"
  echo "$target" >.deploy/deployed
  echo "Up: https://backup.home.danco.page ($(git log -1 --format='%h %s'))"
}

# A backup or restore test reads this checkout's code and node_modules, which
# the deploy replaces: let it finish first.
wait_for_runs() {
  local waited=0
  while systemctl is-active --quiet tools-backup-run.service tools-backup-verify.service; do
    if ((waited == 0)); then
      echo "==> Waiting for a backup run or restore test to finish"
    fi
    if ((waited >= 1800)); then
      echo "Still running after 30 minutes. Giving up." >&2
      exit 1
    fi
    sleep 10
    waited=$((waited + 10))
  done
}

# Asks systemd to restart the web UI, then waits until it has and answers.
restart() {
  local url=$1 before now
  before=$(systemctl show -p ActiveEnterTimestampMonotonic --value tools-backup)
  echo "==> Restart"
  date -u +%FT%TZ >/opt/tools-backup/.deploy/restart
  for _ in $(seq 1 30); do
    sleep 1
    now=$(systemctl show -p ActiveEnterTimestampMonotonic --value tools-backup)
    if [[ $now != "$before" ]] && curl -fs -o /dev/null "$url"; then
      return 0
    fi
  done
  echo "Not answering after a restart. Check: journalctl -u tools-backup -n 50" >&2
  exit 1
}

main "$@"
exit
