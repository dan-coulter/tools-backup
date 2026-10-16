// Reports gaps in backups and the dashboard across the tools on plex.local. Exits 1 when
// anything is missing. Run nightly after the backup by deploy/audit-cron.sh; see README.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  audit,
  caddySubdomains,
  dashboardSubdomains,
  findCandidates,
  formatAudit,
  hasGaps,
  parseAllowlist,
  toolUnits,
} from "../src/lib/audit";
import { latestBackups, listItems } from "../src/lib/db";

const { values } = parseArgs({
  options: {
    "claude-dir": { type: "string", default: "/home/dan/claude" },
    "apps-dir": { type: "string", default: "/home/dan/apps" },
    "opt-dir": { type: "string", default: "/opt" },
    caddyfile: { type: "string" },
    // What's deployed, not a dev checkout that may be on a branch.
    services: { type: "string", default: "/opt/tools-dashboard/src/lib/services.ts" },
    allowlist: { type: "string", default: path.join(process.cwd(), "audit-allowlist.txt") },
    "max-age-hours": { type: "string", default: "48" },
  },
});

process.on("uncaughtException", (e) => {
  console.error(`Audit failed to run: ${e.message}`);
  process.exit(2);
});

const claudeDir = values["claude-dir"]!;
const maxAgeHours = Number(values["max-age-hours"]);
const read = (f: string) => fs.readFileSync(f, "utf8");
const subdirs = (dir: string) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
};
const exists = (f: string) => fs.existsSync(f);

// Tool names: projects in ~/claude, folders in /opt, and services that run from /opt or /home.
const units = toolUnits("/etc/systemd/system");
const names = new Set([...subdirs(claudeDir), ...subdirs(values["opt-dir"]!), ...units.map((u) => u.name)]);

const candidates = [
  ...findCandidates(claudeDir),
  ...findCandidates(values["apps-dir"]!, 3),
  ...subdirs(values["opt-dir"]!).flatMap((d) => findCandidates(path.join(values["opt-dir"]!, d), 3)),
  ...[...names].flatMap((n) => findCandidates(path.join("/var/lib", n), 0)),
  ...[...names].map((n) => path.join("/etc", n, "env")).filter(exists),
  ...units.flatMap((u) => u.environmentFiles).filter(exists),
];

const result = audit({
  caddySubdomains: caddySubdomains(read(values.caddyfile ?? path.join(claudeDir, "caddy", "Caddyfile"))),
  dashboardSubdomains: dashboardSubdomains(read(values.services!)),
  candidates,
  items: listItems(),
  latest: latestBackups(),
  allowlist: exists(values.allowlist!) ? parseAllowlist(read(values.allowlist!)) : [],
  now: new Date(),
  maxAgeHours,
});

const report = formatAudit(result, maxAgeHours);
if (hasGaps(result)) {
  console.log(`Tools audit: gaps found\n\n${report}`);
  process.exit(1);
}
console.log(`Tools audit: OK (${listItems().length} items, ${new Set(candidates).size} files checked)${report ? `\n\n${report}` : ""}`);
