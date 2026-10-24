/**
 * Shape a character's timeline for the profile's journey view: group it by month
 * in the viewer's time zone, fold the levels from one logout into a single line
 * ("Levels 39–41"), and phrase each time honestly ("around 8 October", "between
 * 5 and 6 October") — Blizzard only reports logouts, so that's all mustr knows.
 * Pure, so it's unit-tested.
 */

import type { TimelineEntry } from '../../shared/wow';

export type JourneyItem =
  | { kind: 'levels'; from: number; to: number; milestone: boolean; seenAt: number; sinceAt: number | null }
  | { kind: 'entry'; entry: TimelineEntry };

export interface JourneyMonth {
  key: string; // 'YYYY-MM'
  label: string; // 'October 2026'
  items: JourneyItem[];
}

function parts(t: number, timeZone: string) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(t * 1000));
  const get = (type: string) => p.find((x) => x.type === type)!.value;
  return { year: get('year'), month: get('month'), day: get('day') };
}

const monthName = (t: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, month: 'long' }).format(new Date(t * 1000));

const dayMonth = (t: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'long' }).format(new Date(t * 1000));

/** Entries arrive newest first; months and items stay newest first. */
export function groupJourney(entries: TimelineEntry[], timeZone: string): JourneyMonth[] {
  const months: JourneyMonth[] = [];
  for (const e of entries) {
    const { year, month } = parts(e.seenAt, timeZone);
    const key = `${year}-${month}`;
    let bucket = months[months.length - 1];
    if (!bucket || bucket.key !== key) {
      bucket = { key, label: `${monthName(e.seenAt, timeZone)} ${year}`, items: [] };
      months.push(bucket);
    }
    const last = bucket.items[bucket.items.length - 1];
    if (e.kind === 'level' && e.level !== null) {
      if (last?.kind === 'levels' && last.seenAt === e.seenAt && last.from === e.level + 1) {
        last.from = e.level;
        last.milestone ||= e.level % 10 === 0;
      } else {
        bucket.items.push({
          kind: 'levels',
          from: e.level,
          to: e.level,
          milestone: e.level % 10 === 0,
          seenAt: e.seenAt,
          sinceAt: e.sinceAt,
        });
      }
    } else {
      bucket.items.push({ kind: 'entry', entry: e });
    }
  }
  return months;
}

export function aroundPhrase(seenAt: number, sinceAt: number | null, timeZone: string): string {
  const end = parts(seenAt, timeZone);
  if (sinceAt === null) return `around ${dayMonth(seenAt, timeZone)}`;
  const start = parts(sinceAt, timeZone);
  if (start.year === end.year && start.month === end.month && start.day === end.day) {
    return `around ${dayMonth(seenAt, timeZone)}`;
  }
  if (start.year === end.year && start.month === end.month) {
    return `between ${Number(start.day)} and ${dayMonth(seenAt, timeZone)}`;
  }
  return `between ${dayMonth(sinceAt, timeZone)} and ${dayMonth(seenAt, timeZone)}`;
}
