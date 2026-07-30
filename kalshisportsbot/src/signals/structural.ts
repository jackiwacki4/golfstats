import type { MarketView } from "../core/market.js";
import { marginalFeeRate, round2 } from "../core/money.js";
import type { ProbabilityEstimate } from "./types.js";

/**
 * Structural edges: places where a *set* of live prices contradicts itself.
 *
 * This is the one signal that needs no opinion about the world. If you can buy
 * every outcome of a mutually exclusive event for less than $1 total, you make
 * money regardless of what happens — no model, no forecast, no view. That
 * makes it both the most reliable edge here and the rarest.
 */

export interface ArbOpportunity {
  kind: "yes-no-underpriced" | "dutch-book" | "oversold-set";
  eventTicker: string;
  eventTitle: string;
  legs: { ticker: string; label: string; side: "yes" | "no"; price: number }[];
  /** Total outlay per unit set, including estimated fees. */
  costPerSet: number;
  /** Guaranteed payout per unit set. */
  payoutPerSet: number;
  profitPerSet: number;
  /** Return on capital risked, as a fraction. */
  returnOnCost: number;
  /** Smallest top-of-book size across legs — how many sets you can actually fill. */
  maxSets: number;
  /**
   * True when the payout depends on the legs covering every possible outcome.
   * These are NOT risk-free — see `breakEvenFieldProbability`.
   */
  requiresExhaustive: boolean;
  /**
   * For exhaustiveness-dependent trades: the probability of "none of the listed
   * outcomes" at which this breaks even. Above it, the trade loses. NaN when
   * the payout doesn't depend on exhaustiveness.
   */
  breakEvenFieldProbability: number;
  note: string;
}

const MIN_PROFIT_PER_SET = 0.005; // half a cent — below this, slippage eats it

/**
 * Within one market: buying YES and NO together always pays exactly $1.
 * If both asks sum to less than $1 after fees, that's free money.
 */
function findYesNoArb(market: MarketView): ArbOpportunity | null {
  const { yesAsk, noAsk } = market;
  if (!(yesAsk > 0 && yesAsk < 1 && noAsk > 0 && noAsk < 1)) return null;

  const fees = marginalFeeRate(yesAsk) + marginalFeeRate(noAsk);
  const cost = yesAsk + noAsk + fees;
  const profit = 1 - cost;
  if (profit < MIN_PROFIT_PER_SET) return null;

  return {
    kind: "yes-no-underpriced",
    eventTicker: market.eventTicker,
    eventTitle: market.eventTitle,
    legs: [
      { ticker: market.ticker, label: `${market.yesLabel} YES`, side: "yes", price: yesAsk },
      { ticker: market.ticker, label: `${market.yesLabel} NO`, side: "no", price: noAsk },
    ],
    costPerSet: round2(cost),
    payoutPerSet: 1,
    profitPerSet: round2(profit),
    returnOnCost: profit / cost,
    maxSets: Math.floor(Math.min(market.yesAskSize, market.yesBidSize) || 0),
    requiresExhaustive: false,
    breakEvenFieldProbability: NaN,
    note: "YES and NO asks sum below $1 — the pair pays $1 whatever happens.",
  };
}

/**
 * Minimum ask-sum for a YES-side dutch book to be believable.
 *
 * See `findDutchBook` — an exhaustive set can only ever be *slightly*
 * underpriced, so a low ask-sum is proof the set isn't exhaustive.
 */
const EXHAUSTIVE_FLOOR = 0.9;

/**
 * Across a mutually exclusive event: buy every leg, and if one of them resolves
 * YES the set pays exactly $1. Asks summing below $1 after fees looks like free
 * money — but only if the legs actually cover every outcome.
 *
 * That caveat is the whole difficulty, and getting it wrong is expensive.
 * Kalshi's `mutually_exclusive` flag means *at most* one leg resolves YES, not
 * exactly one. "What will be the 51st state?" lists eight candidates whose asks
 * sum to $0.17, which reads as a 475% risk-free return and is nothing of the
 * kind: no state is admitted, every leg settles NO, and the whole stake is
 * gone. The missing 83% isn't mispricing, it's the market correctly pricing
 * "none of these".
 *
 * The ask-sum floor below screens out that class of trap: on a set that really
 * does cover everything, the asks sum to *more* than $1 — the excess is the
 * exchange's overround — so a genuine inversion sits just under $1 and is worth
 * fractions of a cent. An ask-sum far below $1 is a set with an unlisted
 * outcome, not a mispriced one.
 *
 * But the floor is a filter, not a proof, and it's important to be clear about
 * the difference. Exhaustiveness is a fact about what the legs *mean*, and no
 * amount of price arithmetic can establish it — a 25-leg "2028 Republican
 * ticket" market clears the floor comfortably while "some other pairing"
 * remains entirely live. So this function does not claim risk-free. It reports
 * the trade along with `breakEvenFieldProbability`: the chance of "none of the
 * above" at which the position stops making money. That reframes the judgement
 * into one a human can actually make — not "is this arbitrage?" but "is an
 * unlisted outcome more likely than 2%?" — and keeps the decision with the
 * person who can read the market rules.
 */
function findDutchBook(
  eventTicker: string,
  eventTitle: string,
  markets: MarketView[],
): ArbOpportunity | null {
  if (markets.length < 2) return null;
  if (!markets.every((m) => m.yesAsk > 0 && m.yesAsk < 1)) return null;

  const askSum = markets.reduce((sum, m) => sum + m.yesAsk, 0);
  if (askSum < EXHAUSTIVE_FLOOR) return null; // "none of the above" is live

  const fees = markets.reduce((sum, m) => sum + marginalFeeRate(m.yesAsk), 0);
  const cost = askSum + fees;
  const profit = 1 - cost;
  if (profit < MIN_PROFIT_PER_SET) return null;

  return {
    kind: "dutch-book",
    eventTicker,
    eventTitle,
    legs: markets.map((m) => ({
      ticker: m.ticker,
      label: m.yesLabel,
      side: "yes" as const,
      price: m.yesAsk,
    })),
    costPerSet: round2(cost),
    payoutPerSet: 1,
    profitPerSet: round2(profit),
    returnOnCost: profit / cost,
    maxSets: Math.floor(Math.min(...markets.map((m) => m.yesAskSize || 0))),
    requiresExhaustive: true,
    // Profit needs (1 - field) * $1 > cost, so the trade dies once the chance
    // of an unlisted outcome exceeds this.
    breakEvenFieldProbability: profit,
    note:
      `NOT risk-free. Pays $1 only if one of these ${markets.length} legs actually wins. ` +
      `Profitable only while "none of the above" stays below ${(profit * 100).toFixed(1)}% — ` +
      "read the market rules and confirm the legs cover every outcome.",
  };
}

/**
 * The mirror trade: buy NO on every leg. At most one NO can lose, so the set
 * returns at least (n - 1).
 *
 * Unlike the YES-side dutch book, this needs no exhaustiveness check — and it's
 * worth being clear why, because the asymmetry is easy to misread as an
 * oversight. Non-exhaustiveness only helps here: if some unlisted outcome
 * happens instead, every NO leg wins and the set pays n rather than n - 1. The
 * downside is capped by `mutually_exclusive` alone, which is exactly the
 * guarantee Kalshi's flag actually provides.
 */
function findOversoldSet(
  eventTicker: string,
  eventTitle: string,
  markets: MarketView[],
): ArbOpportunity | null {
  if (markets.length < 2) return null;
  if (!markets.every((m) => m.noAsk > 0 && m.noAsk < 1)) return null;

  const payout = markets.length - 1;
  const fees = markets.reduce((sum, m) => sum + marginalFeeRate(m.noAsk), 0);
  const cost = markets.reduce((sum, m) => sum + m.noAsk, 0) + fees;
  const profit = payout - cost;
  if (profit < MIN_PROFIT_PER_SET) return null;

  return {
    kind: "oversold-set",
    eventTicker,
    eventTitle,
    legs: markets.map((m) => ({
      ticker: m.ticker,
      label: m.yesLabel,
      side: "no" as const,
      price: m.noAsk,
    })),
    costPerSet: round2(cost),
    payoutPerSet: payout,
    profitPerSet: round2(profit),
    returnOnCost: profit / cost,
    maxSets: 0, // NO-side depth isn't in the nested payload; confirm on the book
    requiresExhaustive: false,
    breakEvenFieldProbability: NaN,
    note:
      `Buying NO on all ${markets.length} outcomes returns at least $${payout} — ` +
      "at most one NO can lose, so an unlisted outcome only pays better.",
  };
}

export function findArbitrage(
  eventTicker: string,
  eventTitle: string,
  markets: MarketView[],
  mutuallyExclusive: boolean,
): ArbOpportunity[] {
  const found: ArbOpportunity[] = [];

  for (const market of markets) {
    const single = findYesNoArb(market);
    if (single) found.push(single);
  }

  if (mutuallyExclusive) {
    const dutch = findDutchBook(eventTicker, eventTitle, markets);
    if (dutch) found.push(dutch);
    const oversold = findOversoldSet(eventTicker, eventTitle, markets);
    if (oversold) found.push(oversold);
  }

  return found;
}

/**
 * Renormalize a mutually exclusive event's prices so they sum to 1.
 *
 * Kalshi's quotes carry an overround — the mids across an event's legs
 * typically sum to more than 100% — and that excess is distributed unevenly.
 * Dividing through by the total removes it, which systematically shades
 * favourites and longshots differently than the raw quotes do.
 *
 * The catch is exhaustiveness. "Who wins the election" with five named
 * candidates and no "someone else" leg is exhaustive; a market listing eight
 * possible NATO Secretaries General is not, and there the missing probability
 * mass belongs to the field, not to the listed legs. Normalizing a
 * non-exhaustive set would invent edge out of nothing, so confidence decays
 * with distance from a total of 1 and the signal switches off entirely once
 * the sum strays far enough that a field outcome is the obvious explanation.
 */
export function normalizeExclusiveSet(
  markets: MarketView[],
): Map<string, ProbabilityEstimate> {
  const out = new Map<string, ProbabilityEstimate>();
  if (markets.length < 2) return out;

  const usable = markets.filter((m) => Number.isFinite(m.mid) && m.mid > 0);
  if (usable.length !== markets.length) return out;

  const total = usable.reduce((sum, m) => sum + m.mid, 0);
  if (!(total > 0)) return out;

  // Below 0.90 the legs plainly don't cover the outcome space; above 1.25 the
  // quotes are too wide to be a real overround.
  if (total < 0.9 || total > 1.25) return out;

  // Full confidence at a small overround, fading to zero at the boundaries.
  const distance = Math.abs(total - 1);
  const confidence = Math.max(0, 1 - distance / 0.25);
  if (confidence <= 0) return out;

  for (const market of usable) {
    out.set(market.ticker, {
      source: "structural",
      probability: market.mid / total,
      confidence,
      rationale:
        `${usable.length} exclusive outcomes priced at ${(total * 100).toFixed(1)}% total; ` +
        `renormalizing moves this leg ${((market.mid / total - market.mid) * 100).toFixed(1)} pts.`,
    });
  }
  return out;
}
