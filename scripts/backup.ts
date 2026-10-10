// Runs a backup. Used by the systemd timer, and handy by hand:
//   npm run backup                     everything enabled
//   npm run backup -- --tool oscars-db one tool
//   npm run backup -- --item 3         one item (even if disabled)
import { parseArgs } from "node:util";
import { runBackup } from "../src/lib/backup";

const { values } = parseArgs({
  options: {
    tool: { type: "string" },
    item: { type: "string", multiple: true },
    trigger: { type: "string", default: "cli" },
  },
});

const result = await runBackup({
  trigger: values.trigger!,
  tool: values.tool,
  itemIds: values.item?.map(Number),
  log: (l) => console.log(l),
});

if ("busy" in result) {
  console.error("Another backup run is in progress.");
  process.exit(2);
}
const failed = result.results.filter((r) => r.status === "failed").length;
console.log(`Run ${result.runId}: ${result.results.length - failed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
