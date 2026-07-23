import { defineCollection, reference, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * Content is modeled as ENTITIES, not articles.
 *
 *   courses  ── reused across years, own the structured "demands"
 *   players  ── stable IDs so records connect year over year
 *   events   ── one tournament instance, references a course
 *   entries  ── PlayerEventEntry: the hand-entered odds/fit/result lines for an event
 *   previews ── the written analysis, references an event (never duplicates it)
 *
 * This shape is deliberately data-first so a weekly prediction game can grow on
 * top of it later. An article-shaped CMS could not.
 */

// ── Courses ────────────────────────────────────────────────────────────────
const demands = z.object({
  // 1 = neutralised, 5 = decisive. Golfer-language labels live in the UI.
  drivingDistance: z.number().min(1).max(5),
  // The approach yardages that actually decide the week, with how much they matter.
  approachBuckets: z.array(
    z.object({ range: z.string(), weight: z.number().min(1).max(5) })
  ),
  roughSeverity: z.number().min(1).max(5),
  greenSize: z.enum(['small', 'medium', 'large']),
  greenComplexity: z.number().min(1).max(5),
  windExposure: z.number().min(1).max(5),
});

const courses = defineCollection({
  loader: glob({ pattern: '**/*.yaml', base: './src/content/courses' }),
  schema: z.object({
    name: z.string(),
    location: z.object({
      city: z.string(),
      state: z.string(),
      country: z.string().default('USA'),
    }),
    coords: z.object({ lat: z.number(), lng: z.number() }),
    par: z.number(),
    yardage: z.number(),
    greenType: z.string(),
    architect: z.string(),
    established: z.number().optional(),
    demands,
    // Reusable written character of the course. Markdown allowed.
    profile: z.string(),
  }),
});

// ── Players ────────────────────────────────────────────────────────────────
const players = defineCollection({
  loader: glob({ pattern: '**/*.yaml', base: './src/content/players' }),
  schema: z.object({
    name: z.string(),
    country: z.string(),
    turnedPro: z.number().optional(),
  }),
});

// ── Events ─────────────────────────────────────────────────────────────────
const events = defineCollection({
  loader: glob({ pattern: '**/*.yaml', base: './src/content/events' }),
  schema: z.object({
    name: z.string(),
    year: z.number(),
    startDate: z.string(), // ISO date, e.g. 2026-07-23
    endDate: z.string(),
    course: reference('courses'),
    purse: z.number().optional(),
    fieldStrength: z.number().min(1).max(5),
    tour: z.string().default('PGA'),
    defendingChampion: reference('players').optional(),
  }),
});

// ── Entries (PlayerEventEntry) ───────────────────────────────────────────────
// odds is an OBJECT, not a number: this is the seam an odds feed drops into later
// with zero restructuring — a feed writes the exact shape a human types today.
const odds = z.object({
  outright: z.number(),
  format: z.enum(['american', 'decimal']).default('american'),
  asOf: z.string().optional(),
  book: z.string().default('manual'),
});

const result = z
  .object({
    finish: z.number().nullable().default(null),
    madeCut: z.boolean().nullable().default(null),
    status: z.enum(['pending', 'cut', 'finished', 'wd']).default('pending'),
  })
  .default({});

const entries = defineCollection({
  loader: glob({ pattern: '**/*.yaml', base: './src/content/entries' }),
  schema: z.object({
    event: reference('events'),
    players: z.array(
      z.object({
        player: reference('players'),
        odds,
        fit: z.object({
          rating: z.number().min(1).max(5),
          notes: z.string(),
          // Same 4 axes as a course's demands, so a player's shape can be
          // plotted directly against the course's shape on one radar chart.
          skills: z.object({
            distance: z.number().min(1).max(5),
            approach: z.number().min(1).max(5),
            recovery: z.number().min(1).max(5), // scrambling / rough-and-trouble play
            greens: z.number().min(1).max(5), // putting + proximity control
          }),
        }),
        result, // filled in after the event — being publicly wrong on record is the point
      })
    ),
  }),
});

// ── Previews ─────────────────────────────────────────────────────────────────
const previews = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/previews' }),
  schema: z.object({
    event: reference('events'),
    publishDate: z.string(),
    dek: z.string(), // one-line standfirst under the title
    isCurrent: z.boolean().default(false), // the home page reads this
    marketNotes: z
      .array(z.object({ label: z.string(), note: z.string() }))
      .optional(),
  }),
});

export const collections = { courses, players, events, entries, previews };
