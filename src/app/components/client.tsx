"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition } from "react";
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

export function ItemActions({ id, enabled, removable, busy }: { id: number; enabled: boolean; removable: boolean; busy: boolean }) {
  const { pending, msg, run } = useAction();
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
      {removable && (
        <button
          className="danger"
          disabled={pending}
          onClick={() => confirm("Stop backing this up? Copies already in S3 are kept.") && run(() => removeItem(id))}
        >
          Remove
        </button>
      )}
      <Message msg={msg} />
    </div>
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
        Path on this server
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
