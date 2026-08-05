import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildReportData, verdict } from "./report/data.js";
import { renderReport } from "./report/render.js";

/** Writes a self-contained performance review you can open, print, or send on. */

const out = resolve(process.cwd(), "report.html");

console.log("\nScoring every recorded decision against the market…\n");
const data = await buildReportData();
writeFileSync(out, renderReport(data), "utf8");

const v = verdict(data);
console.log(`  ${v.headline}`);
console.log(`  ${data.totals.scored} decisions scored, ${data.totals.settled} resolved\n`);
console.log(`Written to ${out}`);
console.log("Open it with:  open report.html\n");
