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
  category: string;
  closeTime: number;
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
    category: event?.category ?? "",
    closeTime: time(market.close_time),
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

/** Markets worth scanning: actually tradeable, two-sided, and not yet closing. */
export function isTradeable(view: MarketView, now = Date.now()): boolean {
  return (
    Number.isFinite(view.yesAsk) &&
    Number.isFinite(view.yesBid) &&
    view.yesAsk > 0 &&
    view.yesAsk < 1 &&
    view.yesBid > 0 &&
    view.closeTime > now
  );
}
