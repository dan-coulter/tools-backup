import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export const SELF_TOOL = "tools-backup";

export function databasePath(): string {
  return path.resolve(process.env.DATABASE_PATH || path.join(process.cwd(), "data", "tools-backup.db"));
}

export type Tool = { id: number; slug: string; created_at: string };

export type Item = {
  id: number;
  tool_id: number;
  tool: string;
  label: string;
  fetcher: string;
  path: string;
  options: string;
  enabled: number;
  created_at: string;
};

export type BackupStatus = "success" | "unchanged" | "failed";

export type Backup = {
  id: number;
  run_id: number;
  item_id: number;
  started_at: string;
  finished_at: string | null;
  status: BackupStatus;
  s3_key: string | null;
  bytes: number | null;
  sha256: string | null;
  source_mtime: string | null;
  error: string | null;
  verified_at: string | null;
  verify_detail: string | null;
  filename: string | null;
  compressed: number;
};

export type Run = {
  id: number;
  trigger: string;
  scope: string | null;
  started_at: string;
  finished_at: string | null;
  status: "running" | "success" | "partial" | "failed";
  ok_count: number;
  fail_count: number;
};

const MIGRATIONS = [
  `
  CREATE TABLE tools (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    tool_id INTEGER NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    fetcher TEXT NOT NULL,
    path TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (tool_id, label)
  );
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    trigger TEXT NOT NULL,
    scope TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    ok_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE backups (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    s3_key TEXT,
    bytes INTEGER,
    sha256 TEXT,
    source_mtime TEXT,
    error TEXT,
    verified_at TEXT,
    verify_detail TEXT
  );
  CREATE INDEX backups_item ON backups(item_id, started_at DESC);
  `,
  // What was uploaded: the snapshot's own filename and whether we gzipped it.
  `
  ALTER TABLE backups ADD COLUMN filename TEXT;
  ALTER TABLE backups ADD COLUMN compressed INTEGER NOT NULL DEFAULT 0;
  UPDATE backups SET compressed = (s3_key LIKE '%.gz'),
    filename = substr(s3_key, instr(s3_key, '__') + 2) WHERE s3_key IS NOT NULL;
  UPDATE backups SET filename = substr(filename, 1, length(filename) - 3) WHERE compressed = 1;
  `,
];

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const file = databasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  ensureSelf(db, file);
  return db;
}

function migrate(d: Database.Database) {
  const version = d.pragma("user_version", { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    d.transaction(() => {
      d.exec(MIGRATIONS[v]);
      d.pragma(`user_version = ${v + 1}`);
    })();
  }
}

// This app's own database is always registered, and always backed up first.
function ensureSelf(d: Database.Database, file: string) {
  const tool = upsertTool(d, SELF_TOOL);
  d.prepare(
    `INSERT INTO items (tool_id, label, fetcher, path) VALUES (?, 'tools-backup.db', 'sqlite', ?)
     ON CONFLICT (tool_id, label) DO UPDATE SET path = excluded.path`,
  ).run(tool.id, file);
}

function upsertTool(d: Database.Database, slug: string): Tool {
  d.prepare("INSERT OR IGNORE INTO tools (slug) VALUES (?)").run(slug);
  return d.prepare("SELECT * FROM tools WHERE slug = ?").get(slug) as Tool;
}

const ITEM_SELECT = `
  SELECT items.*, tools.slug AS tool FROM items JOIN tools ON tools.id = items.tool_id`;
const ITEM_ORDER = `ORDER BY (tools.slug = '${SELF_TOOL}') DESC, tools.slug, items.label`;

export function listItems(filter: { tool?: string; enabledOnly?: boolean } = {}): Item[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.tool) {
    where.push("tools.slug = ?");
    args.push(filter.tool);
  }
  if (filter.enabledOnly) where.push("items.enabled = 1");
  const sql = `${ITEM_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ${ITEM_ORDER}`;
  return getDb().prepare(sql).all(...args) as Item[];
}

export function getItem(id: number): Item | undefined {
  return getDb().prepare(`${ITEM_SELECT} WHERE items.id = ?`).get(id) as Item | undefined;
}

export const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function addItem(input: {
  tool: string;
  label: string;
  fetcher: string;
  path: string;
  options?: Record<string, unknown>;
}): Item {
  const d = getDb();
  if (!SLUG_RE.test(input.tool)) {
    throw new Error(`Tool name "${input.tool}" must be lowercase letters, digits, dot, dash or underscore`);
  }
  return d.transaction(() => {
    const tool = upsertTool(d, input.tool);
    const { lastInsertRowid } = d
      .prepare("INSERT INTO items (tool_id, label, fetcher, path, options) VALUES (?, ?, ?, ?, ?)")
      .run(tool.id, input.label, input.fetcher, input.path, JSON.stringify(input.options ?? {}));
    return getItem(Number(lastInsertRowid))!;
  })();
}

export function setItemEnabled(id: number, enabled: boolean) {
  getDb().prepare("UPDATE items SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

export function deleteItem(id: number) {
  const d = getDb();
  const item = getItem(id);
  if (!item) return;
  if (item.tool === SELF_TOOL) throw new Error("The tools-backup database can't be removed");
  d.transaction(() => {
    d.prepare("DELETE FROM items WHERE id = ?").run(id);
    d.prepare("DELETE FROM tools WHERE id = ? AND NOT EXISTS (SELECT 1 FROM items WHERE tool_id = tools.id)").run(
      item.tool_id,
    );
  })();
}

// Latest attempt and latest good copy, per item.
export function latestBackups(): Map<number, { last?: Backup; lastGood?: Backup }> {
  const d = getDb();
  const out = new Map<number, { last?: Backup; lastGood?: Backup }>();
  const last = d
    .prepare(
      `SELECT * FROM backups b WHERE id = (SELECT id FROM backups WHERE item_id = b.item_id ORDER BY started_at DESC, id DESC LIMIT 1)`,
    )
    .all() as Backup[];
  const good = d
    .prepare(
      `SELECT * FROM backups b WHERE id = (SELECT id FROM backups WHERE item_id = b.item_id AND status IN ('success','unchanged') ORDER BY started_at DESC, id DESC LIMIT 1)`,
    )
    .all() as Backup[];
  for (const b of last) out.set(b.item_id, { ...out.get(b.item_id), last: b });
  for (const b of good) out.set(b.item_id, { ...out.get(b.item_id), lastGood: b });
  return out;
}

// The newest backup that actually uploaded something, for de-duplication and restores.
export function lastUploaded(itemId: number): Backup | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM backups WHERE item_id = ? AND status = 'success' AND s3_key IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get(itemId) as Backup | undefined;
}

export function itemHistory(itemId: number, limit = 20): Backup[] {
  return getDb()
    .prepare("SELECT * FROM backups WHERE item_id = ? ORDER BY started_at DESC, id DESC LIMIT ?")
    .all(itemId, limit) as Backup[];
}

export function recentRuns(limit = 10): Run[] {
  return getDb().prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit) as Run[];
}

export function activeRun(): Run | undefined {
  return getDb().prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY id DESC LIMIT 1").get() as
    | Run
    | undefined;
}

const STALE_RUN_HOURS = 6;

// Claims the single run slot. Returns undefined if another run is in progress.
export function startRun(trigger: string, scope: string | null): Run | undefined {
  const d = getDb();
  return d.transaction(() => {
    d.prepare(
      `UPDATE runs SET status = 'failed', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE status = 'running' AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)`,
    ).run(`-${STALE_RUN_HOURS} hours`);
    if (activeRun()) return undefined;
    const { lastInsertRowid } = d
      .prepare("INSERT INTO runs (trigger, scope, started_at, status) VALUES (?, ?, ?, 'running')")
      .run(trigger, scope, new Date().toISOString());
    return d.prepare("SELECT * FROM runs WHERE id = ?").get(lastInsertRowid) as Run;
  }).immediate();
}

export function finishRun(id: number, ok: number, failed: number) {
  const status = failed === 0 ? "success" : ok === 0 ? "failed" : "partial";
  getDb()
    .prepare("UPDATE runs SET status = ?, finished_at = ?, ok_count = ?, fail_count = ? WHERE id = ?")
    .run(status, new Date().toISOString(), ok, failed, id);
}

export function recordVerification(backupId: number, detail: string) {
  getDb()
    .prepare("UPDATE backups SET verified_at = ?, verify_detail = ? WHERE id = ?")
    .run(new Date().toISOString(), detail, backupId);
}

export function recordBackup(b: Omit<Backup, "id" | "verified_at" | "verify_detail">) {
  getDb()
    .prepare(
      `INSERT INTO backups (run_id, item_id, started_at, finished_at, status, s3_key, bytes, sha256, source_mtime, error, filename, compressed)
       VALUES (@run_id, @item_id, @started_at, @finished_at, @status, @s3_key, @bytes, @sha256, @source_mtime, @error, @filename, @compressed)`,
    )
    .run(b);
}
