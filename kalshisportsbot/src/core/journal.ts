import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * A permanent record of what the bot believed, and when.
 *
 * Everything else in this codebase is a judgement call I made without evidence:
 * the source weights, the prior scale on edges, the confidence tiers. They are
 * reasonable, and they are unverified. The only way they stop being guesses is
 * to write down each prediction at the moment it's made and check it later —
 * and that is impossible retroactively, because the price you needed is gone
 * the moment the market moves.
 *
 * So this logs first and asks questions later. It is deliberately append-only
 * JSONL: one self-contained line per recommendation, trivially greppable, and
 * safe to keep forever.
 *
 * The measurement worth taking is **closing line value** — did the price move
 * toward us before resolution? A bet's win or loss is mostly noise; you need
 * hundreds before the record means anything. But CLV is visible on every single
 * bet and answers the real question: was our number better than the market's at
 * the moment we disagreed with it? A bot that consistently beats the closing
 * price has an edge even during a losing month. One that doesn't, doesn't —
 * however well its picks happen to be running.
 */

export interface JournalEntry {
  /** When the recommendation was made. */
  at: number;
  ticker: string;
  eventTicker: string;
  seriesTicker: string;
  title: string;
  side: "yes" | "no";
  /** Price we'd have paid or posted at. */
  price: number;
  /** Kalshi's midpoint at the time — the benchmark CLV is measured against. */
  marketMid: number;
  /** Our estimate after shrinkage. */
  fair: number;
  /** Our estimate before shrinkage — kept so the prior can be re-fit later. */
  rawFair: number;
  netEdge: number;
  confidence: number;
  quality: number;
  executionStyle: string;
  contracts: number;
  resolutionTime: number;
  /** Which signals contributed, so a source's record can be isolated. */
  sources: string[];
}

const JOURNAL_PATH = resolve(process.cwd(), "data", "predictions.jsonl");

export function journalPath(): string {
  return JOURNAL_PATH;
}

/**
 * Append entries. Never throws — a logging failure must not lose you a scan.
 */
export function record(entries: JournalEntry[]): number {
  if (entries.length === 0) return 0;
  try {
    mkdirSync(dirname(JOURNAL_PATH), { recursive: true });
    appendFileSync(
      JOURNAL_PATH,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8",
    );
    return entries.length;
  } catch {
    return 0;
  }
}

/** Read the journal back, skipping any line that got truncated mid-write. */
export function readJournal(): JournalEntry[] {
  if (!existsSync(JOURNAL_PATH)) return [];
  const out: JournalEntry[] = [];
  for (const line of readFileSync(JOURNAL_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as JournalEntry);
    } catch {
      // A partial final line is expected if a process died mid-append.
    }
  }
  return out;
}

/**
 * Closing line value: how far the market moved toward us after we spoke.
 *
 * Positive means the price we'd have paid became more expensive — the market
 * came to our view. That is the single best fast-feedback measure of whether
 * there's a real edge here, because it's visible on every bet instead of
 * needing a season of results to emerge from the noise.
 */
export function closingLineValue(
  entry: JournalEntry,
  laterPrice: number,
): number {
  if (!Number.isFinite(laterPrice)) return NaN;
  return entry.side === "yes" ? laterPrice - entry.price : entry.price - laterPrice;
}
