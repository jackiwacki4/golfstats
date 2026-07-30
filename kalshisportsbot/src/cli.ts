import { runScan } from "./engine/scan.js";

/** Terminal view of the same scan the dashboard runs — handy for cron or a quick look. */

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const cents = (x: number) => `${(x * 100).toFixed(0)}c`;

const minEdgeArg = flag("min-edge");
const categoriesArg = flag("categories");

const result = await runScan({
  minEdge: minEdgeArg ? Number(minEdgeArg) / 100 : undefined,
  categories: categoriesArg?.split(","),
  maxResults: Number(flag("limit") ?? 15),
});

console.log(
  `\nScanned ${result.stats.marketsScanned} markets across ${result.stats.eventsScanned} events ` +
    `in ${(result.durationMs / 1000).toFixed(1)}s — ` +
    `${result.stats.marketsWithSignal} had an independent signal.\n`,
);

if (result.arbitrage.length > 0) {
  console.log("STRUCTURAL EDGES");
  for (const arb of result.arbitrage.slice(0, 5)) {
    const status = arb.requiresExhaustive
      ? `CONDITIONAL — loses if "none of the above" exceeds ${pct(arb.breakEvenFieldProbability)}`
      : "LOCKED IN";
    console.log(
      `  [${arb.kind}] ${arb.eventTitle.slice(0, 60)}\n` +
        `    cost $${arb.costPerSet.toFixed(2)} -> pays $${arb.payoutPerSet.toFixed(2)} ` +
        `(+${pct(arb.returnOnCost)}), ${arb.legs.length} legs\n` +
        `    ${status}\n`,
    );
  }
}

if (result.bets.length === 0) {
  console.log("No bets cleared the edge bar. That is a fine outcome — sit it out.\n");
} else {
  console.log(`TOP ${result.bets.length} BETS`);
  for (const [index, bet] of result.bets.entries()) {
    console.log(
      `\n ${index + 1}. ${bet.label} — ${bet.eventTitle.slice(0, 64)}\n` +
        `    buy ${bet.side.toUpperCase()} @ ${cents(bet.price)}  fair ${cents(bet.fair)}  ` +
        `net edge ${pct(bet.netEdge)}  conf ${pct(bet.confidence)}\n` +
        `    stake ${bet.stake.contracts} contracts ($${bet.stake.costDollars.toFixed(2)}) ` +
        `-> win +$${bet.stake.winProfitDollars.toFixed(2)} / lose -$${bet.stake.lossDollars.toFixed(2)}\n` +
        `    ${bet.ticker}${bet.flags.length ? `  [${bet.flags.join(", ")}]` : ""}`,
    );
    for (const contribution of bet.contributions) {
      if (contribution.source === "market") continue;
      console.log(`      - ${contribution.source}: ${contribution.rationale}`);
    }
  }
  console.log();
}

for (const note of result.notes) console.log(`note: ${note}`);
console.log();
