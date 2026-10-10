import { fileFetcher } from "./file";
import { latestInDirFetcher } from "./latest-in-dir";
import { sqliteFetcher } from "./sqlite";
import type { Fetcher } from "./types";

// To support a new way of getting files (ssh, HTTP, docker exec...), write a
// Fetcher and add it here. The UI, CLI and backup run pick it up automatically.
export const FETCHERS: Fetcher[] = [sqliteFetcher, fileFetcher, latestInDirFetcher];

export function getFetcher(id: string): Fetcher {
  const f = FETCHERS.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown fetcher "${id}". Known: ${FETCHERS.map((x) => x.id).join(", ")}`);
  return f;
}

export type { Fetcher, Snapshot } from "./types";

// Picks a fetcher from what's at `p`: folders get "newest file", files that
// start with the SQLite header get the backup API, everything else is copied.
export async function detectFetcher(p: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const st = await fs.stat(p);
  if (st.isDirectory()) return "latest-in-dir";
  const fh = await fs.open(p, "r");
  try {
    const buf = Buffer.alloc(16);
    await fh.read(buf, 0, 16, 0);
    return buf.toString("latin1") === "SQLite format 3\0" ? "sqlite" : "file";
  } finally {
    await fh.close();
  }
}
