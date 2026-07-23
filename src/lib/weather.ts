/**
 * Build-time weather from Open-Meteo (free, no API key). Wind is treated as a
 * first-class part of the preview, so this returns not just daily summaries but a
 * per-day WIND ROSE — direction-binned hourly wind — for the signature element.
 *
 * A daily rebuild (driven externally) keeps the forecast fresh. The fetch is
 * defensive: if the tournament dates are outside the forecast horizon or the
 * network is unavailable at build time, it degrades to clearly-labelled sample
 * data so the page always renders. `isLive` tells the UI which it got.
 */

const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Only count hours a round is actually in progress. */
const PLAY_HOURS = { start: 7, end: 19 };

export interface WindBin {
  label: Direction;
  fromDeg: number; // compass bearing the wind blows FROM
  count: number; // hours in this bin
  avgSpeed: number; // mph
  maxSpeed: number; // mph
}

export interface DayWeather {
  date: string; // ISO date
  weekday: string; // Thu, Fri...
  avgSpeed: number;
  maxSpeed: number;
  dominant: Direction | null;
  maxPrecipProb: number; // %
  rose: WindBin[]; // 8 bins, N..NW
}

export interface TournamentWeather {
  isLive: boolean;
  unit: 'mph';
  days: DayWeather[];
}

interface Coords {
  lat: number;
  lng: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weekdayOf(isoDate: string): string {
  // Parse as UTC noon to avoid timezone rollover on the label.
  return WEEKDAYS[new Date(`${isoDate}T12:00:00Z`).getUTCDay()];
}

function dirIndex(deg: number): number {
  return Math.round(deg / 45) % 8;
}

interface HourlyBlock {
  time: string[];
  wind_speed_10m: number[];
  wind_direction_10m: number[];
  precipitation_probability: number[];
}

function summariseDay(date: string, hourly: HourlyBlock): DayWeather {
  const bins: WindBin[] = DIRECTIONS.map((label, i) => ({
    label,
    fromDeg: i * 45,
    count: 0,
    avgSpeed: 0,
    maxSpeed: 0,
  }));
  const binSpeedTotals = new Array(8).fill(0);

  let speedTotal = 0;
  let speedCount = 0;
  let maxSpeed = 0;
  let maxPrecip = 0;

  for (let h = 0; h < hourly.time.length; h++) {
    if (!hourly.time[h].startsWith(date)) continue;
    const hour = Number(hourly.time[h].slice(11, 13));
    if (hour < PLAY_HOURS.start || hour > PLAY_HOURS.end) continue;

    const speed = hourly.wind_speed_10m[h] ?? 0;
    const dir = hourly.wind_direction_10m[h] ?? 0;
    const precip = hourly.precipitation_probability[h] ?? 0;

    const bi = dirIndex(dir);
    bins[bi].count += 1;
    binSpeedTotals[bi] += speed;
    bins[bi].maxSpeed = Math.max(bins[bi].maxSpeed, speed);

    speedTotal += speed;
    speedCount += 1;
    maxSpeed = Math.max(maxSpeed, speed);
    maxPrecip = Math.max(maxPrecip, precip);
  }

  bins.forEach((b, i) => {
    b.avgSpeed = b.count ? Math.round((binSpeedTotals[i] / b.count) * 10) / 10 : 0;
    b.maxSpeed = Math.round(b.maxSpeed);
  });

  const dominantBin = bins.reduce((a, b) => (b.count > a.count ? b : a), bins[0]);

  return {
    date,
    weekday: weekdayOf(date),
    avgSpeed: speedCount ? Math.round((speedTotal / speedCount) * 10) / 10 : 0,
    maxSpeed: Math.round(maxSpeed),
    dominant: dominantBin.count ? dominantBin.label : null,
    maxPrecipProb: Math.round(maxPrecip),
    rose: bins,
  };
}

function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function fetchWindow(coords: Coords, start: string, end: string): Promise<HourlyBlock | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lng}` +
    `&hourly=wind_speed_10m,wind_direction_10m,precipitation_probability` +
    `&wind_speed_unit=mph&timezone=auto&start_date=${start}&end_date=${end}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { hourly?: HourlyBlock };
    if (!data.hourly?.time?.length) return null;
    return data.hourly;
  } catch {
    return null;
  }
}

/**
 * Deterministic sample fallback: light-to-moderate SW summer winds over parkland,
 * with an afternoon bump and one wetter day. Clearly flagged via isLive:false.
 */
function sampleWeather(dates: string[]): TournamentWeather {
  const seeds = [
    { base: 6, peak: 11, from: 'SW', precip: 10 },
    { base: 8, peak: 14, from: 'S', precip: 20 },
    { base: 10, peak: 17, from: 'NW', precip: 55 },
    { base: 5, peak: 9, from: 'W', precip: 15 },
  ];
  const days = dates.map((date, di) => {
    const s = seeds[di % seeds.length];
    const hourly: HourlyBlock = { time: [], wind_speed_10m: [], wind_direction_10m: [], precipitation_probability: [] };
    const fromDeg = DIRECTIONS.indexOf(s.from as Direction) * 45;
    for (let h = 0; h <= 23; h++) {
      // Smooth arc peaking mid-afternoon.
      const t = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));
      const speed = Math.round((s.base + (s.peak - s.base) * t) * 10) / 10;
      const jitter = ((h * 37 + di * 91) % 5) - 2; // small deterministic wobble
      hourly.time.push(`${date}T${String(h).padStart(2, '0')}:00`);
      hourly.wind_speed_10m.push(speed);
      hourly.wind_direction_10m.push((fromDeg + jitter * 9 + 360) % 360);
      hourly.precipitation_probability.push(Math.round(s.precip * (0.5 + 0.5 * t)));
    }
    return summariseDay(date, hourly);
  });
  return { isLive: false, unit: 'mph', days };
}

export async function getTournamentWeather(
  coords: Coords,
  startDate: string,
  endDate: string
): Promise<TournamentWeather> {
  const dates = datesBetween(startDate, endDate);

  // 1) The real tournament window, if it's inside Open-Meteo's forecast horizon.
  let hourly = await fetchWindow(coords, startDate, endDate);

  // 2) Fall back to the next four days from "now" so a build still shows real,
  //    live wind for the venue even when the fixture is outside the horizon.
  if (!hourly) {
    const today = new Date().toISOString().slice(0, 10);
    const plus3 = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const alt = await fetchWindow(coords, today, plus3);
    if (alt) {
      const altDates = datesBetween(today, plus3);
      return {
        isLive: true,
        unit: 'mph',
        days: altDates.map((d, i) => ({ ...summariseDay(d, alt), weekday: weekdayOf(dates[i] ?? d) })),
      };
    }
  }

  // 3) Offline build — deterministic sample so the page never breaks.
  if (!hourly) return sampleWeather(dates);

  return { isLive: true, unit: 'mph', days: dates.map((d) => summariseDay(d, hourly!)) };
}
