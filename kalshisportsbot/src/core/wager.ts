import type { MarketView } from "./market.js";

/**
 * Saying, in English, what bet is actually being suggested.
 *
 * Kalshi labels a contract from the YES side only — and critically,
 * `no_sub_title` is a *copy* of `yes_sub_title`, not its negation. So a NO
 * position on "Las Vegas wins by over 13.5 points" has no label of its own, and
 * mechanically prefixing "NOT" produces the unreadable "NOT Las Vegas wins by
 * over 13.5 points". A person then has to work out for themselves that this
 * means Las Vegas winning by 13 or fewer *or losing outright* — which is
 * precisely the sort of thing you don't want to be deriving under time pressure
 * with money on it.
 *
 * So the negation is constructed here per market family rather than by string
 * surgery, and the wager is split in two: what you *win on* (plain English) and
 * what you *click* (the Kalshi mechanics). They are different things and
 * conflating them is what made the board hard to read.
 */

export type WagerKind =
  | "moneyline"
  | "spread"
  | "total"
  | "team-total"
  | "segment"
  | "player-prop"
  | "threshold"
  | "range"
  | "other";

export interface WagerDescription {
  kind: WagerKind;
  /** Short chip: "Moneyline", "Spread", "Total". */
  typeLabel: string;
  /** The condition under which this position pays. Always side-aware. */
  youWinIf: string;
  /** What to actually do on Kalshi. */
  mechanics: string;
  /** Kalshi's own settlement wording, when available — the final authority. */
  officialRule: string;
}

/** "13.5" -> "14 or more" / "13 or fewer" for whole-number scoring. */
function overUnderPhrases(line: number, unit: string): { over: string; under: string } {
  const isHalf = Math.abs(line % 1 - 0.5) < 1e-9;
  if (isHalf) {
    return {
      over: `${Math.ceil(line)} or more ${unit}`,
      under: `${Math.floor(line)} or fewer ${unit}`,
    };
  }
  return {
    over: `more than ${line} ${unit}`,
    under: `${line} ${unit} or fewer`,
  };
}

const TYPE_LABELS: Record<WagerKind, string> = {
  moneyline: "Moneyline",
  spread: "Spread",
  total: "Over / Under",
  "team-total": "Team total",
  segment: "Partial game",
  "player-prop": "Player prop",
  threshold: "Price level",
  range: "Price range",
  other: "Market",
};

/**
 * Describe one side of one market.
 *
 * Parsing works off `yes_sub_title` rather than the series ticker, because the
 * label is what actually states the terms — the ticker only hints at the family
 * and Kalshi adds new ones constantly. Anything unrecognised degrades to the raw
 * label plus a plain negation, which is still readable.
 */
export function describeWager(market: MarketView, side: "yes" | "no"): WagerDescription {
  const label = (market.yesLabel ?? "").trim();
  const title = (market.title ?? "").trim();
  const officialRule = market.rulesPrimary ?? "";
  const yes = side === "yes";

  const build = (kind: WagerKind, winYes: string, winNo: string): WagerDescription => ({
    kind,
    typeLabel: TYPE_LABELS[kind],
    youWinIf: yes ? winYes : winNo,
    mechanics: `Buy ${side.toUpperCase()} on “${label}”`,
    officialRule,
  });

  // "Las Vegas wins by over 13.5 points"
  const spread = label.match(/^(.+?)\s+wins by over\s+([\d.]+)\s+(\w+)$/i);
  if (spread) {
    const [, team, raw, unit] = spread;
    const line = Number(raw);
    const { over, under } = overUnderPhrases(line, unit!);
    return build(
      "spread",
      `${team} wins by ${over}.`,
      `${team} wins by ${under}, or loses outright.`,
    );
  }

  // "Over 163.5 points scored" — the whole game's combined score.
  const total = label.match(/^over\s+([\d.]+)\s+(\w+)\s+scored$/i);
  if (total) {
    const [, raw, unit] = total;
    const { over, under } = overUnderPhrases(Number(raw), unit!);
    return build(
      "total",
      `Both teams combined score ${over}.`,
      `Both teams combined score ${under}.`,
    );
  }

  // "A's over 1.5 runs scored" — one team's own total.
  const teamTotal = label.match(/^(.+?)\s+over\s+([\d.]+)\s+(\w+)\s+scored$/i);
  if (teamTotal) {
    const [, team, raw, unit] = teamTotal;
    const { over, under } = overUnderPhrases(Number(raw), unit!);
    return build("team-total", `${team} scores ${over}.`, `${team} scores ${under}.`);
  }

  // "San Francisco wins first 5 innings"
  const segment = label.match(/^(.+?)\s+wins\s+(first\s+\d+\s+\w+)$/i);
  if (segment) {
    const [, team, part] = segment;
    return build(
      "segment",
      `${team} is ahead after the ${part} (not the full game).`,
      `${team} is level or behind after the ${part}.`,
    );
  }

  // "Sonny Gray: 3+" — the stat lives in the market title.
  const prop = label.match(/^(.+?):\s*(\d+)\+$/);
  if (prop) {
    const [, player, count] = prop;
    const stat = title.match(/:\s*\d+\+\s*([a-z\s]+)\??$/i)?.[1]?.trim() ?? "";
    const noun = stat || "of that stat";
    return build(
      "player-prop",
      `${player} records ${count} or more ${noun}.`,
      `${player} records fewer than ${count} ${noun}.`,
    );
  }

  // "$54,600 or above"
  const threshold = label.match(/^(\$?[\d,]+(?:\.\d+)?)\s+or\s+(above|below)$/i);
  if (threshold) {
    const [, level, direction] = threshold;
    const isAbove = direction!.toLowerCase() === "above";
    return build(
      "threshold",
      `It settles at ${level} or ${isAbove ? "above" : "below"}.`,
      `It settles ${isAbove ? "below" : "above"} ${level}.`,
    );
  }

  // "$73 to 73.9999"
  const range = label.match(/^(\$?[\d,.]+)\s+to\s+(\$?[\d,.]+)$/i);
  if (range) {
    const [, lo, hi] = range;
    return build(
      "range",
      `It settles between ${lo} and ${hi}.`,
      `It settles outside ${lo}–${hi}.`,
    );
  }

  // A bare name — team or player — is a straight winner market.
  const matchup = market.eventTitle.match(/^(.+?)\s+vs\.?\s+(.+?)(?::.*)?$/i);
  if (matchup && !/\d/.test(label) && label.split(/\s+/).length <= 4) {
    const [, a, b] = matchup;
    const opponent =
      label.toLowerCase().includes((a ?? "").toLowerCase().split(" ").pop() ?? "§")
        ? b
        : a;
    return build(
      "moneyline",
      `${label} wins${opponent ? ` (beats ${opponent})` : ""}.`,
      `${label} loses${opponent ? ` (${opponent} wins)` : ""}.`,
    );
  }

  return build("other", `“${label}” happens.`, `“${label}” does not happen.`);
}
