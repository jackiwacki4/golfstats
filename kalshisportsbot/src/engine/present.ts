import type { ArbOpportunity } from "../signals/structural.js";
import type { BetRecommendation, ScanResult } from "./scan.js";
import { formatClose, shortTzName } from "../core/time.js";

/**
 * The presentation layer: engine output -> what the website renders.
 *
 * This exists so the site never has to do arithmetic or make judgement calls.
 * The engine decides what's true; this decides how it reads; the page just
 * lays out what it's given. That separation is what keeps a redesign from
 * quietly changing what counts as a bet — and stops the page from having to
 * know that `netEdge` is a probability delta while `price` is dollars.
 *
 * Every number arrives pre-formatted as a string, alongside the raw value for
 * sorting and meters.
 */

export interface PresentedPick {
  id: string;
  rank: number;
  /** "Buy YES · Dodgers" */
  headline: string;
  /** The question being bet on. */
  matchup: string;
  league: string;
  resolvesLabel: string;
  horizon: "day-of" | "future";

  priceLabel: string;
  fairLabel: string;
  edgeLabel: string;
  edgeValue: number;
  oddsLabel: string;

  confidence: { tier: "strong" | "moderate" | "thin"; label: string; value: number };

  stake: {
    contractsLabel: string;
    costLabel: string;
    winLabel: string;
    loseLabel: string;
  };

  /** How to place it: take the offer, or post a limit order. */
  execution: {
    style: "taker" | "maker";
    actionLabel: string;
    note: string;
  };

  /** How much of the raw disagreement with the crowd survived shrinkage. */
  discipline: {
    rawGapLabel: string;
    keptLabel: string;
    implausible: boolean;
  };

  /** One sentence a person can act on without reading the breakdown. */
  summary: string;
  drivers: { source: string; label: string; text: string }[];
  badges: string[];
  ticker: string;
  kalshiUrl: string;
}

export interface PresentedArb {
  id: string;
  title: string;
  kindLabel: string;
  lockedIn: boolean;
  costLabel: string;
  payoutLabel: string;
  returnLabel: string;
  /** Only for conditional trades. */
  breakEvenLabel: string | null;
  legs: { label: string; sideLabel: string; priceLabel: string }[];
  caution: string;
}

export interface BoardSection {
  key: string;
  title: string;
  picks: PresentedPick[];
}

export interface Board {
  meta: {
    generatedAtMs: number;
    generatedLabel: string;
    slateLabel: string;
    timezone: string;
    tzAbbrev: string;
    durationLabel: string;
    bankrollLabel: string;
  };
  headline: { state: "picks" | "quiet"; title: string; subtitle: string };
  summary: { label: string; value: string }[];
  sections: BoardSection[];
  lockedIn: PresentedArb[];
  conditional: PresentedArb[];
  notes: string[];
}

// --- Formatting helpers ------------------------------------------------------

const cents = (x: number): string => `${Math.round(x * 100)}¢`;
const usd = (x: number): string => `$${x.toFixed(2)}`;
const pts = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pts`;
const pctLabel = (x: number): string => `${(x * 100).toFixed(1)}%`;
const american = (x: number): string => (x > 0 ? `+${x}` : `${x}`);

/**
 * Series prefix -> how a person would name it.
 *
 * Kalshi tickers are not consumer-facing text: "KXMLBF5TOTAL" means "MLB first
 * five innings, total runs". Longest-prefix wins so KXMLBF5 beats KXMLB.
 */
const LEAGUE_NAMES: [string, string][] = [
  ["KXMLBF5", "MLB · First 5 Innings"],
  ["KXMLBHR", "MLB · Home Runs"],
  ["KXMLBSPREAD", "MLB · Run Line"],
  ["KXMLBTOTAL", "MLB · Totals"],
  ["KXMLBGAME", "MLB"],
  ["KXMLB", "MLB · Props"],
  ["KXWNBAGAME", "WNBA"],
  ["KXWNBASPREAD", "WNBA · Spread"],
  ["KXWNBATOTAL", "WNBA · Totals"],
  ["KXWNBA", "WNBA · Props"],
  ["KXNFLGAME", "NFL"],
  ["KXNFL", "NFL"],
  ["KXNBAGAME", "NBA"],
  ["KXNBA", "NBA"],
  ["KXNHLGAME", "NHL"],
  ["KXNHL", "NHL"],
  ["KXCFB", "College Football"],
  ["KXATPMATCH", "ATP Tennis"],
  ["KXATP", "ATP Tennis"],
  ["KXWTAMATCH", "WTA Tennis"],
  ["KXWTA", "WTA Tennis"],
  ["KXBTC", "Bitcoin"],
  ["KXETH", "Ethereum"],
  ["KXSOL", "Solana"],
  ["KXNASDAQ", "Nasdaq 100"],
  ["KXINX", "S&P 500"],
  ["KXDJI", "Dow Jones"],
  ["KXCPI", "Inflation"],
  ["KXFED", "Federal Reserve"],
  ["KXHIGH", "Weather"],
  ["KXRAIN", "Weather"],
];

function leagueName(seriesTicker: string, category: string): string {
  const upper = seriesTicker.toUpperCase();
  let best = "";
  let name = "";
  for (const [prefix, label] of LEAGUE_NAMES) {
    if (upper.startsWith(prefix) && prefix.length > best.length) {
      best = prefix;
      name = label;
    }
  }
  return name || category || "Other";
}

/** Section ordering: sports first, then the rest, "Other" always last. */
function sectionRank(title: string): number {
  if (/MLB|WNBA|NFL|NBA|NHL|Tennis|College/.test(title)) return 0;
  if (title === "Other") return 3;
  return 1;
}

function confidenceOf(value: number): PresentedPick["confidence"] {
  if (value >= 0.6) return { tier: "strong", label: "Strong evidence", value };
  if (value >= 0.35) return { tier: "moderate", label: "Moderate evidence", value };
  return { tier: "thin", label: "Thin evidence", value };
}

/** Turn an internal signal name into something a reader recognises. */
const DRIVER_LABELS: Record<string, string> = {
  consensus: "Sportsbook consensus",
  structural: "Priced-set correction",
  model: "Model",
  microstructure: "Stale quote",
  market: "Kalshi crowd",
};

function presentPick(bet: BetRecommendation, rank: number, tz: string): PresentedPick {
  const crowd = bet.contributions.find((c) => c.source === "market");
  const crowdPrice = crowd ? crowd.probability : bet.price;

  const drivers = bet.contributions
    .filter((c) => c.source !== "market")
    .sort((a, b) => b.weight - a.weight)
    .map((c) => ({
      source: c.source,
      label: DRIVER_LABELS[c.source] ?? c.source,
      text: c.rationale,
    }));

  // Lead with whatever is actually carrying the disagreement.
  const lead = drivers[0];
  const direction = bet.fair > bet.price ? "cheap" : "rich";
  const summary =
    `Kalshi is asking ${cents(bet.price)}; we make it ${cents(bet.fair)}. ` +
    `That's ${pts(bet.netEdge)} of edge after fees, looking ${direction} against ` +
    `${lead ? (DRIVER_LABELS[lead.source] ?? lead.source).toLowerCase() : "our estimate"}.`;

  const badges: string[] = [];
  if (bet.horizonKind === "future") badges.push("Future — cleared the high bar");
  badges.push(...bet.flags);

  const actionLabel =
    bet.execution.style === "maker"
      ? `Post a limit at ${cents(bet.execution.price)}`
      : `Take the offer at ${cents(bet.execution.price)}`;

  return {
    id: `${bet.ticker}-${bet.side}`,
    rank,
    headline: `Buy ${bet.side.toUpperCase()} · ${bet.label}`,
    matchup: bet.eventTitle,
    league: leagueName(bet.seriesTicker, bet.category),
    resolvesLabel: `Resolves ${formatClose(bet.closeTime, tz)}`,
    horizon: bet.horizonKind,

    priceLabel: cents(bet.price),
    fairLabel: cents(bet.fair),
    edgeLabel: pts(bet.netEdge),
    edgeValue: bet.netEdge,
    oddsLabel: `${american(bet.americanOdds)} offered · ${american(bet.fairAmericanOdds)} fair`,

    confidence: confidenceOf(bet.confidence),

    execution: {
      style: bet.execution.style,
      actionLabel,
      note: bet.execution.note,
    },

    discipline: {
      rawGapLabel: pts(bet.shrinkage.rawGap),
      keptLabel: `${(bet.shrinkage.factor * 100).toFixed(0)}% kept`,
      implausible: bet.shrinkage.implausible,
    },

    stake: {
      contractsLabel: `${bet.stake.contracts}`,
      costLabel: usd(bet.stake.costDollars),
      winLabel: `+${usd(bet.stake.winProfitDollars)}`,
      loseLabel: `−${usd(bet.stake.lossDollars)}`,
    },

    summary,
    drivers: [
      {
        source: "market",
        label: "Kalshi crowd",
        text: `The market's own midpoint is ${cents(crowdPrice)}.`,
      },
      ...drivers,
      {
        source: "discipline",
        label: "Discipline",
        text:
          `Raw disagreement was ${pts(bet.shrinkage.rawGap)}; we kept ` +
          `${(bet.shrinkage.factor * 100).toFixed(0)}% of it. Big gaps are usually a ` +
          "mismatch or a stale line, so the estimate is pulled back toward the market " +
          "in proportion to how well the evidence holds up.",
      },
    ],
    badges,
    ticker: bet.ticker,
    kalshiUrl: `https://kalshi.com/markets/${bet.seriesTicker.toLowerCase()}`,
  };
}

const ARB_KIND_LABELS: Record<ArbOpportunity["kind"], string> = {
  "yes-no-underpriced": "Both sides underpriced",
  "dutch-book": "Full set underpriced",
  "oversold-set": "Every NO underpriced",
};

function presentArb(arb: ArbOpportunity, index: number): PresentedArb {
  const lockedIn = !arb.requiresExhaustive;
  return {
    id: `${arb.eventTicker}-${arb.kind}-${index}`,
    title: arb.eventTitle,
    kindLabel: ARB_KIND_LABELS[arb.kind],
    lockedIn,
    costLabel: usd(arb.costPerSet),
    payoutLabel: usd(arb.payoutPerSet),
    returnLabel: `+${pctLabel(arb.returnOnCost)}`,
    breakEvenLabel: lockedIn ? null : pctLabel(arb.breakEvenFieldProbability),
    legs: arb.legs.map((leg) => ({
      label: leg.label,
      sideLabel: leg.side.toUpperCase(),
      priceLabel: cents(leg.price),
    })),
    caution: arb.note,
  };
}

/** Build the full view model the website renders. */
export function presentBoard(scan: ScanResult): Board {
  const tz = scan.slate.timezone;
  const picks = scan.bets.map((bet, index) => presentPick(bet, index + 1, tz));

  // Group into sections, preserving each pick's rank order within a league.
  const grouped = new Map<string, PresentedPick[]>();
  for (const pick of picks) {
    const bucket = grouped.get(pick.league);
    if (bucket) bucket.push(pick);
    else grouped.set(pick.league, [pick]);
  }

  const sections: BoardSection[] = [...grouped.entries()]
    .map(([title, sectionPicks]) => ({
      key: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      title,
      picks: sectionPicks,
    }))
    .sort((a, b) => {
      const rank = sectionRank(a.title) - sectionRank(b.title);
      if (rank !== 0) return rank;
      // Strongest section first, judged by its best pick.
      return (b.picks[0]?.edgeValue ?? 0) - (a.picks[0]?.edgeValue ?? 0);
    });

  const arbs = scan.arbitrage.map(presentArb);
  const lockedIn = arbs.filter((a) => a.lockedIn);
  const conditional = arbs.filter((a) => !a.lockedIn);

  const hasPicks = picks.length > 0 || lockedIn.length > 0;
  const dayOfCount = picks.filter((p) => p.horizon === "day-of").length;

  return {
    meta: {
      generatedAtMs: scan.generatedAt,
      generatedLabel: formatClose(scan.generatedAt, tz),
      slateLabel: scan.slate.label,
      timezone: tz,
      tzAbbrev: shortTzName(tz, new Date(scan.generatedAt)),
      durationLabel: `${(scan.durationMs / 1000).toFixed(1)}s`,
      bankrollLabel: usd(scan.bankroll),
    },
    headline: hasPicks
      ? {
          state: "picks",
          title:
            dayOfCount > 0
              ? `${dayOfCount} bet${dayOfCount === 1 ? "" : "s"} worth taking today`
              : "Nothing on today's slate, but see below",
          subtitle:
            "Ranked by edge after fees, discounted for weak evidence and thin books.",
        }
      : {
          state: "quiet",
          title: "No bet is the right call right now",
          subtitle:
            "Every market on today's board is priced close enough to fair that " +
            "there's nothing worth paying the fee to take. Check back later — " +
            "prices move all day.",
        },
    summary: [
      { label: "Markets scanned", value: scan.stats.marketsScanned.toLocaleString() },
      { label: "Resolving today", value: scan.stats.marketsTradeable.toLocaleString() },
      { label: "Matched to books", value: scan.stats.consensusMatched.toLocaleString() },
      { label: "Bets found", value: String(picks.length) },
      { label: "Locked-in edges", value: String(lockedIn.length) },
    ],
    sections,
    lockedIn,
    conditional,
    notes: scan.notes,
  };
}
