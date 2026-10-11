"use client";

import { useRouter } from "next/navigation";
import { Download, Eye, Trash2, X } from "lucide-react";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { type ActionState, addItemAction, removeItem, startBackup, toggleItem, verify } from "../actions";

export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}

function useAction() {
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<ActionState>({});
  const run = (fn: () => Promise<ActionState | void>) =>
    startTransition(async () => setMsg((await fn()) ?? {}));
  return { pending, msg, run };
}

function Message({ msg }: { msg: ActionState }) {
  if (msg.error) return <span className="msg err">{msg.error}</span>;
  if (msg.ok) return <span className="msg ok">{msg.ok}</span>;
  return null;
}

export function BackupButton({
  tool,
  itemId,
  disabled,
  children,
  primary,
}: {
  tool?: string;
  itemId?: number;
  disabled?: boolean;
  children: React.ReactNode;
  primary?: boolean;
}) {
  const { pending, msg, run } = useAction();
  return (
    <span className="action">
      <button
        className={primary ? "primary" : undefined}
        disabled={disabled || pending}
        onClick={() => run(() => startBackup({ tool, itemId }))}
      >
        {pending ? "Starting…" : children}
      </button>
      {msg.error && <Message msg={msg} />}
    </span>
  );
}

export function ItemActions({
  id,
  label,
  enabled,
  removable,
  busy,
  previewable,
  hasCopy,
}: {
  id: number;
  label: string;
  enabled: boolean;
  removable: boolean;
  busy: boolean;
  previewable: boolean;
  hasCopy: boolean;
}) {
  const { pending, msg, run } = useAction();
  const [previewing, setPreviewing] = useState(false);
  const noCopy = "Nothing backed up yet";
  return (
    <div className="item-actions">
      <BackupButton itemId={id} disabled={busy}>
        Back up
      </BackupButton>
      <button disabled={pending} onClick={() => run(() => verify(id))} title="Download the newest copy from S3 and check it">
        {pending ? "Checking…" : "Verify"}
      </button>
      <button disabled={pending} onClick={() => run(() => toggleItem(id, !enabled))}>
        {enabled ? "Disable" : "Enable"}
      </button>
      {previewable && (
        <button
          className="icon"
          onClick={() => setPreviewing(true)}
          title="View the current file"
          aria-label={`View ${label}`}
        >
          <Eye size={16} />
        </button>
      )}
      {hasCopy ? (
        <a
          className="button icon"
          href={`/api/items/${id}/download`}
          download
          title="Download the newest backed-up copy"
          aria-label={`Download ${label}`}
        >
          <Download size={16} />
        </a>
      ) : (
        <button className="icon" disabled title={noCopy} aria-label={`Download ${label}`}>
          <Download size={16} />
        </button>
      )}
      {removable && (
        <button
          className="icon danger"
          disabled={pending}
          title="Stop backing this up"
          aria-label={`Remove ${label}`}
          onClick={() => confirm(`Stop backing up ${label}? Copies already in S3 are kept.`) && run(() => removeItem(id))}
        >
          <Trash2 size={16} />
        </button>
      )}
      <Message msg={msg} />
      {previewing && <Preview id={id} label={label} hasCopy={hasCopy} onClose={() => setPreviewing(false)} />}
    </div>
  );
}

type PreviewData = { path: string; modifiedAt: string; text: string; truncated: boolean } | { error: string };

function Preview({ id, label, hasCopy, onClose }: { id: number; label: string; hasCopy: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<PreviewData | null>(null);
  useEffect(() => {
    ref.current?.showModal();
    fetch(`/api/items/${id}/preview`)
      .then((r) => r.json())
      .then(setData, (e: Error) => setData({ error: e.message }));
  }, [id]);
  return (
    <dialog
      ref={ref}
      className="preview"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current.close()}
    >
      <div className="preview-head">
        <div>
          <strong>{label}</strong>
          {data && "path" in data && (
            <div className="sub">
              {data.path} · current file, changed {new Date(data.modifiedAt).toLocaleString()}
            </div>
          )}
        </div>
        {hasCopy && (
          <a
            className="button icon"
            href={`/api/items/${id}/download`}
            download
            title="Download the newest backed-up copy"
            aria-label={`Download ${label}`}
          >
            <Download size={16} />
          </a>
        )}
        <button className="icon" onClick={() => ref.current?.close()} title="Close" aria-label="Close">
          <X size={16} />
        </button>
      </div>
      {!data ? (
        <p className="sub">Loading…</p>
      ) : "error" in data ? (
        <p className="err">{data.error}</p>
      ) : (
        <>
          <pre>{data.text}</pre>
          {data.truncated && <p className="sub">Showing the first 512 KB.</p>}
        </>
      )}
    </dialog>
  );
}

export function AddItemForm({
  tools,
  fetchers,
}: {
  tools: string[];
  fetchers: { id: string; label: string; description: string; pathHint: string }[];
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addItemAction, {});
  const [fetcher, setFetcher] = useState("auto");
  const hint = fetchers.find((f) => f.id === fetcher);
  return (
    <form action={action} className="add-form">
      <label>
        Tool
        <input name="tool" list="tool-names" required placeholder="oscars-db" pattern="[a-z0-9][a-z0-9._\-]*" />
        <datalist id="tool-names">
          {tools.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </label>
      <label className="wide">
        <span>Path on this server <small>(or container:/path)</small></span>
        <input name="path" required placeholder={hint?.pathHint ?? "/path/to/app.db, .env or Backups folder"} />
      </label>
      <label>
        Type
        <select name="fetcher" value={fetcher} onChange={(e) => setFetcher(e.target.value)}>
          <option value="auto">Detect automatically</option>
          {fetchers.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Label <small>(optional)</small></span>
        <input name="label" placeholder="defaults to file name" />
      </label>
      {(fetcher === "auto" || fetcher === "latest-in-dir") && (
        <label>
          <span>Pattern <small>(folders only)</small></span>
          <input name="pattern" placeholder="*.zip" />
        </label>
      )}
      {fetcher === "docker-dir" && (
        <label>
          <span>Exclude <small>(tar patterns)</small></span>
          <input name="exclude" placeholder="plugins, war, jobs/*/builds" />
        </label>
      )}
      <div className="form-foot">
        <button className="primary" disabled={pending}>
          {pending ? "Checking…" : "Add"}
        </button>
        <span className="hint">{hint?.description ?? "Folders take the newest file, SQLite files use the backup API, anything else is copied."}</span>
        <Message msg={state} />
      </div>
    </form>
  );
}
