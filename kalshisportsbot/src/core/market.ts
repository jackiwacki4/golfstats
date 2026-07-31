import type { KalshiEvent, KalshiMarket } from "../kalshi/types.js";
import { parseDollars, parseSize } from "./money.js";

/**
 * A market reduced to the numbers the engine reasons about.
 *
 * `yesAsk` is what you pay to buy YES; `yesBid` is what you'd receive selling
 * it. Buying NO at `noAsk` is economically identical to selling YES, so the
 * scanner evaluates both directions off this one shape.
 */
export interface MarketView {
  ticker: string;
  eventTicker: string;
  seriesTicker: string;
  title: string;
  yesLabel: string;
  eventTitle: string;
  /** Kalshi's own settlement wording — the final authority on what settles. */
  rulesPrimary: string;
  category: string;
  /** Kalshi's trading deadline. For sports this is a settlement backstop, not game time. */
  closeTime: number;
  /**
   * When this actually resolves — what "day of" means.
   *
   * These are not the same field and conflating them breaks the day-of board
   * outright. A tennis match tonight carries a `close_time` fifteen days out
   * (Kalshi's settlement deadline) and an `expected_expiration_time` of
   * tonight. Filter a slate on close time and every sports market on the board
   * looks like a future.
   */
  resolutionTime: number;
  updatedTime: number;

  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  lastPrice: number;

  /** Midpoint of the YES spread — the market's own implied probability. */
  mid: number;
  spread: number;

  yesBidSize: number;
  yesAskSize: number;
  volume24h: number;
  openInterest: number;
  liquidity: number;
}

const time = (iso: string | undefined): number => {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
};

export function normalizeMarket(market: KalshiMarket, event?: KalshiEvent): MarketView {
  const yesBid = parseDollars(market.yes_bid_dollars);
  const yesAsk = parseDollars(market.yes_ask_dollars);

  // A market with no resting orders on one side reports 0.00/1.00. Midpoint is
  // only meaningful when both sides are quoted; otherwise fall back to the last
  // trade so downstream code isn't handed a fabricated 50%.
  const twoSided = yesBid > 0 && yesAsk < 1 && yesAsk >= yesBid;
  const lastPrice = parseDollars(market.last_price_dollars);
  const mid = twoSided ? (yesBid + yesAsk) / 2 : lastPrice;

  return {
    ticker: market.ticker,
    eventTicker: market.event_ticker,
    seriesTicker: event?.series_ticker ?? market.event_ticker.split("-")[0] ?? "",
    title: market.title,
    yesLabel: market.yes_sub_title || market.title,
    eventTitle: event?.title ?? market.title,
    rulesPrimary: market.rules_primary ?? "",
    category: event?.category ?? "",
    closeTime: time(market.close_time),
    resolutionTime: time(market.expected_expiration_time) || time(market.close_time),
    updatedTime: time(market.updated_time),

    yesBid,
    yesAsk,
    noBid: parseDollars(market.no_bid_dollars),
    noAsk: parseDollars(market.no_ask_dollars),
    lastPrice,

    mid: Number.isFinite(mid) ? mid : NaN,
    spread: twoSided ? yesAsk - yesBid : NaN,

    yesBidSize: parseSize(market.yes_bid_size_fp),
    yesAskSize: parseSize(market.yes_ask_size_fp),
    volume24h: parseSize(market.volume_24h_fp),
    openInterest: parseSize(market.open_interest_fp),
    liquidity: parseSize(market.liquidity_dollars),
  };
}

/** Markets worth scanning: actually tradeable, two-sided, and not yet resolved. */
export function isTradeable(view: MarketView, now = Date.now()): boolean {
  return (
    Number.isFinite(view.yesAsk) &&
    Number.isFinite(view.yesBid) &&
    view.yesAsk > 0 &&
    view.yesAsk < 1 &&
    view.yesBid > 0 &&
    view.resolutionTime > now
  );
}

/**
 * Widest spread at which the midpoint still means something.
 *
 * Kalshi's liquid markets quote a cent or two wide. Past roughly a dime, the
 * "midpoint" stops being a price anyone would trade at and becomes the average
 * of two numbers nobody will touch.
 */
export const MAX_RELIABLE_SPREAD = 0.1;

/**
 * Does this market have a midpoint worth reasoning from?
 *
 * This gate exists because of a specific and instructive failure. A market
 * quoted 47/76 has a midpoint of 61.5c, and the engine will happily treat that
 * as the crowd's view — then notice you could rest a bid at 48c and report
 * thirteen points of edge. The edge is entirely fictional: it comes from the
 * width of the spread, not from any disagreement about the outcome, and a
 * resting bid that far below fair value simply never fills.
 *
 * Worse, it produced *both* sides of the same market as strong buys
 * simultaneously, which is impossible and was the tell that the midpoint had
 * stopped carrying information. Structural arbitrage is unaffected — it works
 * off real ask prices rather than midpoints — so this gate applies only where a
 * fair value is being estimated.
 */
export function hasReliableMid(view: MarketView): boolean {
  return (
    Number.isFinite(view.mid) &&
    Number.isFinite(view.spread) &&
    view.spread <= MAX_RELIABLE_SPREAD &&
    view.mid > 0 &&
    view.mid < 1
  );
}

/** True when this market resolves inside the slate window. */
export function resolvesWithin(
  view: MarketView,
  startMs: number,
  endMs: number,
): boolean {
  return view.resolutionTime > startMs && view.resolutionTime <= endMs;
}

/**
 * Multivariate "parlay" markets — Kalshi's combinations of other contracts.
 *
 * Excluded from scanning. Their price is a function of legs we already evaluate
 * individually, so any edge found here is the same edge counted twice, and the
 * signals would misread them badly: a consensus matcher seeing two team names
 * in a fourteen-leg parlay title would confidently price the wrong thing.
 */
export function isMultivariate(market: KalshiMarket): boolean {
  return Boolean(
    (market as { mve_collection_ticker?: string }).mve_collection_ticker,
  );
}
