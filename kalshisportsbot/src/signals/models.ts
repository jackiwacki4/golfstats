import type { MarketView } from "../core/market.js";
import { clamp01 } from "../core/money.js";
import type { ProbabilityEstimate } from "./types.js";

/**
 * Your own models.
 *
 * This is the slot where a genuine, durable edge lives — the other three
 * signals all read someone else's opinion, and anything derived from a public
 * price is competing with everyone else reading that same price. A model built
 * on data you bothered to collect is the only source here that nobody else has.
 *
 * One real model ships (favourite-longshot bias, below). Everything else is
 * yours to add: write a `Model`, register it, and the engine blends it in
 * automatically with a weight reflecting how much it has earned.
 */

export interface Model {
  name: string;
  /** Cheap check — return false to skip a market entirely. */
  appliesTo(market: MarketView): boolean;
  estimate(market: MarketView): ProbabilityEstimate | null;
}

const logit = (p: number): number => Math.log(p / (1 - p));
const logistic = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * Favourite-longshot bias.
 *
 * One of the most replicated findings in betting-market research: longshots are
 * systematically overpriced and heavy favourites systematically underpriced.
 * People will pay 6c for a 4c chance because the payoff is exciting, and that
 * preference shows up in the price. It holds in racetrack betting, sportsbooks,
 * and prediction markets alike.
 *
 * The correction stretches the price in log-odds space: a 5c contract is really
 * worth a bit less than 5c, a 95c contract a bit more than 95c. `k` is the
 * stretch factor, and 1.05 is deliberately conservative — Kalshi is a
 * relatively efficient exchange, so the effect is real but small.
 *
 * The confidence is low on purpose. This is a broad statistical prior about
 * markets in general, not knowledge about *this* market, so it should lose to
 * any source that actually knows something. Its job is to break ties in the
 * right direction, not to originate bets.
 */
export const longshotBias: Model = {
  name: "favourite-longshot-bias",

  appliesTo(market) {
    if (!Number.isFinite(market.mid)) return false;
    // Only where the effect is measurable — near 50c it's indistinguishable
    // from zero and would just add noise.
    return (market.mid > 0.02 && market.mid < 0.2) || (market.mid > 0.8 && market.mid < 0.98);
  },

  estimate(market) {
    const price = market.mid;
    if (!(price > 0 && price < 1)) return null;

    const k = 1.05;
    const probability = clamp01(logistic(k * logit(price)));
    const shift = probability - price;
    if (Math.abs(shift) < 0.002) return null;

    return {
      source: "model",
      probability,
      confidence: 0.3,
      rationale:
        `Longshot-bias correction: ${(price * 100).toFixed(0)}c -> ` +
        `${(probability * 100).toFixed(1)}c (${shift > 0 ? "+" : ""}${(shift * 100).toFixed(1)} pts). ` +
        "Broad market-wide prior, not specific knowledge.",
    };
  },
};

/**
 * Registered models. Add yours here.
 *
 * A worked example — say you track bullpen fatigue and think it's mispriced in
 * MLB totals:
 *
 *   const bullpenFatigue: Model = {
 *     name: "bullpen-fatigue",
 *     appliesTo: (m) => m.seriesTicker === "KXMLBTOTAL",
 *     estimate: (m) => {
 *       const p = myModel(m.ticker);          // your data, your fit
 *       if (p === null) return null;          // no read? say so, don't guess
 *       return {
 *         source: "model",
 *         probability: p,
 *         confidence: 0.7,                    // earn this with a track record
 *         rationale: "Both bullpens on 3 straight days; overs hit 61% here.",
 *       };
 *     },
 *   };
 *
 * Two rules worth keeping: return `null` rather than a guess when you have no
 * read, and start `confidence` low. An overconfident model is worse than no
 * model, because the engine will happily size up behind it.
 */
export const MODELS: Model[] = [longshotBias];

export function runModels(market: MarketView): ProbabilityEstimate[] {
  const out: ProbabilityEstimate[] = [];
  for (const model of MODELS) {
    if (!model.appliesTo(market)) continue;
    try {
      const estimate = model.estimate(market);
      if (estimate && Number.isFinite(estimate.probability)) out.push(estimate);
    } catch {
      // A broken model shouldn't take down the scan.
    }
  }
  return out;
}
