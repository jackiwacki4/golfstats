# golfstats

Weekly PGA tournament preview site. One page per tournament, published Tuesday of
tournament week. The promise to the reader: **understand this week's tournament in
five minutes.**

This is explanation, not prediction. golfstats does not sell picks and never
presents itself as a picks service. The product is helping a reader form their own
opinion — course profile, what the course demands, who fits that profile, weather
risk, and where the market price looks fair versus stretched.

## Stack

- **[Astro](https://astro.build)** static output + TypeScript + content collections
- **Open-Meteo** (free, no API key) for build-time weather — the one live data source
- **Fontsource** self-hosted fonts (no third-party requests)
- Zero recurring cost. No database, no CMS, no backend. Deploys free on Vercel.

## Commands

```sh
npm install
npm run dev      # local dev server
npm run build    # static build to ./dist
npm run preview  # serve the build
npm run check    # astro + TypeScript diagnostics
```

## Data model

Content is modeled as **entities, not articles** — deliberately, so a weekly
prediction game can grow on top of it later. Everything lives in `src/content/`
as hand-edited YAML/Markdown; schemas are in `src/content.config.ts`.

| Collection | What it is |
|---|---|
| `courses/` | Reusable course profile + structured **demands** (distance premium, approach-yardage buckets, rough, greens, wind exposure). Shared across years. |
| `players/` | Stable player IDs so records connect year over year. |
| `events/` | One tournament instance — references a course, plus dates, purse, field strength. |
| `entries/` | **PlayerEventEntry** — the hand-entered odds / fit rating / notes / result lines for an event. One file per event. |
| `previews/` | The written analysis (Markdown). References an event; never duplicates it. |

Two shape decisions worth knowing:

- **`odds` is an object** (`{ outright, format, asOf, book }`), not a bare number.
  That's the seam an odds feed drops into later with zero restructuring — a feed
  writes the exact shape a human types today.
- **`result` lives on each entry and is nullable.** Publish with
  `status: pending`; fill `finish` after the event. Course pages then render "how
  it went" from that data. Being publicly on record — right or wrong — is the
  credibility mechanism, and it's free because it's just data.

### Adding a new week

1. Add/confirm the `courses/<slug>.yaml` (reused if the venue has been here before).
2. Add any new `players/<slug>.yaml`.
3. Add `events/<year>-<slug>.yaml`.
4. Add `entries/<year>-<slug>.yaml` with the hand-entered odds + fit lines.
5. Write `previews/<year>-<slug>.md`; set `isCurrent: true` (and clear it on the
   previous week). The home page reads that flag.
6. After the event, fill each entry's `result`.

## Weather refresh

Weather is fetched from Open-Meteo **at build time** from the course coordinates —
hourly wind speed/direction and precipitation probability for the four tournament
days, rendered as a per-day **wind rose**. A daily rebuild keeps the forecast
fresh (driven externally — no host cron required). The fetch degrades gracefully:
if the fixture is outside the forecast horizon or the network is down at build
time, it shows clearly-labelled sample data so the page always renders.

## Pages

- `/` — this week's tournament, prominently (reads the `isCurrent` preview).
- `/preview/<id>` — the core product: course profile, demands, player fits,
  weather, market notes.
- `/course/<id>` — reusable course profile + every past event played there.
- `/archive` — past previews with results attached.

## Compliance

Built in from the first commit, not bolted on: a 21+ age gate (remembered
locally), a persistent 1-800-GAMBLER responsible-gambling notice, an
editorial-not-advice disclaimer, and a footer whose `disclosures` array is
structured so state-specific disclosures can be added later without a redesign.

## Deploy (Vercel)

Static output — Vercel auto-detects Astro. Import the repo; build command
`npm run build`, output directory `dist`. Trigger the daily rebuild via a
Deploy Hook.

---

The example preview (2026 3M Open at TPC Twin Cities) uses **illustrative,
hand-entered odds and fictional players** — it exists to show the shape of the
product, not to represent real prices or real people.
