import { config } from "../config.js";
import { fetchOpenEvents } from "../kalshi/client.js";
import { slateWindow, type Horizon } from "../core/time.js";
import type { KalshiEvent } from "../kalshi/types.js";
import {
  hasReliableMid,
  isMultivariate,
  isTradeable,
  normalizeMarket,
  MAX_RELIABLE_SPREAD,
  resolvesWithin,
  type MarketView,
} from "../core/market.js";
import { evPerContract, marginalFeeRate, round2, sizeStake, toAmericanOdds, type Stake } from "../core/money.js";
import { shrinkTowardMarket } from "../core/inference.js";
import { record } from "../core/journal.js";
import { feeFor, planExecution, type ExecutionPlan } from "../core/execution.js";
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

  /** How to get the position on, and what it costs each way. */
  execution: ExecutionPlan;

  /** How much of the raw disagreement with the crowd survived shrinkage. */
  shrinkage: {
    rawGap: number;
    shrunkGap: number;
    factor: number;
    implausible: boolean;
  };
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
  const takerPrice = side === "yes" ? market.yesAsk : market.noAsk;
  if (!(takerPrice > 0 && takerPrice < 1)) return null;

  const micro = readMicrostructure(market, side, now);

  // Shrink the disagreement with the crowd before anything downstream uses it.
  // Doing it here rather than at ranking time is deliberate: sizing, EV and the
  // edge bar all read from `fair`, so shrinking the estimate itself keeps them
  // consistent instead of leaving Kelly to stake against an unshrunk number.
  const shrunk = shrinkTowardMarket({
    fair: fused.fair,
    marketMid: market.mid,
    confidence: fused.confidence,
    quality: micro.quality,
    priorScale: config.edgePriorScale,
  });

  // Probability that *this side* wins.
  const fair = side === "yes" ? shrunk.fair : 1 - shrunk.fair;
  if (!Number.isFinite(fair)) return null;

  const execution = planExecution(market, side, fair, takerPrice, now);
  const price = execution.price;

  // Qualify on the taker price, always — even when we'd rather post.
  //
  // Crediting a resting order with the distance from its post price to the
  // midpoint is circular: on any wide market that "edge" is just half the
  // spread, conjured by the same quote that defined the midpoint. It fires on
  // every illiquid market regardless of whether anything is actually mispriced,
  // and it was manufacturing four-point edges out of a signal worth less than
  // one. Requiring the bet to stand up while crossing the spread separates a
  // genuine disagreement about the outcome from being paid to provide liquidity
  // — the second is a real strategy, but it isn't this one, and it shouldn't
  // borrow the first one's confidence.
  const rawEdge = fair - takerPrice;
  const netEdge = fair - takerPrice - marginalFeeRate(takerPrice);
  if (netEdge <= 0) return null;

  // Sized at the price actually paid: posting really does improve the trade,
  // it just doesn't get to be the reason for taking it.
  const stake = sizeStake(fair, price, config.bankroll, config.kellyFraction);
  if (stake.contracts <= 0) return null;

  // Rank by edge, discounted for unfillable books. Evidence strength is no
  // longer a multiplier here — it has already done its work inside the
  // shrinkage, which is a more honest place for it: weak evidence now reduces
  // the estimate itself rather than merely demoting a number we still bet on.
  const score = netEdge * (0.3 + 0.7 * micro.quality);

  const flags = [...micro.flags];
  if (shrunk.implausible) {
    flags.push(
      `${(Math.abs(shrunk.rawGap) * 100).toFixed(0)}-pt raw gap — verify both venues price the same question`,
    );
  }
  if (execution.style === "maker") flags.push("limit order — may not fill");

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
    flags,
    contributions: fused.contributions,
    horizonKind,
    execution,
    shrinkage: {
      rawGap: shrunk.rawGap,
      shrunkGap: shrunk.shrunkGap,
      factor: shrunk.factor,
      implausible: shrunk.implausible,
    },
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
/**
 * Cap correlated and total exposure, trimming the weakest bets first.
 *
 * Kelly sizes each bet as though it were the only one in the world, and that
 * assumption breaks hardest exactly where this bot is most likely to fire: five
 * recommendations on one baseball game are not five independent bets, they are
 * one bet on that game wearing five costumes. Sized individually they can add up
 * to a position far larger than Kelly would ever sanction, and if the game turns
 * they all lose together.
 *
 * Rather than model the correlation matrix — which would need joint
 * distributions the bot doesn't have — this applies the blunt, robust version: a
 * ceiling per event and a ceiling across the board. Bets are already ranked, so
 * trimming from the bottom keeps the strongest ones whole instead of shrinking
 * everything into insignificance.
 */
function applyExposureCaps(bets: BetRecommendation[], bankroll: number): string | null {
  const eventCap = bankroll * config.maxEventExposure;
  const boardCap = bankroll * config.maxBoardExposure;

  const perEvent = new Map<string, number>();
  let boardTotal = 0;
  let trimmed = 0;

  for (const bet of bets) {
    const spent = perEvent.get(bet.eventTicker) ?? 0;
    const room = Math.min(
      Math.max(0, eventCap - spent),
      Math.max(0, boardCap - boardTotal),
    );

    if (bet.stake.costDollars <= room) {
      perEvent.set(bet.eventTicker, spent + bet.stake.costDollars);
      boardTotal += bet.stake.costDollars;
      continue;
    }

    trimmed++;
    const contracts = bet.price > 0 ? Math.floor(room / bet.price) : 0;

    if (contracts <= 0) {
      bet.stake = {
        ...bet.stake,
        contracts: 0,
        costDollars: 0,
        feeDollars: 0,
        winProfitDollars: 0,
        lossDollars: 0,
      };
      bet.flags = [...bet.flags, "skipped — exposure cap reached"];
      continue;
    }

    const cost = contracts * bet.price;
    const fee = feeFor(bet.execution, contracts);
    bet.stake = {
      ...bet.stake,
      contracts,
      costDollars: round2(cost),
      feeDollars: round2(fee),
      winProfitDollars: round2(contracts * (1 - bet.price) - fee),
      lossDollars: round2(cost + fee),
    };
    bet.flags = [...bet.flags, "size reduced — correlated exposure cap"];

    perEvent.set(bet.eventTicker, spent + cost);
    boardTotal += cost;
  }

  if (trimmed === 0) return null;
  return (
    `${trimmed} bet${trimmed === 1 ? "" : "s"} resized or skipped to respect exposure caps ` +
    `(${(config.maxEventExposure * 100).toFixed(0)}% per event, ` +
    `${(config.maxBoardExposure * 100).toFixed(0)}% across the board) — ` +
    "several bets on one game are one bet, not several."
  );
}

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
  let unreliableMid = 0;

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

    // A midpoint from a very wide quote isn't a price, and every "edge" derived
    // from it is really just the spread in disguise.
    if (!hasReliableMid(market)) {
      unreliableMid++;
      continue;
    }

    const isSlate = slateTickers.has(market.ticker);
    const bar = isSlate ? minEdge : Math.max(minEdge, screamingEdge);

    // Evaluate both sides but keep only the better one. Both can clear the bar
    // when resting orders are involved — that's market-making, not two separate
    // opinions, and showing a market twice as opposing "picks" is incoherent.
    let best: BetRecommendation | null = null;
    for (const side of ["yes", "no"] as const) {
      const bet = evaluateSide(
        market,
        side,
        fused,
        startedAt,
        isSlate ? "day-of" : "future",
      );
      if (!bet || bet.netEdge < bar) continue;
      if (!best || bet.score > best.score) best = bet;
    }

    if (best) {
      if (!isSlate) futuresPromoted++;
      bets.push(best);
    }
  }

  // Day-of first: a future has to be genuinely exceptional to be here at all,
  // but today's board is still the point of the page.
  bets.sort((a, b) => {
    if (a.horizonKind !== b.horizonKind) return a.horizonKind === "day-of" ? -1 : 1;
    return b.score - a.score;
  });

  const cappedNote = applyExposureCaps(bets, config.bankroll);
  if (cappedNote) notes.push(cappedNote);

  // Write down what we believed, while the price that made us believe it still
  // exists. See core/journal.ts — this is the only way the weights above ever
  // stop being guesses.
  const shown = bets.slice(0, options.maxResults ?? 40);
  const midByTicker = new Map(allMarkets.map((m) => [m.ticker, m]));
  record(
    shown
      .filter((bet) => bet.stake.contracts > 0)
      .map((bet) => {
        const market = midByTicker.get(bet.ticker);
        return {
          at: startedAt,
          ticker: bet.ticker,
          eventTicker: bet.eventTicker,
          seriesTicker: bet.seriesTicker,
          title: `${bet.label} — ${bet.eventTitle}`,
          side: bet.side,
          price: bet.price,
          marketMid: market?.mid ?? NaN,
          fair: bet.fair,
          rawFair: bet.fair - bet.shrinkage.shrunkGap + bet.shrinkage.rawGap,
          netEdge: bet.netEdge,
          confidence: bet.confidence,
          quality: bet.quality,
          executionStyle: bet.execution.style,
          contracts: bet.stake.contracts,
          resolutionTime: market?.resolutionTime ?? 0,
          sources: bet.contributions.map((c) => c.source),
        };
      }),
  );

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
  if (unreliableMid > 0) {
    notes.push(
      `${unreliableMid} markets skipped for quoting wider than ` +
        `${(MAX_RELIABLE_SPREAD * 100).toFixed(0)}c — no usable midpoint to price against.`,
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
    bets: shown,
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
