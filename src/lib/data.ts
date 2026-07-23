import { getCollection, getEntry } from 'astro:content';
import type { Odds } from './odds';

/**
 * Join helpers. Pages stay declarative: they ask for an "event bundle" and get the
 * event, its course, and the fully-resolved player lines (names looked up from the
 * players collection) in one shape.
 */

export interface ResolvedLine {
  id: string;
  name: string;
  country: string;
  odds: Odds;
  fit: {
    rating: number;
    notes: string;
    skills: { distance: number; approach: number; recovery: number; greens: number };
  };
  result: {
    finish: number | null;
    madeCut: boolean | null;
    status: 'pending' | 'cut' | 'finished' | 'wd';
  };
}

export async function resolveEntries(eventId: string): Promise<ResolvedLine[]> {
  const entryDoc = await getEntry('entries', eventId);
  if (!entryDoc) return [];

  const lines = await Promise.all(
    entryDoc.data.players.map(async (row) => {
      const player = await getEntry(row.player);
      return {
        id: row.player.id,
        name: player?.data.name ?? row.player.id,
        country: player?.data.country ?? '',
        odds: row.odds,
        fit: row.fit,
        result: row.result,
      } satisfies ResolvedLine;
    })
  );

  // Shortest price first — the market's own ordering.
  return lines.sort((a, b) => impliedRank(a.odds) - impliedRank(b.odds));
}

function impliedRank(o: Odds): number {
  // Lower american for favourites (+1400 < +5000); decimals sort naturally.
  return o.format === 'decimal' ? o.outright : o.outright;
}

export async function getEventBundle(eventId: string) {
  const event = await getEntry('events', eventId);
  if (!event) return null;
  const course = await getEntry(event.data.course);
  const lines = await resolveEntries(eventId);
  return { event, course, lines };
}

/** The preview flagged isCurrent, else the most recent by publishDate. */
export async function getCurrentPreview() {
  const previews = await getCollection('previews');
  if (previews.length === 0) return null;
  const current = previews.find((p) => p.data.isCurrent);
  if (current) return current;
  return previews.sort(
    (a, b) => Date.parse(b.data.publishDate) - Date.parse(a.data.publishDate)
  )[0];
}

/** All previews, newest first. */
export async function getPreviewsByDate() {
  const previews = await getCollection('previews');
  return previews.sort(
    (a, b) => Date.parse(b.data.publishDate) - Date.parse(a.data.publishDate)
  );
}

export function formatDateRange(start: string, end: string): string {
  const s = new Date(`${start}T12:00:00Z`);
  const e = new Date(`${end}T12:00:00Z`);
  const month = s.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const endMonth = e.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const year = e.getUTCFullYear();
  if (month === endMonth) {
    return `${month} ${s.getUTCDate()}–${e.getUTCDate()}, ${year}`;
  }
  return `${month} ${s.getUTCDate()} – ${endMonth} ${e.getUTCDate()}, ${year}`;
}
