import type { MarketView } from "./market.js";
import { matchupSides, parseTerms, type Terms } from "./terms.js";

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
 * So the negation is constructed here per market family, and the wager is split
 * in two: what you *win on* (plain English) and what you *click* (the Kalshi
 * mechanics). They are different things and conflating them made the board hard
 * to read.
 */

export interface WagerDescription {
  kind: Terms["kind"];
  /** Short chip: "Moneyline", "Spread", "Over / Under". */
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
  const isHalf = Math.abs((line % 1) - 0.5) < 1e-9;
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

const TYPE_LABELS: Record<Terms["kind"], string> = {
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

export function describeWager(market: MarketView, side: "yes" | "no"): WagerDescription {
  const terms = parseTerms(market);
  const label = (market.yesLabel ?? "").trim();
  const yes = side === "yes";

  const build = (winYes: string, winNo: string): WagerDescription => ({
    kind: terms.kind,
    typeLabel: TYPE_LABELS[terms.kind],
    youWinIf: yes ? winYes : winNo,
    mechanics: `Buy ${side.toUpperCase()} on “${label}”`,
    officialRule: market.rulesPrimary ?? "",
  });

  switch (terms.kind) {
    case "spread": {
      const { over, under } = overUnderPhrases(terms.line, terms.unit);
      return build(
        `${terms.team} wins by ${over}.`,
        `${terms.team} wins by ${under}, or loses outright.`,
      );
    }
    case "total": {
      const { over, under } = overUnderPhrases(terms.line, terms.unit);
      return build(
        `Both teams combined score ${over}.`,
        `Both teams combined score ${under}.`,
      );
    }
    case "team-total": {
      const { over, under } = overUnderPhrases(terms.line, terms.unit);
      return build(`${terms.team} scores ${over}.`, `${terms.team} scores ${under}.`);
    }
    case "segment":
      return build(
        `${terms.team} is ahead after the ${terms.part} (not the full game).`,
        `${terms.team} is level or behind after the ${terms.part}.`,
      );
    case "player-prop": {
      const noun = terms.stat || "of that stat";
      return build(
        `${terms.player} records ${terms.count} or more ${noun}.`,
        `${terms.player} records fewer than ${terms.count} ${noun}.`,
      );
    }
    case "threshold":
      return build(
        `It settles at ${terms.level} or ${terms.above ? "above" : "below"}.`,
        `It settles ${terms.above ? "below" : "above"} ${terms.level}.`,
      );
    case "range":
      return build(
        `It settles between ${terms.lo} and ${terms.hi}.`,
        `It settles outside ${terms.lo}–${terms.hi}.`,
      );
    case "moneyline": {
      const sides = matchupSides(market.eventTitle);
      const opponent = sides
        ? sides[0].toLowerCase().includes(terms.team.toLowerCase())
          ? sides[1]
          : sides[0]
        : "";
      return build(
        `${terms.team} wins${opponent ? ` (beats ${opponent})` : ""}.`,
        `${terms.team} loses${opponent ? ` (${opponent} wins)` : ""}.`,
      );
    }
    default:
      return build(`“${label}” happens.`, `“${label}” does not happen.`);
  }
}
