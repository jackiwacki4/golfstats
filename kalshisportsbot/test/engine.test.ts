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
import {
  hasReliableMid,
  isMultivariate,
  normalizeMarket,
  resolvesWithin,
  type MarketView,
} from "../src/core/market.js";
import { slateWindow } from "../src/core/time.js";
import { fuse } from "../src/engine/fuse.js";
import { devig, devigPower, splitMatchup, teamsMatch } from "../src/signals/consensus.js";
import { shrinkTowardMarket } from "../src/core/inference.js";
import { planExecution } from "../src/core/execution.js";
import { describeWager } from "../src/core/wager.js";
import { fitGame, SPORT_MODELS } from "../src/core/scoring.js";
import { buildCoherence, inferExpectedTotal } from "../src/signals/coherence.js";
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
    rulesPrimary: "",
    category: "Test",
    closeTime: Date.now() + 86_400_000,
    resolutionTime: Date.now() + 86_400_000,
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

// --- Team matching -----------------------------------------------------------

test("REGRESSION: Kalshi city names match full sportsbook team names", () => {
  // Kalshi sends the city, the books send the full name. Matching on the last
  // word looks for "marlins", which Kalshi never sends — that silently produced
  // zero matches across every league.
  assert.equal(teamsMatch("Miami", "Miami Marlins"), true);
  assert.equal(teamsMatch("Pittsburgh", "Pittsburgh Pirates"), true);
  assert.equal(teamsMatch("Washington", "Washington Nationals"), true);
  assert.equal(teamsMatch("Miami", "Pittsburgh Pirates"), false);
});

test("single-letter suffixes disambiguate same-city teams", () => {
  // Kalshi writes "New York M" and "New York Y" for the Mets and Yankees.
  assert.equal(teamsMatch("New York M", "New York Mets"), true);
  assert.equal(teamsMatch("New York M", "New York Yankees"), false);
  assert.equal(teamsMatch("New York Y", "New York Yankees"), true);
  assert.equal(teamsMatch("New York Y", "New York Mets"), false);
});

test("REGRESSION: a stray initial cannot re-use the city token", () => {
  // "Chicago C" is the Cubs. Without requiring distinct token assignments the
  // "c" matches "Chicago" again and the White Sox pass — a confident bet on
  // the wrong team, which is far worse than no match at all.
  assert.equal(teamsMatch("Chicago C", "Chicago Cubs"), true);
  assert.equal(teamsMatch("Chicago C", "Chicago White Sox"), false);
  assert.equal(teamsMatch("Los Angeles D", "Los Angeles Dodgers"), true);
  assert.equal(teamsMatch("Los Angeles D", "Los Angeles Angels"), false);
});

test("punctuation and one-word teams still match", () => {
  assert.equal(teamsMatch("St. Louis", "St. Louis Cardinals"), true);
  assert.equal(teamsMatch("Athletics", "Oakland Athletics"), true);
});

test("possessive and initialism forms Kalshi actually sends", () => {
  // Live Kalshi titles include "Boston vs A's" and "Chicago WS vs Tampa Bay".
  assert.equal(teamsMatch("A's", "Oakland Athletics"), true);
  assert.equal(teamsMatch("A's", "Detroit Tigers"), false);
  assert.equal(teamsMatch("Chicago WS", "Chicago White Sox"), true);
  assert.equal(teamsMatch("Chicago WS", "Chicago Cubs"), false);
  // The initialism must not cannibalise a token another word already claimed.
  assert.equal(teamsMatch("Chicago C", "Chicago White Sox"), false);
});

test("matchup titles split into two sides", () => {
  assert.deepEqual(splitMatchup("Miami vs New York M"), ["Miami", "New York M"]);
  assert.deepEqual(splitMatchup("Miami vs New York M Winner?"), ["Miami", "New York M"]);
  // Kalshi prefixes special fixtures; the prefix is not part of the team name.
  assert.deepEqual(splitMatchup("Hall of Fame Game: Carolina vs Arizona"), [
    "Carolina",
    "Arizona",
  ]);
  // Not a head-to-head title — spreads and totals must not be priced off a moneyline.
  assert.equal(splitMatchup("Total runs in Marlins game"), null);
  assert.equal(splitMatchup("FC Sion vs Bate Borisov: Regulation Time Correct Score")?.[1], "Bate Borisov: Regulation Time Correct Score");
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

// --- Slate windows -----------------------------------------------------------

test("REGRESSION: sports markets are slated by resolution, not close time", () => {
  // A tennis match tonight carries a close_time ~15 days out (Kalshi's
  // settlement backstop) and an expected_expiration_time of tonight. Slating on
  // close time would classify every sports market as a future and leave the
  // day-of board permanently empty.
  const match = normalizeMarket({
    ticker: "KXATPMATCH-26JUL31FRIMIC-FRI",
    event_ticker: "KXATPMATCH-26JUL31FRIMIC",
    market_type: "binary",
    title: "Match winner",
    yes_sub_title: "Fritz",
    no_sub_title: "Michelsen",
    status: "active",
    open_time: "2026-07-29T00:00:00Z",
    close_time: "2026-08-14T15:00:00Z",
    expected_expiration_time: "2026-07-30T23:00:00Z",
    yes_bid_dollars: "0.4000",
    yes_ask_dollars: "0.4200",
    no_bid_dollars: "0.5800",
    no_ask_dollars: "0.6000",
    last_price_dollars: "0.4100",
  });

  const start = Date.parse("2026-07-30T16:00:00Z");
  const end = Date.parse("2026-07-31T04:00:00Z");

  assert.equal(match.resolutionTime, Date.parse("2026-07-30T23:00:00Z"));
  assert.ok(match.closeTime > end, "close time is well outside the slate");
  assert.equal(resolvesWithin(match, start, end), true, "must land on today's slate");
});

test("markets falling back to close time still slate correctly", () => {
  // Crypto and index markets have no separate expiration — close is resolution.
  const crypto = normalizeMarket({
    ticker: "KXBTCD-26JUL3017-T50",
    event_ticker: "KXBTCD-26JUL3017",
    market_type: "binary",
    title: "BTC above 50k",
    yes_sub_title: "Above",
    no_sub_title: "Below",
    status: "active",
    open_time: "2026-07-30T00:00:00Z",
    close_time: "2026-07-30T21:00:00Z",
    yes_bid_dollars: "0.4000",
    yes_ask_dollars: "0.4200",
    no_bid_dollars: "0.5800",
    no_ask_dollars: "0.6000",
    last_price_dollars: "0.4100",
  });
  assert.equal(crypto.resolutionTime, crypto.closeTime);
  assert.equal(
    resolvesWithin(crypto, Date.parse("2026-07-30T16:00:00Z"), Date.parse("2026-07-31T04:00:00Z")),
    true,
  );
});

test("today's window ends at local midnight, not 24 hours out", () => {
  const now = new Date("2026-07-30T16:00:00Z"); // 12pm ET
  const w = slateWindow("today", "America/New_York", now);
  assert.equal(w.label, "today");
  // Midnight ET = 04:00Z next day.
  assert.equal(new Date(w.endMs).toISOString(), "2026-07-31T04:00:00.000Z");
  assert.ok(w.endMs - w.startMs < 86_400_000);
});

test("a nearly-over day rolls forward to tomorrow's board", () => {
  const now = new Date("2026-07-31T03:30:00Z"); // 11:30pm ET
  const w = slateWindow("today", "America/New_York", now);
  assert.match(w.label, /tomorrow/);
  assert.equal(new Date(w.endMs).toISOString(), "2026-08-01T04:00:00.000Z");
});

test("parlay markets are excluded from scanning", () => {
  assert.equal(isMultivariate({ mve_collection_ticker: "KXMVE-R" } as never), true);
  assert.equal(isMultivariate({ ticker: "KXMLBGAME-X" } as never), false);
});

// --- Describing the wager ----------------------------------------------------

/** Kalshi labels only the YES side, so `no_sub_title` is a copy, not a negation. */
const wagerOf = (yesLabel: string, side: "yes" | "no", extra: Partial<MarketView> = {}) =>
  describeWager(market({ yesLabel, ...extra }), side);

test("REGRESSION: the NO side of a spread reads as a real sentence", () => {
  // This used to render as "NOT Las Vegas wins by over 13.5 points", leaving the
  // reader to derive that it covers both a narrow win AND an outright loss.
  const yes = wagerOf("Las Vegas wins by over 13.5 points", "yes");
  const no = wagerOf("Las Vegas wins by over 13.5 points", "no");
  assert.equal(yes.typeLabel, "Spread");
  assert.equal(yes.youWinIf, "Las Vegas wins by 14 or more points.");
  assert.equal(no.youWinIf, "Las Vegas wins by 13 or fewer points, or loses outright.");
  assert.ok(!no.youWinIf.includes("NOT"));
});

test("game totals and team totals are not confused", () => {
  const total = wagerOf("Over 163.5 points scored", "yes");
  assert.equal(total.typeLabel, "Over / Under");
  assert.match(total.youWinIf, /Both teams combined score 164 or more points/);

  const teamTotal = wagerOf("A's over 1.5 runs scored", "yes");
  assert.equal(teamTotal.typeLabel, "Team total");
  assert.match(teamTotal.youWinIf, /A's scores 2 or more runs/);
});

test("a partial-game market says so explicitly", () => {
  // Easy to mistake for a full-game bet and lose on a late comeback.
  const w = wagerOf("San Francisco wins first 5 innings", "yes");
  assert.equal(w.typeLabel, "Partial game");
  assert.match(w.youWinIf, /first 5 innings/);
  assert.match(w.youWinIf, /not the full game/);
});

test("player props name the stat, and negate by count", () => {
  const m = market({ yesLabel: "Sonny Gray: 3+", title: "Sonny Gray: 3+ strikeouts?" });
  assert.equal(describeWager(m, "yes").youWinIf, "Sonny Gray records 3 or more strikeouts.");
  assert.equal(describeWager(m, "no").youWinIf, "Sonny Gray records fewer than 3 strikeouts.");
});

test("moneylines name the opponent on both sides", () => {
  const m = market({ yesLabel: "Boston", eventTitle: "Boston vs A's" });
  assert.equal(describeWager(m, "yes").typeLabel, "Moneyline");
  assert.match(describeWager(m, "yes").youWinIf, /Boston wins/);
  assert.match(describeWager(m, "no").youWinIf, /Boston loses/);
});

test("price levels invert correctly", () => {
  assert.match(wagerOf("$54,600 or above", "yes").youWinIf, /at \$54,600 or above/);
  assert.match(wagerOf("$54,600 or above", "no").youWinIf, /below \$54,600/);
});

test("an unrecognised label still negates readably", () => {
  const w = wagerOf("Something entirely novel happens", "no");
  assert.equal(w.typeLabel, "Market");
  assert.match(w.youWinIf, /does not happen/);
});

// --- Scoring model -----------------------------------------------------------

test("a fitted game reproduces both of its anchors", () => {
  // The whole method rests on this: fit to a win probability and an expected
  // total, and the distribution must actually return them.
  for (const [pWin, total, model] of [
    [0.58, 8.5, SPORT_MODELS.MLB!],
    [0.42, 9.5, SPORT_MODELS.MLB!],
    [0.65, 162, SPORT_MODELS.WNBA!],
  ] as const) {
    const d = fitGame(pWin, total, model)!;
    assert.ok(d, "should fit");
    assert.ok(Math.abs(d.pWin() - pWin) < 0.01, `win prob off: ${d.pWin()} vs ${pWin}`);
    // The total anchor is the median, so the over/under at it sits near 50%.
    assert.ok(
      Math.abs(d.pTotalOver(total) - 0.5) < 0.12,
      `total anchor off: ${d.pTotalOver(total)}`,
    );
  }
});

test("derived prices obey the orderings they must", () => {
  const d = fitGame(0.6, 8.5, SPORT_MODELS.MLB!)!;
  // Winning by more is always less likely than winning by less.
  assert.ok(d.pWinBy(true, 1.5) < d.pWinBy(true, 0.5));
  assert.ok(d.pWinBy(true, 3.5) < d.pWinBy(true, 1.5));
  // Higher totals are less likely to be exceeded.
  assert.ok(d.pTotalOver(10.5) < d.pTotalOver(7.5));
  // The favourite covers a given line more often than the underdog.
  assert.ok(d.pWinBy(true, 1.5) > d.pWinBy(false, 1.5));
  // Every probability stays a probability.
  for (const p of [d.pWin(), d.pWinBy(true, 2.5), d.pTotalOver(9.5), d.pTeamOver(true, 4.5)]) {
    assert.ok(p >= 0 && p <= 1, `not a probability: ${p}`);
  }
});

test("the two teams' totals are consistent with the game total", () => {
  const d = fitGame(0.55, 9, SPORT_MODELS.MLB!)!;
  // Each side should score around half the total, the favourite slightly more.
  assert.ok(d.pTeamOver(true, 4.5) > d.pTeamOver(false, 4.5));
  assert.ok(d.pTeamOver(true, 0.5) > 0.9, "almost always scores at least one");
  assert.ok(d.pTeamOver(true, 20.5) < 0.01, "twenty runs is rare");
});

test("a pick'em game is symmetric", () => {
  const d = fitGame(0.5, 9, SPORT_MODELS.MLB!)!;
  assert.ok(Math.abs(d.pWinBy(true, 1.5) - d.pWinBy(false, 1.5)) < 0.01);
  assert.ok(Math.abs(d.pTeamOver(true, 4.5) - d.pTeamOver(false, 4.5)) < 0.01);
});

test("the expected total is read off the ladder by interpolation", () => {
  // A ladder priced 0.70 / 0.55 / 0.40 across 7.5 / 8.5 / 9.5 crosses 50%
  // between 8.5 and 9.5, nearer 8.5.
  const ladder = [
    market({ ticker: "t1", yesLabel: "Over 7.5 runs scored", yesBid: 0.69, yesAsk: 0.71 }),
    market({ ticker: "t2", yesLabel: "Over 8.5 runs scored", yesBid: 0.54, yesAsk: 0.56 }),
    market({ ticker: "t3", yesLabel: "Over 9.5 runs scored", yesBid: 0.39, yesAsk: 0.41 }),
  ];
  const total = inferExpectedTotal(ladder)!;
  assert.ok(total > 8.5 && total < 9.5, `expected ~8.8, got ${total}`);
});

test("no total ladder means no derived prices — it refuses to guess", () => {
  assert.equal(inferExpectedTotal([]), null);
  assert.equal(inferExpectedTotal([market({ yesLabel: "Over 7.5 runs scored" })]), null);
});

test("coherence prices a game's other markets off its moneyline", () => {
  const game = "26JUL302140BOSATH";
  const mk = (series: string, label: string, ticker: string, mid = 0.5) =>
    market({
      ticker,
      seriesTicker: series,
      eventTicker: `${series}-${game}`,
      eventTitle: "Boston vs A's",
      yesLabel: label,
      yesBid: mid - 0.01,
      yesAsk: mid + 0.01,
    });

  const moneyline = mk("KXMLBGAME", "Boston", "ML-BOS", 0.5);
  const markets = [
    moneyline,
    mk("KXMLBTOTAL", "Over 7.5 runs scored", "T-7.5", 0.7),
    mk("KXMLBTOTAL", "Over 8.5 runs scored", "T-8.5", 0.55),
    mk("KXMLBTOTAL", "Over 9.5 runs scored", "T-9.5", 0.4),
    mk("KXMLBSPREAD", "Boston wins by over 1.5 runs", "S-1.5", 0.35),
    mk("KXMLBTEAMTOTAL", "Boston over 3.5 runs scored", "TT-3.5", 0.5),
  ];

  // Sharp books say Boston are 60% — the anchor consensus provides.
  const anchors = new Map<string, ProbabilityEstimate>([
    ["ML-BOS", { source: "consensus", probability: 0.6, confidence: 0.9, rationale: "books" }],
  ]);

  const result = buildCoherence(markets, anchors);
  assert.equal(result.gamesModelled, 1);
  assert.ok(result.marketsPriced >= 4, `priced only ${result.marketsPriced}`);

  // The anchor itself must NOT be re-derived — that would double-count it.
  assert.equal(result.estimates.has("ML-BOS"), false);

  // A favourite winning by 2+ should land well under their win probability.
  const spread = result.estimates.get("S-1.5")!;
  assert.ok(spread, "run line should be priced");
  assert.ok(spread.probability < 0.6 && spread.probability > 0.2, `got ${spread.probability}`);
  assert.equal(spread.source, "coherence");
});

test("REGRESSION: a game already under way is not modelled", () => {
  // A live A's/Boston ladder read 99% / 99% / 99% / 45% across consecutive
  // strikes — not a scoring distribution, but a team that had already scored
  // four. Anchoring to it made the model disagree with liquid, heavily-traded
  // markets by up to 35 points.
  const game = "26JUL302140BOSATH";
  const mk = (series: string, label: string, ticker: string, mid: number) =>
    market({
      ticker,
      seriesTicker: series,
      eventTicker: `${series}-${game}`,
      eventTitle: "Boston vs A's",
      yesLabel: label,
      yesBid: Math.max(0.01, mid - 0.01),
      yesAsk: Math.min(0.99, mid + 0.01),
    });

  const live = [
    mk("KXMLBGAME", "Boston", "ML-BOS", 0.34),
    mk("KXMLBTOTAL", "Over 7.5 runs scored", "T-7.5", 0.67),
    mk("KXMLBTOTAL", "Over 9.5 runs scored", "T-9.5", 0.37),
    // Runs already banked: certainty at the bottom of the ladder.
    mk("KXMLBTEAMTOTAL", "A's over 1.5 runs scored", "TT-1.5", 0.99),
    mk("KXMLBTEAMTOTAL", "A's over 3.5 runs scored", "TT-3.5", 0.99),
    mk("KXMLBTEAMTOTAL", "A's over 4.5 runs scored", "TT-4.5", 0.45),
  ];
  const anchors = new Map<string, ProbabilityEstimate>([
    ["ML-BOS", { source: "consensus", probability: 0.34, confidence: 0.9, rationale: "books" }],
  ]);

  const result = buildCoherence(live, anchors);
  assert.equal(result.gamesInProgress, 1);
  assert.equal(result.gamesModelled, 0);
  assert.equal(result.estimates.size, 0, "must price nothing on a live game");
});

test("a normal pre-game ladder is not mistaken for a live one", () => {
  const game = "26AUG012140DETATH";
  const mk = (series: string, label: string, ticker: string, mid: number) =>
    market({
      ticker,
      seriesTicker: series,
      eventTicker: `${series}-${game}`,
      eventTitle: "Detroit vs Athletics",
      yesLabel: label,
      yesBid: mid - 0.01,
      yesAsk: mid + 0.01,
    });

  // Pre-game, "over 1.5 runs" for a team sits near 88% — high, but not certain.
  const pregame = [
    mk("KXMLBGAME", "Detroit", "ML-DET", 0.52),
    mk("KXMLBTOTAL", "Over 7.5 runs scored", "T-7.5", 0.62),
    mk("KXMLBTOTAL", "Over 9.5 runs scored", "T-9.5", 0.38),
    mk("KXMLBTEAMTOTAL", "Detroit over 1.5 runs scored", "TT-1.5", 0.88),
    mk("KXMLBTEAMTOTAL", "Detroit over 3.5 runs scored", "TT-3.5", 0.55),
  ];
  const anchors = new Map<string, ProbabilityEstimate>([
    ["ML-DET", { source: "consensus", probability: 0.52, confidence: 0.9, rationale: "books" }],
  ]);

  const result = buildCoherence(pregame, anchors);
  assert.equal(result.gamesInProgress, 0);
  assert.equal(result.gamesModelled, 1);
  assert.ok(result.marketsPriced > 0);
});

test("coherence stays silent without a sharp anchor", () => {
  // No consensus moneyline means no trustworthy input, so nothing is derived
  // rather than something being invented from Kalshi's own prices.
  const markets = [
    market({ ticker: "T1", seriesTicker: "KXMLBTOTAL", eventTicker: "KXMLBTOTAL-26JUL30X", yesLabel: "Over 7.5 runs scored" }),
    market({ ticker: "T2", seriesTicker: "KXMLBTOTAL", eventTicker: "KXMLBTOTAL-26JUL30X", yesLabel: "Over 8.5 runs scored" }),
  ];
  const result = buildCoherence(markets, new Map());
  assert.equal(result.gamesModelled, 0);
  assert.equal(result.estimates.size, 0);
});

test("confidence decays into the tails", () => {
  // The anchors pin the middle; the far strikes are the model's shape talking.
  const d = fitGame(0.55, 9, SPORT_MODELS.MLB!)!;
  assert.ok(d.pWinBy(true, 6.5) < 0.15, "a 7-run win should be a longshot");
});

// --- Shrinkage ---------------------------------------------------------------

test("a modest well-evidenced disagreement mostly survives", () => {
  const r = shrinkTowardMarket({ fair: 0.48, marketMid: 0.44, confidence: 0.85, quality: 0.9 });
  assert.ok(r.factor > 0.4, `expected most of the edge to survive, kept ${r.factor}`);
  assert.ok(r.fair > 0.44 && r.fair < 0.48);
  assert.equal(r.implausible, false);
});

test("the same gap on weak evidence is shrunk much harder", () => {
  const strong = shrinkTowardMarket({ fair: 0.48, marketMid: 0.44, confidence: 0.85, quality: 0.9 });
  const weak = shrinkTowardMarket({ fair: 0.48, marketMid: 0.44, confidence: 0.1, quality: 0.2 });
  assert.ok(weak.factor < strong.factor / 2, "weak evidence must be discounted far more");
  assert.ok(weak.shrunkGap < 0.015, "a weakly-evidenced 4pt gap should nearly vanish");
});

test("REGRESSION: an implausible gap does not become an enormous edge", () => {
  // A 30-point disagreement is a defect — a mismatched game, a stale line, or
  // two venues pricing different questions. Kelly scales with edge, so left
  // unshrunk this is precisely the bet the bot would stake hardest on.
  const r = shrinkTowardMarket({ fair: 0.75, marketMid: 0.45, confidence: 0.8, quality: 0.8 });
  assert.equal(r.implausible, true);
  assert.ok(r.shrunkGap < 0.06, `30pt gap survived as ${r.shrunkGap}, far too much`);

  // And it must end up worth *less* than an honest, well-evidenced 5pt edge —
  // past a point, a wider disagreement is evidence of a bug, not of profit.
  const honest = shrinkTowardMarket({ fair: 0.49, marketMid: 0.44, confidence: 0.9, quality: 0.9 });
  assert.ok(
    r.shrunkGap < honest.shrunkGap,
    `suspect gap survived as ${r.shrunkGap} vs credible ${honest.shrunkGap}`,
  );
});

test("surviving edge falls once a gap is implausibly wide", () => {
  const at = (gap: number) =>
    shrinkTowardMarket({ fair: 0.45 + gap, marketMid: 0.45, confidence: 0.8, quality: 0.8 })
      .shrunkGap;
  // Rising while the gap is credible, falling once it plainly isn't.
  assert.ok(at(0.05) < at(0.12));
  assert.ok(at(0.40) < at(0.20));
});

test("shrinkage is symmetric and never crosses the market price", () => {
  const up = shrinkTowardMarket({ fair: 0.60, marketMid: 0.50, confidence: 0.6, quality: 0.6 });
  const down = shrinkTowardMarket({ fair: 0.40, marketMid: 0.50, confidence: 0.6, quality: 0.6 });
  assert.ok(Math.abs(up.shrunkGap + down.shrunkGap) < 1e-9);
  // Shrinking toward the market must never overshoot past it.
  assert.ok(up.fair > 0.5 && up.fair < 0.6);
  assert.ok(down.fair < 0.5 && down.fair > 0.4);
});

// --- Execution ---------------------------------------------------------------

test("posting inside a wide spread beats taking it", () => {
  const m = market({ yesBid: 0.40, yesAsk: 0.44 });
  const plan = planExecution(m, "yes", 0.47, 0.44);
  assert.equal(plan.style, "maker");
  assert.equal(plan.price, 0.41); // improve the bid by a cent
  assert.ok(plan.netEdge > plan.alternativeNetEdge);
  // Saves ~3c of spread plus three quarters of the fee.
  assert.ok(plan.netEdge - plan.alternativeNetEdge > 0.02);
});

test("REGRESSION: a very wide quote has no usable midpoint", () => {
  // A live market quoted 47/76. Its "midpoint" of 61.5c is the average of two
  // prices nobody will trade at, and the engine reported ~30 points of edge on
  // BOTH sides at once — impossible, and the tell that the mid meant nothing.
  const wide = market({ yesBid: 0.47, yesAsk: 0.76 });
  assert.equal(hasReliableMid(wide), false);
  assert.equal(hasReliableMid(market({ yesBid: 0.4, yesAsk: 0.42 })), true);
});

test("REGRESSION: no resting order deep inside a wide spread", () => {
  // Posting at 48c against a 47/76 quote is arithmetic, not a fill.
  const wide = market({ yesBid: 0.47, yesAsk: 0.76 });
  assert.equal(planExecution(wide, "yes", 0.62, 0.76).style, "taker");
});

test("a one-cent spread leaves no room to post", () => {
  const m = market({ yesBid: 0.43, yesAsk: 0.44 });
  assert.equal(planExecution(m, "yes", 0.47, 0.44).style, "taker");
});

test("near resolution, take the offer rather than rest an order", () => {
  const now = Date.now();
  const m = market({ yesBid: 0.40, yesAsk: 0.44, resolutionTime: now + 5 * 60_000 });
  const plan = planExecution(m, "yes", 0.47, 0.44, now);
  assert.equal(plan.style, "taker");
  assert.match(plan.note, /too close to resolution/);
});

test("the NO side posts against the mirrored book", () => {
  // A YES ask of 0.44 is a NO bid of 0.56; buying NO takes 0.60.
  const m = market({ yesBid: 0.40, yesAsk: 0.44 });
  const plan = planExecution(m, "no", 0.62, 0.60);
  assert.equal(plan.style, "maker");
  assert.ok(Math.abs(plan.price - 0.57) < 1e-9, `expected 0.57, got ${plan.price}`);
});

// --- De-vig ------------------------------------------------------------------

test("the power method also produces a proper distribution", () => {
  const fair = devigPower([1.909, 1.909]);
  assert.ok(Math.abs(fair[0]! - 0.5) < 1e-6);
  assert.ok(Math.abs(fair[0]! + fair[1]! - 1) < 1e-9);
});

test("power de-vig shades the longshot below proportional", () => {
  // Books load more margin onto longshots, so removing it evenly leaves the
  // longshot overstated.
  const prices = [1.2, 5.5];
  const prop = devig(prices);
  const power = devigPower(prices);
  assert.ok(Math.abs(power.reduce((a, b) => a + b, 0) - 1) < 1e-6);
  assert.ok(power[1]! < prop[1]!, "power method should shade the longshot down");
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
