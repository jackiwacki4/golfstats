import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { config, hasKalshiAuth } from "../config.js";
import type {
  EventsResponse,
  KalshiEvent,
  KalshiMarket,
  KalshiOrderbook,
  MarketsResponse,
} from "./types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let privateKeyCache: string | null = null;
function privateKey(): string {
  if (privateKeyCache === null) {
    privateKeyCache = readFileSync(config.kalshi.privateKeyPath, "utf8");
  }
  return privateKeyCache;
}

/**
 * Kalshi signs requests as RSA-PSS(SHA-256) over `timestampMs + METHOD + path`,
 * base64-encoded. Only needed for portfolio endpoints — every market-data call
 * this bot makes works unauthenticated.
 */
function authHeaders(method: string, path: string): Record<string, string> {
  if (!hasKalshiAuth()) return {};
  const timestamp = Date.now().toString();
  const signer = createSign("RSA-SHA256");
  signer.update(timestamp + method.toUpperCase() + path);
  signer.end();
  const signature = signer.sign(
    {
      key: privateKey(),
      padding: 6 /* RSA_PKCS1_PSS_PADDING */,
      saltLength: 32 /* RSA_PSS_SALTLEN_DIGEST for SHA-256 */,
    },
    "base64",
  );
  return {
    "KALSHI-ACCESS-KEY": config.kalshi.keyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
}

export class KalshiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "KalshiError";
  }
}

/**
 * GET a Kalshi endpoint, retrying on rate limits and transient 5xx.
 *
 * A scan fans out across many markets, so hitting 429 is normal rather than
 * exceptional; we back off and continue instead of failing the run.
 */
async function get<T>(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const url = new URL(config.kalshi.base + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const signedPath = new URL(config.kalshi.base).pathname + path;

  let lastError = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: "application/json", ...authHeaders("GET", signedPath) },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(400 * 2 ** attempt);
      continue;
    }

    if (response.ok) return (await response.json()) as T;

    // 429 = rate limited, 5xx = Kalshi hiccup. Both are worth retrying.
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 400 * 2 ** attempt;
      lastError = `HTTP ${response.status}`;
      await sleep(waitMs);
      continue;
    }

    throw new KalshiError(
      `Kalshi ${path} failed: ${response.status} ${await response.text().catch(() => "")}`.slice(0, 300),
      response.status,
    );
  }
  throw new KalshiError(`Kalshi ${path} failed after retries: ${lastError}`, 0);
}

/** Walk a cursor-paginated endpoint up to `maxPages`. */
async function paginate<T, R extends { cursor?: string }>(
  path: string,
  params: Record<string, string | number | undefined>,
  extract: (page: R) => T[],
  maxPages: number,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const response = await get<R>(path, { ...params, cursor });
    const batch = extract(response);
    out.push(...batch);
    cursor = response.cursor;
    if (!cursor || batch.length === 0) break;
  }
  return out;
}

export interface FetchEventsOptions {
  /** Cap on pages; each page is up to 200 events. Bounds a scan's runtime. */
  maxPages?: number;
  seriesTicker?: string;
}

/** Open events with their markets nested — one call instead of N+1. */
export async function fetchOpenEvents(
  options: FetchEventsOptions = {},
): Promise<KalshiEvent[]> {
  return paginate<KalshiEvent, EventsResponse>(
    "/events",
    {
      limit: 200,
      status: "open",
      with_nested_markets: "true",
      series_ticker: options.seriesTicker,
    },
    (page) => page.events ?? [],
    options.maxPages ?? 8,
  );
}

/** Settled markets for one series — the raw material for base-rate models. */
export async function fetchSettledMarkets(
  seriesTicker: string,
  maxPages = 2,
): Promise<KalshiMarket[]> {
  return paginate<KalshiMarket, MarketsResponse>(
    "/markets",
    { limit: 200, status: "settled", series_ticker: seriesTicker },
    (page) => page.markets ?? [],
    maxPages,
  );
}

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface NormalizedOrderbook {
  /** Resting YES bids, best (highest) first. */
  yesBids: OrderbookLevel[];
  /** Resting NO bids, best first — mirrored into YES-ask terms by the caller. */
  noBids: OrderbookLevel[];
}

/**
 * Fetch and normalize a market's book.
 *
 * Kalshi returns bid ladders in *ascending* price order and publishes no asks
 * at all, because a NO bid at $0.84 is by definition a YES ask at $0.16. We
 * reverse both ladders so index 0 is always the best price.
 */
export async function fetchOrderbook(ticker: string): Promise<NormalizedOrderbook> {
  const raw = await get<KalshiOrderbook>(
    `/markets/${encodeURIComponent(ticker)}/orderbook`,
    { depth: 10 },
  );

  const toLevels = (rows: [string, string][] | undefined): OrderbookLevel[] =>
    (rows ?? [])
      .map(([price, size]) => ({ price: Number(price), size: Number(size) }))
      .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size))
      .reverse();

  return {
    yesBids: toLevels(raw.orderbook_fp?.yes_dollars),
    noBids: toLevels(raw.orderbook_fp?.no_dollars),
  };
}

/** Run async work with bounded concurrency, preserving input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}
