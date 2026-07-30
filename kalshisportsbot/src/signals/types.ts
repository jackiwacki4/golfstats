/**
 * Every edge source answers the same question — "what's the true probability
 * this resolves YES?" — and states how much it trusts its own answer.
 *
 * Keeping sources in this uniform shape is what lets the engine blend four
 * very different kinds of evidence without special-casing each one.
 */
export interface ProbabilityEstimate {
  source: SignalSource;
  /** Estimated probability of YES, in [0, 1]. */
  probability: number;
  /**
   * Confidence in [0, 1]. Multiplied by the source's base weight, so a source
   * can say "I have an opinion, but a weak one" on a per-market basis.
   */
  confidence: number;
  /** Human-readable justification, shown in the dashboard. */
  rationale: string;
}

export type SignalSource =
  | "market"
  | "structural"
  | "consensus"
  | "microstructure"
  | "model";

/**
 * Base weights for blending. Ordered by how much the source can be trusted to
 * be independently right, not by how often it fires:
 *
 *  - `consensus` is highest: de-vigged sportsbook lines aggregate far more
 *    capital and sharper money than Kalshi's book, so where they disagree the
 *    books are usually closer to true.
 *  - `structural` is arithmetic on live prices, not an opinion, so it's
 *    trustworthy — but it only constrains a set of prices, it doesn't tell you
 *    which leg is wrong.
 *  - `model` earns less by default because a home-grown model is the easiest
 *    thing here to fool yourself with. Raise it once yours has a track record.
 *  - `market` is the prior: the crowd's price. It anchors the blend so that a
 *    market with no independent signal produces no edge, rather than noise.
 */
export const SOURCE_WEIGHTS: Record<SignalSource, number> = {
  consensus: 1.0,
  structural: 0.65,
  model: 0.45,
  market: 0.8,
  microstructure: 0,
};

/** A quality read on whether an edge is actually *takeable*. */
export interface MicrostructureRead {
  /** 0..1 — execution quality. Scales position size and the final score. */
  quality: number;
  /** Notes worth showing: wide spread, thin book, stale price. */
  flags: string[];
  /** Contracts available at the top of the book on the side we'd trade. */
  topSize: number;
  stale: boolean;
}
