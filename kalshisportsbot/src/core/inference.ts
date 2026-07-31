import { clamp01 } from "./money.js";

/**
 * Shrinking a disagreement toward the market.
 *
 * This is the most important thing in the codebase, and it is not intuitive.
 *
 * A naive scanner treats its biggest disagreement with the market as its best
 * find. That is almost exactly backwards. On a market where both Kalshi and the
 * sportsbooks have real money down, genuine exploitable edges live in a narrow
 * band — call it one to four points. A twenty-point gap is not twenty points of
 * profit waiting to be collected; it is overwhelmingly a *defect*: the wrong
 * game matched, a book line that went stale, or the two venues quietly pricing
 * different questions (Kalshi settling on regulation time while the book
 * includes overtime; a player prop that voids on a scratch).
 *
 * The damage compounds, which is what makes this worth a module of its own.
 * Kelly sizing scales with edge, so an unshrunk estimate stakes hardest exactly
 * where the number is least trustworthy. Every large error the bot can make
 * routes through this one behaviour.
 *
 * So the observed gap is treated as a noisy measurement of a small quantity,
 * and combined with a prior that says real edges are rare and modest. The
 * result is the posterior mean — what the evidence *actually* supports once you
 * account for how often a big number is a bug.
 */

export interface ShrinkageInput {
  /** Blended probability before shrinking. */
  fair: number;
  /** The market's own midpoint — what we're disagreeing with. */
  marketMid: number;
  /** Share of the estimate backed by non-market evidence, 0..1. */
  confidence: number;
  /** Execution quality, 0..1. A wide, thin market has a noisy midpoint. */
  quality: number;
  /** Prior scale of genuine edges, in probability. Default 3.5 points. */
  priorScale?: number;
}

export interface ShrinkageResult {
  /** Fair value after shrinking toward the market. */
  fair: number;
  /** Raw disagreement, before shrinking. */
  rawGap: number;
  /** What survived. */
  shrunkGap: number;
  /** Multiplier applied, 0..1. */
  factor: number;
  /** Assumed standard deviation of our own estimate. */
  sigma: number;
  /** Set when the gap is large enough to suggest a defect rather than an edge. */
  implausible: boolean;
}

/** Prior standard deviation of true edges — most are small. */
const DEFAULT_PRIOR_SCALE = 0.035;

/** Estimate error when evidence is strong / weak. */
const SIGMA_BEST = 0.02;
const SIGMA_WORST = 0.11;

/**
 * Beyond this gap, a definitional mismatch is more likely than an edge.
 *
 * Two venues that agree within a few points on a hundred markets do not
 * suddenly disagree by twenty on one because a genuine inefficiency appeared.
 * Far more often they have stopped pricing the same question.
 */
const IMPLAUSIBLE_GAP = 0.15;

export function shrinkTowardMarket(input: ShrinkageInput): ShrinkageResult {
  const { fair, marketMid, confidence, quality } = input;
  const tau = input.priorScale ?? DEFAULT_PRIOR_SCALE;

  if (!Number.isFinite(fair) || !Number.isFinite(marketMid)) {
    return {
      fair,
      rawGap: 0,
      shrunkGap: 0,
      factor: 0,
      sigma: SIGMA_WORST,
      implausible: false,
    };
  }

  const rawGap = fair - marketMid;

  // How noisy is our own number? Corroborated estimates on liquid markets are
  // the trustworthy ones; a lone weak signal on a wide market is not.
  const evidence = clamp01(0.7 * clamp01(confidence) + 0.3 * clamp01(quality));
  let sigma = SIGMA_WORST - (SIGMA_WORST - SIGMA_BEST) * evidence;

  // Robustness against the heavy tail. Ordinary Gaussian shrinkage assumes the
  // errors are well behaved, and the errors that hurt here are not: a mismatched
  // game produces a gap that has nothing to do with measurement noise.
  //
  // Inflating sigma faster than the gap grows is what makes the surviving edge
  // eventually *fall* as the disagreement widens — the model's way of saying
  // that past some point a bigger number is evidence of a bug rather than of
  // profit. The coefficient is set so a flagged 30-point gap ends up worth less
  // than a credible 5-point one; without it the defect still wins the board.
  const excess = Math.abs(rawGap) - IMPLAUSIBLE_GAP;
  if (excess > 0) sigma *= 1 + (2 * excess) / IMPLAUSIBLE_GAP;

  // Posterior mean of a normal prior with normal measurement error.
  const factor = (tau * tau) / (tau * tau + sigma * sigma);
  const shrunkGap = rawGap * factor;

  return {
    fair: clamp01(marketMid + shrunkGap),
    rawGap,
    shrunkGap,
    factor,
    sigma,
    implausible: Math.abs(rawGap) > IMPLAUSIBLE_GAP,
  };
}
