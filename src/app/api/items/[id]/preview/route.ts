import fs from "node:fs/promises";
import { getItem } from "@/lib/db";

export const dynamic = "force-dynamic";

const MAX_BYTES = 512 * 1024;

// Text of a plain file (env, JSON, config...) as it is on disk right now.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const item = getItem(Number((await params).id));
  if (!item) return Response.json({ error: "Not found" }, { status: 404 });
  if (item.fetcher !== "file") return Response.json({ error: "Only plain files can be previewed" }, { status: 400 });
  try {
    const fh = await fs.open(item.path, "r");
    try {
      const { size, mtime } = await fh.stat();
      const buf = Buffer.alloc(Math.min(size, MAX_BYTES));
      await fh.read(buf, 0, buf.length, 0);
      if (buf.includes(0)) return Response.json({ error: "This file is binary" }, { status: 415 });
      return Response.json(
        { path: item.path, modifiedAt: mtime.toISOString(), text: buf.toString("utf8"), truncated: size > MAX_BYTES },
        { headers: { "Cache-Control": "no-store" } },
      );
    } finally {
      await fh.close();
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}
