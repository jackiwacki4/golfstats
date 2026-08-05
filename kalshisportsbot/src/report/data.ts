import { closingLineValue, readJournal, type JournalEntry } from "../core/journal.js";
import { config } from "../config.js";
import { mapLimit } from "../kalshi/client.js";
import { parseDollars } from "../core/money.js";
import type { KalshiMarket } from "../kalshi/types.js";

/**
 * Turning the journal into a story someone can read in two minutes.
 *
 * `npm run review` prints numbers for whoever built the thing. This is for
 * everyone else — the question isn't "what is the per-signal CLV" but "is this
 * working, and how would I know". So the shape here is deliberately narrative:
 * a verdict, the evidence for it, and the honest size of the sample it rests on.
 */

export interface ScoredBet {
  at: number;
  title: string;
  side: string;
  price: number;
  fair: number;
  clv: number;
  settled: boolean;
  won: boolean;
  stakeDollars: number;
  profitDollars: number | null;
  sources: string[];
}

export interface ReportData {
  generatedAt: number;
  bankroll: number;
  bets: ScoredBet[];
  totals: {
    recorded: number;
    scored: number;
    settled: number;
    wins: number;
    losses: number;
    beatClose: number;
    avgClv: number;
    totalStaked: number;
    netProfit: number;
    firstAt: number;
    lastAt: number;
  };
  /** Cumulative CLV after each bet, in order — the "is it working" curve. */
  curve: { index: number; at: number; cumulative: number }[];
  bySignal: { source: string; avgClv: number; count: number }[];
  /** Bets that haven't settled yet, newest first. */
  open: ScoredBet[];
}

const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

export async function buildReportData(): Promise<ReportData> {
  const entries = readJournal();
  const tickers = [...new Set(entries.map((e) => e.ticker))];

  // One lookup per market, not per bet — the same contract often gets
  // recommended on several consecutive scans.
  const snapshots = new Map<string, KalshiMarket | null>();
  await mapLimit(tickers, 8, async (ticker) => {
    try {
      const response = await fetch(
        `${config.kalshi.base}/markets/${encodeURIComponent(ticker)}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      snapshots.set(
        ticker,
        response.ok ? ((await response.json()) as { market?: KalshiMarket }).market ?? null : null,
      );
    } catch {
      snapshots.set(ticker, null);
    }
  });

  const bets: ScoredBet[] = [];
  for (const entry of entries) {
    const market = snapshots.get(entry.ticker);
    if (!market) continue;

    const yesNow = parseDollars(market.last_price_dollars);
    if (!Number.isFinite(yesNow)) continue;

    const settled = market.status === "settled" || market.status === "finalized";
    const result = (market.result ?? "").toLowerCase();
    const won = settled && (entry.side === "yes" ? result === "yes" : result === "no");

    const sidePrice = entry.side === "yes" ? yesNow : 1 - yesNow;
    const stake = entry.contracts * entry.price;

    bets.push({
      at: entry.at,
      title: entry.title,
      side: entry.side,
      price: entry.price,
      fair: entry.fair,
      clv: closingLineValue(entry, sidePrice),
      settled,
      won,
      stakeDollars: stake,
      profitDollars: settled
        ? won
          ? entry.contracts * (1 - entry.price)
          : -stake
        : null,
      sources: entry.sources.filter((s) => s !== "market"),
    });
  }

  bets.sort((a, b) => a.at - b.at);

  const clvs = bets.map((b) => b.clv).filter(Number.isFinite);
  const settledBets = bets.filter((b) => b.settled);

  let running = 0;
  const curve = bets
    .filter((b) => Number.isFinite(b.clv))
    .map((b, index) => {
      running += b.clv;
      return { index: index + 1, at: b.at, cumulative: running };
    });

  const bySignalMap = new Map<string, number[]>();
  for (const bet of bets) {
    for (const source of new Set(bet.sources)) {
      const bucket = bySignalMap.get(source) ?? [];
      bucket.push(bet.clv);
      bySignalMap.set(source, bucket);
    }
  }

  return {
    generatedAt: Date.now(),
    bankroll: config.bankroll,
    bets,
    totals: {
      recorded: entries.length,
      scored: bets.length,
      settled: settledBets.length,
      wins: settledBets.filter((b) => b.won).length,
      losses: settledBets.filter((b) => !b.won).length,
      beatClose: clvs.filter((c) => c > 0).length,
      avgClv: mean(clvs),
      totalStaked: bets.reduce((sum, b) => sum + b.stakeDollars, 0),
      netProfit: settledBets.reduce((sum, b) => sum + (b.profitDollars ?? 0), 0),
      firstAt: bets[0]?.at ?? 0,
      lastAt: bets[bets.length - 1]?.at ?? 0,
    },
    curve,
    bySignal: [...bySignalMap.entries()]
      .map(([source, values]) => ({
        source,
        avgClv: mean(values),
        count: values.length,
      }))
      .sort((a, b) => b.avgClv - a.avgClv),
    open: bets.filter((b) => !b.settled).reverse().slice(0, 12),
  };
}

/**
 * The headline verdict, in the language a reader without the code would use.
 *
 * Deliberately refuses to declare success on a small sample. Thirty bets is
 * where closing-line value starts to mean anything at all, and saying so is
 * more useful than a confident number resting on eleven.
 */
export function verdict(data: ReportData): {
  state: "working" | "early" | "not-working" | "no-data";
  headline: string;
  explanation: string;
} {
  const { scored, avgClv, beatClose } = data.totals;

  if (scored === 0) {
    return {
      state: "no-data",
      headline: "No track record yet",
      explanation:
        "The system hasn't recommended any bets that cleared its own bar. That's " +
        "normal early on — it only acts when it disagrees with the market for a " +
        "reason, and quiet days are the expected majority.",
    };
  }

  const beatRate = beatClose / scored;
  const points = avgClv * 100;

  if (scored < 30) {
    return {
      state: "early",
      headline: `Too early to call — ${scored} decision${scored === 1 ? "" : "s"} in`,
      explanation:
        `So far the price has moved our way on ${beatClose} of ${scored} positions ` +
        `(${(beatRate * 100).toFixed(0)}%), averaging ${points >= 0 ? "+" : ""}${points.toFixed(1)} ` +
        "points per bet. Below about thirty decisions that figure is mostly noise. " +
        "The number to watch is whether it holds as the count grows.",
    };
  }

  if (avgClv > 0.005 && beatRate > 0.52) {
    return {
      state: "working",
      headline: "The evidence points to a real edge",
      explanation:
        `Across ${scored} positions the market has moved toward our price ` +
        `${(beatRate * 100).toFixed(0)}% of the time, worth an average of ` +
        `+${points.toFixed(1)} points per bet. That is the measure professionals ` +
        "trust ahead of win-loss record, because it shows up long before results do.",
    };
  }

  return {
    state: "not-working",
    headline: "No demonstrated edge yet",
    explanation:
      `Across ${scored} positions the average movement is ${points >= 0 ? "+" : ""}${points.toFixed(1)} ` +
      "points per bet, which is not distinguishable from getting the market price. " +
      "The system may still be profitable by luck over short stretches; that is not " +
      "the same as an edge, and it should not be funded as if it were.",
  };
}
