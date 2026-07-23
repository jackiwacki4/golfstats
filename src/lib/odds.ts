/**
 * Odds helpers. The stored shape ({ outright, format, ... }) is provider-neutral,
 * so these functions are the only place that knows how to read american vs decimal.
 */

export type OddsFormat = 'american' | 'decimal';

export interface Odds {
  outright: number;
  format?: OddsFormat;
  asOf?: string;
  book?: string;
}

/** Human-facing american string, e.g. +1400 or -120. */
export function formatAmerican(odds: Odds): string {
  const american = toAmerican(odds);
  return american > 0 ? `+${american}` : `${american}`;
}

/** Decimal price, e.g. 15.0. Rounded to one place for display. */
export function toDecimal(odds: Odds): number {
  if (odds.format === 'decimal') return odds.outright;
  const a = odds.outright;
  const dec = a > 0 ? a / 100 + 1 : 100 / -a + 1;
  return Math.round(dec * 100) / 100;
}

function toAmerican(odds: Odds): number {
  if (odds.format !== 'decimal') return odds.outright;
  const d = odds.outright;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

/** Implied probability as a 0–1 fraction (vig included, as priced). */
export function impliedProbability(odds: Odds): number {
  return 1 / toDecimal(odds);
}

/** Implied probability formatted as a percent string, e.g. "6.7%". */
export function impliedPercent(odds: Odds): string {
  return `${(impliedProbability(odds) * 100).toFixed(1)}%`;
}
