import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Minimal .env loader — avoids a dependency for something this small. */
function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment variables win over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Config ${key} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function str(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}

export const config = {
  host: str("HOST", "127.0.0.1"),
  port: num("PORT", 8787),
  dashboardPassword: str("DASHBOARD_PASSWORD"),

  kalshi: {
    base: str("KALSHI_API_BASE", "https://api.elections.kalshi.com/trade-api/v2"),
    keyId: str("KALSHI_KEY_ID"),
    privateKeyPath: str("KALSHI_PRIVATE_KEY_PATH"),
  },

  oddsApiKey: str("ODDS_API_KEY"),

  bankroll: num("BANKROLL_DOLLARS", 1000),
  kellyFraction: num("KELLY_FRACTION", 0.25),
  minEdge: num("MIN_EDGE", 0.03),

  /** Timezone that defines "today" for the day-of slate. */
  timezone: str("TIMEZONE", "America/New_York"),
  /**
   * Edge a longer-dated market must clear to earn a place on a day-of board.
   * Deliberately high — the whole point of the day-of filter is that futures
   * only interrupt when the number is impossible to ignore.
   */
  screamingEdge: num("SCREAMING_EDGE", 0.1),
} as const;

/** True when Kalshi credentials are present; unlocks authenticated endpoints. */
export function hasKalshiAuth(): boolean {
  return Boolean(config.kalshi.keyId && config.kalshi.privateKeyPath);
}
