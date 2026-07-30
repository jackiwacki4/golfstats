/**
 * Prices, fees, and stake sizing.
 *
 * A Kalshi contract pays $1.00 if it resolves in your favour and $0 if not.
 * So a YES price of $0.37 is the market saying "37% chance", and buying it
 * risks $0.37 to win $0.63.
 */

/** Parse a Kalshi decimal string ("0.1300"). Returns NaN for junk, never throws. */
export function parseDollars(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null || raw === "") return NaN;
  return typeof raw === "number" ? raw : Number(raw);
}

/** Parse a Kalshi fixed-point size string, defaulting to 0 rather than NaN. */
export function parseSize(raw: string | undefined | null): number {
  const n = parseDollars(raw);
  return Number.isFinite(n) ? n : 0;
}

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Round up to the next whole cent, correcting binary-float representation error. */
function ceilCents(dollars: number): number {
  return Math.ceil(Number((dollars * 100).toFixed(6))) / 100;
}

/**
 * Kalshi taker fee: round_up(0.07 * C * P * (1 - P)), charged in dollars.
 *
 * The fee is quadratic in price, so it peaks at $0.50 (1.75c/contract) and
 * shrinks toward the extremes. This matters more than it looks: a 3-point edge
 * on a 50c contract is roughly half eaten by fees, while the same 3 points on
 * a 10c contract barely notices them. Every edge in this codebase is reported
 * net of this.
 */
export function takerFee(contracts: number, price: number): number {
  if (!Number.isFinite(price) || contracts <= 0) return 0;
  return ceilCents(0.07 * contracts * price * (1 - price));
}

/** Kalshi maker fee (resting orders): round_up(0.0175 * C * P * (1 - P)). */
export function makerFee(contracts: number, price: number): number {
  if (!Number.isFinite(price) || contracts <= 0) return 0;
  return ceilCents(0.0175 * contracts * price * (1 - price));
}

/**
 * Per-contract taker fee at the margin.
 *
 * Deliberately NOT `takerFee(1, price)` — that rounds a sub-cent fee up to a
 * full cent and would overstate costs by up to 100% on a large order. This is
 * the unrounded rate, which is what the marginal contract in a real-sized
 * order actually costs.
 */
export function marginalFeeRate(price: number): number {
  if (!Number.isFinite(price)) return 0;
  return 0.07 * price * (1 - price);
}

/**
 * Expected value per contract, net of fees, for buying at `price` when the
 * true probability is `fair`.
 *
 *   win:  +(1 - price)   with probability fair
 *   lose: -price         with probability (1 - fair)
 *   => EV = fair - price, minus fees.
 */
export function evPerContract(fair: number, price: number): number {
  if (!Number.isFinite(fair) || !Number.isFinite(price)) return 0;
  return fair - price - marginalFeeRate(price);
}

/**
 * Fraction of bankroll to stake, by the Kelly criterion.
 *
 * For a contract costing `price` that pays $1, net odds are (1-price)/price,
 * and full Kelly reduces to (fair - price) / (1 - price). Fees are folded in
 * by treating them as part of the purchase price.
 *
 * Returns 0 when there's no edge — Kelly never asks you to bet a losing price.
 */
export function kellyFraction(fair: number, price: number): number {
  const effectivePrice = price + marginalFeeRate(price);
  if (!(effectivePrice > 0) || effectivePrice >= 1) return 0;
  if (!Number.isFinite(fair)) return 0;
  const f = (fair - effectivePrice) / (1 - effectivePrice);
  return Math.max(0, Math.min(1, f));
}

export interface Stake {
  contracts: number;
  costDollars: number;
  feeDollars: number;
  /** Profit if the contract resolves in your favour, after fees. */
  winProfitDollars: number;
  /** Loss if it doesn't, after fees. */
  lossDollars: number;
  kelly: number;
  stakedFraction: number;
}

/**
 * Turn an edge into an actual order size using fractional Kelly.
 *
 * Full Kelly maximises long-run growth but is famously wild — it assumes your
 * probability estimate is exactly right, and ours never is. `kellyMultiplier`
 * (0.25 by default) buys a much smoother ride for a small growth cost.
 */
export function sizeStake(
  fair: number,
  price: number,
  bankroll: number,
  kellyMultiplier: number,
): Stake {
  const kelly = kellyFraction(fair, price);
  const stakedFraction = kelly * kellyMultiplier;
  const targetDollars = bankroll * stakedFraction;

  const contracts = price > 0 ? Math.floor(targetDollars / price) : 0;
  const costDollars = contracts * price;
  const feeDollars = takerFee(contracts, price);

  return {
    contracts,
    costDollars: round2(costDollars),
    feeDollars: round2(feeDollars),
    winProfitDollars: round2(contracts * (1 - price) - feeDollars),
    lossDollars: round2(costDollars + feeDollars),
    kelly,
    stakedFraction,
  };
}

export const round2 = (x: number): number => Math.round(x * 100) / 100;

/** American odds for a probability — handy for comparing against a sportsbook. */
export function toAmericanOdds(p: number): number {
  if (!(p > 0) || p >= 1) return 0;
  return p > 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
}
