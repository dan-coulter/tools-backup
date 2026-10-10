import { Readable } from "node:stream";
import { openLatest } from "@/lib/backup";
import { getItem } from "@/lib/db";

export const dynamic = "force-dynamic";

// The newest copy from S3, un-gzipped, as a file download.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const item = getItem(Number((await params).id));
  if (!item) return new Response("Not found", { status: 404 });
  try {
    const { filename, body } = await openLatest(item.id);
    // "dot.env" -> "arlo-snapshot.env", so several tools' env files don't collide.
    const name = filename.startsWith("dot.") ? `${item.tool}${filename.slice(3)}` : filename;
    return new Response(Readable.toWeb(body) as ReadableStream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return new Response((e as Error).message, { status: 404 });
  }
}
