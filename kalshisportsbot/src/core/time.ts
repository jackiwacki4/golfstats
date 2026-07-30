/**
 * Slate windows.
 *
 * "Day of" means today's board in a real timezone, not a rolling 24 hours —
 * a game closing at 11pm tonight belongs to today's slate, and one closing at
 * 1am tomorrow does not, even though both are "within 24 hours".
 */

export type Horizon = "today" | "24h" | "all";

/** Milliseconds to add to UTC to get local wall-clock time in `tz`. */
function tzOffsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);

  // `hour` comes back as 24 at midnight under hour12:false in some engines.
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

export interface SlateWindow {
  /** Inclusive lower bound (epoch ms) — always now; closed markets are useless. */
  startMs: number;
  /** Exclusive upper bound (epoch ms). */
  endMs: number;
  label: string;
}

/**
 * The window a scan should cover.
 *
 * There's a wrinkle worth handling: run this at 11:45pm and "today" is fifteen
 * minutes wide, which returns an empty board and looks broken. So when today's
 * remainder gets too thin to be a usable slate, the window rolls forward to
 * tomorrow's board and says so in the label.
 */
export function slateWindow(
  horizon: Horizon,
  tz: string,
  now = new Date(),
): SlateWindow {
  const startMs = now.getTime();

  if (horizon === "all") {
    return { startMs, endMs: Number.MAX_SAFE_INTEGER, label: "all open markets" };
  }

  if (horizon === "24h") {
    return { startMs, endMs: startMs + 86_400_000, label: "next 24 hours" };
  }

  const offset = tzOffsetMs(tz, now);
  const local = new Date(startMs + offset);
  const localMidnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + 1,
  );
  let endMs = localMidnight - offset;

  // Less than two hours of slate left: show tomorrow's board instead.
  if (endMs - startMs < 2 * 3_600_000) {
    const tomorrow = new Date(endMs + 3_600_000);
    const tomorrowOffset = tzOffsetMs(tz, tomorrow);
    const tomorrowLocal = new Date(tomorrow.getTime() + tomorrowOffset);
    endMs =
      Date.UTC(
        tomorrowLocal.getUTCFullYear(),
        tomorrowLocal.getUTCMonth(),
        tomorrowLocal.getUTCDate() + 1,
      ) - tomorrowOffset;
    return { startMs, endMs, label: "tomorrow's board (today is nearly over)" };
  }

  return { startMs, endMs, label: "today" };
}

/** "7:05pm ET" — how a close time should read on the board. */
export function formatClose(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  })
    .format(new Date(ms))
    .toLowerCase();
}

export function shortTzName(tz: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "short",
  }).formatToParts(now);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}
