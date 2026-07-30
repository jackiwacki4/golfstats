/**
 * Kalshi trade-api/v2 shapes, as returned in 2026.
 *
 * Kalshi migrated money fields to decimal *strings* denominated in dollars
 * (`yes_ask_dollars: "0.1300"`) and size fields to fixed-point strings
 * (`yes_bid_size_fp: "129.37"`). They are strings to avoid float drift on the
 * wire, so every one of them goes through `parseDollars` before use — never
 * `Number(...)` them inline.
 */

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type: string;
  title: string;
  yes_sub_title: string;
  no_sub_title: string;
  status: string;
  open_time: string;
  close_time: string;
  expected_expiration_time?: string;
  updated_time?: string;
  rules_primary?: string;

  yes_bid_dollars: string;
  yes_ask_dollars: string;
  no_bid_dollars: string;
  no_ask_dollars: string;
  last_price_dollars: string;
  previous_price_dollars?: string;
  notional_value_dollars?: string;

  yes_bid_size_fp?: string;
  yes_ask_size_fp?: string;
  volume_fp?: string;
  volume_24h_fp?: string;
  open_interest_fp?: string;
  liquidity_dollars?: string;

  /** Present on settled markets: "yes" | "no" | "" */
  result?: string;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  sub_title?: string;
  category?: string;
  /** Exactly one market in the event can resolve YES. Drives dutch-book checks. */
  mutually_exclusive?: boolean;
  markets?: KalshiMarket[];
}

/** Bid ladders only. Kalshi publishes no asks: a NO bid at 0.84 IS a YES ask at 0.16. */
export interface KalshiOrderbook {
  orderbook_fp?: {
    yes_dollars?: [string, string][];
    no_dollars?: [string, string][];
  };
}

export interface EventsResponse {
  events: KalshiEvent[];
  cursor?: string;
}

export interface MarketsResponse {
  markets: KalshiMarket[];
  cursor?: string;
}
