import { config } from "../config.js";
import type { MarketView } from "../core/market.js";
import { clamp01 } from "../core/money.js";
import { getCached, setCached } from "../core/cache.js";
import type { ProbabilityEstimate } from "./types.js";

/**
 * Cross-book consensus — the strongest edge source here.
 *
 * Sportsbook markets absorb orders of magnitude more capital than Kalshi's
 * book, and the sharp money that sets closing lines is very hard to beat. So
 * rather than trying to out-handicap anyone, this asks a narrower and much more
 * winnable question: has Kalshi's price drifted away from what the wider market
 * already agrees on? Where it has, the books are usually right and the Kalshi
 * price is the outlier.
 *
 * Raw sportsbook odds can't be used directly — they're padded with vig, so
 * implied probabilities across a game sum to more than 100%. That padding has
 * to be stripped before the number means anything.
 */

const ODDS_API = "https://api.the-odds-api.com/v4";
/** Odds move, but not fast enough to justify burning the free-tier quota. */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface OddsOutcome {
  name: string;
  price: number;
}
interface OddsEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: {
    key: string;
    title: string;
    markets: { key: string; outcomes: OddsOutcome[] }[];
  }[];
}

/**
 * Kalshi series prefix -> The Odds API sport key *prefix*.
 *
 * A prefix, not an exact key, because tennis has no single league feed: the
 * books publish `tennis_atp_wimbledon`, `tennis_atp_us_open` and so on, and
 * asking for a bare `tennis_atp` returns a 404. Prefixes are resolved against
 * the live catalogue at scan time, so whichever tournaments are running get
 * picked up automatically and out-of-season keys are never requested.
 *
 * Only sports with live Kalshi markets get queried, because the free tier is
 * 500 requests/month and each sport is one request.
 */
const SPORT_KEYS: Record<string, string> = {
  KXMLBGAME: "baseball_mlb",
  KXMLBSPREAD: "baseball_mlb",
  KXMLBTOTAL: "baseball_mlb",
  KXNFLGAME: "americanfootball_nfl",
  KXNFLSPREAD: "americanfootball_nfl",
  KXNBAGAME: "basketball_nba",
  KXNBASPREAD: "basketball_nba",
  KXWNBAGAME: "basketball_wnba",
  KXNHLGAME: "icehockey_nhl",
  KXCFBGAME: "americanfootball_ncaaf",
  KXATPMATCH: "tennis_atp",
  KXWTAMATCH: "tennis_wta",
  KXEPLGAME: "soccer_epl",
  KXUCLGAME: "soccer_uefa_champs_league",
};

export function sportKeyFor(seriesTicker: string): string | null {
  return SPORT_KEYS[seriesTicker.toUpperCase()] ?? null;
}

/**
 * Strip vig proportionally: divide each implied probability by their total.
 *
 * Simple and standard, but it assumes the book spreads its margin evenly across
 * outcomes, and books demonstrably do not — they load more of it onto
 * longshots, because that's where the recreational money goes. On a lopsided
 * matchup this leaves the longshot's fair probability overstated.
 */
export function devig(decimalPrices: number[]): number[] {
  const implied = decimalPrices.map((price) => (price > 1 ? 1 / price : 0));
  const total = implied.reduce((sum, p) => sum + p, 0);
  if (!(total > 0)) return decimalPrices.map(() => NaN);
  return implied.map((p) => p / total);
}

/**
 * Strip vig by the power method: find k such that Σ(implied_i^k) = 1.
 *
 * The improvement over proportional is that it removes margin
 * *multiplicatively in log space*, taking proportionally more out of longshots
 * than favourites — which is how books actually apply it. On a 90/10 market the
 * two methods can disagree by a point or more on the longshot, and since a
 * point is a meaningful fraction of a real edge, that difference is worth
 * having.
 *
 * k is found by bisection. Since every implied probability is below 1, raising
 * them to a higher power shrinks the sum monotonically, so the root is unique
 * and always above 1 whenever the book has any margin at all.
 */
export function devigPower(decimalPrices: number[]): number[] {
  const implied = decimalPrices.map((price) => (price > 1 ? 1 / price : 0));
  if (implied.some((p) => !(p > 0 && p < 1))) return devig(decimalPrices);

  const sumAt = (k: number): number =>
    implied.reduce((sum, p) => sum + Math.pow(p, k), 0);

  if (sumAt(1) <= 1) return devig(decimalPrices); // no margin to strip

  let lo = 1;
  let hi = 8;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid;
    else hi = mid;
  }

  const k = (lo + hi) / 2;
  const out = implied.map((p) => Math.pow(p, k));
  const total = out.reduce((sum, p) => sum + p, 0);
  return total > 0 ? out.map((p) => p / total) : devig(decimalPrices);
}

/**
 * How much each book's opinion is worth.
 *
 * Not all books are equally informative, and the gap is large. Pinnacle and
 * Circa run low margins and high limits and *welcome* sharp money, so their
 * lines are a genuine market-clearing price. The retail-facing books largely
 * copy them, shade for public bias, and manage risk by limiting winners — so
 * treating a soft book as an independent opinion double-counts Pinnacle's
 * number while adding the soft book's bias on top.
 *
 * An unweighted median across eight books is therefore mostly a measure of what
 * the copying books think.
 */
const BOOK_WEIGHTS: Record<string, number> = {
  pinnacle: 3.0,
  circasports: 2.5,
  bookmaker: 2.0,
  betonlineag: 1.8,
  lowvig: 1.8,
  betfair_ex_us: 1.8,
  matchbook: 1.5,
  draftkings: 1.0,
  fanduel: 1.0,
  betmgm: 1.0,
  williamhill_us: 1.0,
  betrivers: 0.8,
  pointsbetus: 0.8,
};
const DEFAULT_BOOK_WEIGHT = 0.6;

const bookWeight = (key: string): number =>
  BOOK_WEIGHTS[key.toLowerCase()] ?? DEFAULT_BOOK_WEIGHT;

/** Weighted average in log-odds space — respects ratios at the extremes. */
function weightedConsensus(samples: { p: number; weight: number }[]): number {
  let weighted = 0;
  let total = 0;
  for (const { p, weight } of samples) {
    const safe = Math.min(1 - 1e-6, Math.max(1e-6, p));
    weighted += Math.log(safe / (1 - safe)) * weight;
    total += weight;
  }
  if (!(total > 0)) return NaN;
  return 1 / (1 + Math.exp(-weighted / total));
}

function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      // Drop the possessive before punctuation is stripped, so Kalshi's "A's"
      // reduces to "a" (an initial for Athletics) rather than "a s".
      .replace(/'s\b/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
  );
}

/**
 * Does a Kalshi team string name the same team as a sportsbook team name?
 *
 * The two sources describe teams completely differently, which is the whole
 * difficulty. Kalshi uses the city — "Miami", "Pittsburgh" — while the books
 * use the full name, "Miami Marlins". Matching on the last word (the nickname)
 * finds nothing at all, because Kalshi never sends one.
 *
 * Where two teams share a city, Kalshi disambiguates with a single letter:
 * "New York M" and "New York Y". So the rule is that every Kalshi token must be
 * a *prefix* of some book token — "m" matches "mets" but not "yankees".
 *
 * Each token must claim a *different* book token, and that requirement is
 * carrying real weight rather than being defensive tidiness. Without it,
 * "Chicago C" (the Cubs) matches "Chicago White Sox", because the stray "c"
 * happily re-uses "chicago" as its prefix. Forcing distinct assignments makes
 * "c" find "cubs" or fail, which is the correct behaviour on the one case most
 * likely to hand you a confident bet on the wrong team.
 */
export function teamsMatch(kalshiTeam: string, bookTeam: string): boolean {
  const wanted = tokenize(kalshiTeam);
  const available = tokenize(bookTeam);
  if (wanted.length === 0 || available.length === 0) return false;
  if (wanted.length > available.length) return false;

  const taken = new Set<number>();

  // Longest tokens first: the specific ones ("chicago") should claim their
  // match before a bare initial ("c") can steal it.
  const order = [...wanted].sort((a, b) => b.length - a.length);

  for (const token of order) {
    let claimed = false;

    for (let i = 0; i < available.length; i++) {
      if (taken.has(i)) continue;
      if (available[i]!.startsWith(token)) {
        taken.add(i);
        claimed = true;
        break;
      }
    }
    if (claimed) continue;

    // Initialisms: Kalshi writes the White Sox as "Chicago WS", where one token
    // stands for the initials of several. Try to spend the token's letters
    // across a run of consecutive unclaimed tokens.
    for (let start = 0; start + token.length <= available.length; start++) {
      let fits = true;
      for (let offset = 0; offset < token.length; offset++) {
        const index = start + offset;
        if (taken.has(index) || !available[index]!.startsWith(token[offset]!)) {
          fits = false;
          break;
        }
      }
      if (fits) {
        for (let offset = 0; offset < token.length; offset++) taken.add(start + offset);
        claimed = true;
        break;
      }
    }
    if (!claimed) return false;
  }
  return true;
}

/**
 * Pull the two sides out of a Kalshi matchup title.
 *
 * Titles read "Miami vs New York M" or "Miami vs New York M Winner?", so the
 * separator is reliable. Splitting beats searching the whole string for team
 * names: it keeps the two sides distinct, which is what makes it possible to
 * tell which one buying YES actually backs.
 */
export function splitMatchup(title: string): [string, string] | null {
  const cleaned = title.replace(/\s+(winner|moneyline)\s*\??$/i, "").trim();
  const parts = cleaned.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return null;

  // Kalshi labels special fixtures with a prefix — "Hall of Fame Game: Carolina
  // vs Arizona" — which otherwise gets tokenized as part of the team name.
  const a = parts[0]?.replace(/^.*:\s*/, "").trim();
  const b = parts[1]?.trim();
  if (!a || !b) return null;
  return [a, b];
}

interface SportEntry {
  key: string;
  active: boolean;
  has_outrights: boolean;
}

/**
 * The catalogue of sports the books currently cover.
 *
 * Free to call — the sports list doesn't count against the monthly quota — and
 * it's what turns a hardcoded guess at a league key into something that tracks
 * the actual season and tournament calendar.
 */
async function fetchAvailableSports(): Promise<SportEntry[]> {
  const cached = getCached<SportEntry[]>("odds:sports", 6 * 60 * 60 * 1000);
  if (cached) return cached;

  const url = new URL(`${ODDS_API}/sports`);
  url.searchParams.set("apiKey", config.oddsApiKey);
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Odds API sports list: HTTP ${response.status}`);

  const sports = (await response.json()) as SportEntry[];
  setCached("odds:sports", sports);
  return sports;
}

/** Live keys matching a configured prefix — exact match wins, else all in-season. */
function resolveSportKeys(prefix: string, catalogue: SportEntry[]): string[] {
  const exact = catalogue.find((s) => s.key === prefix);
  if (exact) return exact.active ? [exact.key] : [];
  return catalogue
    .filter((s) => s.active && !s.has_outrights && s.key.startsWith(prefix))
    .map((s) => s.key);
}

async function fetchSport(sportKey: string): Promise<OddsEvent[]> {
  const cacheKey = `odds:${sportKey}`;
  const cached = getCached<OddsEvent[]>(cacheKey, CACHE_TTL_MS);
  if (cached) return cached;

  const url = new URL(`${ODDS_API}/sports/${sportKey}/odds`);
  url.searchParams.set("apiKey", config.oddsApiKey);
  url.searchParams.set("regions", config.oddsRegions);
  url.searchParams.set("markets", "h2h");
  url.searchParams.set("oddsFormat", "decimal");

  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    throw new Error(`Odds API ${sportKey}: HTTP ${response.status}`);
  }
  const events = (await response.json()) as OddsEvent[];
  setCached(cacheKey, events);
  return events;
}

export interface ConsensusResult {
  estimates: Map<string, ProbabilityEstimate>;
  /** Sports actually queried, and any failures — surfaced in the dashboard. */
  notes: string[];
}

/**
 * Build consensus probability estimates for whichever markets can be matched
 * to a sportsbook game.
 *
 * Matching is deliberately conservative: both teams' nicknames must appear in
 * the Kalshi event title, and the YES leg must clearly correspond to one of
 * them. A wrong match would produce a confident, completely fabricated edge,
 * which is far worse than no match at all.
 */
export async function buildConsensus(markets: MarketView[]): Promise<ConsensusResult> {
  const estimates = new Map<string, ProbabilityEstimate>();
  const notes: string[] = [];

  if (!config.oddsApiKey) {
    notes.push("No ODDS_API_KEY set — cross-book consensus skipped (see README).");
    return { estimates, notes };
  }

  // Only fetch sports we actually have markets for.
  const wanted = new Map<string, MarketView[]>();
  for (const market of markets) {
    const sportKey = sportKeyFor(market.seriesTicker);
    if (!sportKey) continue;
    const bucket = wanted.get(sportKey);
    if (bucket) bucket.push(market);
    else wanted.set(sportKey, [market]);
  }

  if (wanted.size === 0) {
    notes.push("No Kalshi markets matched a supported sportsbook league.");
    return { estimates, notes };
  }

  let catalogue: SportEntry[];
  try {
    catalogue = await fetchAvailableSports();
  } catch (err) {
    notes.push(
      `Could not reach the odds catalogue: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { estimates, notes };
  }

  for (const [prefix, sportMarkets] of wanted) {
    const keys = resolveSportKeys(prefix, catalogue);
    if (keys.length === 0) {
      notes.push(`${prefix}: nothing in season at the books right now.`);
      continue;
    }

    const games: OddsEvent[] = [];
    for (const key of keys) {
      try {
        games.push(...(await fetchSport(key)));
      } catch (err) {
        notes.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let matched = 0;
    for (const market of sportMarkets) {
      const estimate = matchMarket(market, games);
      if (estimate) {
        estimates.set(market.ticker, estimate);
        matched++;
      }
    }

    // Most Kalshi markets in a league are spreads, totals and props, which have
    // no moneyline to compare against — so a low ratio here is expected, not a
    // fault. Report matched games too, which is the number that says whether
    // matching is actually working.
    notes.push(
      `${prefix}: matched ${matched} winner market${matched === 1 ? "" : "s"} ` +
        `from ${sportMarkets.length} scanned, across ${games.length} games.`,
    );
  }

  return { estimates, notes };
}

function matchMarket(market: MarketView, events: OddsEvent[]): ProbabilityEstimate | null {
  // Only straight winner markets. Spreads, totals and props share the matchup
  // title but ask a different question, and pricing them off a moneyline would
  // be confidently wrong rather than merely unmatched.
  const sides = splitMatchup(market.eventTitle) ?? splitMatchup(market.title);
  if (!sides) return null;
  const [teamA, teamB] = sides;

  const candidates = events.filter(
    (event) =>
      (teamsMatch(teamA, event.away_team) && teamsMatch(teamB, event.home_team)) ||
      (teamsMatch(teamA, event.home_team) && teamsMatch(teamB, event.away_team)),
  );

  // Exactly one game, or none. Short Kalshi forms like "A's" are unambiguous
  // beside their opponent but not in isolation, and taking the first of several
  // candidates is how you end up confidently pricing the wrong game.
  if (candidates.length !== 1) return null;
  const game = candidates[0]!;

  // Which team does buying YES back? The YES label names it directly.
  const backsHome = teamsMatch(market.yesLabel, game.home_team);
  const backsAway = teamsMatch(market.yesLabel, game.away_team);
  if (backsHome === backsAway) return null; // ambiguous or neither — refuse to guess

  const targetTeam = backsHome ? game.home_team : game.away_team;

  // De-vig each book on its own, then blend them weighted by how much the
  // book's opinion is actually worth.
  const samples: { p: number; weight: number; key: string }[] = [];
  for (const bookmaker of game.bookmakers) {
    const h2h = bookmaker.markets.find((m) => m.key === "h2h");
    if (!h2h || h2h.outcomes.length < 2) continue;

    const fair = devigPower(h2h.outcomes.map((o) => o.price));
    const index = h2h.outcomes.findIndex((o) => o.name === targetTeam);
    if (index === -1) continue;

    const probability = fair[index];
    if (probability === undefined || !Number.isFinite(probability)) continue;
    samples.push({ p: probability, weight: bookWeight(bookmaker.key), key: bookmaker.key });
  }

  if (samples.length < 2) return null; // one book is an opinion, not a consensus

  const consensus = weightedConsensus(samples);
  if (!Number.isFinite(consensus)) return null;

  const probabilities = samples.map((s) => s.p);
  const spread = Math.max(...probabilities) - Math.min(...probabilities);

  // Confidence rises with corroboration and with agreement, but the sharp books
  // carry it: six soft books agreeing is largely six copies of one opinion, so
  // their unanimity is much weaker evidence than it looks.
  const sharpWeight = samples
    .filter((s) => bookWeight(s.key) >= 1.5)
    .reduce((sum, s) => sum + s.weight, 0);

  const breadth = clamp01(samples.length / 6);
  const sharpness = clamp01(sharpWeight / 3);
  const agreement = clamp01(1 - spread / 0.1);
  const confidence = clamp01(0.3 + 0.25 * breadth + 0.25 * sharpness + 0.2 * agreement);

  const sharpNote = sharpness > 0 ? ", sharp books included" : ", no sharp book in the mix";

  return {
    source: "consensus",
    probability: clamp01(consensus),
    confidence,
    rationale:
      `${samples.length} sportsbooks de-vig to ${(consensus * 100).toFixed(1)}% for ` +
      `${targetTeam} (spread ${(spread * 100).toFixed(1)} pts${sharpNote}).`,
  };
}
