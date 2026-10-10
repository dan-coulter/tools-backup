import { parseOptions } from "@/lib/backup";
import { type Backup, type Item, SELF_TOOL, activeRun, lastUploaded, latestBackups, listItems, recentRuns } from "@/lib/db";
import { FETCHERS, getFetcher } from "@/lib/fetchers";
import { bucket } from "@/lib/s3";
import { AddItemForm, AutoRefresh, BackupButton, ItemActions } from "./components/client";

export const dynamic = "force-dynamic";

function bytes(n?: number | null) {
  if (n == null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${units[i]}`;
}

function ago(iso?: string | null) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function When({ iso }: { iso?: string | null }) {
  return <time title={iso ?? undefined}>{ago(iso)}</time>;
}

// Over two days without a good backup is worth flagging; the timer runs daily.
const STALE_MS = 48 * 3600 * 1000;

async function Row({ item, last, lastGood, busy }: { item: Item; last?: Backup; lastGood?: Backup; busy: boolean }) {
  const source = await getFetcher(item.fetcher)
    .inspect(item.path, parseOptions(item))
    .catch((e: Error) => ({ ok: false, detail: e.message, mtime: undefined }));
  const stale = !lastGood || Date.now() - new Date(lastGood.started_at).getTime() > STALE_MS;
  const state = !item.enabled ? "off" : last?.status === "failed" || !source.ok ? "bad" : stale ? "warn" : "good";
  const pattern = parseOptions(item).pattern;
  const uploaded = lastUploaded(item.id);
  return (
    <tr className={item.enabled ? undefined : "disabled"}>
      <td>
        <span className={`dot ${state}`} />
      </td>
      <td>
        <div className="label">{item.label}</div>
        <div className="path" title={item.path}>
          {item.path}
          {pattern ? ` (${pattern})` : ""}
        </div>
        <div className={`source ${source.ok ? "" : "err"}`}>
          {source.ok ? (
            <>
              {source.detail}
              {source.mtime && <> · changed <When iso={source.mtime.toISOString()} /></>}
            </>
          ) : (
            `Source problem: ${source.detail}`
          )}
        </div>
      </td>
      <td className="type">{getFetcher(item.fetcher).label}</td>
      <td>
        <div>
          <When iso={lastGood?.started_at} />
        </div>
        {lastGood && <div className="sub">{bytes(lastGood.bytes)}{lastGood.status === "unchanged" ? " · unchanged" : ""}</div>}
        {last?.status === "failed" && (
          <div className="err" title={last.error ?? ""}>
            Failed <When iso={last.started_at} />: {last.error}
          </div>
        )}
        {uploaded?.verified_at ? (
          <div className={`sub ${uploaded.verify_detail?.startsWith("OK") ? "" : "err"}`} title={uploaded.verify_detail ?? ""}>
            Restore tested <When iso={uploaded.verified_at} />
            {uploaded.verify_detail?.startsWith("OK") ? "" : `: ${uploaded.verify_detail}`}
          </div>
        ) : null}
        {lastGood?.s3_key && (
          <div className="sub key" title={`s3://${bucket()}/${lastGood.s3_key}`}>
            {lastGood.s3_key.split("/").pop()}
          </div>
        )}
      </td>
      <td>
        <ItemActions
          id={item.id}
          label={item.label}
          enabled={!!item.enabled}
          removable={item.tool !== SELF_TOOL}
          busy={busy}
          previewable={item.fetcher === "file"}
          hasCopy={!!uploaded}
        />
      </td>
    </tr>
  );
}

export default async function Home() {
  const items = listItems();
  const latest = latestBackups();
  const running = activeRun();
  const runs = recentRuns(8);
  const busy = !!running;

  const byTool = new Map<string, Item[]>();
  for (const i of items) byTool.set(i.tool, [...(byTool.get(i.tool) ?? []), i]);

  return (
    <main>
      <AutoRefresh active={busy} />
      <header className="top">
        <div>
          <h1>Tools backup</h1>
          <p className="sub">
            {items.length} files across {byTool.size} tools → <code>s3://{bucket()}/</code>
          </p>
        </div>
        <BackupButton primary disabled={busy}>
          {busy ? "Backup running…" : "Back up everything"}
        </BackupButton>
      </header>

      {running && (
        <div className="banner">
          Backup #{running.id} running since <When iso={running.started_at} />
          {running.scope ? ` (${running.scope})` : ""}…
        </div>
      )}

      {[...byTool].map(([tool, toolItems]) => (
        <section key={tool} className="tool">
          <div className="tool-head">
            <h2>{tool}</h2>
            <code className="sub">s3://…/{tool}/</code>
            <BackupButton tool={tool} disabled={busy}>
              Back up {tool}
            </BackupButton>
          </div>
          <table>
            <thead>
              <tr>
                <th className="c-dot" />
                <th>File</th>
                <th className="c-type">Type</th>
                <th className="c-when">Last backed up</th>
                <th className="c-actions" />
              </tr>
            </thead>
            <tbody>
              {toolItems.map((i) => (
                <Row key={i.id} item={i} {...latest.get(i.id)} busy={busy} />
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <section className="tool">
        <h2>Add a file</h2>
        <AddItemForm
          tools={[...byTool.keys()]}
          fetchers={FETCHERS.map(({ id, label, description, pathHint }) => ({ id, label, description, pathHint }))}
        />
      </section>

      <section className="tool">
        <h2>Recent runs</h2>
        <table className="runs">
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>#{r.id}</td>
                <td>
                  <span className={`dot ${r.status === "success" ? "good" : r.status === "running" ? "warn" : "bad"}`} /> {r.status}
                </td>
                <td>{r.trigger}</td>
                <td>{r.scope ?? "everything"}</td>
                <td>
                  <When iso={r.started_at} />
                </td>
                <td>
                  {r.ok_count} ok{r.fail_count ? `, ${r.fail_count} failed` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
