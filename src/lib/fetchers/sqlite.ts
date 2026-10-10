import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import type { Fetcher } from "./types";

// Uses SQLite's online backup API, which is safe while the owning app is
// writing. Copying the .db file directly can capture a torn write or miss
// pages still sitting in the -wal file.
export const sqliteFetcher: Fetcher = {
  id: "sqlite",
  label: "SQLite database",
  description: "Consistent snapshot via SQLite's backup API. Safe while the app is running.",
  pathHint: "/path/to/app.db",
  async inspect(p) {
    try {
      const st = await fs.stat(p);
      const db = new Database(p, { readonly: true, fileMustExist: true });
      try {
        db.prepare("SELECT count(*) FROM sqlite_master").get();
      } finally {
        db.close();
      }
      return { ok: true, detail: "readable SQLite database", mtime: st.mtime, bytes: st.size };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  },
  async snapshot(p, _options, workDir) {
    const st = await fs.stat(p);
    const out = path.join(workDir, path.basename(p));
    const db = new Database(p, { readonly: true, fileMustExist: true });
    try {
      await db.backup(out);
    } finally {
      db.close();
    }
    // The WAL is folded into the snapshot. Make it a self-contained file.
    const snap = new Database(out);
    snap.pragma("journal_mode = DELETE");
    snap.close();
    return { file: out, filename: path.basename(p), sourceMtime: st.mtime, compress: true };
  },
  async check(file) {
    const db = new Database(file, { readonly: true });
    try {
      const rows = db.pragma("integrity_check") as { integrity_check: string }[];
      const result = rows.map((r) => r.integrity_check).join("; ");
      if (result !== "ok") throw new Error(`integrity_check: ${result}`);
      const tables = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }).n;
      return `integrity_check ok, ${tables} tables`;
    } finally {
      db.close();
    }
  },
};
