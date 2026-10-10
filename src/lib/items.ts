import fs from "node:fs";
import path from "node:path";
import { addItem, type Item } from "./db";
import { detectFetcher, getFetcher } from "./fetchers";

// Shared by the UI form and the CLI. Validates the path with the fetcher
// before registering it, unless `force` is set.
export async function registerItem(input: {
  tool: string;
  path: string;
  fetcher?: string;
  label?: string;
  options?: Record<string, string>;
  force?: boolean;
}): Promise<{ item: Item; check: string }> {
  const tool = input.tool.trim().toLowerCase();
  const p = path.resolve(input.path.trim());
  if (!input.force && !fs.existsSync(p)) throw new Error(`${p} does not exist (or isn't readable)`);
  const fetcherId = !input.fetcher || input.fetcher === "auto" ? await detectFetcher(p) : input.fetcher;
  const fetcher = getFetcher(fetcherId);
  const options = Object.fromEntries(Object.entries(input.options ?? {}).filter(([, v]) => v));
  const check = await fetcher.inspect(p, options);
  if (!check.ok && !input.force) throw new Error(`${p}: ${check.detail}`);
  const label = input.label?.trim() || path.basename(p);
  const item = addItem({ tool, label, fetcher: fetcherId, path: p, options });
  return { item, check: check.detail };
}
