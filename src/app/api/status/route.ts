import { NextResponse } from "next/server";
import { latestBackups, listItems, recentRuns } from "@/lib/db";

export const dynamic = "force-dynamic";

// Compact status for dashboards (e.g. a homepage tile): last run plus the last
// good backup of every item.
export function GET() {
  const latest = latestBackups();
  const items = listItems().map((i) => {
    const b = latest.get(i.id);
    return {
      id: i.id,
      tool: i.tool,
      label: i.label,
      enabled: !!i.enabled,
      lastStatus: b?.last?.status ?? null,
      lastError: b?.last?.error ?? null,
      lastBackupAt: b?.lastGood?.started_at ?? null,
      bytes: b?.lastGood?.bytes ?? null,
      s3Key: b?.lastGood?.s3_key ?? null,
    };
  });
  const [lastRun] = recentRuns(1);
  const failing = items.filter((i) => i.enabled && i.lastStatus === "failed").length;
  return NextResponse.json({ ok: failing === 0, failing, lastRun: lastRun ?? null, items });
}
