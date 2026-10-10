import fs from "node:fs/promises";
import path from "node:path";
import type { Fetcher } from "./types";

// A plain file: .env files, config.json, settings.json and the like.
export const fileFetcher: Fetcher = {
  id: "file",
  label: "File",
  description: "Copies a single file as-is. Use for env and config files, not live databases.",
  pathHint: "/path/to/.env",
  async inspect(p) {
    try {
      const st = await fs.stat(p);
      if (!st.isFile()) return { ok: false, detail: "not a regular file" };
      await fs.access(p, fs.constants.R_OK);
      return { ok: true, detail: "readable file", mtime: st.mtime, bytes: st.size };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  },
  async snapshot(p, _options, workDir) {
    const st = await fs.stat(p);
    // Keep dotfiles visible in S3 listings: ".env" -> "dot.env".
    const base = path.basename(p);
    const filename = base.startsWith(".") ? `dot${base}` : base;
    const out = path.join(workDir, filename);
    await fs.copyFile(p, out);
    return { file: out, filename, sourceMtime: st.mtime, compress: !/\.(zip|gz|tgz|xz|zst|bz2|7z)$/i.test(base) };
  },
};
