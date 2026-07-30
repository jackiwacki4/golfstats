import { config } from "../config.js";
import { fetchOpenEvents } from "../kalshi/client.js";
import { slateWindow, type Horizon } from "../core/time.js";
import type { KalshiEvent } from "../kalshi/types.js";
import {
  isMultivariate,
  isTradeable,
  normalizeMarket,
  resolvesWithin,
  type MarketView,
} from "../core/market.js";
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

  /**
   * Whether this resolves on the current slate or is a longer-dated market that
   * cleared the much higher "screaming" bar to appear at all.
   */
  horizonKind: "day-of" | "future";
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
    futuresPromoted: number;
  };
  notes: string[];
  bankroll: number;
  slate: {
    horizon: Horizon;
    label: string;
    startMs: number;
    endMs: number;
    timezone: string;
    screamingEdge: number;
  };
}

export interface ScanOptions {
  /** Cap pages fetched; each page is up to 200 items. */
  maxPages?: number;
  /** Override the configured minimum net edge. */
  minEdge?: number;
  /** Only scan these categories (case-insensitive), e.g. ["Sports"]. */
  categories?: string[];
  maxResults?: number;
  /** Which slate to scan. Defaults to "today". */
  horizon?: Horizon;
  /**
   * Also surface longer-dated markets, but only ones clearing `screamingEdge`.
   * On by default: the point of a day-of board is focus, not blindness.
   */
  includeScreamingFutures?: boolean;
  /** Edge a future must clear to interrupt the day-of board. */
  screamingEdge?: number;
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
  horizonKind: "day-of" | "future",
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
    horizonKind,
  };
}

/**
 * Turn a batch of events into tradeable markets plus their structural signals.
 *
 * Shared by the day-of pass and the futures sweep so both get identical
 * treatment — only the edge bar applied afterwards differs.
 */
function collectFromEvents(
  events: KalshiEvent[],
  now: number,
  categoryFilter: string[] | undefined,
): {
  markets: MarketView[];
  structural: Map<string, ProbabilityEstimate>;
  arbitrage: ArbOpportunity[];
  marketsScanned: number;
} {
  const markets: MarketView[] = [];
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

    const views = (event.markets ?? [])
      .filter((m) => !isMultivariate(m))
      .map((m) => normalizeMarket(m, event));
    marketsScanned += views.length;

    const tradeable = views.filter((v) => isTradeable(v, now));
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

    markets.push(...tradeable);
  }

  return { markets, structural, arbitrage, marketsScanned };
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
  const horizon = options.horizon ?? "today";
  const screamingEdge = options.screamingEdge ?? config.screamingEdge;
  const includeFutures = options.includeScreamingFutures ?? true;
  // Default high enough to walk the entire board — see `fetchOpenEvents` for
  // why a truncated sweep silently loses today's sports.
  const maxPages = options.maxPages ?? 60;

  const window = slateWindow(horizon, config.timezone, new Date(startedAt));
  const categoryFilter = options.categories?.map((c) => c.toLowerCase());

  // --- The board ------------------------------------------------------------
  // One sweep of every open event, then split by resolution time. Kalshi's
  // cursor order is unrelated to when things resolve, so the whole board has to
  // be in hand before "today" means anything.
  const events = await fetchOpenEvents({ maxPages });
  const collected = collectFromEvents(events, startedAt, categoryFilter);

  const onSlate = (market: MarketView): boolean =>
    horizon === "all" || resolvesWithin(market, window.startMs, window.endMs);

  const slateTickers = new Set(
    collected.markets.filter(onSlate).map((m) => m.ticker),
  );

  // A day-of board that silently ignores a 20-point edge two weeks out would be
  // worse than useless, so longer-dated markets are still evaluated — they just
  // have to be loud enough to justify interrupting today's board.
  const allMarkets = includeFutures
    ? collected.markets
    : collected.markets.filter(onSlate);

  const structural = collected.structural;

  // --- Cross-book consensus, batched ---------------------------------------
  const { estimates: consensus, notes: consensusNotes } = await buildConsensus(allMarkets);
  notes.push(...consensusNotes);

  // --- Fuse and rank --------------------------------------------------------
  const bets: BetRecommendation[] = [];
  let marketsWithSignal = 0;
  let futuresPromoted = 0;

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

    const isSlate = slateTickers.has(market.ticker);
    const bar = isSlate ? minEdge : Math.max(minEdge, screamingEdge);

    for (const side of ["yes", "no"] as const) {
      const bet = evaluateSide(
        market,
        side,
        fused,
        startedAt,
        isSlate ? "day-of" : "future",
      );
      if (!bet || bet.netEdge < bar) continue;
      if (!isSlate) futuresPromoted++;
      bets.push(bet);
    }
  }

  // Day-of first: a future has to be genuinely exceptional to be here at all,
  // but today's board is still the point of the page.
  bets.sort((a, b) => {
    if (a.horizonKind !== b.horizonKind) return a.horizonKind === "day-of" ? -1 : 1;
    return b.score - a.score;
  });

  // Structural edges only count on the slate — a locked-in 2% return isn't
  // worth tying up capital until 2028.
  const arbitrage = collected.arbitrage
    .filter((a) => slateTickers.has(a.legs[0]?.ticker ?? ""))
    .sort((a, b) => b.returnOnCost - a.returnOnCost);

  if (horizon !== "all") {
    notes.push(
      `Slate: ${window.label} — markets closing before ` +
        `${new Date(window.endMs).toLocaleString("en-US", { timeZone: config.timezone })}.`,
    );
  }
  if (includeFutures && horizon !== "all") {
    notes.push(
      `Longer-dated markets included only above ${(screamingEdge * 100).toFixed(0)} points of net edge` +
        (futuresPromoted > 0 ? ` — ${futuresPromoted} cleared it.` : " — none cleared it."),
    );
  }
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
      marketsScanned: collected.marketsScanned,
      marketsTradeable: slateTickers.size,
      marketsWithSignal,
      consensusMatched: consensus.size,
      futuresPromoted,
    },
    notes,
    bankroll: config.bankroll,
    slate: {
      horizon,
      label: window.label,
      startMs: window.startMs,
      endMs: window.endMs,
      timezone: config.timezone,
      screamingEdge,
    },
  };
}

export { round2 };
