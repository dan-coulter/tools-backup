import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import path from "node:path";
import {
  audit,
  caddySubdomains,
  dashboardSubdomains,
  findCandidates,
  formatAudit,
  hasGaps,
  parseAllowlist,
  toolUnits,
  type AuditInput,
} from "@/lib/audit";
import type { Backup, Item } from "@/lib/db";
import { cleanup, tempDir, writeFile } from "@/test/helpers";

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => cleanup(dir));

const NOW = new Date("2026-10-16T12:00:00Z");

function item(id: number, p: string, extra: Partial<Item> = {}): Item {
  return {
    id,
    tool_id: 1,
    tool: "t",
    label: path.basename(p),
    fetcher: "file",
    path: p,
    options: "{}",
    enabled: 1,
    created_at: "",
    ...extra,
  };
}

function good(itemId: number, startedAt: string): Backup {
  return { item_id: itemId, started_at: startedAt, status: "success" } as Backup;
}

function input(over: Partial<AuditInput>): AuditInput {
  return {
    caddySubdomains: [],
    dashboardSubdomains: [],
    candidates: [],
    items: [],
    latest: new Map(),
    allowlist: [],
    now: NOW,
    maxAgeHours: 48,
    ...over,
  };
}

describe("caddySubdomains", () => {
  it("reads @name host lines, not the bare domain or wildcard", () => {
    const caddy = `{$DOMAIN} {\n}\n*.{$DOMAIN} {\n\t@plex host plex.{$DOMAIN}\n\thandle @plex {}\n\t@qbit host qbit.{$DOMAIN}\n}`;
    expect(caddySubdomains(caddy)).toEqual(["plex", "qbit"]);
  });
});

describe("dashboardSubdomains", () => {
  it("reads subdomain values and skips full hosts", () => {
    const ts = `  subdomain: string;\n  { subdomain: 'oscars',\n        subdomain: 'movies',\n        host: 'banjo.email',`;
    expect(dashboardSubdomains(ts)).toEqual(["movies", "oscars"]);
  });
});

describe("findCandidates", () => {
  it("finds databases and env files, skipping node_modules, .next and data/backups", () => {
    writeFile(dir, "a/data/app.db", "");
    writeFile(dir, "a/.env.local", "");
    writeFile(dir, "a/.env.example", "");
    writeFile(dir, "a/x.sqlite3", "");
    writeFile(dir, "a/node_modules/p/test.db", "");
    writeFile(dir, "a/.next/standalone/.env", "");
    writeFile(dir, "a/data/backups/app-1.db", "");
    expect(findCandidates(dir).map((f) => path.relative(dir, f)).sort()).toEqual([
      "a/.env.local",
      "a/data/app.db",
      "a/x.sqlite3",
    ]);
  });

  it("stops at maxDepth and ignores missing folders", () => {
    writeFile(dir, "top.db", "");
    writeFile(dir, "deep/inner.db", "");
    expect(findCandidates(dir, 0)).toEqual([path.join(dir, "top.db")]);
    expect(findCandidates(path.join(dir, "missing"))).toEqual([]);
  });
});

describe("toolUnits", () => {
  it("keeps services that run from /opt or /home, with their env files", () => {
    writeFile(dir, "app.service", "[Service]\nWorkingDirectory=/opt/app\nEnvironmentFile=-/opt/app/.deploy/env\n");
    writeFile(dir, "sys.service", "[Service]\nExecStart=/usr/bin/thing\n");
    expect(toolUnits(dir)).toEqual([{ name: "app", environmentFiles: ["/opt/app/.deploy/env"] }]);
  });
});

describe("audit", () => {
  it("compares Caddy and the dashboard both ways, minus the allowlist", () => {
    const r = audit(
      input({
        caddySubdomains: ["a", "b", "hidden"],
        dashboardSubdomains: ["a", "c"],
        allowlist: parseAllowlist("caddy:hidden  # internal only"),
      }),
    );
    expect(r.notOnDashboard).toEqual(["b"]);
    expect(r.notInCaddy).toEqual(["c"]);
  });

  it("flags files no enabled item covers", () => {
    const f = (n: string) => writeFile(dir, n, "");
    const [reg, inDir, off, loose, dev] = [f("reg.db"), f("backups/x.zip.db"), f("off.db"), f("loose.db"), f("dev/x.db")];
    const r = audit(
      input({
        candidates: [reg, inDir, off, loose, dev],
        items: [
          item(1, reg),
          item(2, path.join(dir, "backups"), { fetcher: "latest-in-dir" }),
          item(3, off, { enabled: 0 }),
        ],
        allowlist: parseAllowlist(`${dir}/dev/*  # dev copy`),
      }),
    );
    expect(r.unregistered).toEqual([loose, off]);
    expect(r.disabled.map((i) => i.id)).toEqual([3]);
  });

  it("flags enabled items without a good backup in the window", () => {
    const items = [item(1, "/a"), item(2, "/b"), item(3, "/c"), item(4, "/d", { enabled: 0 })];
    const latest = new Map([
      [1, { lastGood: good(1, "2026-10-15T04:30:00Z") }],
      [2, { lastGood: good(2, "2026-10-13T04:30:00Z"), last: { status: "failed", error: "boom" } as Backup }],
    ]);
    const r = audit(input({ items, latest }));
    expect(r.stale.map((s) => [s.item.id, s.lastGood, s.error])).toEqual([
      [2, "2026-10-13T04:30:00Z", "boom"],
      [3, undefined, null],
    ]);
    expect(hasGaps(r)).toBe(true);
    expect(formatAudit(r, 48)).toContain("#2 t/b: last good 2026-10-13T04:30:00Z (last error: boom)");
  });

  it("is clean when nothing is missing, and warns about unused or unexplained allowlist entries", () => {
    const r = audit(input({ allowlist: parseAllowlist("/nowhere/x.db\n# comment\n") }));
    expect(hasGaps(r)).toBe(false);
    expect(r.unusedAllow.map((a) => a.pattern)).toEqual(["/nowhere/x.db"]);
    expect(r.unexplainedAllow.map((a) => a.pattern)).toEqual(["/nowhere/x.db"]);
  });
});

describe("parseAllowlist", () => {
  it("matches * within a folder and ** across folders", () => {
    const [one, any] = parseAllowlist("/a/*.db  # x\n/b/**  # y");
    expect(one.regex.test("/a/x.db")).toBe(true);
    expect(one.regex.test("/a/s/x.db")).toBe(false);
    expect(any.regex.test("/b/s/t/x.db")).toBe(true);
    expect(one.reason).toBe("x");
  });
});
