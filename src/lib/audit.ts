// Finds what the checklist in ~/claude/CLAUDE.md missed: Caddy sites that aren't on the
// dashboard (and the reverse), databases and env files that aren't registered here, and
// registered items without a recent good backup. scripts/audit.ts gathers the inputs.
import fs from "node:fs";
import path from "node:path";
import type { Backup, Item } from "./db";

/** File names that hold data or secrets only this machine has. */
export const CANDIDATE_NAME = /(\.db|\.sqlite|\.sqlite3)$|^\.env(\.local)?$/;
/** Folders never worth looking in: rebuilt, vendored, or a tool's own backups. */
export const PRUNE_DIRS = new Set(["node_modules", ".next", ".git", ".swc", "coverage"]);
const PRUNE_SUFFIXES = [`${path.sep}data${path.sep}backups`];

export type AllowEntry = { pattern: string; reason: string; regex: RegExp };

/**
 * One entry per line: `<pattern>  # why`. A pattern is an absolute path (`*` matches
 * within a folder, `**` across folders), `caddy:<subdomain>` for a site that stays off
 * the dashboard, or `dashboard:<subdomain>` for a link with no Caddy site.
 */
export function parseAllowlist(text: string): AllowEntry[] {
  const out: AllowEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const hash = line.indexOf(" #");
    const pattern = (hash === -1 ? line : line.slice(0, hash)).trim();
    const reason = hash === -1 ? "" : line.slice(hash + 2).trim();
    out.push({ pattern, reason, regex: globToRegex(pattern) });
  }
  return out;
}

export function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Subdomains from `@name host <sub>.{$DOMAIN}` lines. */
export function caddySubdomains(caddyfile: string): string[] {
  const out = new Set<string>();
  for (const m of caddyfile.matchAll(/^\s*@\S+\s+host\s+(.+)$/gm)) {
    for (const h of m[1].trim().split(/\s+/)) {
      const sub = /^([a-z0-9-]+)\.\{\$DOMAIN\}$/i.exec(h);
      if (sub) out.add(sub[1]);
    }
  }
  return [...out].sort();
}

/** `subdomain: '<sub>'` values in tools-dashboard's services.ts. */
export function dashboardSubdomains(servicesTs: string): string[] {
  const out = new Set<string>();
  for (const m of servicesTs.matchAll(/\bsubdomain:\s*['"`]([^'"`]+)['"`]/gm)) out.add(m[1]);
  return [...out].sort();
}

/** Every candidate file under `root`, at most `maxDepth` folders down. Unreadable folders are skipped. */
export function findCandidates(root: string, maxDepth = Infinity): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (PRUNE_DIRS.has(e.name) || PRUNE_SUFFIXES.some((s) => p.endsWith(s))) continue;
        if (depth < maxDepth) walk(p, depth + 1);
      } else if (e.isFile() && CANDIDATE_NAME.test(e.name)) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

export type ToolUnit = { name: string; environmentFiles: string[] };

/**
 * Services from a systemd unit folder that run one of the tools (their working
 * directory or command is under /opt or /home), with their EnvironmentFile= paths.
 */
export function toolUnits(unitDir: string): ToolUnit[] {
  const out: ToolUnit[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(unitDir).filter((f) => f.endsWith(".service"));
  } catch {
    return out;
  }
  for (const f of files.sort()) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(unitDir, f), "utf8");
    } catch {
      continue;
    }
    if (!/^(WorkingDirectory|ExecStart)=\S*\s*(\/opt\/|\/home\/)/m.test(text)) continue;
    const environmentFiles = [...text.matchAll(/^EnvironmentFile=-?(\S+)/gm)].map((m) => m[1]);
    out.push({ name: f.replace(/\.service$/, ""), environmentFiles });
  }
  return out;
}

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Fetchers whose path is a folder, so they cover the files in it. */
const FOLDER_FETCHERS = new Set(["latest-in-dir"]);

/** Whether an enabled item backs up `file`. */
export function isRegistered(file: string, items: Item[]): boolean {
  const target = real(file);
  return items.some((i) => {
    if (!i.enabled || i.path.includes(":")) return false;
    const p = real(i.path);
    return p === target || (FOLDER_FETCHERS.has(i.fetcher) && target.startsWith(p + path.sep));
  });
}

export type AuditInput = {
  caddySubdomains: string[];
  dashboardSubdomains: string[];
  candidates: string[];
  items: Item[];
  latest: Map<number, { last?: Backup; lastGood?: Backup }>;
  allowlist: AllowEntry[];
  now: Date;
  maxAgeHours: number;
};

export type AuditResult = {
  notOnDashboard: string[];
  notInCaddy: string[];
  unregistered: string[];
  disabled: Item[];
  stale: { item: Item; lastGood?: string; error?: string | null }[];
  /** Allowlist entries that matched nothing, so they can be removed. */
  unusedAllow: AllowEntry[];
  /** Allowlist entries without a `# reason`. */
  unexplainedAllow: AllowEntry[];
};

export function audit(input: AuditInput): AuditResult {
  const used = new Set<AllowEntry>();
  const allowed = (key: string) => {
    const hit = input.allowlist.find((a) => a.regex.test(key));
    if (hit) used.add(hit);
    return !!hit;
  };

  const caddy = new Set(input.caddySubdomains);
  const dash = new Set(input.dashboardSubdomains);
  const notOnDashboard = input.caddySubdomains.filter((s) => !dash.has(s) && !allowed(`caddy:${s}`));
  const notInCaddy = input.dashboardSubdomains.filter((s) => !caddy.has(s) && !allowed(`dashboard:${s}`));

  const unregistered = [...new Set(input.candidates.map((c) => path.resolve(c)))]
    .sort()
    .filter((c) => !isRegistered(c, input.items) && !allowed(c));

  const disabled = input.items.filter((i) => !i.enabled && !allowed(i.path));

  const cutoff = input.now.getTime() - input.maxAgeHours * 3600_000;
  const stale = input.items
    .filter((i) => i.enabled)
    .flatMap((item) => {
      const b = input.latest.get(item.id);
      const good = b?.lastGood?.started_at;
      if (good && Date.parse(good) >= cutoff) return [];
      return [{ item, lastGood: good, error: b?.last?.status === "failed" ? b.last.error : null }];
    });

  return {
    notOnDashboard,
    notInCaddy,
    unregistered,
    disabled,
    stale,
    unusedAllow: input.allowlist.filter((a) => !used.has(a)),
    unexplainedAllow: input.allowlist.filter((a) => !a.reason),
  };
}

export function hasGaps(r: AuditResult): boolean {
  return !!(r.notOnDashboard.length || r.notInCaddy.length || r.unregistered.length || r.disabled.length || r.stale.length);
}

export function formatAudit(r: AuditResult, maxAgeHours: number): string {
  const lines: string[] = [];
  const section = (title: string, rows: string[], hint?: string) => {
    if (!rows.length) return;
    lines.push(`${title} (${rows.length}):`, ...rows.map((x) => `  - ${x}`));
    if (hint) lines.push(`  ${hint}`);
    lines.push("");
  };
  section(
    "Caddy sites missing from tools-dashboard services.ts",
    r.notOnDashboard,
    "Add them to tools-dashboard/src/lib/services.ts and merge to main, or allowlist `caddy:<sub>`.",
  );
  section("Dashboard links with no Caddy site", r.notInCaddy, "Fix the subdomain, or allowlist `dashboard:<sub>`.");
  section(
    "Databases and env files not registered with tools-backup",
    r.unregistered,
    "cd /opt/tools-backup && npm run -s items -- add <tool> <path>   (or allowlist the path, with a reason)",
  );
  section(
    "Registered but disabled",
    r.disabled.map((i) => `#${i.id} ${i.tool}/${i.label}  ${i.path}`),
    "npm run -s items -- enable <id>, or remove it.",
  );
  section(
    `No good backup in the last ${maxAgeHours} hours`,
    r.stale.map(
      (s) =>
        `#${s.item.id} ${s.item.tool}/${s.item.label}: last good ${s.lastGood ?? "never"}${s.error ? ` (last error: ${s.error})` : ""}`,
    ),
  );
  if (r.unusedAllow.length || r.unexplainedAllow.length) {
    lines.push("Allowlist warnings (not failures):");
    for (const a of r.unusedAllow) lines.push(`  - matches nothing, remove it: ${a.pattern}`);
    for (const a of r.unexplainedAllow) lines.push(`  - no "# reason": ${a.pattern}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
