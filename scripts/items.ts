// Manage what gets backed up. See README for examples.
import { parseArgs } from "node:util";
import { restoreLatest, verifyItem } from "../src/lib/backup";
import { deleteItem, latestBackups, listItems, setItemEnabled } from "../src/lib/db";
import { FETCHERS } from "../src/lib/fetchers";
import { registerItem } from "../src/lib/items";

const USAGE = `Usage:
  npm run items -- list [--tool <tool>]
  npm run items -- add <tool> <path> [--type auto|${FETCHERS.map((f) => f.id).join("|")}] [--label <name>] [--pattern '*.zip'] [--force]
  npm run items -- remove <id>
  npm run items -- enable <id> | disable <id>
  npm run items -- verify [<id>...]          test-restore the newest copy (all items if none given)
  npm run items -- restore <id> [--out <dir>] download the newest copy (default ./restore)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    tool: { type: "string" },
    type: { type: "string", default: "auto" },
    label: { type: "string" },
    pattern: { type: "string" },
    out: { type: "string", default: "restore" },
    force: { type: "boolean", default: false },
  },
});
const [cmd, ...args] = positionals;

process.on("uncaughtException", (e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});

function ago(iso?: string | null) {
  return iso ? iso.replace("T", " ").slice(0, 16) + "Z" : "never";
}

switch (cmd) {
  case "list": {
    const latest = latestBackups();
    for (const i of listItems({ tool: values.tool })) {
      const b = latest.get(i.id);
      const status = b?.last ? `${b.last.status}${b.last.error ? `: ${b.last.error}` : ""}` : "-";
      console.log(
        `#${String(i.id).padEnd(3)} ${i.enabled ? " " : "off"} ${`${i.tool}/${i.label}`.padEnd(40)} ${i.fetcher.padEnd(13)} last good ${ago(b?.lastGood?.started_at).padEnd(18)} ${status}\n      ${i.path}`,
      );
    }
    break;
  }
  case "add": {
    const [tool, p] = args;
    if (!tool || !p) throw new Error(USAGE);
    const { item, check } = await registerItem({
      tool,
      path: p,
      fetcher: values.type,
      label: values.label,
      options: values.pattern ? { pattern: values.pattern } : undefined,
      force: values.force,
    });
    console.log(`Added #${item.id} ${item.tool}/${item.label} (${item.fetcher}): ${check}`);
    break;
  }
  case "remove":
    deleteItem(Number(args[0]));
    console.log(`Removed #${args[0]}`);
    break;
  case "enable":
  case "disable":
    setItemEnabled(Number(args[0]), cmd === "enable");
    console.log(`${cmd}d #${args[0]}`);
    break;
  case "verify": {
    const ids = args.length ? args.map(Number) : listItems({ enabledOnly: true }).map((i) => i.id);
    let failed = 0;
    for (const id of ids) {
      const r = await verifyItem(id);
      if (!r.ok) failed++;
      const i = listItems().find((x) => x.id === id)!;
      console.log(`#${id} ${i.tool}/${i.label}: ${r.detail}`);
    }
    process.exit(failed ? 1 : 0);
  }
  case "restore": {
    const { file, key } = await restoreLatest(Number(args[0]), values.out!);
    console.log(`Restored ${key} -> ${file}`);
    break;
  }
  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}
