/**
 * A probability distribution over a game's final score.
 *
 * This is what lets one market price another. A moneyline, a run line, a game
 * total and a team total are not four opinions — they are four questions about
 * a single underlying quantity, how many runs each side scores. Pin that
 * distribution down and every one of them has an implied fair price, whether or
 * not anybody has traded it.
 *
 * The distribution is fitted from two anchors: the probability the favourite
 * wins (from sharp sportsbooks, the number hardest to beat) and the expected
 * combined score (from the market's own total ladder). Two numbers, two
 * parameters — the fit is exactly determined, no curve-fitting or free
 * parameters to fool yourself with.
 */

export interface ScoreDistribution {
  /** P(team A beats team B). Ties count as neither. */
  pWin(): number;
  /** P(margin for `team` > line), where line is typically x.5. */
  pWinBy(teamIsA: boolean, line: number): number;
  /** P(combined score > line). */
  pTotalOver(line: number): number;
  /** P(one team's score > line). */
  pTeamOver(teamIsA: boolean, line: number): number;
}

// --- Poisson pair: correct for low-scoring sports ----------------------------

const MAX_GOALS = 40;

function poissonPmf(lambda: number, max: number): number[] {
  const out = new Array<number>(max + 1);
  let term = Math.exp(-lambda);
  out[0] = term;
  for (let k = 1; k <= max; k++) {
    term = (term * lambda) / k;
    out[k] = term;
  }
  return out;
}

/**
 * Each side's score as an independent Poisson draw.
 *
 * The right model where scoring events are discrete and rare — baseball,
 * hockey, soccer. The margin is then a Skellam distribution, computed here by
 * explicit convolution rather than Bessel functions: at these means the grid is
 * tiny, and the arithmetic is obvious enough to check by hand.
 *
 * Independence is an approximation — real games have shared conditions like
 * weather and umpires — but it's a mild one next to the alternative of having
 * no estimate at all for these markets.
 */
export function poissonPair(
  lambdaA: number,
  lambdaB: number,
  resolveTies = true,
): ScoreDistribution {
  const a = poissonPmf(Math.max(lambdaA, 1e-6), MAX_GOALS);
  const b = poissonPmf(Math.max(lambdaB, 1e-6), MAX_GOALS);

  // Build the margin and total distributions once, then answer every query off
  // them — cheaper than re-convolving per question, and it makes the tie
  // handling below a single clear step rather than a condition in four loops.
  const margin = new Array<number>(2 * MAX_GOALS + 1).fill(0);
  const total = new Array<number>(2 * MAX_GOALS + 1).fill(0);
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = a[i]! * b[j]!;
      margin[i - j + MAX_GOALS]! += p;
      total[i + j]! += p;
    }
  }

  /**
   * Extra innings, overtime, shootouts.
   *
   * A Poisson pair puts real mass on an exact draw, but baseball, basketball
   * and hockey don't end level — they play on. Leaving that mass on zero breaks
   * the model at its most important point: with two evenly matched sides,
   * P(A beats B) tops out around 44%, so a 50% moneyline is *unreachable* and
   * the fit silently runs to an extreme trying to find it. The pick'em case is
   * where this shows up first and worst.
   *
   * Draws are therefore pushed to a one-run win, split in proportion to each
   * side's regulation edge — the stronger team wins more of them, which is what
   * happens in practice.
   */
  if (resolveTies) {
    const drawMass = margin[MAX_GOALS]!;
    if (drawMass > 0) {
      let aWins = 0;
      let bWins = 0;
      for (let m = 1; m <= MAX_GOALS; m++) aWins += margin[MAX_GOALS + m]!;
      for (let m = 1; m <= MAX_GOALS; m++) bWins += margin[MAX_GOALS - m]!;
      const shareA = aWins + bWins > 0 ? aWins / (aWins + bWins) : 0.5;
      margin[MAX_GOALS] = 0;
      margin[MAX_GOALS + 1]! += drawMass * shareA;
      margin[MAX_GOALS - 1]! += drawMass * (1 - shareA);
    }
  }

  const sumMarginAbove = (line: number, flip: boolean): number => {
    let p = 0;
    for (let m = -MAX_GOALS; m <= MAX_GOALS; m++) {
      const value = flip ? -m : m;
      if (value > line) p += margin[m + MAX_GOALS]!;
    }
    return p;
  };

  return {
    pWin: () => sumMarginAbove(0, false),
    pWinBy: (teamIsA, line) => sumMarginAbove(line, !teamIsA),
    pTotalOver(line) {
      let p = 0;
      for (let t = 0; t < total.length; t++) if (t > line) p += total[t]!;
      return p;
    },
    pTeamOver(teamIsA, line) {
      const pmf = teamIsA ? a : b;
      let p = 0;
      for (let k = 0; k <= MAX_GOALS; k++) if (k > line) p += pmf[k]!;
      return p;
    },
  };
}

// --- Normal: right for high-scoring sports -----------------------------------

/** Abramowitz & Stegun 7.1.26 — plenty accurate for pricing to the cent. */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

/** Inverse normal CDF (Acklam's approximation). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;

  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - pl) return -normalQuantile(1 - p);

  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/**
 * Margin and total as separate normals.
 *
 * For basketball and football a Poisson pair fits badly — it ties the margin's
 * spread to the total's, and in those sports they diverge sharply (an NBA game
 * has a margin sigma near 11 but a total sigma near 17). Modelling them as two
 * roughly independent normals with sport-specific widths is both simpler and
 * closer to how these games actually behave.
 */
export function normalGame(
  meanMargin: number,
  sigmaMargin: number,
  meanTotal: number,
  sigmaTotal: number,
): ScoreDistribution {
  // A team's score is (total + margin) / 2; independence gives its variance.
  const teamSigma = Math.sqrt(sigmaMargin ** 2 + sigmaTotal ** 2) / 2;

  return {
    pWin: () => normalCdf(meanMargin / sigmaMargin),
    pWinBy(teamIsA, line) {
      const mu = teamIsA ? meanMargin : -meanMargin;
      return 1 - normalCdf((line - mu) / sigmaMargin);
    },
    pTotalOver: (line) => 1 - normalCdf((line - meanTotal) / sigmaTotal),
    pTeamOver(teamIsA, line) {
      const mu = (meanTotal + (teamIsA ? meanMargin : -meanMargin)) / 2;
      return 1 - normalCdf((line - mu) / teamSigma);
    },
  };
}

// --- Fitting -----------------------------------------------------------------

export interface SportModel {
  kind: "poisson" | "normal";
  /**
   * Does the sport play on until someone wins? True for baseball, basketball
   * and hockey; false for soccer, where a draw is a real settled outcome.
   */
  resolveTies: boolean;
  /** Standard deviation of the winning margin, in the sport's own units. */
  sigmaMargin: number;
  /** Standard deviation of the combined score. Normal model only. */
  sigmaTotal: number;
}

/**
 * Sport parameters, from long-run public data on scoring variance.
 *
 * These are the model's only hand-set numbers, so they're worth stating
 * plainly: they are reasonable published values, not fitted here, and they set
 * how confidently a derived price can be quoted. Wrong sigma shows up as
 * systematically mispriced tails, which is exactly what `npm run review` would
 * eventually reveal.
 */
export const SPORT_MODELS: Record<string, SportModel> = {
  // Baseball is normal, not Poisson, and the reason is worth recording. A
  // Poisson pair ties the spread of outcomes to the mean: at a 8.8-run total it
  // implies a margin SD of sqrt(8.8) = 3.0 and a team-total SD of 2.1, where
  // the real figures are about 4.2 and 3.1. Runs cluster — a six-run inning is
  // one event, not six independent ones — so baseball is materially
  // over-dispersed relative to Poisson, and using it would price every deep
  // strike on the ladder too cheaply.
  MLB: { kind: "normal", resolveTies: true, sigmaMargin: 4.2, sigmaTotal: 4.3 },
  // Hockey and soccer stay Poisson: scores are low enough that discreteness
  // matters more than over-dispersion, and there the fit is close (NHL margin
  // SD 2.2 observed vs 2.4 implied; soccer 1.6 vs 1.64).
  NHL: { kind: "poisson", resolveTies: true, sigmaMargin: 2.2, sigmaTotal: 2.4 },
  SOCCER: { kind: "poisson", resolveTies: false, sigmaMargin: 1.6, sigmaTotal: 1.7 },
  NBA: { kind: "normal", resolveTies: true, sigmaMargin: 11.5, sigmaTotal: 17 },
  WNBA: { kind: "normal", resolveTies: true, sigmaMargin: 10.5, sigmaTotal: 16 },
  NFL: { kind: "normal", resolveTies: true, sigmaMargin: 13.5, sigmaTotal: 13 },
  CFB: { kind: "normal", resolveTies: true, sigmaMargin: 16, sigmaTotal: 16 },
};

/**
 * Fit a score distribution to a win probability and an expected total.
 *
 * For the Poisson model this solves for the two scoring rates that reproduce
 * both anchors: their sum is the expected total, and the split is whatever
 * makes P(A wins) match. The split is found by bisection, which is safe here
 * because win probability rises monotonically as you shift scoring from one
 * side to the other.
 */
export function fitGame(
  pWinA: number,
  expectedTotal: number,
  model: SportModel,
): ScoreDistribution | null {
  if (!(pWinA > 0.001 && pWinA < 0.999)) return null;
  if (!(expectedTotal > 0) || !Number.isFinite(expectedTotal)) return null;

  if (model.kind === "normal") {
    const meanMargin = model.sigmaMargin * normalQuantile(pWinA);
    if (!Number.isFinite(meanMargin)) return null;
    return normalGame(meanMargin, model.sigmaMargin, expectedTotal, model.sigmaTotal);
  }

  // Poisson: hold the sum fixed, bisect on team A's share.
  let lo = 0.02;
  let hi = 0.98;
  for (let i = 0; i < 50; i++) {
    const share = (lo + hi) / 2;
    const p = poissonPair(
      expectedTotal * share,
      expectedTotal * (1 - share),
      model.resolveTies,
    ).pWin();
    if (p < pWinA) lo = share;
    else hi = share;
  }
  const share = (lo + hi) / 2;
  return poissonPair(
    expectedTotal * share,
    expectedTotal * (1 - share),
    model.resolveTies,
  );
}
