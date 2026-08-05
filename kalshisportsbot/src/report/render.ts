import { verdict, type ReportData, type ScoredBet } from "./data.js";

/**
 * The board-meeting view.
 *
 * Written for a reader who will never open the code: no tickers, no basis
 * points, no talk of shrinkage or Kelly fractions. Two charts carry the whole
 * argument — is the line going up, and which parts are pulling their weight —
 * and every number is stated next to the sentence explaining what it means.
 */

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const pts = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;
const usd = (x: number): string =>
  `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`;
const date = (ms: number): string =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

const SIGNAL_NAMES: Record<string, string> = {
  consensus: "Sportsbook comparison",
  coherence: "Same-game model",
  structural: "Price-set arithmetic",
  model: "In-house model",
  microstructure: "Stale-quote detection",
};

/**
 * Cumulative closing-line value, one point per decision.
 *
 * A single series, so no legend — the title names it. The zero line is the
 * reference that matters: above it the market kept moving toward us, below it
 * we were simply taking the market price.
 */
function curveChart(data: ReportData): string {
  const points = data.curve;
  if (points.length < 2) {
    return `<p class="empty-chart">Not enough decisions yet to plot a trend. Come back after about ten.</p>`;
  }

  const W = 720;
  const H = 260;
  const P = { top: 16, right: 16, bottom: 30, left: 46 };
  const values = points.map((p) => p.cumulative * 100);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const pad = Math.max(1, (rawMax - rawMin) * 0.12);
  const min = rawMin - pad;
  const max = rawMax + pad;

  const x = (i: number): number =>
    P.left + (i / (points.length - 1)) * (W - P.left - P.right);
  const y = (v: number): number =>
    P.top + (1 - (v - min) / (max - min)) * (H - P.top - P.bottom);

  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.cumulative * 100).toFixed(1)}`).join("");
  const area =
    `M${x(0).toFixed(1)},${y(0).toFixed(1)}` +
    points.map((p, i) => `L${x(i).toFixed(1)},${y(p.cumulative * 100).toFixed(1)}`).join("") +
    `L${x(points.length - 1).toFixed(1)},${y(0).toFixed(1)}Z`;

  const ticks = [min, (min + max) / 2, max].map(
    (v) =>
      `<line x1="${P.left}" x2="${W - P.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/>` +
      `<text x="${P.left - 8}" y="${(y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${v.toFixed(0)}</text>`,
  ).join("");

  // Hover targets sit on an invisible band per point, wider than the marker.
  const hover = points
    .map((p, i) => {
      const band = (W - P.left - P.right) / points.length;
      return `<rect x="${(x(i) - band / 2).toFixed(1)}" y="${P.top}" width="${band.toFixed(1)}" height="${H - P.top - P.bottom}" fill="transparent" class="hit"
        data-label="Decision ${p.index} · ${esc(date(p.at))}" data-value="${pts(p.cumulative)} points cumulative"/>`;
    })
    .join("");

  const last = points[points.length - 1]!;

  return `
  <figure class="chart">
    <figcaption>
      <strong>Has the market moved toward us?</strong>
      <span>Running total of closing-line value across every decision, in probability points.</span>
    </figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative closing line value over ${points.length} decisions, ending at ${pts(last.cumulative)} points">
      ${ticks}
      <line x1="${P.left}" x2="${W - P.right}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="zero"/>
      <path d="${area}" class="area"/>
      <path d="${path}" class="line"/>
      <circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.cumulative * 100).toFixed(1)}" r="4.5" class="dot"/>
      ${hover}
      <text x="${P.left}" y="${H - 8}" class="axis">${esc(date(points[0]!.at))}</text>
      <text x="${W - P.right}" y="${H - 8}" class="axis" text-anchor="end">${esc(date(last.at))}</text>
    </svg>
    <p class="read">
      ${
        last.cumulative > 0
          ? `The line finishes above zero, at <strong>${pts(last.cumulative)} points</strong>. Prices have on balance moved in our favour after we committed — the pattern you'd expect if the estimates are better than the market's.`
          : `The line finishes below zero, at <strong>${pts(last.cumulative)} points</strong>. Prices have on balance moved against us after we committed, which is what you'd expect if we were simply paying the market price.`
      }
    </p>
  </figure>`;
}

/**
 * Average closing-line value by signal.
 *
 * Bars diverge from a zero baseline because the sign is the point — this is
 * polarity, not identity, so the palette is the diverging blue/red pair rather
 * than one hue per signal. Every bar carries its own value label, so the colour
 * is reinforcement rather than the only carrier of meaning.
 */
function signalChart(data: ReportData): string {
  const rows = data.bySignal.filter((r) => r.count > 0);
  if (rows.length === 0) {
    return `<p class="empty-chart">No signals have a track record yet.</p>`;
  }

  const maxAbs = Math.max(0.01, ...rows.map((r) => Math.abs(r.avgClv)));

  const bars = rows
    .map((r) => {
      const width = (Math.abs(r.avgClv) / maxAbs) * 50;
      const positive = r.avgClv >= 0;
      const thin = r.count < 30;
      return `
      <div class="bar-row">
        <div class="bar-name">${esc(SIGNAL_NAMES[r.source] ?? r.source)}</div>
        <div class="bar-track">
          <span class="bar-mid"></span>
          <span class="bar ${positive ? "pos" : "neg"}"
                style="${positive ? `left:50%;width:${width}%` : `right:50%;width:${width}%`}"></span>
        </div>
        <div class="bar-value ${positive ? "pos" : "neg"}">${pts(r.avgClv)}</div>
        <div class="bar-count">${r.count} bet${r.count === 1 ? "" : "s"}${thin ? " · thin" : ""}</div>
      </div>`;
    })
    .join("");

  const best = rows[0]!;
  const worst = rows[rows.length - 1]!;

  return `
  <figure class="chart">
    <figcaption>
      <strong>Which parts are earning their keep?</strong>
      <span>Average closing-line value per decision, by the method that drove it.</span>
    </figcaption>
    <div class="bars">${bars}</div>
    <p class="read">
      ${
        rows.length > 1
          ? `<strong>${esc(SIGNAL_NAMES[best.source] ?? best.source)}</strong> is contributing most at ${pts(best.avgClv)} points a decision, while <strong>${esc(SIGNAL_NAMES[worst.source] ?? worst.source)}</strong> sits at ${pts(worst.avgClv)}. Methods that keep failing to earn get their influence cut; the ones that earn get more.`
          : `Only one method has a record so far, so there's nothing to compare it against yet.`
      }
      Anything marked <em>thin</em> has too few decisions behind it to act on.
    </p>
  </figure>`;
}

function openTable(bets: ScoredBet[]): string {
  if (bets.length === 0) return "";
  const rows = bets
    .map(
      (b) => `
    <tr>
      <td>${esc(date(b.at))}</td>
      <td class="wager">${esc(b.title)}</td>
      <td class="num">${(b.price * 100).toFixed(0)}¢</td>
      <td class="num">${(b.fair * 100).toFixed(0)}¢</td>
      <td class="num ${b.clv >= 0 ? "pos" : "neg"}">${pts(b.clv)}</td>
    </tr>`,
    )
    .join("");

  return `
  <section>
    <h2>Positions still live</h2>
    <p class="lede">Decisions taken but not yet resolved. "Our price" is what the system judged fair at the time; the last column is how far the market has since moved toward it.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Position</th><th>Paid</th><th>Our price</th><th>Move since</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </section>`;
}

export function renderReport(data: ReportData): string {
  const v = verdict(data);
  const t = data.totals;
  const beatRate = t.scored ? (t.beatClose / t.scored) * 100 : 0;
  const span =
    t.firstAt && t.lastAt ? `${date(t.firstAt)} – ${date(t.lastAt)}` : "no activity yet";

  const tiles = [
    ["Decisions taken", String(t.scored), "Times the system found a price worth acting on"],
    ["Moved our way", `${beatRate.toFixed(0)}%`, "Share where the market later came toward our price"],
    ["Average movement", `${pts(t.avgClv)} pts`, "Per decision — the core measure of edge"],
    ["Resolved", `${t.wins}–${t.losses}`, "Win–loss on positions that have finished"],
    ["Realised", usd(t.netProfit), `Against ${usd(t.totalStaked)} committed`],
  ]
    .map(
      ([label, value, note]) => `
      <div class="tile">
        <div class="tile-value">${esc(value)}</div>
        <div class="tile-label">${esc(label)}</div>
        <div class="tile-note">${esc(note)}</div>
      </div>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex, nofollow"/>
<title>Performance Review — kalshisportsbot</title>
<style>
  :root {
    color-scheme: light;
    --surface:#fcfcfb; --plane:#f9f9f7; --ink:#0b0b0b; --ink-2:#52514e;
    --muted:#898781; --rule:#e1e0d9; --axis:#c3c2b7; --grid:#e1e0d9;
    --pos:#2a78d6; --neg:#e34948; --good:#0ca30c; --good-text:#006300; --critical:#d03b3b;
    --mono:ui-monospace,"SF Mono",Menlo,monospace;
    --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Helvetica,sans-serif;
  }
  @media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){
    color-scheme:dark;
    --surface:#1a1a19; --plane:#0d0d0d; --ink:#fff; --ink-2:#c3c2b7;
    --muted:#898781; --rule:#2c2c2a; --axis:#383835; --grid:#2c2c2a;
    --pos:#3987e5; --neg:#e66767; --good-text:#0ca30c;
  }}
  *{box-sizing:border-box}
  body{margin:0;background:var(--plane);color:var(--ink);font-family:var(--sans);
       font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased}
  .page{max-width:860px;margin:0 auto;padding:48px 24px 96px}
  .eyebrow{font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--muted)}
  h1{font-size:clamp(28px,5vw,42px);line-height:1.12;letter-spacing:-.025em;margin:10px 0 14px}
  .lede{color:var(--ink-2);font-size:17px;max-width:64ch;margin:0 0 8px}
  .period{font-family:var(--mono);font-size:13px;color:var(--muted);margin-top:6px}

  .verdict{border-left:4px solid var(--axis);padding:16px 20px;margin:28px 0 36px;
           background:var(--surface);border-radius:0 12px 12px 0}
  .verdict.working{border-left-color:var(--good)}
  .verdict.not-working{border-left-color:var(--critical)}
  .verdict h2{margin:0 0 6px;font-size:20px;letter-spacing:-.01em}
  .verdict p{margin:0;color:var(--ink-2);font-size:15.5px}

  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:40px}
  .tile{background:var(--surface);border:1px solid var(--rule);border-radius:12px;padding:14px 16px}
  .tile-value{font-family:var(--mono);font-size:24px;font-weight:650;letter-spacing:-.03em}
  .tile-label{font-size:12.5px;font-weight:600;margin-top:2px}
  .tile-note{font-size:11.5px;color:var(--muted);line-height:1.45;margin-top:3px}

  section{margin:44px 0}
  h2{font-size:19px;letter-spacing:-.012em;margin:0 0 8px}

  .chart{margin:0 0 40px;background:var(--surface);border:1px solid var(--rule);
         border-radius:14px;padding:20px 22px}
  figcaption{margin-bottom:14px}
  figcaption strong{display:block;font-size:17px;letter-spacing:-.01em}
  figcaption span{font-size:13.5px;color:var(--muted)}
  svg{width:100%;height:auto;display:block;overflow:visible}
  .grid{stroke:var(--grid);stroke-width:1}
  .zero{stroke:var(--axis);stroke-width:1.5;stroke-dasharray:3 3}
  .axis{fill:var(--muted);font-size:11px;font-family:var(--mono)}
  .line{fill:none;stroke:var(--pos);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
  .area{fill:var(--pos);opacity:.10}
  .dot{fill:var(--pos);stroke:var(--surface);stroke-width:2}
  .hit{cursor:crosshair}
  .read{margin:14px 0 0;font-size:14.5px;color:var(--ink-2);border-top:1px solid var(--rule);padding-top:12px}
  .empty-chart{color:var(--muted);font-size:14.5px;padding:22px;text-align:center;
               border:1px dashed var(--axis);border-radius:12px}

  .bars{display:flex;flex-direction:column;gap:9px}
  .bar-row{display:grid;grid-template-columns:150px 1fr 62px 76px;gap:10px;align-items:center}
  .bar-name{font-size:13.5px}
  .bar-track{position:relative;height:16px;background:var(--plane);border-radius:4px}
  .bar-mid{position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:var(--axis)}
  .bar{position:absolute;top:2px;bottom:2px;border-radius:3px;min-width:2px}
  .bar.pos{background:var(--pos)}
  .bar.neg{background:var(--neg)}
  .bar-value{font-family:var(--mono);font-size:13.5px;font-weight:650;text-align:right}
  .bar-count{font-size:11.5px;color:var(--muted)}
  .pos{color:var(--pos)} .neg{color:var(--neg)}

  .table-wrap{overflow-x:auto;border:1px solid var(--rule);border-radius:12px;background:var(--surface)}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th,td{text-align:left;padding:9px 14px;border-bottom:1px solid var(--rule);white-space:nowrap}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}
  tr:last-child td{border-bottom:0}
  td.num{font-family:var(--mono);text-align:right}
  td.wager{white-space:normal;min-width:260px}

  .method{background:var(--surface);border:1px solid var(--rule);border-radius:14px;padding:20px 22px}
  .method h3{font-size:14px;margin:18px 0 4px;letter-spacing:-.005em}
  .method h3:first-of-type{margin-top:0}
  .method p{margin:0;font-size:14.5px;color:var(--ink-2)}

  footer{margin-top:52px;padding-top:18px;border-top:1px solid var(--rule);
         font-size:12.5px;color:var(--muted)}

  #tip{position:fixed;pointer-events:none;opacity:0;transition:opacity .12s;
       background:var(--ink);color:var(--plane);font-size:12px;padding:6px 9px;
       border-radius:6px;font-family:var(--mono);z-index:10;white-space:nowrap}
  @media print{body{background:#fff}.chart,.tile,.method,.table-wrap{break-inside:avoid}}
  @media (max-width:640px){.bar-row{grid-template-columns:110px 1fr 56px}.bar-count{display:none}}
</style>
</head>
<body>
<div class="page">
  <div class="eyebrow">Performance Review</div>
  <h1>${esc(v.headline)}</h1>
  <p class="lede">An automated system that looks for contracts on Kalshi priced differently from what the wider betting market implies, and reports the gap. It places no orders itself.</p>
  <div class="period">${esc(span)} · ${t.recorded} decisions recorded</div>

  <div class="verdict ${esc(v.state)}">
    <h2>What the numbers say</h2>
    <p>${esc(v.explanation)}</p>
  </div>

  <div class="tiles">${tiles}</div>

  ${curveChart(data)}
  ${signalChart(data)}
  ${openTable(data.open)}

  <section>
    <h2>How to read this</h2>
    <div class="method">
      <h3>Why "movement" matters more than wins and losses</h3>
      <p>Any individual bet is mostly luck; you would need hundreds of settled results before a win rate told you anything reliable. So the primary measure here is whether the market price moved toward our number <em>after</em> we committed. That signal appears on every single decision, not just the resolved ones, and it is the standard professional test of whether a pricing edge is real.</p>

      <h3>Where the estimates come from</h3>
      <p>Sportsbooks handle far more money than Kalshi, so their prices are the benchmark. The system strips out the bookmakers' built-in margin, weights the sharper books more heavily, and compares the result to Kalshi. It then extends that read to the dozens of related markets on the same game — spreads, totals, team totals — which nobody is pricing closely.</p>

      <h3>Why it recommends so little</h3>
      <p>Every edge is reported after trading costs, and large disagreements are treated as suspect rather than exciting — a twenty-point gap is usually a fault in the comparison, not free money. Days with no recommendation are the expected majority, and are a feature of the design rather than a failure of it.</p>

      <h3>The honest limits</h3>
      <p>Fewer than about thirty decisions per method tells you very little. Prediction markets can lose real money. Nothing here is a forecast of future returns, and the system holds no trading permissions — every position shown was placed, or not placed, by a human.</p>
    </div>
  </section>

  <footer>
    Generated ${esc(new Date(data.generatedAt).toLocaleString("en-US"))} ·
    bankroll basis ${esc(usd(data.bankroll))} · advisory only, no orders are placed automatically.
  </footer>
</div>

<div id="tip"></div>
<script>
  // Crosshair tooltip on the trend line — an HTML chart should be readable by
  // pointing at it, not only by reading the axis.
  const tip = document.getElementById('tip');
  for (const hit of document.querySelectorAll('.hit')) {
    hit.addEventListener('mousemove', (e) => {
      tip.textContent = hit.dataset.label + ' — ' + hit.dataset.value;
      tip.style.opacity = '1';
      tip.style.left = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 10) + 'px';
      tip.style.top = (e.clientY - 34) + 'px';
    });
    hit.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
  }
</script>
</body>
</html>`;
}
