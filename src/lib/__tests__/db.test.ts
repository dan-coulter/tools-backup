import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import Database from "better-sqlite3";
import { cleanup, freshDb, tempDir } from "@/test/helpers";

let dir: string;
let db: ReturnType<typeof freshDb>["db"];
beforeEach(() => {
  dir = tempDir();
  ({ db } = freshDb(dir));
});
afterEach(() => {
  db.getDb().close();
  cleanup(dir);
});

function addFile(tool: string, label: string) {
  return db.addItem({ tool, label, fetcher: "file", path: `/tmp/${label}` });
}

function backupRow(runId: number, itemId: number, status: "success" | "unchanged" | "failed", startedAt: string) {
  db.recordBackup({
    run_id: runId,
    item_id: itemId,
    started_at: startedAt,
    finished_at: startedAt,
    status,
    s3_key: status === "failed" ? null : `k/${startedAt}`,
    bytes: 1,
    sha256: status === "failed" ? null : "abc",
    source_mtime: null,
    error: status === "failed" ? "boom" : null,
    filename: "f",
    compressed: 0,
  });
}

describe("a new database", () => {
  it("runs every migration", () => {
    expect(db.getDb().pragma("user_version", { simple: true })).toBe(2);
    const columns = db.getDb().prepare("SELECT name FROM pragma_table_info('backups')").pluck().all();
    expect(columns).toEqual(expect.arrayContaining(["filename", "compressed"]));
  });

  it("registers its own database first", () => {
    const items = db.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ tool: "tools-backup", label: "tools-backup.db", fetcher: "sqlite" });
    expect(items[0].path).toBe(process.env.DATABASE_PATH);
  });
});

describe("migration 2 on older data", () => {
  it("fills in filename and compressed from the S3 key", () => {
    db.getDb().close();
    const file = process.env.DATABASE_PATH!;
    const raw = new Database(file);
    raw.exec(`
      DROP TABLE backups;
      CREATE TABLE backups (
        id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, item_id INTEGER NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, s3_key TEXT,
        bytes INTEGER, sha256 TEXT, source_mtime TEXT, error TEXT, verified_at TEXT, verify_detail TEXT);
      INSERT INTO backups (run_id, item_id, started_at, status, s3_key) VALUES
        (1, 1, 'a', 'success', 'oscars-db/oscars.db/2026-10-01T00-00-00Z__oscars.db.gz'),
        (1, 1, 'b', 'success', 'sonarr/scheduled/2026-10-01T00-00-00Z__sonarr_backup.zip'),
        (1, 1, 'c', 'failed', NULL);
    `);
    raw.pragma("user_version = 1");
    raw.close();

    ({ db } = freshDb(dir));
    const rows = db.getDb().prepare("SELECT filename, compressed FROM backups ORDER BY id").all();
    expect(rows).toEqual([
      { filename: "oscars.db", compressed: 1 },
      { filename: "sonarr_backup.zip", compressed: 0 },
      { filename: null, compressed: 0 },
    ]);
  });
});

describe("items", () => {
  it("adds an item and creates its tool", () => {
    const item = db.addItem({ tool: "oscars-db", label: ".env", fetcher: "file", path: "/x/.env", options: { a: "1" } });
    expect(item).toMatchObject({ tool: "oscars-db", label: ".env", fetcher: "file", enabled: 1, options: '{"a":"1"}' });
    expect(db.getItem(item.id)).toEqual(item);
  });

  it("rejects tool names that won't work as S3 folders", () => {
    for (const tool of ["Oscars", "my tool", "-x", ""]) {
      expect(() => db.addItem({ tool, label: "l", fetcher: "file", path: "/p" })).toThrow(/must be lowercase/);
    }
  });

  it("refuses two items with the same label in one tool", () => {
    addFile("radarr", "config");
    expect(() => addFile("radarr", "config")).toThrow(/UNIQUE/);
    expect(() => addFile("sonarr", "config")).not.toThrow();
  });

  it("lists its own database first, then by tool and label", () => {
    addFile("sonarr", "b");
    addFile("arlo", "z");
    addFile("sonarr", "a");
    expect(db.listItems().map((i) => `${i.tool}/${i.label}`)).toEqual([
      "tools-backup/tools-backup.db",
      "arlo/z",
      "sonarr/a",
      "sonarr/b",
    ]);
  });

  it("filters by tool and by enabled", () => {
    const a = addFile("sonarr", "a");
    addFile("sonarr", "b");
    addFile("radarr", "c");
    db.setItemEnabled(a.id, false);
    expect(db.listItems({ tool: "sonarr" }).map((i) => i.label)).toEqual(["a", "b"]);
    expect(db.listItems({ tool: "sonarr", enabledOnly: true }).map((i) => i.label)).toEqual(["b"]);
  });

  it("removes a tool along with its last item", () => {
    const a = addFile("radarr", "a");
    const b = addFile("radarr", "b");
    db.deleteItem(a.id);
    expect(db.getDb().prepare("SELECT slug FROM tools").pluck().all()).toContain("radarr");
    db.deleteItem(b.id);
    expect(db.getDb().prepare("SELECT slug FROM tools").pluck().all()).not.toContain("radarr");
  });

  it("won't remove its own database, and ignores unknown ids", () => {
    const self = db.listItems()[0];
    expect(() => db.deleteItem(self.id)).toThrow("The tools-backup database can't be removed");
    expect(() => db.deleteItem(9999)).not.toThrow();
  });
});

describe("runs", () => {
  it("allows one run at a time", () => {
    const run = db.startRun("cli", null);
    expect(run).toMatchObject({ trigger: "cli", status: "running" });
    expect(db.startRun("web", null)).toBeUndefined();
    expect(db.activeRun()?.id).toBe(run!.id);
    db.finishRun(run!.id, 2, 0);
    expect(db.startRun("web", null)).toBeDefined();
  });

  it("takes over a run that's been stuck for over 6 hours", () => {
    const stuck = db.startRun("schedule", null)!;
    db.getDb()
      .prepare("UPDATE runs SET started_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 7 * 3600_000).toISOString(), stuck.id);
    const next = db.startRun("cli", null);
    expect(next).toBeDefined();
    expect(db.recentRuns().find((r) => r.id === stuck.id)?.status).toBe("failed");
  });

  it.each([
    [3, 0, "success"],
    [2, 1, "partial"],
    [0, 2, "failed"],
  ])("finishes with %i ok and %i failed as %s", (ok, failed, status) => {
    const run = db.startRun("cli", null)!;
    db.finishRun(run.id, ok, failed);
    expect(db.recentRuns()[0]).toMatchObject({ status, ok_count: ok, fail_count: failed });
  });
});

describe("backup history", () => {
  it("tracks the latest attempt and the latest good copy separately", () => {
    const item = addFile("radarr", "config");
    const run = db.startRun("cli", null)!;
    backupRow(run.id, item.id, "success", "2026-10-01T00:00:00Z");
    backupRow(run.id, item.id, "unchanged", "2026-10-02T00:00:00Z");
    backupRow(run.id, item.id, "failed", "2026-10-03T00:00:00Z");
    const latest = db.latestBackups().get(item.id)!;
    expect(latest.last?.status).toBe("failed");
    expect(latest.lastGood).toMatchObject({ status: "unchanged", started_at: "2026-10-02T00:00:00Z" });
  });

  it("finds the newest upload, skipping unchanged and failed runs", () => {
    const item = addFile("radarr", "config");
    const run = db.startRun("cli", null)!;
    expect(db.lastUploaded(item.id)).toBeUndefined();
    backupRow(run.id, item.id, "success", "2026-10-01T00:00:00Z");
    backupRow(run.id, item.id, "unchanged", "2026-10-02T00:00:00Z");
    backupRow(run.id, item.id, "failed", "2026-10-03T00:00:00Z");
    expect(db.lastUploaded(item.id)?.started_at).toBe("2026-10-01T00:00:00Z");
    expect(db.itemHistory(item.id).map((b) => b.status)).toEqual(["failed", "unchanged", "success"]);
  });

  it("records a test restore on a backup", () => {
    const item = addFile("radarr", "config");
    const run = db.startRun("cli", null)!;
    backupRow(run.id, item.id, "success", "2026-10-01T00:00:00Z");
    const b = db.lastUploaded(item.id)!;
    db.recordVerification(b.id, "OK: sha256 matches");
    expect(db.lastUploaded(item.id)).toMatchObject({ verify_detail: "OK: sha256 matches" });
    expect(db.lastUploaded(item.id)?.verified_at).toEqual(expect.any(String));
  });
});
