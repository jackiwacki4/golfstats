import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evPerContract,
  kellyFraction,
  makerFee,
  marginalFeeRate,
  sizeStake,
  takerFee,
} from "../src/core/money.js";
import type { MarketView } from "../src/core/market.js";
import { fuse } from "../src/engine/fuse.js";
import { devig } from "../src/signals/consensus.js";
import { findArbitrage, normalizeExclusiveSet } from "../src/signals/structural.js";
import type { ProbabilityEstimate } from "../src/signals/types.js";

/** Build a market with sane defaults; override just what a test cares about. */
function market(overrides: Partial<MarketView> = {}): MarketView {
  const yesBid = overrides.yesBid ?? 0.4;
  const yesAsk = overrides.yesAsk ?? 0.42;
  return {
    ticker: "TEST-1",
    eventTicker: "TEST",
    seriesTicker: "TEST",
    title: "Test market",
    yesLabel: "Yes",
    eventTitle: "Test event",
    category: "Test",
    closeTime: Date.now() + 86_400_000,
    updatedTime: Date.now(),
    yesBid,
    yesAsk,
    noBid: 1 - yesAsk,
    noAsk: 1 - yesBid,
    lastPrice: (yesBid + yesAsk) / 2,
    mid: (yesBid + yesAsk) / 2,
    spread: yesAsk - yesBid,
    yesBidSize: 500,
    yesAskSize: 500,
    volume24h: 5000,
    openInterest: 10_000,
    liquidity: 1000,
    ...overrides,
  };
}

// --- Fees --------------------------------------------------------------------

test("taker fee matches Kalshi's published formula and ceiling", () => {
  // round_up(0.07 * C * P * (1-P)). Peaks at 50c: 0.07*100*0.25 = $1.75/100.
  assert.equal(takerFee(100, 0.5), 1.75);
  // 0.07 * 100 * 0.1 * 0.9 = $0.63
  assert.equal(takerFee(100, 0.1), 0.63);
  // Symmetric about 50c.
  assert.equal(takerFee(100, 0.3), takerFee(100, 0.7));
  // Rounds up to the cent, never down: 0.07*1*0.25 = $0.0175 -> $0.02
  assert.equal(takerFee(1, 0.5), 0.02);
});

test("maker fee is a quarter of the taker rate", () => {
  assert.equal(makerFee(100, 0.5), 0.44); // 0.0175*100*0.25 = 0.4375 -> 0.44
});

test("marginal fee rate is unrounded, unlike a 1-contract fee", () => {
  // The rounded single-contract fee overstates the true marginal cost.
  assert.equal(marginalFeeRate(0.5), 0.0175);
  assert.ok(takerFee(1, 0.5) > marginalFeeRate(0.5));
});

// --- Edge and sizing ---------------------------------------------------------

test("EV is zero at a fair price before fees, negative after them", () => {
  // Buying at exactly fair value is a losing trade once fees are charged.
  assert.ok(evPerContract(0.5, 0.5) < 0);
  assert.ok(Math.abs(evPerContract(0.5, 0.5) + 0.0175) < 1e-9);
});

test("Kelly refuses a bet with no edge and scales with one", () => {
  assert.equal(kellyFraction(0.4, 0.5), 0);
  assert.equal(kellyFraction(0.5, 0.5), 0);
  const small = kellyFraction(0.55, 0.5);
  const large = kellyFraction(0.7, 0.5);
  assert.ok(small > 0 && large > small);
});

test("stake sizing is internally consistent", () => {
  const stake = sizeStake(0.6, 0.5, 1000, 0.25);
  assert.ok(stake.contracts > 0);
  // Cost must equal contracts * price, and risk must include the fee.
  assert.ok(Math.abs(stake.costDollars - stake.contracts * 0.5) < 0.01);
  assert.ok(Math.abs(stake.lossDollars - (stake.costDollars + stake.feeDollars)) < 0.01);
  // Fractional Kelly must stake strictly less than full Kelly.
  assert.ok(stake.stakedFraction < stake.kelly);
});

// --- Fusion ------------------------------------------------------------------

test("no independent signal means no disagreement with the market", () => {
  const m = market({ yesBid: 0.4, yesAsk: 0.42 });
  const fused = fuse(m, []);
  assert.equal(fused.hasIndependentSignal, false);
  // Fair value collapses to the crowd price, so no edge can be manufactured.
  assert.ok(Math.abs(fused.fair - m.mid) < 1e-9);
});

test("a confident consensus pulls fair value away from the crowd", () => {
  const m = market({ yesBid: 0.4, yesAsk: 0.42 }); // mid 0.41
  const consensus: ProbabilityEstimate = {
    source: "consensus",
    probability: 0.55,
    confidence: 0.9,
    rationale: "test",
  };
  const fused = fuse(m, [consensus]);
  // Moves toward the books, but stays short of them — the crowd still counts.
  assert.ok(fused.fair > m.mid, "should move toward consensus");
  assert.ok(fused.fair < 0.55, "should not fully abandon the market prior");
  assert.ok(fused.confidence > 0.4);
});

test("a low-confidence source barely moves fair value", () => {
  const m = market({ yesBid: 0.4, yesAsk: 0.42 });
  const weak: ProbabilityEstimate = {
    source: "model",
    probability: 0.9,
    confidence: 0.05,
    rationale: "test",
  };
  const fused = fuse(m, [weak]);
  assert.ok(Math.abs(fused.fair - m.mid) < 0.02, "weak signal should not swing fair value");
});

// --- De-vig ------------------------------------------------------------------

test("de-vigging strips the overround to a proper distribution", () => {
  // -110 both sides = 1.909 decimal; implied sums to ~1.048.
  const fair = devig([1.909, 1.909]);
  assert.ok(Math.abs(fair[0]! - 0.5) < 1e-6);
  assert.ok(Math.abs(fair[0]! + fair[1]! - 1) < 1e-9);

  const lopsided = devig([1.25, 4.5]);
  assert.ok(Math.abs(lopsided.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(lopsided[0]! > lopsided[1]!);
});

// --- Structural --------------------------------------------------------------

test("a genuine YES/NO underpricing is flagged", () => {
  // Both sides buyable for 0.94 total, guaranteed $1 payout.
  const m = market({ yesAsk: 0.45, noAsk: 0.49, yesBid: 0.44 });
  const found = findArbitrage("E", "Event", [m], false);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.kind, "yes-no-underpriced");
  assert.ok(found[0]!.profitPerSet > 0);
});

test("a normally-priced market yields no arbitrage", () => {
  const m = market({ yesAsk: 0.52, noAsk: 0.5, yesBid: 0.48 });
  assert.equal(findArbitrage("E", "Event", [m], false).length, 0);
});

test("REGRESSION: a non-exhaustive exclusive set is not a dutch book", () => {
  // The "51st state" trap: eight candidates whose asks sum to $0.17. Buying all
  // of them is not free money — if no state is admitted, every leg settles NO
  // and the entire stake is lost. `mutually_exclusive` promises at most one
  // YES, never exactly one.
  const legs = Array.from({ length: 8 }, (_, i) =>
    market({ ticker: `L${i}`, yesBid: 0.01, yesAsk: 0.02, noAsk: 0.99, noBid: 0.98 }),
  );
  const found = findArbitrage("E", "51st state", legs, true);
  assert.equal(
    found.filter((a) => a.kind === "dutch-book").length,
    0,
    "must not report a dutch book on a set with a live 'none of the above'",
  );
});

test("a plausibly exhaustive set just under $1 IS a dutch book", () => {
  // Two legs at 0.46 = 0.92 gross, ~3.5c of fees, so still profitable.
  const legs = Array.from({ length: 2 }, (_, i) =>
    market({ ticker: `L${i}`, yesBid: 0.44, yesAsk: 0.46, noAsk: 0.56, noBid: 0.54 }),
  );
  const found = findArbitrage("E", "Exhaustive event", legs, true);
  const dutch = found.filter((a) => a.kind === "dutch-book");
  assert.equal(dutch.length, 1);
  // It must never present itself as locked in — the payout depends on the legs
  // actually covering every outcome, which prices cannot prove.
  assert.equal(dutch[0]!.requiresExhaustive, true);
  assert.ok(dutch[0]!.breakEvenFieldProbability > 0);
  assert.match(dutch[0]!.note, /NOT risk-free/);
});

test("locked-in trades are marked as such, conditional ones are not", () => {
  // Single-market YES+NO pays $1 no matter what — genuinely risk-free.
  const m = market({ yesAsk: 0.45, noAsk: 0.49, yesBid: 0.44 });
  const single = findArbitrage("E", "Event", [m], false)[0]!;
  assert.equal(single.requiresExhaustive, false);
  assert.ok(Number.isNaN(single.breakEvenFieldProbability));
});

test("fees kill a dutch book that looks profitable gross", () => {
  // Four legs at 0.245 sum to 0.98 — 2c of gross edge. But each leg carries
  // ~1.3c of fee, so the set costs $1.03 to buy and loses money. Leg count is
  // the thing that kills these: fees scale with legs while the payout doesn't.
  const legs = Array.from({ length: 4 }, (_, i) =>
    market({ ticker: `L${i}`, yesBid: 0.23, yesAsk: 0.245, noAsk: 0.77, noBid: 0.755 }),
  );
  const found = findArbitrage("E", "Event", legs, true);
  assert.equal(found.filter((a) => a.kind === "dutch-book").length, 0);
});

test("buying NO across every leg is safe without exhaustiveness", () => {
  // At most one NO can lose, so an unlisted outcome only pays better.
  const legs = Array.from({ length: 4 }, (_, i) =>
    market({ ticker: `L${i}`, yesBid: 0.26, yesAsk: 0.28, noAsk: 0.72, noBid: 0.7 }),
  );
  const found = findArbitrage("E", "Event", legs, true);
  const oversold = found.find((a) => a.kind === "oversold-set");
  assert.ok(oversold, "should find the NO-side set");
  assert.equal(oversold!.payoutPerSet, 3); // n - 1
});

test("renormalization is skipped when outcomes don't cover the space", () => {
  const legs = Array.from({ length: 5 }, (_, i) =>
    market({ ticker: `L${i}`, yesBid: 0.04, yesAsk: 0.06 }),
  );
  // Mids sum to 0.25 — a huge unlisted "field", so normalizing would invent edge.
  assert.equal(normalizeExclusiveSet(legs).size, 0);
});

test("renormalization strips the overround on a covered set", () => {
  const legs = Array.from({ length: 4 }, (_, i) =>
    market({ ticker: `L${i}`, yesBid: 0.26, yesAsk: 0.28 }),
  );
  // Mids sum to 1.08; each leg should be shaded down to 0.25.
  const estimates = normalizeExclusiveSet(legs);
  assert.equal(estimates.size, 4);
  const first = estimates.get("L0")!;
  assert.ok(Math.abs(first.probability - 0.25) < 1e-6);
  assert.ok(first.probability < 0.27, "renormalized price must sit below the raw mid");
});

// --- End to end --------------------------------------------------------------

test("a real consensus disagreement produces a positive-EV, correctly sized bet", () => {
  // Kalshi says 41%, the books say 58%. This is the case the bot exists for.
  const m = market({ yesBid: 0.4, yesAsk: 0.42 });
  const fused = fuse(m, [
    { source: "consensus", probability: 0.58, confidence: 0.9, rationale: "books" },
  ]);

  const price = m.yesAsk;
  const netEdge = fused.fair - price - marginalFeeRate(price);
  assert.ok(netEdge > 0.03, `expected a tradeable edge, got ${netEdge}`);

  const stake = sizeStake(fused.fair, price, 1000, 0.25);
  assert.ok(stake.contracts > 0);
  assert.ok(stake.winProfitDollars > 0);
  // Quarter-Kelly on a ~7-point edge should stay a modest slice of bankroll.
  assert.ok(stake.costDollars < 100, `sizing too aggressive: $${stake.costDollars}`);
});
