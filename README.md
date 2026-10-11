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
sudo bash deploy/install.sh   # production service on :4760 + timers
```

Re-run `sudo bash deploy/install.sh` after pulling changes.

## Restoring

```bash
npm run items -- restore <id> --out /tmp/restore
```

Stop the owning app, replace its file with the restored copy (for SQLite,
delete any stale `-wal`/`-shm` next to it), then start the app. Sonarr/Radarr
zips are restored from the app's own UI (System → Backup → Restore).

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
