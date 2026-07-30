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
 * Kalshi series prefix -> The Odds API sport key.
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
 * Strip vig by proportional (multiplicative) de-vigging.
 *
 * Implied probabilities from a book's prices sum to something like 1.05; the
 * 5% is the house's margin. Dividing each by the total rescales them to sum to
 * 1. This assumes the margin is spread proportionally across outcomes, which is
 * the standard assumption and close enough for two-way markets. It does slightly
 * overstate longshots — books load more margin onto them — so on lopsided
 * matchups treat a favourite-side edge as the more trustworthy one.
 */
export function devig(decimalPrices: number[]): number[] {
  const implied = decimalPrices.map((price) => (price > 1 ? 1 / price : 0));
  const total = implied.reduce((sum, p) => sum + p, 0);
  if (!(total > 0)) return decimalPrices.map(() => NaN);
  return implied.map((p) => p / total);
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return NaN;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

/** Normalize a team name to its nickname token — "Los Angeles Dodgers" -> "dodgers". */
function nickname(teamName: string): string {
  const cleaned = teamName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  return words[words.length - 1] ?? cleaned;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
}

async function fetchSport(sportKey: string): Promise<OddsEvent[]> {
  const cacheKey = `odds:${sportKey}`;
  const cached = getCached<OddsEvent[]>(cacheKey, CACHE_TTL_MS);
  if (cached) return cached;

  const url = new URL(`${ODDS_API}/sports/${sportKey}/odds`);
  url.searchParams.set("apiKey", config.oddsApiKey);
  url.searchParams.set("regions", "us");
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

  for (const [sportKey, sportMarkets] of wanted) {
    let events: OddsEvent[];
    try {
      events = await fetchSport(sportKey);
    } catch (err) {
      notes.push(`${sportKey}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    let matched = 0;
    for (const market of sportMarkets) {
      const estimate = matchMarket(market, events);
      if (estimate) {
        estimates.set(market.ticker, estimate);
        matched++;
      }
    }
    notes.push(`${sportKey}: matched ${matched}/${sportMarkets.length} markets across ${events.length} games.`);
  }

  return { estimates, notes };
}

function matchMarket(market: MarketView, events: OddsEvent[]): ProbabilityEstimate | null {
  const haystack = normalizeText(`${market.eventTitle} ${market.title} ${market.yesLabel}`);

  const game = events.find((event) => {
    const home = nickname(event.home_team);
    const away = nickname(event.away_team);
    return (
      home.length > 2 &&
      away.length > 2 &&
      haystack.includes(home) &&
      haystack.includes(away)
    );
  });
  if (!game) return null;

  // Which team does buying YES back? Only the YES label decides this — using
  // the whole title would match both teams and pick the wrong side.
  const yesText = normalizeText(market.yesLabel);
  const homeNick = nickname(game.home_team);
  const awayNick = nickname(game.away_team);
  const backsHome = yesText.includes(homeNick);
  const backsAway = yesText.includes(awayNick);
  if (backsHome === backsAway) return null; // ambiguous or neither — refuse to guess

  const targetTeam = backsHome ? game.home_team : game.away_team;

  // De-vig each book separately, then take the median across books. The median
  // shrugs off one book with a stale or deliberately off-market line.
  const perBook: number[] = [];
  for (const bookmaker of game.bookmakers) {
    const h2h = bookmaker.markets.find((m) => m.key === "h2h");
    if (!h2h || h2h.outcomes.length < 2) continue;

    const fair = devig(h2h.outcomes.map((o) => o.price));
    const index = h2h.outcomes.findIndex((o) => o.name === targetTeam);
    if (index === -1) continue;

    const probability = fair[index];
    if (probability !== undefined && Number.isFinite(probability)) perBook.push(probability);
  }

  if (perBook.length < 2) return null; // one book is an opinion, not a consensus

  const consensus = median(perBook);
  if (!Number.isFinite(consensus)) return null;

  // More books agreeing, and agreeing tightly, means more confidence.
  const spread = Math.max(...perBook) - Math.min(...perBook);
  const bookCount = clamp01(perBook.length / 6);
  const agreement = clamp01(1 - spread / 0.1);
  const confidence = clamp01(0.45 + 0.3 * bookCount + 0.25 * agreement);

  return {
    source: "consensus",
    probability: clamp01(consensus),
    confidence,
    rationale:
      `${perBook.length} sportsbooks de-vig to ${(consensus * 100).toFixed(1)}% for ` +
      `${targetTeam} (book spread ${(spread * 100).toFixed(1)} pts).`,
  };
}
