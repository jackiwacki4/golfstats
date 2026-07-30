import { config } from "../config.js";
import { fetchOpenEvents } from "../kalshi/client.js";
import { isTradeable, normalizeMarket, type MarketView } from "../core/market.js";
import { evPerContract, marginalFeeRate, round2, sizeStake, toAmericanOdds, type Stake } from "../core/money.js";
import { buildConsensus } from "../signals/consensus.js";
import { readMicrostructure, stalePriceEstimate } from "../signals/microstructure.js";
import { runModels } from "../signals/models.js";
import { findArbitrage, normalizeExclusiveSet, type ArbOpportunity } from "../signals/structural.js";
import type { ProbabilityEstimate } from "../signals/types.js";
import { fuse, type FusedEstimate } from "./fuse.js";

export interface BetRecommendation {
  ticker: string;
  eventTicker: string;
  seriesTicker: string;
  eventTitle: string;
  label: string;
  side: "yes" | "no";
  category: string;
  closeTime: number;

  /** What you pay per contract for this side. */
  price: number;
  /** Blended probability this side wins. */
  fair: number;
  /** fair - price, before fees. */
  rawEdge: number;
  /** fair - price - fees. This is the number that matters. */
  netEdge: number;
  evPerContract: number;
  americanOdds: number;
  fairAmericanOdds: number;

  stake: Stake;
  confidence: number;
  quality: number;
  score: number;
  flags: string[];
  contributions: FusedEstimate["contributions"];
}

export interface ScanResult {
  generatedAt: number;
  durationMs: number;
  bets: BetRecommendation[];
  arbitrage: ArbOpportunity[];
  stats: {
    eventsScanned: number;
    marketsScanned: number;
    marketsTradeable: number;
    marketsWithSignal: number;
    consensusMatched: number;
  };
  notes: string[];
  bankroll: number;
}

export interface ScanOptions {
  /** Cap pages of events fetched; each page is up to 200 events. */
  maxPages?: number;
  /** Override the configured minimum net edge. */
  minEdge?: number;
  /** Only scan these categories (case-insensitive), e.g. ["Sports"]. */
  categories?: string[];
  maxResults?: number;
}

/**
 * Evaluate one side of one market.
 *
 * Both sides get evaluated independently because they're genuinely different
 * trades. Buying NO at 0.62 is not the same bet as declining to buy YES at
 * 0.41 — the spread sits between them, and after fees only one side is usually
 * worth taking.
 */
function evaluateSide(
  market: MarketView,
  side: "yes" | "no",
  fused: FusedEstimate,
  now: number,
): BetRecommendation | null {
  const price = side === "yes" ? market.yesAsk : market.noAsk;
  if (!(price > 0 && price < 1)) return null;

  // Probability that *this side* wins.
  const fair = side === "yes" ? fused.fair : 1 - fused.fair;
  if (!Number.isFinite(fair)) return null;

  const rawEdge = fair - price;
  const netEdge = rawEdge - marginalFeeRate(price);
  if (netEdge <= 0) return null;

  const micro = readMicrostructure(market, side, now);
  const stake = sizeStake(fair, price, config.bankroll, config.kellyFraction);
  if (stake.contracts <= 0) return null;

  // Rank by edge, but discount hard for shaky evidence and unfillable books —
  // a huge edge in a market you can't trade is not a better bet than a modest
  // edge you can actually get filled on.
  const score = netEdge * (0.35 + 0.65 * fused.confidence) * (0.3 + 0.7 * micro.quality);

  return {
    ticker: market.ticker,
    eventTicker: market.eventTicker,
    seriesTicker: market.seriesTicker,
    eventTitle: market.eventTitle,
    label: side === "yes" ? market.yesLabel : `NOT ${market.yesLabel}`,
    side,
    category: market.category,
    closeTime: market.closeTime,

    price,
    fair,
    rawEdge,
    netEdge,
    evPerContract: evPerContract(fair, price),
    americanOdds: toAmericanOdds(price),
    fairAmericanOdds: toAmericanOdds(fair),

    stake,
    confidence: fused.confidence,
    quality: micro.quality,
    score,
    flags: micro.flags,
    contributions: fused.contributions,
  };
}

/**
 * Run a full scan: pull live markets, gather every signal, blend, rank.
 *
 * The order matters — consensus is fetched in one batch across all candidate
 * markets rather than per-market, because the Odds API bills per request and
 * per-market fetching would exhaust a month's quota in a single scan.
 */
export async function runScan(options: ScanOptions = {}): Promise<ScanResult> {
  const startedAt = Date.now();
  const notes: string[] = [];
  const minEdge = options.minEdge ?? config.minEdge;

  const events = await fetchOpenEvents({ maxPages: options.maxPages ?? 6 });

  const categoryFilter = options.categories?.map((c) => c.toLowerCase());

  // --- Normalize, and collect structural signals per event ------------------
  const allMarkets: MarketView[] = [];
  const structural = new Map<string, ProbabilityEstimate>();
  const arbitrage: ArbOpportunity[] = [];
  let marketsScanned = 0;

  for (const event of events) {
    if (
      categoryFilter &&
      !categoryFilter.includes((event.category ?? "").toLowerCase())
    ) {
      continue;
    }

    const views = (event.markets ?? []).map((m) => normalizeMarket(m, event));
    marketsScanned += views.length;

    const tradeable = views.filter((v) => isTradeable(v, startedAt));
    if (tradeable.length === 0) continue;

    arbitrage.push(
      ...findArbitrage(
        event.event_ticker,
        event.title,
        tradeable,
        Boolean(event.mutually_exclusive),
      ),
    );

    if (event.mutually_exclusive && tradeable.length === views.length) {
      for (const [ticker, estimate] of normalizeExclusiveSet(tradeable)) {
        structural.set(ticker, estimate);
      }
    }

    allMarkets.push(...tradeable);
  }

  // --- Cross-book consensus, batched ---------------------------------------
  const { estimates: consensus, notes: consensusNotes } = await buildConsensus(allMarkets);
  notes.push(...consensusNotes);

  // --- Fuse and rank --------------------------------------------------------
  const bets: BetRecommendation[] = [];
  let marketsWithSignal = 0;

  for (const market of allMarkets) {
    const estimates: ProbabilityEstimate[] = [];

    const structuralEstimate = structural.get(market.ticker);
    if (structuralEstimate) estimates.push(structuralEstimate);

    const consensusEstimate = consensus.get(market.ticker);
    if (consensusEstimate) estimates.push(consensusEstimate);

    estimates.push(...runModels(market));

    const yesRead = readMicrostructure(market, "yes", startedAt);
    const stale = stalePriceEstimate(market, yesRead, startedAt);
    if (stale) estimates.push(stale);

    if (estimates.length === 0) continue;
    marketsWithSignal++;

    const fused = fuse(market, estimates);
    if (!fused.hasIndependentSignal || !Number.isFinite(fused.fair)) continue;

    for (const side of ["yes", "no"] as const) {
      const bet = evaluateSide(market, side, fused, startedAt);
      if (bet && bet.netEdge >= minEdge) bets.push(bet);
    }
  }

  bets.sort((a, b) => b.score - a.score);
  arbitrage.sort((a, b) => b.returnOnCost - a.returnOnCost);

  if (bets.length === 0 && marketsWithSignal > 0) {
    notes.push(
      `No market cleared the ${(minEdge * 100).toFixed(1)}-point net-edge bar. ` +
        "That is a normal result — an efficient board means no bet is the right call.",
    );
  }

  return {
    generatedAt: startedAt,
    durationMs: Date.now() - startedAt,
    bets: bets.slice(0, options.maxResults ?? 40),
    arbitrage: arbitrage.slice(0, 20),
    stats: {
      eventsScanned: events.length,
      marketsScanned,
      marketsTradeable: allMarkets.length,
      marketsWithSignal,
      consensusMatched: consensus.size,
    },
    notes,
    bankroll: config.bankroll,
  };
}

export { round2 };
