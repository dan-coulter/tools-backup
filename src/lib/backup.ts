import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import type { Readable } from "node:stream";
import {
  type Backup,
  type Item,
  finishRun,
  getItem,
  lastUploaded,
  listItems,
  recordBackup,
  recordVerification,
  startRun,
} from "./db";
import { getFetcher } from "./fetchers";
import { getStream, s3Uri, upload } from "./s3";

export type ItemResult = { item: Item; status: "success" | "unchanged" | "failed"; detail: string };

export type RunResult = { runId: number; results: ItemResult[] } | { busy: true };

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

export function parseOptions(item: Pick<Item, "options">): Record<string, string> {
  try {
    return JSON.parse(item.options || "{}");
  } catch {
    return {};
  }
}

// Backs up every enabled item (or a subset). Only one run happens at a time,
// across the web app and CLI; a second caller gets { busy: true }.
export async function runBackup(opts: {
  trigger: string;
  tool?: string;
  itemIds?: number[];
  log?: (line: string) => void;
}): Promise<RunResult> {
  const log = opts.log ?? (() => {});
  let items = listItems({ tool: opts.tool, enabledOnly: !opts.itemIds });
  if (opts.itemIds) items = items.filter((i) => opts.itemIds!.includes(i.id));
  const scope = opts.itemIds ? `items:${opts.itemIds.join(",")}` : opts.tool ? `tool:${opts.tool}` : null;

  const run = startRun(opts.trigger, scope);
  if (!run) return { busy: true };

  const workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "tools-backup-"));
  const results: ItemResult[] = [];
  try {
    for (const item of items) {
      const r = await backupItem(item, run.id, workRoot);
      results.push(r);
      log(`${r.status.padEnd(9)} ${item.tool}/${item.label}  ${r.detail}`);
    }
  } finally {
    await fsp.rm(workRoot, { recursive: true, force: true });
    const ok = results.filter((r) => r.status !== "failed").length;
    finishRun(run.id, ok, results.length - ok);
  }
  return { runId: run.id, results };
}

async function backupItem(item: Item, runId: number, workRoot: string): Promise<ItemResult> {
  const startedAt = new Date();
  const workDir = await fsp.mkdtemp(path.join(workRoot, `${item.id}-`));
  const base = {
    run_id: runId,
    item_id: item.id,
    started_at: startedAt.toISOString(),
    s3_key: null as string | null,
    bytes: null as number | null,
    sha256: null as string | null,
    source_mtime: null as string | null,
    error: null as string | null,
    filename: null as string | null,
    compressed: 0,
  };
  try {
    const fetcher = getFetcher(item.fetcher);
    const snap = await fetcher.snapshot(item.path, parseOptions(item), workDir);
    const sha256 = await sha256File(snap.file);
    const sourceMtime = snap.sourceMtime?.toISOString() ?? null;

    const prev = lastUploaded(item.id);
    if (prev?.sha256 === sha256) {
      recordBackup({
        ...base,
        finished_at: new Date().toISOString(),
        status: "unchanged",
        s3_key: prev.s3_key,
        bytes: prev.bytes,
        sha256,
        source_mtime: sourceMtime,
        filename: prev.filename,
        compressed: prev.compressed,
      });
      return { item, status: "unchanged", detail: `same as ${prev.s3_key}` };
    }

    let file = snap.file;
    let uploadName = snap.filename;
    if (snap.compress) {
      file = `${snap.file}.gz`;
      uploadName = `${snap.filename}.gz`;
      await pipeline(fs.createReadStream(snap.file), zlib.createGzip({ level: 9 }), fs.createWriteStream(file));
    }
    const bytes = (await fsp.stat(file)).size;
    const stamp = startedAt.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
    const key = `${item.tool}/${slug(item.label)}/${stamp}__${uploadName}`;
    await upload(key, file, sha256);
    recordBackup({
      ...base,
      finished_at: new Date().toISOString(),
      status: "success",
      s3_key: key,
      bytes,
      sha256,
      source_mtime: sourceMtime,
      filename: snap.filename,
      compressed: snap.compress ? 1 : 0,
    });
    return { item, status: "success", detail: `${s3Uri(key)} (${bytes} bytes)` };
  } catch (e) {
    const error = (e as Error).message;
    recordBackup({ ...base, finished_at: new Date().toISOString(), status: "failed", error });
    return { item, status: "failed", detail: error };
  }
}

// Streams the newest uploaded copy of an item from S3, un-gzipped, as it was
// on disk. Used by download, preview and restore.
export async function openLatest(itemId: number): Promise<{ backup: Backup; filename: string; body: Readable }> {
  const backup = lastUploaded(itemId);
  if (!backup?.s3_key) throw new Error("No uploaded backup for this item yet");
  const raw = await getStream(backup.s3_key);
  // Rows written before migration 2 (or by an older build) have no filename;
  // for those, a .gz key means we compressed it.
  const compressed = backup.filename == null ? backup.s3_key.endsWith(".gz") : !!backup.compressed;
  const body = compressed ? raw.pipe(zlib.createGunzip()) : raw;
  raw.on("error", (e) => body.destroy(e));
  const filename =
    backup.filename ?? path.basename(backup.s3_key).replace(/^[^_]+__/, "").replace(compressed ? /\.gz$/ : /$^/, "");
  return { backup, filename, body };
}

// Downloads the newest uploaded copy of an item into `destDir`. Returns the
// path of the restored file.
export async function restoreLatest(itemId: number, destDir: string): Promise<{ file: string; key: string }> {
  const { backup, filename, body } = await openLatest(itemId);
  await fsp.mkdir(destDir, { recursive: true });
  const file = path.join(destDir, filename);
  await pipeline(body, fs.createWriteStream(file));
  return { file, key: backup.s3_key! };
}

// A test restore: fetch the newest copy from S3, confirm its checksum and, for
// databases, run SQLite's integrity check on it.
export async function verifyItem(itemId: number): Promise<{ ok: boolean; detail: string }> {
  const item = getItem(itemId);
  if (!item) throw new Error(`No item ${itemId}`);
  const prev = lastUploaded(itemId);
  if (!prev) return { ok: false, detail: "nothing uploaded yet" };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tools-backup-verify-"));
  try {
    const { file } = await restoreLatest(itemId, dir);
    const sha = await sha256File(file);
    if (sha !== prev.sha256) throw new Error(`checksum mismatch (expected ${prev.sha256?.slice(0, 12)}, got ${sha.slice(0, 12)})`);
    const fetcher = getFetcher(item.fetcher);
    const extra = fetcher.check ? `, ${await fetcher.check(file)}` : "";
    const detail = `OK: sha256 matches${extra}`;
    recordVerification(prev.id, detail);
    return { ok: true, detail };
  } catch (e) {
    const detail = `FAILED: ${(e as Error).message}`;
    recordVerification(prev.id, detail);
    return { ok: false, detail };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
