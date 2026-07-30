import { clamp01 } from "../core/money.js";
import type { MarketView } from "../core/market.js";
import { SOURCE_WEIGHTS, type ProbabilityEstimate } from "../signals/types.js";

/**
 * Blend independent probability estimates into one fair value.
 *
 * The blend happens in log-odds space rather than on raw probabilities. That
 * matters at the extremes: averaging 2% and 6% linearly gives 4%, but those two
 * views differ by a factor of three in what they imply about the payoff, and
 * log-odds respects that where a straight mean flattens it.
 */

const logit = (p: number): number => Math.log(p / (1 - p));
const logistic = (x: number): number => 1 / (1 + Math.exp(-x));

/** Keep probabilities off the asymptotes so logit stays finite. */
const EPS = 1e-4;
const safe = (p: number): number => Math.min(1 - EPS, Math.max(EPS, p));

export interface FusedEstimate {
  fair: number;
  /** 0..1 — how much independent evidence backs this, beyond the crowd price. */
  confidence: number;
  contributions: {
    source: string;
    probability: number;
    weight: number;
    rationale: string;
  }[];
  /** True when something other than the market price contributed. */
  hasIndependentSignal: boolean;
}

/**
 * Fuse estimates for one market.
 *
 * The market's own price is always included as a prior. That's deliberate and
 * it's the safety rail on the whole system: with no independent evidence, the
 * blend collapses to the market price, the edge computes to zero, and nothing
 * gets recommended. The bot only disagrees with the crowd when it has an actual
 * reason to, rather than manufacturing a take for every market it can see.
 */
export function fuse(
  market: MarketView,
  estimates: ProbabilityEstimate[],
): FusedEstimate {
  const usable = estimates.filter(
    (e) => Number.isFinite(e.probability) && e.probability > 0 && e.probability < 1 && e.confidence > 0,
  );

  const prior = Number.isFinite(market.mid) ? market.mid : NaN;
  if (!Number.isFinite(prior) || prior <= 0 || prior >= 1) {
    return {
      fair: NaN,
      confidence: 0,
      contributions: [],
      hasIndependentSignal: false,
    };
  }

  const contributions: FusedEstimate["contributions"] = [];
  let weightedLogit = 0;
  let totalWeight = 0;

  const priorWeight = SOURCE_WEIGHTS.market;
  weightedLogit += logit(safe(prior)) * priorWeight;
  totalWeight += priorWeight;
  contributions.push({
    source: "market",
    probability: prior,
    weight: priorWeight,
    rationale: "Kalshi midpoint — the crowd's price, used as the prior.",
  });

  for (const estimate of usable) {
    const weight = SOURCE_WEIGHTS[estimate.source] * estimate.confidence;
    if (weight <= 0) continue;
    weightedLogit += logit(safe(estimate.probability)) * weight;
    totalWeight += weight;
    contributions.push({
      source: estimate.source,
      probability: estimate.probability,
      weight,
      rationale: estimate.rationale,
    });
  }

  const fair = clamp01(logistic(weightedLogit / totalWeight));

  // Confidence is the share of total weight coming from somewhere other than
  // the crowd — i.e. how much of this view is actually independent.
  const independentWeight = totalWeight - priorWeight;
  const confidence = clamp01(independentWeight / (independentWeight + priorWeight));

  return {
    fair,
    confidence,
    contributions,
    hasIndependentSignal: independentWeight > 0,
  };
}
