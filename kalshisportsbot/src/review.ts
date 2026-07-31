import { closingLineValue, readJournal, journalPath } from "./core/journal.js";
import { config } from "./config.js";
import { mapLimit } from "./kalshi/client.js";
import { parseDollars } from "./core/money.js";
import type { KalshiMarket } from "./kalshi/types.js";

/**
 * Scoring the bot against reality.
 *
 * The headline number here is closing line value, not win rate, and the
 * distinction is the whole point. Whether a bet won is mostly luck; you need
 * hundreds of settled bets before a win rate separates skill from variance, and
 * by then the season is over. CLV asks the sharper question — did the price
 * move toward us after we spoke? — and it answers on every single bet, win or
 * lose.
 *
 * A bot with consistently positive CLV has a real edge even during a losing
 * month. One with negative CLV does not have an edge, however well its picks
 * happen to be running. Trust this over the P&L.
 */

const pct = (x: number) => `${(x * 100).toFixed(2)}`;

const entries = readJournal();
if (entries.length === 0) {
  console.log(
    `\nNothing recorded yet at ${journalPath()}.\n` +
      "Run a scan that produces bets, then come back.\n",
  );
  process.exit(0);
}

console.log(`\nReviewing ${entries.length} recorded predictions…\n`);

// Fetch each market once, current price or final settlement.
const tickers = [...new Set(entries.map((e) => e.ticker))];
const snapshots = new Map<string, KalshiMarket | null>();

await mapLimit(tickers, 8, async (ticker) => {
  try {
    const response = await fetch(
      `${config.kalshi.base}/markets/${encodeURIComponent(ticker)}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) {
      snapshots.set(ticker, null);
      return;
    }
    const body = (await response.json()) as { market?: KalshiMarket };
    snapshots.set(ticker, body.market ?? null);
  } catch {
    snapshots.set(ticker, null);
  }
});

interface Scored {
  clv: number;
  settled: boolean;
  won: boolean;
  sources: string[];
}

const scored: Scored[] = [];

for (const entry of entries) {
  const market = snapshots.get(entry.ticker);
  if (!market) continue;

  const settled = market.status === "settled" || market.status === "finalized";
  const yesNow = parseDollars(market.last_price_dollars);
  if (!Number.isFinite(yesNow)) continue;

  // Convert to the price of the side we backed.
  const sidePrice = entry.side === "yes" ? yesNow : 1 - yesNow;
  const clv = closingLineValue(entry, sidePrice);

  const result = (market.result ?? "").toLowerCase();
  const won = settled && (entry.side === "yes" ? result === "yes" : result === "no");

  scored.push({ clv, settled, won, sources: entry.sources });
}

if (scored.length === 0) {
  console.log("No recorded markets could be matched back to Kalshi yet.\n");
  process.exit(0);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

const clvs = scored.map((s) => s.clv).filter(Number.isFinite);
const beat = clvs.filter((c) => c > 0).length;
const settledOnes = scored.filter((s) => s.settled);
const wins = settledOnes.filter((s) => s.won).length;

console.log("CLOSING LINE VALUE — the number that matters");
console.log(`  average CLV      ${pct(mean(clvs))} points per bet`);
console.log(`  beat the close   ${beat}/${clvs.length} (${pct(beat / clvs.length)}%)`);
console.log(
  `  read as          ${mean(clvs) > 0 ? "a real edge, if it holds" : "no demonstrated edge yet"}\n`,
);

if (settledOnes.length > 0) {
  console.log("SETTLED RESULTS — noisy, needs hundreds before it means much");
  console.log(`  record           ${wins}-${settledOnes.length - wins}\n`);
} else {
  console.log("No recorded bets have settled yet.\n");
}

// Per-source CLV: which signals are actually earning their weight?
const bySource = new Map<string, number[]>();
for (const s of scored) {
  for (const source of new Set(s.sources)) {
    if (source === "market") continue;
    const bucket = bySource.get(source) ?? [];
    bucket.push(s.clv);
    bySource.set(source, bucket);
  }
}

if (bySource.size > 0) {
  console.log("BY SIGNAL — raise the weight on what earns it, cut what doesn't");
  for (const [source, values] of [...bySource].sort((a, b) => mean(b[1]) - mean(a[1]))) {
    console.log(`  ${source.padEnd(16)} ${pct(mean(values)).padStart(6)} pts over ${values.length} bets`);
  }
  console.log();
}

console.log(
  "Sample sizes below ~30 say almost nothing. Let it run before changing weights.\n",
);
