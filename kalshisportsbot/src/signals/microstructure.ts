import type { MarketView } from "../core/market.js";
import { clamp01 } from "../core/money.js";
import type { MicrostructureRead, ProbabilityEstimate } from "./types.js";

/**
 * Microstructure: reading the book rather than the world.
 *
 * This serves two purposes, and it's worth keeping them separate. First, a
 * reality check — a 6-point edge in a market quoted 10 wide with 3 contracts
 * resting isn't an edge, it's a screenshot. Second, an actual signal: when a
 * market's quotes haven't moved but trades are printing away from the mid, the
 * quote is stale and the trades are the better information.
 */

const HOUR = 3_600_000;

/** Assess whether an edge in this market is takeable, and at what size. */
export function readMicrostructure(
  market: MarketView,
  side: "yes" | "no",
  now = Date.now(),
): MicrostructureRead {
  const flags: string[] = [];

  // --- Spread -------------------------------------------------------------
  // You cross the spread to get in. Half of it is the immediate cost of the
  // round trip, so a wide quote is a real haircut on any edge.
  const spread = Number.isFinite(market.spread) ? market.spread : 1;
  const spreadScore = clamp01(1 - (spread - 0.01) / 0.09); // 1c great, 10c worthless
  if (spread >= 0.05) flags.push(`wide spread (${(spread * 100).toFixed(0)}c)`);

  // --- Depth --------------------------------------------------------------
  const topSize = side === "yes" ? market.yesAskSize : market.yesBidSize;
  const depthScore = clamp01(Math.log10(Math.max(topSize, 1)) / 2.5); // ~300+ is full marks
  if (topSize < 25) flags.push(`thin book (${Math.floor(topSize)} at top)`);

  // --- Participation ------------------------------------------------------
  // A market nobody trades can stay mispriced forever, which sounds like an
  // opportunity but usually means you can't get out either.
  const volumeScore = clamp01(Math.log10(Math.max(market.volume24h, 1)) / 3.2);
  if (market.volume24h < 100) flags.push("low 24h volume");

  // --- Staleness ----------------------------------------------------------
  const ageMs = market.updatedTime > 0 ? now - market.updatedTime : 0;
  const stale = ageMs > 6 * HOUR;
  if (stale) flags.push(`quote ${Math.floor(ageMs / HOUR)}h old`);

  // Weighted toward spread and depth: those decide whether you can trade,
  // volume only decides how comfortable it feels.
  const quality = clamp01(
    0.4 * spreadScore + 0.35 * depthScore + 0.25 * volumeScore - (stale ? 0.15 : 0),
  );

  return { quality, flags, topSize, stale };
}

/**
 * Stale-quote signal: trust the tape over the quote.
 *
 * When a market's last trade sits well away from the current midpoint, someone
 * paid a price the resting orders haven't caught up to. Trades are information;
 * untouched quotes are just orders nobody has bothered to cancel. This nudges
 * the estimate toward the traded price, weighted by how far the two diverge and
 * how stale the quote is.
 *
 * The confidence stays modest on purpose — a single print can be noise, and this
 * is the signal most likely to be wrong when the divergence is genuine news the
 * quotes are correctly ignoring.
 */
export function stalePriceEstimate(
  market: MarketView,
  read: MicrostructureRead,
  now = Date.now(),
): ProbabilityEstimate | null {
  if (!Number.isFinite(market.mid) || !Number.isFinite(market.lastPrice)) return null;
  if (market.lastPrice <= 0 || market.lastPrice >= 1) return null;
  if (market.volume24h < 20) return null; // no meaningful tape to read

  const divergence = market.lastPrice - market.mid;
  if (Math.abs(divergence) < 0.02) return null;

  const ageHours = market.updatedTime > 0 ? (now - market.updatedTime) / HOUR : 0;
  const staleness = clamp01(ageHours / 12);
  if (staleness <= 0.1) return null;

  // Move only partway to the traded price — the truth is usually between them.
  const probability = clamp01(market.mid + divergence * 0.5 * staleness);

  return {
    source: "microstructure",
    probability,
    confidence: clamp01(staleness * 0.5 * (1 - read.quality * 0.3)),
    rationale:
      `Last trade ${(market.lastPrice * 100).toFixed(0)}c vs mid ` +
      `${(market.mid * 100).toFixed(0)}c on a quote ${ageHours.toFixed(0)}h stale — ` +
      "the tape is ahead of the book.",
  };
}
