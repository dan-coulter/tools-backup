import fs from "node:fs/promises";
import path from "node:path";
import type { Fetcher } from "./types";

// Picks the newest file in a folder. Made for apps that write their own
// scheduled backups, like Sonarr/Radarr's Backups/scheduled/*.zip.
async function newest(dir: string, pattern: string) {
  const re = globToRegExp(pattern || "*");
  let best: { file: string; mtime: Date; bytes: number } | undefined;
  for (const name of await fs.readdir(dir)) {
    if (!re.test(name)) continue;
    const file = path.join(dir, name);
    const st = await fs.stat(file);
    if (st.isFile() && (!best || st.mtime > best.mtime)) best = { file, mtime: st.mtime, bytes: st.size };
  }
  return best;
}

function globToRegExp(glob: string) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export const latestInDirFetcher: Fetcher = {
  id: "latest-in-dir",
  label: "Newest file in folder",
  description: "Uploads the most recent matching file, e.g. an app's own scheduled backup zips.",
  pathHint: "/path/to/Backups/scheduled",
  options: [{ name: "pattern", label: "Filename pattern", placeholder: "*.zip" }],
  async inspect(dir, options) {
    try {
      const best = await newest(dir, options.pattern);
      if (!best) return { ok: false, detail: `no files matching ${options.pattern || "*"}` };
      return { ok: true, detail: `newest: ${path.basename(best.file)}`, mtime: best.mtime, bytes: best.bytes };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  },
  async snapshot(dir, options, workDir) {
    const best = await newest(dir, options.pattern);
    if (!best) throw new Error(`No files matching ${options.pattern || "*"} in ${dir}`);
    const filename = path.basename(best.file);
    const out = path.join(workDir, filename);
    await fs.copyFile(best.file, out);
    return { file: out, filename, sourceMtime: best.mtime, compress: !/\.(zip|gz|tgz|xz|zst|bz2|7z)$/i.test(filename) };
  },
};
