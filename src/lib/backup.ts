import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import {
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
import { download, s3Uri, upload } from "./s3";

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
      });
      return { item, status: "unchanged", detail: `same as ${prev.s3_key}` };
    }

    let file = snap.file;
    let filename = snap.filename;
    if (snap.compress) {
      file = `${snap.file}.gz`;
      filename = `${snap.filename}.gz`;
      await pipeline(fs.createReadStream(snap.file), zlib.createGzip({ level: 9 }), fs.createWriteStream(file));
    }
    const bytes = (await fsp.stat(file)).size;
    const stamp = startedAt.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
    const key = `${item.tool}/${slug(item.label)}/${stamp}__${filename}`;
    await upload(key, file, sha256);
    recordBackup({
      ...base,
      finished_at: new Date().toISOString(),
      status: "success",
      s3_key: key,
      bytes,
      sha256,
      source_mtime: sourceMtime,
    });
    return { item, status: "success", detail: `${s3Uri(key)} (${bytes} bytes)` };
  } catch (e) {
    const error = (e as Error).message;
    recordBackup({ ...base, finished_at: new Date().toISOString(), status: "failed", error });
    return { item, status: "failed", detail: error };
  }
}

// Downloads the newest uploaded copy of an item to `dest` (a directory),
// un-gzipping it. Returns the path of the restored file.
export async function restoreLatest(itemId: number, destDir: string): Promise<{ file: string; key: string }> {
  const prev = lastUploaded(itemId);
  if (!prev?.s3_key) throw new Error("No uploaded backup for this item yet");
  await fsp.mkdir(destDir, { recursive: true });
  const name = path.basename(prev.s3_key).replace(/^[^_]+__/, "");
  const downloaded = path.join(destDir, name);
  await download(prev.s3_key, downloaded);
  // We gzip on upload unless the source already was compressed, in which case
  // the checksum (always of the uncompressed snapshot) matches as-is.
  if (!name.endsWith(".gz") || (await sha256File(downloaded)) === prev.sha256) {
    return { file: downloaded, key: prev.s3_key };
  }
  const file = downloaded.slice(0, -3);
  await pipeline(fs.createReadStream(downloaded), zlib.createGunzip(), fs.createWriteStream(file));
  await fsp.rm(downloaded);
  return { file, key: prev.s3_key };
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
