import type { MarketView } from "./market.js";
import { marginalFeeRate, makerFee, takerFee } from "./money.js";

/**
 * How to actually get the position on.
 *
 * The bot previously assumed every trade crosses the spread. That assumption
 * quietly throws away most of the edge on a marginal bet, because taking costs
 * you twice over: you pay the full spread to the other side, and Kalshi's taker
 * fee is four times the maker fee (0.07 vs 0.0175 per contract).
 *
 * Posting a limit order recovers both. On a market quoted 40/44 with a fair
 * value of 47, taking the offer at 44 leaves 3 points minus ~1.7c of fee.
 * Posting at 41 leaves 6 points minus ~0.4c. Same view, roughly double the
 * expected profit — and a bet that was below the edge bar as a taker can be
 * comfortably above it as a maker.
 *
 * The catch is real and not glossed over here: a resting order might never
 * fill, and the ones that fill fastest are the ones filled by someone who knows
 * something. So the maker route is only suggested where it's plausible — a
 * spread wide enough to improve, and enough time before resolution for a fill
 * to happen at all.
 */

export type ExecutionStyle = "taker" | "maker";

export interface ExecutionPlan {
  style: ExecutionStyle;
  /** Price to pay (taker) or post at (maker), in dollars. */
  price: number;
  /** Edge net of the fee for this route, in probability. */
  netEdge: number;
  /** Fee per contract at this price and route. */
  feePerContract: number;
  /** What the other route would have yielded — for the explanation. */
  alternativeNetEdge: number;
  note: string;
}

/** Minimum spread worth posting inside of. At 1c there's no room to improve. */
const MIN_SPREAD_TO_POST = 0.02;

/**
 * Widest spread where a resting order is still a plausible fill.
 *
 * Inside a very wide market, "post at the bid plus a cent" is arithmetic, not a
 * trade: on a 47/76 quote it means resting at 48c and calling the distance to
 * the midpoint edge. Nobody crosses 28 cents to fill you.
 */
const MAX_SPREAD_TO_POST = 0.1;

/** Below this, a resting order is unlikely to fill before resolution. */
const MIN_MINUTES_TO_FILL = 25;

/**
 * Choose between crossing the spread and posting inside it.
 *
 * `fair` is the probability that the chosen side wins; `takerPrice` is what
 * you'd pay right now to take it.
 */
export function planExecution(
  market: MarketView,
  side: "yes" | "no",
  fair: number,
  takerPrice: number,
  now = Date.now(),
): ExecutionPlan {
  const takerFeeRate = marginalFeeRate(takerPrice);
  const takerEdge = fair - takerPrice - takerFeeRate;

  const taker: ExecutionPlan = {
    style: "taker",
    price: takerPrice,
    netEdge: takerEdge,
    feePerContract: takerFeeRate,
    alternativeNetEdge: takerEdge,
    note: "Take the offer — fills immediately.",
  };

  // Best resting bid on the side being bought. For NO, the YES ask mirrors into
  // a NO bid: a YES ask of 0.44 is a NO bid of 0.56.
  const restingBid = side === "yes" ? market.yesBid : 1 - market.yesAsk;
  const spread = Number.isFinite(market.spread) ? market.spread : 0;

  if (
    spread < MIN_SPREAD_TO_POST ||
    spread > MAX_SPREAD_TO_POST ||
    !Number.isFinite(restingBid) ||
    restingBid <= 0
  ) {
    return taker;
  }

  const minutesLeft = (market.resolutionTime - now) / 60_000;
  if (minutesLeft < MIN_MINUTES_TO_FILL) {
    return { ...taker, note: "Take the offer — too close to resolution to rest an order." };
  }

  // Improve the best bid by a cent, staying strictly inside the spread. Rounded
  // to a whole cent because that's the only granularity Kalshi accepts — binary
  // floating point turns 0.40 + 0.01 into 0.41000000000000003, which is not a
  // price you can actually post.
  const toCents = (x: number): number => Math.round(x * 100) / 100;
  const postPrice = toCents(Math.min(restingBid + 0.01, takerPrice - 0.01));
  if (!(postPrice > 0) || postPrice >= takerPrice) return taker;

  const makerFeeRate = 0.0175 * postPrice * (1 - postPrice);
  const makerEdge = fair - postPrice - makerFeeRate;

  if (makerEdge <= takerEdge) return taker;

  return {
    style: "maker",
    price: postPrice,
    netEdge: makerEdge,
    feePerContract: makerFeeRate,
    alternativeNetEdge: takerEdge,
    note:
      `Post a limit order at ${Math.round(postPrice * 100)}¢ rather than taking ` +
      `${Math.round(takerPrice * 100)}¢ — worth ${((makerEdge - takerEdge) * 100).toFixed(1)} ` +
      "extra points if it fills, but it might not.",
  };
}

/** Total fee for an order of this size and route. */
export function feeFor(plan: ExecutionPlan, contracts: number): number {
  return plan.style === "maker"
    ? makerFee(contracts, plan.price)
    : takerFee(contracts, plan.price);
}
