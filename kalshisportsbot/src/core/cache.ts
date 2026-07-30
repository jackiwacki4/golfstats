import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

/**
 * Disk-backed cache with a TTL.
 *
 * On disk rather than in memory so a restart doesn't re-spend quota — the Odds
 * API free tier is 500 requests a month, and an afternoon of iterating on the
 * scanner can burn through that fast.
 */

const CACHE_DIR = resolve(process.cwd(), ".cache");

function pathFor(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return join(CACHE_DIR, `${hash}.json`);
}

export function getCached<T>(key: string, ttlMs: number): T | null {
  const file = pathFor(key);
  if (!existsSync(file)) return null;
  try {
    if (Date.now() - statSync(file).mtimeMs > ttlMs) return null;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function setCached(key: string, value: unknown): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(pathFor(key), JSON.stringify(value));
  } catch {
    // A cache write failing should never take down a scan.
  }
}

/** Age of the freshest cache entry, for showing data staleness in the UI. */
export function cacheAgeMs(key: string): number | null {
  const file = pathFor(key);
  if (!existsSync(file)) return null;
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

export function clearCache(): number {
  if (!existsSync(CACHE_DIR)) return 0;
  let removed = 0;
  for (const name of readdirSync(CACHE_DIR)) {
    try {
      writeFileSync(join(CACHE_DIR, name), "");
      removed++;
    } catch {
      // ignore
    }
  }
  return removed;
}
