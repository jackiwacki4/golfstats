/**
 * Radar-chart geometry. Four axes, shared between a course's demand profile and
 * a player's skill profile, so the two can be overlaid on one chart: the reader
 * sees the match instead of reading a scalar fit rating.
 */

export interface RadarAxes {
  distance: number;
  approach: number;
  recovery: number;
  greens: number;
}

export const AXIS_ORDER: (keyof RadarAxes)[] = ['distance', 'approach', 'recovery', 'greens'];
export const AXIS_LABELS: Record<keyof RadarAxes, string> = {
  distance: 'DIST',
  approach: 'APP',
  recovery: 'REC',
  greens: 'GRN',
};

interface CourseDemandsForRadar {
  drivingDistance: number;
  approachBuckets: { range: string; weight: number }[];
  roughSeverity: number;
  greenComplexity: number;
}

/** Maps a course's structured demands onto the same 4 axes as a player's skills. */
export function courseAxes(demands: CourseDemandsForRadar): RadarAxes {
  const approachWeight =
    demands.approachBuckets.reduce((sum, b) => sum + b.weight, 0) /
    Math.max(1, demands.approachBuckets.length);
  return {
    distance: demands.drivingDistance,
    approach: Math.round(approachWeight * 10) / 10,
    recovery: demands.roughSeverity,
    greens: demands.greenComplexity,
  };
}

/** Point for one axis at a given 0–1 fraction of the max radius, N axes evenly spaced. */
function axisPoint(index: number, total: number, radius: number, cx: number, cy: number): [number, number] {
  const angle = (index / total) * 2 * Math.PI - Math.PI / 2; // start at top, clockwise
  return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
}

/** SVG polygon "points" string for a set of 1–5 axis values, plotted on a 0..maxR radius. */
export function radarPolygon(axes: RadarAxes, cx: number, cy: number, maxR: number, scaleMax = 5): string {
  return AXIS_ORDER.map((key, i) => {
    const frac = Math.max(0, Math.min(1, axes[key] / scaleMax));
    const [x, y] = axisPoint(i, AXIS_ORDER.length, maxR * frac, cx, cy);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

/** Label anchor points, placed just outside the max-radius ring. */
export function radarLabelPoints(cx: number, cy: number, maxR: number): { x: number; y: number; label: string }[] {
  return AXIS_ORDER.map((key, i) => {
    const [x, y] = axisPoint(i, AXIS_ORDER.length, maxR, cx, cy);
    return { x, y, label: AXIS_LABELS[key] };
  });
}

/** Ring polygon at a given fraction of max radius — for the reference grid. */
export function radarRing(cx: number, cy: number, maxR: number, frac: number): string {
  return Array.from({ length: AXIS_ORDER.length }, (_, i) => {
    const [x, y] = axisPoint(i, AXIS_ORDER.length, maxR * frac, cx, cy);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}
