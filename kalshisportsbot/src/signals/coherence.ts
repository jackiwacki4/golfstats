import type { MarketView } from "../core/market.js";
import { clamp01 } from "../core/money.js";
import { gameKey, matchupSides, parseTerms } from "../core/terms.js";
import { fitGame, SPORT_MODELS, type ScoreDistribution, type SportModel } from "../core/scoring.js";
import type { ProbabilityEstimate } from "./types.js";

/**
 * Cross-market coherence: pricing a game's markets off each other.
 *
 * This is the widest coverage gain available, and it comes from noticing that
 * Kalshi lists ~35 markets on a single baseball game — moneyline, eight run
 * lines, eleven totals, fourteen team totals — while the sportsbook matcher can
 * only speak to two of them. The other thirty-three get no independent signal at
 * all, not because they're efficiently priced but because nothing was looking.
 *
 * They aren't thirty-five separate questions though. They're thirty-five
 * questions about one scoring distribution. Pin that down from the two anchors
 * worth trusting — the sharp books' win probability, and the market's own
 * expected total — and every remaining strike has an implied fair price.
 *
 * The edge here is structural rather than informational. Serious money
 * concentrates on moneylines and headline totals; the deep strikes on a run-line
 * ladder are quoted by a market maker and largely left alone. Propagating a
 * sharp number into markets nobody is watching is a far more winnable game than
 * trying to out-handicap the closing line.
 */

/** Series prefix -> which sport's scoring parameters apply. */
function sportFor(seriesTicker: string): SportModel | null {
  const s = seriesTicker.toUpperCase();
  if (s.startsWith("KXMLB")) return SPORT_MODELS.MLB!;
  if (s.startsWith("KXNHL")) return SPORT_MODELS.NHL!;
  if (s.startsWith("KXWNBA")) return SPORT_MODELS.WNBA!;
  if (s.startsWith("KXNBA")) return SPORT_MODELS.NBA!;
  if (s.startsWith("KXNFL")) return SPORT_MODELS.NFL!;
  if (s.startsWith("KXCFB")) return SPORT_MODELS.CFB!;
  if (s.startsWith("KXEPL") || s.startsWith("KXUCL")) return SPORT_MODELS.SOCCER!;
  return null;
}

/**
 * Read the expected combined score off the total-market ladder.
 *
 * The ladder prices "over N" at a range of N; the point where it crosses 50% is
 * the market's median total. Interpolating between the two strikes that bracket
 * 50% gets closer than picking the nearest one, and the median is a good enough
 * stand-in for the mean on distributions this symmetric.
 */
export function inferExpectedTotal(totalMarkets: MarketView[]): number | null {
  const points: { line: number; p: number }[] = [];
  for (const market of totalMarkets) {
    const terms = parseTerms(market);
    if (terms.kind !== "total") continue;
    if (!Number.isFinite(market.mid) || market.mid <= 0 || market.mid >= 1) continue;
    points.push({ line: terms.line, p: market.mid });
  }
  if (points.length < 2) return null;

  // Prices fall as the line rises; sort so the crossing is easy to find.
  points.sort((a, b) => a.line - b.line);

  for (let i = 0; i < points.length - 1; i++) {
    const hi = points[i]!;
    const lo = points[i + 1]!;
    if (hi.p >= 0.5 && lo.p <= 0.5) {
      const span = hi.p - lo.p;
      if (span <= 1e-9) return (hi.line + lo.line) / 2;
      return hi.line + ((hi.p - 0.5) / span) * (lo.line - hi.line);
    }
  }
  return null;
}

/**
 * Has this game already started?
 *
 * The model prices a game from its opening state, and applying it to one
 * already in progress is not slightly wrong, it's meaningless. A live game's
 * ladder is dominated by runs already on the board rather than by the
 * distribution of runs still to come.
 *
 * The tell is unmistakable once you look: a ladder reading 99% / 99% / 99% /
 * 45% across consecutive strikes is not a probability distribution over a
 * baseball game, it's a team that has already scored four. No smooth scoring
 * model produces a cliff like that, and anchoring to it made the model
 * disagree with liquid, heavily-traded markets by up to 35 points — which,
 * by this codebase's own standard, is evidence of a broken model rather than
 * of a mispriced market.
 *
 * Checking the shape of the ladder rather than a clock is deliberate: it needs
 * no start time (Kalshi's tickers carry one only for some sports), no timezone
 * handling, and no guess about delays or rain. Certainty at a low strike simply
 * *is* the signature of points already scored.
 */
function looksInProgress(group: MarketView[]): boolean {
  const ladders = new Map<string, { line: number; mid: number }[]>();

  for (const market of group) {
    const terms = parseTerms(market);
    if (terms.kind !== "team-total" && terms.kind !== "total") continue;
    if (!Number.isFinite(market.mid)) continue;
    const key = terms.kind === "team-total" ? `tt:${terms.team}` : "total";
    const bucket = ladders.get(key) ?? [];
    bucket.push({ line: terms.line, mid: market.mid });
    ladders.set(key, bucket);
  }

  for (const points of ladders.values()) {
    if (points.length < 2) continue;
    points.sort((a, b) => a.line - b.line);
    // Near-certainty at the bottom of a ladder means those points are banked.
    if (points[0]!.mid >= 0.97) return true;
  }
  return false;
}

export interface CoherenceResult {
  estimates: Map<string, ProbabilityEstimate>;
  gamesModelled: number;
  marketsPriced: number;
  /** Games skipped because they had already started. */
  gamesInProgress: number;
}

/**
 * Derive fair prices for every market on a game whose moneyline we trust.
 *
 * `anchors` maps a moneyline market's ticker to the sportsbook consensus for it.
 * Markets that already carry a consensus estimate are skipped — re-deriving them
 * from their own anchor would just echo it back with extra confidence, which is
 * the double-counting this whole design tries to avoid.
 */
export function buildCoherence(
  markets: MarketView[],
  anchors: Map<string, ProbabilityEstimate>,
): CoherenceResult {
  const estimates = new Map<string, ProbabilityEstimate>();
  let gamesModelled = 0;
  let marketsPriced = 0;
  let gamesInProgress = 0;

  // Group every family of markets by the fixture they belong to.
  const games = new Map<string, MarketView[]>();
  for (const market of markets) {
    if (!sportFor(market.seriesTicker)) continue;
    const key = gameKey(market.eventTicker);
    if (!key) continue;
    const bucket = games.get(key);
    if (bucket) bucket.push(market);
    else games.set(key, [market]);
  }

  for (const [, group] of games) {
    const model = sportFor(group[0]!.seriesTicker);
    if (!model) continue;

    // A pre-game model says nothing useful about a game already under way.
    if (looksInProgress(group)) {
      gamesInProgress++;
      continue;
    }

    // --- Anchor 1: a moneyline we have sharp consensus for -------------------
    const anchored = group
      .map((m) => ({ market: m, estimate: anchors.get(m.ticker) }))
      .find((x) => x.estimate && parseTerms(x.market).kind === "moneyline");
    if (!anchored?.estimate) continue;

    const anchorTerms = parseTerms(anchored.market);
    if (anchorTerms.kind !== "moneyline") continue;

    // Whose margin is this? Team A is the first side named in the matchup.
    const sides = matchupSides(anchored.market.eventTitle);
    if (!sides) continue;
    const anchorIsA = sides[0]
      .toLowerCase()
      .includes(anchorTerms.team.toLowerCase().split(" ")[0] ?? "§");

    // --- Anchor 2: the market's own expected total ---------------------------
    const expectedTotal = inferExpectedTotal(group);
    if (expectedTotal === null) continue;

    const pWinA = anchorIsA ? anchored.estimate.probability : 1 - anchored.estimate.probability;
    const distribution = fitGame(pWinA, expectedTotal, model);
    if (!distribution) continue;

    gamesModelled++;

    for (const market of group) {
      if (anchors.has(market.ticker)) continue; // already has a sharper source
      const priced = priceMarket(market, distribution, sides, expectedTotal);
      if (!priced) continue;
      estimates.set(market.ticker, priced);
      marketsPriced++;
    }
  }

  return { estimates, gamesModelled, marketsPriced, gamesInProgress };
}

function priceMarket(
  market: MarketView,
  distribution: ScoreDistribution,
  sides: [string, string],
  expectedTotal: number,
): ProbabilityEstimate | null {
  const terms = parseTerms(market);
  const isTeamA = (name: string): boolean =>
    sides[0].toLowerCase().includes(name.toLowerCase().split(" ")[0] ?? "§");

  let probability: number;
  let what: string;

  switch (terms.kind) {
    case "spread":
      probability = distribution.pWinBy(isTeamA(terms.team), terms.line);
      what = `${terms.team} by over ${terms.line}`;
      break;
    case "total":
      probability = distribution.pTotalOver(terms.line);
      what = `over ${terms.line} combined`;
      break;
    case "team-total":
      probability = distribution.pTeamOver(isTeamA(terms.team), terms.line);
      what = `${terms.team} over ${terms.line}`;
      break;
    case "moneyline":
      probability = isTeamA(terms.team)
        ? distribution.pWin()
        : 1 - distribution.pWin();
      what = `${terms.team} to win`;
      break;
    default:
      return null; // props and segments need their own models
  }

  if (!Number.isFinite(probability)) return null;

  // Confidence falls away in the tails. The anchors pin the middle of the
  // distribution tightly, but a 6.5-run line lives where the model's shape —
  // not the data — is doing the work, and shape is the part most likely wrong.
  const extremity = Math.abs(probability - 0.5) * 2;
  const confidence = clamp01(0.62 * (1 - 0.55 * extremity ** 2));

  return {
    source: "coherence",
    probability: clamp01(probability),
    confidence,
    rationale:
      `Priced off this game's own moneyline and a ${expectedTotal.toFixed(1)} expected total: ` +
      `${what} implies ${(probability * 100).toFixed(1)}%.`,
  };
}
