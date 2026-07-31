import type { MarketView } from "./market.js";

/**
 * The structured terms of a contract, parsed once.
 *
 * `wager.ts` turns these into English for the reader; `signals/coherence.ts`
 * needs the *numbers* — which team, which line — to price one market off
 * another. Both read from here so the parsing can't drift between them.
 */

export type Terms =
  | { kind: "moneyline"; team: string }
  | { kind: "spread"; team: string; line: number; unit: string }
  | { kind: "total"; line: number; unit: string }
  | { kind: "team-total"; team: string; line: number; unit: string }
  | { kind: "segment"; team: string; part: string }
  | { kind: "player-prop"; player: string; count: number; stat: string }
  | { kind: "threshold"; level: string; above: boolean }
  | { kind: "range"; lo: string; hi: string }
  | { kind: "other" };

export function parseTerms(market: MarketView): Terms {
  const label = (market.yesLabel ?? "").trim();
  const title = (market.title ?? "").trim();

  // "Las Vegas wins by over 13.5 points"
  const spread = label.match(/^(.+?)\s+wins by over\s+([\d.]+)\s+(\w+)$/i);
  if (spread) {
    return {
      kind: "spread",
      team: spread[1]!.trim(),
      line: Number(spread[2]),
      unit: spread[3]!,
    };
  }

  // "Over 163.5 points scored" — the whole game.
  const total = label.match(/^over\s+([\d.]+)\s+(\w+)\s+scored$/i);
  if (total) {
    return { kind: "total", line: Number(total[1]), unit: total[2]! };
  }

  // "A's over 1.5 runs scored" — one team only.
  const teamTotal = label.match(/^(.+?)\s+over\s+([\d.]+)\s+(\w+)\s+scored$/i);
  if (teamTotal) {
    return {
      kind: "team-total",
      team: teamTotal[1]!.trim(),
      line: Number(teamTotal[2]),
      unit: teamTotal[3]!,
    };
  }

  // "San Francisco wins first 5 innings"
  const segment = label.match(/^(.+?)\s+wins\s+(first\s+\d+\s+\w+)$/i);
  if (segment) {
    return { kind: "segment", team: segment[1]!.trim(), part: segment[2]! };
  }

  // "Sonny Gray: 3+", with the stat named in the title.
  const prop = label.match(/^(.+?):\s*(\d+)\+$/);
  if (prop) {
    const stat = title.match(/:\s*\d+\+\s*([a-z\s]+)\??$/i)?.[1]?.trim() ?? "";
    return {
      kind: "player-prop",
      player: prop[1]!.trim(),
      count: Number(prop[2]),
      stat,
    };
  }

  // "$54,600 or above"
  const threshold = label.match(/^(\$?[\d,]+(?:\.\d+)?)\s+or\s+(above|below)$/i);
  if (threshold) {
    return {
      kind: "threshold",
      level: threshold[1]!,
      above: threshold[2]!.toLowerCase() === "above",
    };
  }

  // "$73 to 73.9999"
  const range = label.match(/^(\$?[\d,.]+)\s+to\s+(\$?[\d,.]+)$/i);
  if (range) {
    return { kind: "range", lo: range[1]!, hi: range[2]! };
  }

  // A bare short name inside a "X vs Y" event is a straight winner market.
  const matchup = market.eventTitle.match(/^(.+?)\s+vs\.?\s+(.+?)(?::.*)?$/i);
  if (matchup && !/\d/.test(label) && label.split(/\s+/).length <= 4) {
    return { kind: "moneyline", team: label };
  }

  return { kind: "other" };
}

/**
 * The two sides of a matchup, from the event title.
 *
 * Returns them in title order, which for US sports is away-then-home. That
 * ordering matters to the coherence model, which has to know whose margin it's
 * computing.
 */
export function matchupSides(eventTitle: string): [string, string] | null {
  const cleaned = eventTitle.replace(/:.*$/, "").trim();
  const parts = cleaned.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  if (!a?.trim() || !b?.trim()) return null;
  return [a.trim(), b.trim()];
}

/**
 * The game a market belongs to, independent of which family it's in.
 *
 * Kalshi encodes the fixture in the event ticker's suffix and reuses it across
 * every family: `KXMLBGAME-26JUL302140BOSATH`, `KXMLBSPREAD-26JUL302140BOSATH`,
 * `KXMLBTOTAL-26JUL302140BOSATH`. That shared suffix is what makes it possible
 * to price a run line off the same game's moneyline.
 */
export function gameKey(eventTicker: string): string | null {
  const dash = eventTicker.indexOf("-");
  if (dash === -1) return null;
  const suffix = eventTicker.slice(dash + 1);
  return suffix.length >= 6 ? suffix : null;
}
