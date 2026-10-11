@AGENTS.md

# tools-backup

Backs up tool databases and config/env files on plex.local to S3. See README.md.

## Adding files to the backup (from any project)

When you create a database, `.env`, or config file in another tool, register it:

```bash
cd /home/dan/claude/tools-backup && npm run -s items -- add <tool-name> <absolute-path>
```

- `<tool-name>`: lowercase project name (it becomes the S3 folder), e.g. `oscars-db`.
- The type is auto-detected: SQLite files use the backup API, folders take the newest file
  (add `--pattern '*.zip'`), anything else is copied. Use `--label` to rename it.
- Register the **production** path when one exists (e.g. `/var/lib/<tool>/<tool>.db`), not a dev copy.
- Then run `npm run -s backup -- --tool <tool-name>` once to confirm it uploads.
- `npm run -s items -- list` shows what's registered.

## Code map

- `src/lib/db.ts`: schema/migrations (append to `MIGRATIONS`, never edit old entries) and queries.
- `src/lib/fetchers/`: one file per way of getting a file. Register new ones in `index.ts`.
- `src/lib/backup.ts`: run engine (single run at a time, de-dupe by sha256, gzip, upload), restore, verify.
- `src/app/`: dashboard (server component) + server actions; `api/status` JSON.
- `scripts/`: `backup.ts` and `items.ts` CLIs (run with tsx).
- `deploy/`: systemd units (run as `dan` from this checkout) and `install.sh`.

`npm run check` (typecheck and tests) before finishing; tests import `describe`, `it`, `expect` and `jest` from `@jest/globals`. Dev server is port 4761; production is 4760.
