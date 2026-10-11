import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { cleanup, freshDb, tempDir, writeFile } from "@/test/helpers";

// S3 is an in-memory map: tests never reach AWS.
jest.mock("@/lib/s3", () => {
  const fs = require("node:fs");
  const { Readable } = require("node:stream");
  const store = new Map<string, Buffer>();
  return {
    __store: store,
    bucket: () => "test-bucket",
    s3Uri: (key: string) => `s3://test-bucket/${key}`,
    upload: jest.fn(async (key: string, file: string) => {
      store.set(key, fs.readFileSync(file));
    }),
    getStream: jest.fn(async (key: string) => {
      if (!store.has(key)) throw new Error("NoSuchKey");
      return Readable.from([store.get(key)]);
    }),
  };
});

type FakeS3 = typeof import("@/lib/s3") & { __store: Map<string, Buffer>; upload: ReturnType<typeof jest.fn> };

let dir: string;
let src: string;
let m: ReturnType<typeof freshDb>;
let s3: FakeS3;
beforeEach(() => {
  dir = tempDir();
  src = tempDir();
  m = freshDb(dir);
  s3 = m.s3 as FakeS3;
});
afterEach(() => {
  m.db.getDb().close();
  cleanup(dir, src);
});

function addFile(tool: string, name: string, content: string, label = name) {
  const file = writeFile(src, name, content);
  return { file, item: m.db.addItem({ tool, label, fetcher: "file", path: file }) };
}

async function run(opts: Partial<Parameters<typeof m.backup.runBackup>[0]> = {}) {
  const r = await m.backup.runBackup({ trigger: "test", tool: "app", ...opts });
  if ("busy" in r) throw new Error("busy");
  return r;
}

describe("runBackup", () => {
  it("gzips and uploads a file under <tool>/<label>/<time>__<name>.gz", async () => {
    const { item } = addFile("app", ".env", "A=1\n");
    const r = await run();
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ status: "success" });
    const [key] = [...s3.__store.keys()];
    expect(key).toMatch(/^app\/.env\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ__dot\.env\.gz$/);
    expect(zlib.gunzipSync(s3.__store.get(key)!).toString()).toBe("A=1\n");
    expect(r.results[0].detail).toBe(`s3://test-bucket/${key} (${s3.__store.get(key)!.length} bytes)`);
    expect(m.db.lastUploaded(item.id)).toMatchObject({ s3_key: key, filename: "dot.env", compressed: 1 });
  });

  it("skips the upload when nothing changed, and uploads again when it does", async () => {
    const { file, item } = addFile("app", "config.json", "{}");
    await run();
    const first = m.db.lastUploaded(item.id)!.s3_key;
    const again = await run();
    expect(again.results[0]).toMatchObject({ status: "unchanged", detail: `same as ${first}` });
    expect(s3.upload).toHaveBeenCalledTimes(1);

    fs.writeFileSync(file, '{"changed":true}');
    const changed = await run();
    expect(changed.results[0].status).toBe("success");
    expect(s3.upload).toHaveBeenCalledTimes(2);
  });

  it("uploads already-compressed files as they are", async () => {
    addFile("app", "backup.zip", "PK fake zip");
    await run();
    const [key] = [...s3.__store.keys()];
    expect(key).toMatch(/__backup\.zip$/);
    expect(s3.__store.get(key)!.toString()).toBe("PK fake zip");
  });

  it("turns the label into a safe S3 folder name", async () => {
    addFile("app", "a.txt", "a", "Scheduled Backups!");
    await run();
    expect([...s3.__store.keys()][0]).toMatch(/^app\/scheduled-backups\//);
  });

  it("records a failed item and carries on with the rest", async () => {
    const { file } = addFile("app", "gone.txt", "x");
    addFile("app", "ok.txt", "y");
    fs.rmSync(file);
    const r = await run();
    expect(r.results.map((x) => x.status).sort()).toEqual(["failed", "success"]);
    expect(r.results.find((x) => x.status === "failed")!.detail).toMatch(/ENOENT/);
    expect(m.db.recentRuns()[0]).toMatchObject({ status: "partial", ok_count: 1, fail_count: 1, scope: "tool:app" });
  });

  it("skips disabled items, unless they're asked for by id", async () => {
    const { item } = addFile("app", "a.txt", "a");
    m.db.setItemEnabled(item.id, false);
    expect((await run()).results).toHaveLength(0);
    const byId = await run({ tool: undefined, itemIds: [item.id] });
    expect(byId.results.map((x) => x.item.id)).toEqual([item.id]);
    expect(m.db.recentRuns()[0].scope).toBe(`items:${item.id}`);
  });

  it("backs up its own database when running everything", async () => {
    const r = await run({ tool: undefined });
    expect(r.results.map((x) => `${x.item.tool}/${x.status}`)).toEqual(["tools-backup/success"]);
    expect(m.db.recentRuns()[0].scope).toBeNull();
  });

  it("says it's busy while another run holds the slot", async () => {
    m.db.startRun("other", null);
    await expect(m.backup.runBackup({ trigger: "test" })).resolves.toEqual({ busy: true });
  });

  it("releases the slot even when an item fails", async () => {
    const { file } = addFile("app", "gone.txt", "x");
    fs.rmSync(file);
    await run();
    expect(m.db.activeRun()).toBeUndefined();
  });
});

describe("restore", () => {
  it("restores the newest upload un-gzipped, under its original name", async () => {
    const { item } = addFile("app", ".env", "A=1\n");
    await run();
    const out = path.join(src, "restore");
    const { file, key } = await m.backup.restoreLatest(item.id, out);
    expect(file).toBe(path.join(out, "dot.env"));
    expect(fs.readFileSync(file, "utf8")).toBe("A=1\n");
    expect(key).toBe(m.db.lastUploaded(item.id)!.s3_key);
  });

  it("works out the name of rows from before filenames were stored", async () => {
    const { item } = addFile("app", "config.json", "{}");
    await run();
    m.db.getDb().prepare("UPDATE backups SET filename = NULL, compressed = 0").run();
    const { filename } = await m.backup.openLatest(item.id);
    expect(filename).toBe("config.json");
  });

  it("explains when there's nothing to restore", async () => {
    const { item } = addFile("app", "a.txt", "a");
    await expect(m.backup.openLatest(item.id)).rejects.toThrow("No uploaded backup for this item yet");
  });
});

describe("verifyItem", () => {
  it("passes a good copy and runs the fetcher's own check", async () => {
    const dbFile = path.join(src, "app.db");
    new Database(dbFile).exec("CREATE TABLE a (x)");
    const item = m.db.addItem({ tool: "app", label: "app.db", fetcher: "sqlite", path: dbFile });
    await run();
    const result = await m.backup.verifyItem(item.id);
    expect(result).toEqual({ ok: true, detail: "OK: sha256 matches, integrity_check ok, 1 tables" });
    expect(m.db.lastUploaded(item.id)?.verify_detail).toBe(result.detail);
  });

  it("fails a copy that changed in S3", async () => {
    const { item } = addFile("app", "a.txt", "original");
    await run();
    const key = m.db.lastUploaded(item.id)!.s3_key!;
    s3.__store.set(key, zlib.gzipSync("tampered"));
    const result = await m.backup.verifyItem(item.id);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/^FAILED: checksum mismatch/);
    expect(m.db.lastUploaded(item.id)?.verify_detail).toBe(result.detail);
  });

  it("reports items with nothing uploaded, and unknown ids", async () => {
    const { item } = addFile("app", "a.txt", "a");
    await expect(m.backup.verifyItem(item.id)).resolves.toEqual({ ok: false, detail: "nothing uploaded yet" });
    await expect(m.backup.verifyItem(9999)).rejects.toThrow("No item 9999");
  });
});

describe("parseOptions", () => {
  it("reads stored options and tolerates junk", () => {
    expect(m.backup.parseOptions({ options: '{"pattern":"*.zip"}' })).toEqual({ pattern: "*.zip" });
    expect(m.backup.parseOptions({ options: "" })).toEqual({});
    expect(m.backup.parseOptions({ options: "not json" })).toEqual({});
  });
});

describe("registerItem", () => {
  it("detects the fetcher and names the item after the file", async () => {
    const file = writeFile(src, ".env", "A=1");
    const { item, check } = await m.items.registerItem({ tool: "  Arlo-Snapshot ", path: file });
    expect(item).toMatchObject({ tool: "arlo-snapshot", label: ".env", fetcher: "file", path: file });
    expect(check).toBe("readable file");
  });

  it("keeps only options that were filled in", async () => {
    writeFile(src, "a.zip", "z");
    const { item } = await m.items.registerItem({
      tool: "sonarr",
      path: src,
      label: "scheduled",
      options: { pattern: "*.zip", other: "" },
    });
    expect(item).toMatchObject({ fetcher: "latest-in-dir", label: "scheduled", options: '{"pattern":"*.zip"}' });
  });

  it("refuses missing paths and failed checks unless forced", async () => {
    const missing = path.join(src, "nope.env");
    await expect(m.items.registerItem({ tool: "app", path: missing, fetcher: "file" })).rejects.toThrow(
      "does not exist",
    );
    await expect(m.items.registerItem({ tool: "app", path: src, fetcher: "file" })).rejects.toThrow(
      "not a regular file",
    );
    const { item } = await m.items.registerItem({ tool: "app", path: missing, fetcher: "file", force: true });
    expect(item.path).toBe(missing);
  });
});
