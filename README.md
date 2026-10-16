# tools-backup

Backs up the databases and config/env files of the tools on plex.local to
`s3://aws-utils-db-backups-985753407360-us-east-2/<tool>/`.

- Web UI: http://plex.local:4760. It lists every file per tool, when it was last
  backed up, its last restore test, and has buttons to back up, verify, add and
  remove files. Plain files can be previewed as they are on disk now; every file
  can be downloaded as its newest backed-up copy (un-gzipped).
- Daily run at 04:30 (systemd timer) and a weekly restore test on Sundays.
- Its own SQLite database (`data/tools-backup.db`) is always the first thing
  backed up.

## How a backup works

Each registered file has a **fetcher** that gets a copy onto local disk:

| Fetcher         | For                                   | How                                                |
| --------------- | ------------------------------------- | -------------------------------------------------- |
| `sqlite`        | live SQLite databases                 | SQLite's online backup API (safe mid-write)        |
| `file`          | `.env`, `config.json`, settings files | plain copy                                         |
| `latest-in-dir` | apps that write their own backups     | newest matching file, e.g. Sonarr/Radarr `*.zip`   |
| `docker-dir`    | state kept as many files in Docker    | `docker exec <container> tar`, minus `--exclude`s  |

`docker-dir` paths are `<container>:/path/in/container`, e.g.
`jenkins:/var/jenkins_home`. Tar runs inside the container, so it can read
root-owned files that `dan` can't.

The copy is hashed. If it matches the last upload, nothing is uploaded and the
run records it as `unchanged`. Otherwise it is gzipped (unless it's already
compressed) and uploaded with SSE-AES256 to:

```
<tool>/<label>/<UTC timestamp>__<filename>[.gz]
```

S3 keeps every version. Set retention with a lifecycle rule on the bucket; the
app's IAM user can't manage bucket settings.

**Adding a new way to fetch** (ssh, an HTTP export, `docker exec` and so on):
write a `Fetcher` in `src/lib/fetchers/` (see `types.ts`), and add it to
`FETCHERS` in `src/lib/fetchers/index.ts`. The UI, CLI and runs pick it up.

## CLI

```bash
npm run items -- list
npm run items -- add <tool> <path>                 # type is auto-detected
npm run items -- add sonarr /home/dan/docker-configs/sonarr/Backups/scheduled --pattern 'sonarr_backup_*.zip' --label "scheduled backups"
npm run items -- add jenkins jenkins:/var/jenkins_home --label home --exclude plugins --exclude 'jobs/*/builds'
npm run items -- disable <id> | enable <id> | remove <id>
npm run items -- verify [<id>...]                  # test restore from S3
npm run items -- restore <id> [--out ./restore]    # download newest copy

npm run backup                                     # everything enabled
npm run backup -- --tool oscars-db
npm run backup -- --item 3
```

`GET /api/status` returns JSON (last run, last good backup per file) for a
homepage tile.

## Setup

```bash
cp .env.example .env.local    # AWS keys + bucket
npm install
npm run dev                   # http://plex.local:4761
sudo bash deploy/install.sh   # production in /opt/tools-backup: UI on :4760 + timers
```

Production lives in `/opt/tools-backup`, with its own `.env.local` and
`data/tools-backup.db`. The first install copies both from the development
checkout; after that they're separate, so run the CLI (`npm run items`,
`npm run backup`) from `/opt/tools-backup`. Re-run `sudo bash deploy/install.sh`
after changing a unit file.

## Deploying

Merging to `main` deploys: the Jenkins job `tools-backup-deploy`
(https://jenkins.home.danco.page) checks GitHub every 2 minutes and runs
`deploy/update.sh` on plex for each new commit. To deploy by hand:

```bash
bash /opt/tools-backup/deploy/update.sh [<commit>]
```

It waits for any backup run or restore test to finish, checks out the commit,
runs `npm ci` and `npm run check`, builds, and restarts the web UI through
`tools-backup-restart.path` (a root path unit watching
`/opt/tools-backup/.deploy/restart`), so it needs no sudo. Failing checks or a
failed build put the previous commit back. The timers pick up the new code on
their next run. The web UI uses `next start` from the checkout, so it can
return errors for the minute a deploy takes.

Jenkins runs in Docker, so it SSHes to plex (`dan@172.18.0.1`) with the key
`/var/jenkins_home/.ssh/tools-backup-deploy`, which `~/.ssh/authorized_keys`
limits to one command:

```
restrict,command="/opt/tools-backup/deploy/update.sh" ssh-ed25519 AAAA… jenkins-tools-backup-deploy
```

The job definition is `deploy/jenkins/tools-backup-deploy.xml`; GitHub access
is the Jenkins credential `github-code`.

## Restoring

```bash
npm run items -- restore <id> --out /tmp/restore
```

Stop the owning app, replace its file with the restored copy (for SQLite,
delete any stale `-wal`/`-shm` next to it), then start the app. Sonarr/Radarr
zips are restored from the app's own UI (System → Backup → Restore).

### Jenkins

`jenkins/home` is `/var/jenkins_home` from the `jenkins` container
(`/home/dan/docker-configs/jenkins` on plex): global config, job definitions,
users and `credentials.xml`. It leaves out `plugins`, `war`, `workspace`,
`updates`, `logs`, `.java`, build history (`jobs/*/builds`), `*.log` and
`*.bak`, which Jenkins re-downloads or doesn't need. Job configs record the
plugins they use (`plugin="git@…"`); reinstall those from Manage Jenkins →
Plugins after a restore. Credentials kept in a folder (Folder → Credentials)
are in that folder's `jobs/<folder>/config.xml`, not `credentials.xml`, and
come back with it.

It also leaves out `secrets/` and `.ssh/` on purpose. `secrets/master.key`
and `secrets/hudson.util.Secret` decrypt `credentials.xml`, so they're kept
off S3, on a separate backup service. Both were created when Jenkins was first
set up and don't change, so a one-time copy is enough. Copy them again if a
new file shows up in `secrets/` after installing a plugin that stores its own
secrets. `.ssh/` holds the deploy key (see "Deploying").

```bash
sudo tar czf ~/jenkins-secrets-$(date +%F).tgz -C /home/dan/docker-configs/jenkins secrets .ssh
```

Put the archive on the other backup service, then delete it from your home
folder. It can decrypt every Jenkins credential.

To restore, stop the container, extract the S3 copy and the secrets archive
into `/home/dan/docker-configs/jenkins` (as root), then start it.

## Nightly audit

`npm run -s audit` (from `/opt/tools-backup`) checks for anything the checklist in
`~/claude/CLAUDE.md` missed, and exits 1 with a list when it finds something:

1. Every `@name host <sub>.{$DOMAIN}` in `~/claude/caddy/Caddyfile` has a `subdomain:` in the
   deployed dashboard (`/opt/tools-dashboard/src/lib/services.ts`), and every dashboard
   subdomain has a Caddy site.
2. Every `*.db`, `*.sqlite`, `*.sqlite3`, `.env` and `.env.local` under `~/claude`, `~/apps`
   and `/opt/<tool>` (skipping `node_modules`, `.next`, `.git` and `data/backups`), each
   `/var/lib/<tool>/*.db`, `/etc/<tool>/env`, and each `EnvironmentFile=` of a service that
   runs from `/opt` or `/home`, is covered by an enabled item.
3. Every enabled item had a good backup in the last 48 hours (`--max-age-hours`).

Intentional exclusions (dev copies whose production is registered, regenerated files) go in
`audit-allowlist.txt`, one per line with a `# reason`. Changes deploy with the rest of the repo.

`deploy/audit-cron.sh` runs it from dan's crontab at 05:15 UTC, after the 04:30 backup, logs
to `~/logs/tools-backup-audit.log` and reports to an Uptime Kuma push monitor (up when clean,
down with the first gap). Put the monitor's push URL in `/opt/tools-backup/.env.local`:

```
AUDIT_PUSH_URL=https://uptime.home.danco.page/api/push/<token>
```

Give the monitor a heartbeat interval of 90000 seconds (25 hours), so a night with no
audit raises an alert too.

## Tests

```bash
npm test          # Jest
npm run check     # typecheck, then tests
```

The tests cover the fetchers, the database (migrations, items, the single run
slot, backup history) and the backup engine: de-duplication, gzip, S3 key
names, restore and verify. S3 is replaced by an in-memory fake
(`src/lib/__tests__/backup.test.ts`), and each test gets its own temporary
database (`freshDb` in `src/test/helpers.ts`), so they never touch AWS or the
real `data/tools-backup.db`.
