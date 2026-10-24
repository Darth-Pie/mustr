/**
 * Turn each character's level changes into chart buckets — calendar days or
 * Monday-start weeks in the VIEWER's time zone, so a level gained at 23:30 lands
 * on the evening it happened for them, not on the server's UTC date. Dates are
 * walked as calendar dates (not 24-hour steps), so a clock change never drops or
 * doubles a day. Pure, so it's unit-tested.
 */

export interface SeriesInput {
  characterId: number;
  /** The baseline (tracking started) first, then each level the character reached. */
  points: { t: number; level: number }[];
}

export interface Bucketed {
  labels: string[];
  lines: { characterId: number; levels: (number | null)[]; gained: number[] }[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The local calendar date of a moment, as [year, month (1-12), day]. */
function localDate(t: number, timeZone: string): [number, number, number] {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(t * 1000),
  );
  const [y, m, d] = s.split('-').map(Number);
  return [y!, m!, d!];
}

/** Days since the epoch for a calendar date — plain arithmetic, no time zones. */
const dayNumber = ([y, m, d]: [number, number, number]) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);

function dayLabel(day: number): string {
  const dt = new Date(day * 86400000);
  return `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`;
}

/** Monday on or before this day (1970-01-01 was a Thursday). */
const weekStart = (day: number) => day - ((day + 3) % 7);

export function bucketSeries(series: SeriesInput[], period: 'day' | 'week', timeZone: string, now: number): Bucketed {
  const all = series.flatMap((s) => s.points);
  if (!all.length) return { labels: [], lines: [] };

  const bucketOf = (t: number) => {
    const day = dayNumber(localDate(t, timeZone));
    return period === 'day' ? day : weekStart(day);
  };
  const step = period === 'day' ? 1 : 7;
  const first = Math.min(...all.map((p) => bucketOf(p.t)));
  const last = Math.max(bucketOf(now), ...all.map((p) => bucketOf(p.t)));

  const keys: number[] = [];
  for (let k = first; k <= last; k += step) keys.push(k);
  const labels = keys.map((k) => (period === 'day' ? dayLabel(k) : `Wk of ${dayLabel(k)}`));
  const index = new Map(keys.map((k, i) => [k, i]));

  const lines = series.map((s) => {
    const points = [...s.points].sort((a, b) => a.t - b.t);
    const gained = keys.map(() => 0);
    const levelAt: (number | null)[] = keys.map(() => null);
    let prev: number | null = null;
    for (const p of points) {
      const i = index.get(bucketOf(p.t))!;
      if (prev !== null && p.level > prev) gained[i]! += p.level - prev;
      prev = prev === null ? p.level : Math.max(prev, p.level);
      levelAt[i] = prev;
    }
    // Carry each level forward until the next change.
    let carry: number | null = null;
    const levels = levelAt.map((v) => (carry = v ?? carry));
    return { characterId: s.characterId, levels, gained };
  });

  return { labels, lines };
}
