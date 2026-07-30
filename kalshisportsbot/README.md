# kalshisportsbot

A private dashboard that scans Kalshi, computes its own probability for each
contract, and ranks the day's best bets by edge **net of fees**.

Despite the name it covers all of Kalshi — sports, politics, economics, weather.

It places no orders. It reads public market data, tells you what it thinks is
mispriced and why, sizes the position, and leaves the trade to you.

## The idea

Kalshi is fluid, so this is built to be re-run rather than scheduled: open the
page, hit **Run the numbers**, and see the board as it stands right now.

It defaults to **today's slate only** — markets that resolve before local
midnight. Futures are still scanned but have to clear a much higher bar
(10 points of net edge, vs 3) to interrupt the board.

The design goal is to *not* let the crowd steer the decision. A bot that reads
the Kalshi price and hands it back with confident framing is just the crowd's
opinion with extra steps — that's the predatory version. So the market price
enters as one weighted input among several, and every recommendation shows what
moved it away from the crowd.

The safety rail is deliberate: **with no independent signal, fair value collapses
to the market price and nothing is recommended.** The bot disagrees only when it
has a reason, rather than manufacturing a take for every market it can see.
A quiet day producing zero bets is the system working.

## Quick start

```sh
npm install
cp .env.example .env     # works as-is; nothing is required to start
npm start                # -> http://127.0.0.1:8787
```

Bound to `127.0.0.1`, so it's reachable only from your machine and needs no
password. `npm run scan` prints the same results in the terminal.

```sh
npm run scan -- --min-edge 2 --categories Sports --limit 10
npm run scan -- --horizon 24h            # today | 24h | all
npm run scan -- --no-futures             # day-of only, no exceptions
npm run scan -- --screaming-edge 15      # raise the bar futures must clear
npm test                                 # 25 tests over the math
```

## Today's slate, and the one timestamp that matters

The day-of filter looks harmless and contains the single nastiest trap in the
Kalshi API. A market has **two** end timestamps and they are not
interchangeable:

- `close_time` — the trading deadline. For sports this is a *settlement
  backstop*, often days or weeks out. A tennis match tonight can carry a
  `close_time` fifteen days away.
- `expected_expiration_time` — when it actually resolves. That's tonight.

Slate on `close_time` and every sports market looks like a future, leaving a
day-of sports board permanently and silently empty. This tool slates on
`expected_expiration_time`, falling back to `close_time` for markets like crypto
and index strikes where the two coincide. There's a regression test pinning it.

A related trap: Kalshi's cursor order has nothing to do with resolution time, so
a truncated sweep isn't a smaller board, it's an arbitrary one. Fetching six
pages returns 1,200 events containing **zero** of today's sports. The scanner
walks the whole board — roughly 9,400 events and 77,000 markets, about 11
seconds — then filters. Results are cached in memory for 90 seconds so a second
click is instant.

Multivariate parlay markets (`mve_collection_ticker`) are excluded: their prices
are functions of legs already evaluated individually, so any edge there is the
same edge double-counted.

## Where the edge comes from

Four independent sources, blended in log-odds space. Weights reflect how much
each can be trusted to be *independently right*:

| Source | Weight | What it does |
|---|---|---|
| **Cross-book consensus** | 1.00 | De-vigs sportsbook odds across several books, takes the median, compares to Kalshi. Books absorb far more capital than Kalshi, so where they disagree the books are usually closer to true. |
| **Market price** | 0.80 | The crowd, as a prior. Anchors the blend so no signal means no edge. |
| **Structural** | 0.65 | Renormalizes mutually exclusive events to sum to 100%, stripping the overround. Pure arithmetic. |
| **Own models** | 0.45 | Your models. Ships with a favourite-longshot-bias correction. |
| **Microstructure** | quality | Not a probability — it decides whether an edge is *takeable*, scaling size and rank by spread, depth, volume, and staleness. It also flags stale quotes the tape has moved past. |

Separately, the scanner reports **structural edges** — sets of prices that
contradict each other, needing no forecast at all.

### Fees are not a footnote

Kalshi charges `round_up(0.07 × contracts × P × (1−P))` per taker order. That
peaks at 1.75¢ on a 50¢ contract. A 3-point edge at 50¢ is more than half eaten
by fees; the same 3 points at 10¢ barely notices them. **Every edge in this tool
is net of that**, which is why it recommends fewer bets than a naive scanner.

### On "risk-free" arbitrage

Kalshi's `mutually_exclusive` flag means *at most* one leg resolves YES — **not
exactly one**. This trips up most scanners. "What will be the 51st state?" lists
eight candidates whose asks sum to $0.17, which reads as a 475% risk-free
return. It isn't one: if no state is admitted, every leg settles NO and the
whole stake is gone. The missing 83% is the market correctly pricing "none of
these".

Whether a set is exhaustive is a fact about what the legs *mean*, and no price
arithmetic can establish it. So the dashboard splits structural edges in two:

- **Locked in** — payout doesn't depend on exhaustiveness. Buying YES+NO in one
  market, or NO across every leg of an exclusive set (at most one NO can lose,
  so an unlisted outcome only pays *better*).
- **Conditional** — a YES-side dutch book. Shown with the break-even "none of
  the above" probability, so the judgement becomes one you can actually make:
  *is an unlisted outcome more likely than 1.5%?*

## Adding your own model

The other three signals all read someone else's opinion. Anything derived from a
public price competes with everyone else reading that same price — a model built
on data you collected is the only source here nobody else has. It's the slot
where a durable edge lives.

Add one in `src/signals/models.ts`:

```ts
const bullpenFatigue: Model = {
  name: "bullpen-fatigue",
  appliesTo: (m) => m.seriesTicker === "KXMLBTOTAL",
  estimate: (m) => {
    const p = myModel(m.ticker);
    if (p === null) return null;        // no read? say so, don't guess
    return { source: "model", probability: p, confidence: 0.7, rationale: "…" };
  },
};
```

Then add it to `MODELS`. Two rules: return `null` rather than a guess, and start
`confidence` low — an overconfident model is worse than no model, because the
engine will size up behind it.

## Optional keys

Everything above works with no credentials. Two keys unlock more.

### Sportsbook odds (biggest single upgrade)

The consensus signal is the heaviest-weighted source and it's **off until you
add a key**. Without it the bot leans on structural and model signals, which
rarely overcome the spread — that's why a first run often returns zero bets.

1. Sign up free at [the-odds-api.com](https://the-odds-api.com) (500 requests/month).
2. Put the key in `.env` as `ODDS_API_KEY`.

Responses are cached to disk for 10 minutes, so iterating doesn't burn quota.
One request covers one league, and only leagues with live Kalshi markets are
fetched.

### Kalshi API keys

**Not needed for anything this bot currently does** — all market data is public.
Add them for portfolio-aware features or higher rate limits:

1. Log in to Kalshi → profile menu → **Settings** → **API Keys**.
2. **Create new key.** Kalshi shows a **key ID** and downloads an **RSA private
   key** `.pem` file — the private key is shown exactly once.
3. Save the `.pem` outside this repo (e.g. `~/.kalshi/key.pem`), then set
   `KALSHI_KEY_ID` and `KALSHI_PRIVATE_KEY_PATH` in `.env`.

Request signing (RSA-PSS over `timestamp + METHOD + path`) is already
implemented in `src/kalshi/client.ts` and activates once both values are set.

`.env` and `*.pem` are gitignored. Never commit either.

## Hosting it as a private site

Local-only is the safest default. To reach it from elsewhere, in order of
preference:

1. **Tailscale** — install on both machines, set `HOST=0.0.0.0`, and reach it at
   your tailnet address. Nothing is exposed to the public internet.
2. **Cloudflare Tunnel** — `cloudflared tunnel --url http://localhost:8787`,
   with Cloudflare Access in front for auth.
3. **A small VPS** — set `HOST=0.0.0.0` **and** a strong `DASHBOARD_PASSWORD`,
   behind HTTPS.

The server **refuses to start** if bound to a non-loopback address without
`DASHBOARD_PASSWORD` set, so it can't be exposed unauthenticated by accident.
Password comparison is constant-time; the page is `noindex` and un-framable.

## The website, and how the bot feeds it

The page does no arithmetic and makes no judgement calls. The engine decides
what's true, `src/engine/present.ts` decides how it reads, and the page lays out
what it's handed. That split is what stops a redesign from quietly changing what
counts as a bet.

Two endpoints:

| Endpoint | Shape | For |
|---|---|---|
| `GET /api/board` | `Board` — grouped into sections, every number pre-formatted as a string, plain-English summaries, confidence tiers | the website |
| `GET /api/scan` | raw `ScanResult` — probabilities, weights, internals | debugging, or anything doing its own maths |

Query params (both): `horizon=today|24h|all`, `minEdge=3` (points),
`screamingEdge=10`, `futures=off`, `categories=Sports,Economics`.

`Board` carries presentation-ready fields — `priceLabel: "42¢"`,
`edgeLabel: "+7.5 pts"`, `confidence: { tier: "strong", label: … }`,
`summary: "Kalshi is asking 42¢; we make it 51¢…"` — alongside raw values where
sorting or meters need them. Adding a second front-end (a phone app, a
different layout) means consuming `/api/board` and nothing else.

## Layout

```
src/
  config.ts              env loading
  kalshi/client.ts       API client, pagination, retry, request signing
  kalshi/types.ts        2026 API shapes (dollar-denominated strings)
  core/money.ts          fees, EV, Kelly, sizing        <- the math that matters
  core/market.ts         normalization, resolution time, parlay detection
  core/time.ts           slate windows in a real timezone
  core/cache.ts          disk cache with TTL
  signals/structural.ts  arbitrage + overround stripping
  signals/consensus.ts   sportsbook de-vig + matching
  signals/microstructure.ts  spread/depth/staleness
  signals/models.ts      your models
  engine/fuse.ts         log-odds blending
  engine/scan.ts         orchestration + ranking
  engine/present.ts      view model the website renders
  server.ts / cli.ts     site + terminal
web/index.html           the website
test/engine.test.ts      25 tests
```

## Limitations worth knowing

- **Consensus only covers matched leagues.** Sport-to-book matching requires
  both team nicknames in the Kalshi title and an unambiguous YES side; anything
  ambiguous is skipped rather than guessed, because a wrong match produces a
  confident, fabricated edge. Politics, economics, and weather markets have no
  consensus source at all and lean on the weaker signals.
- **De-vigging is proportional**, which slightly overstates longshots. On lopsided
  matchups, trust favourite-side edges more.
- **Sizing assumes your probability is right.** Quarter-Kelly cushions that; it
  doesn't fix a bad model.
- **Depth comes from the nested payload**, so the top-of-book size is a snapshot.
  Confirm the book before sending anything large.
- **The futures bar is a guess, not a calibration.** 10 points is set so that
  only something genuinely loud interrupts today's board. It has no backtest
  behind it — tune `SCREAMING_EDGE` to taste.
- **No results tracking yet.** The obvious next step: log every recommendation
  and settle it later, so signal weights can be set by measured calibration
  instead of by the judgement calls in `SOURCE_WEIGHTS`.

## Advisory only

This tool places no orders and holds no trading credentials. It is a research
aid, not financial advice. Prediction markets are a real way to lose real money,
and an edge estimated from public data is an estimate, not a promise.
