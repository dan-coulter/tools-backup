"use server";

import { revalidatePath } from "next/cache";
import { runBackup, verifyItem } from "@/lib/backup";
import { activeRun, deleteItem, setItemEnabled } from "@/lib/db";
import { registerItem } from "@/lib/items";

export type ActionState = { ok?: string; error?: string };

// Starts a run in the background; the page polls while it's going.
export async function startBackup(scope: { tool?: string; itemId?: number }): Promise<ActionState> {
  if (activeRun()) return { error: "A backup is already running" };
  void runBackup({
    trigger: "manual",
    tool: scope.tool,
    itemIds: scope.itemId ? [scope.itemId] : undefined,
  }).catch((e) => console.error("backup run failed", e));
  // Give the run a moment to claim its slot so the refresh shows it.
  await new Promise((r) => setTimeout(r, 300));
  revalidatePath("/");
  return { ok: "Backup started" };
}

export async function verify(itemId: number): Promise<ActionState> {
  const r = await verifyItem(itemId);
  revalidatePath("/");
  return r.ok ? { ok: r.detail } : { error: r.detail };
}

export async function toggleItem(itemId: number, enabled: boolean) {
  setItemEnabled(itemId, enabled);
  revalidatePath("/");
}

export async function removeItem(itemId: number): Promise<ActionState> {
  try {
    deleteItem(itemId);
  } catch (e) {
    return { error: (e as Error).message };
  }
  revalidatePath("/");
  return {};
}

export async function addItemAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const s = (k: string) => String(form.get(k) ?? "").trim();
  try {
    const { item, check } = await registerItem({
      tool: s("tool"),
      path: s("path"),
      fetcher: s("fetcher") || "auto",
      label: s("label") || undefined,
      options: { pattern: s("pattern") },
    });
    revalidatePath("/");
    return { ok: `Added ${item.tool}/${item.label} as ${item.fetcher}: ${check}` };
  } catch (e) {
    const msg = (e as Error).message;
    return { error: msg.includes("UNIQUE") ? "That tool already has an item with this label" : msg };
  }
}
