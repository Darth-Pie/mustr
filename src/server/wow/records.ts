/**
 * The level race: standings, firsts, the fastest ten levels and the scenic
 * route, all worked out from the level rows mustr saw happen.
 *
 * Pure and recomputed per request (cheap at guild size). One rule underpins it:
 * a level only counts if tracking started below it. Someone who links Battle.net
 * at 45 can't claim "first to 40" — mustr never saw when they got there.
 */

import { MILESTONES, TIE_WINDOW_SECONDS, type LevelRow } from '../../shared/wow';

export interface RaceCharacter {
  characterId: number;
  userId: number;
  level: number;
  isMain: boolean;
  baselineLevel: number | null;
  levels: LevelRow[];
}

export interface Standing {
  characterId: number;
  level: number;
  reachedAt: number | null;
}

export interface FirstRecord {
  level: number;
  characterIds: number[];
  at: number;
}

export interface BandRecord {
  from: number;
  to: number;
  characterId: number;
  seconds: number;
}

export interface RaceRecords {
  standings: Standing[];
  firsts: FirstRecord[];
  fastest: BandRecord[];
  scenic: BandRecord | null;
}

const BANDS: [number, number][] = [
  [10, 20],
  [20, 30],
  [30, 40],
  [40, 50],
  [50, 60],
];

/** When this character was seen reaching `level`, or null if mustr didn't see it. */
export function reachedAt(c: RaceCharacter, level: number): number | null {
  if (c.baselineLevel === null || c.baselineLevel >= level) return null;
  return c.levels.find((r) => r.level === level)?.seenAt ?? null;
}

/**
 * Who counts. With alts, everyone; otherwise one character per member: their
 * main, or (main unfollowed or deleted) their highest level, ties to the lowest id.
 */
export function pickCounted(chars: RaceCharacter[], alts: boolean): RaceCharacter[] {
  if (alts) return chars;
  const best = new Map<number, RaceCharacter>();
  for (const c of chars) {
    const cur = best.get(c.userId);
    const better =
      !cur ||
      (c.isMain && !cur.isMain) ||
      (c.isMain === cur.isMain &&
        (c.level > cur.level || (c.level === cur.level && c.characterId < cur.characterId)));
    if (better) best.set(c.userId, c);
  }
  return [...best.values()];
}

export function computeRace(chars: RaceCharacter[], alts: boolean): RaceRecords {
  const counted = pickCounted(chars, alts);

  const standings = counted
    .map((c) => ({ characterId: c.characterId, level: c.level, reachedAt: reachedAt(c, c.level) }))
    .sort(
      (a, b) =>
        b.level - a.level ||
        (a.reachedAt ?? Infinity) - (b.reachedAt ?? Infinity) ||
        a.characterId - b.characterId,
    );

  const firsts: FirstRecord[] = [];
  for (const level of MILESTONES) {
    const times = counted
      .map((c) => ({ id: c.characterId, at: reachedAt(c, level) }))
      .filter((t): t is { id: number; at: number } => t.at !== null);
    if (!times.length) continue;
    const at = Math.min(...times.map((t) => t.at));
    const characterIds = times
      .filter((t) => t.at - at <= TIE_WINDOW_SECONDS)
      .sort((a, b) => a.at - b.at || a.id - b.id)
      .map((t) => t.id);
    firsts.push({ level, characterIds, at });
  }

  const fastest: BandRecord[] = [];
  let scenic: BandRecord | null = null;
  for (const [from, to] of BANDS) {
    let best: (BandRecord & { end: number }) | null = null;
    for (const c of counted) {
      const start = reachedAt(c, from);
      const end = reachedAt(c, to);
      if (start === null || end === null) continue;
      const rec = { from, to, characterId: c.characterId, seconds: end - start };
      if (!best || rec.seconds < best.seconds || (rec.seconds === best.seconds && end < best.end)) {
        best = { ...rec, end };
      }
      if (!scenic || rec.seconds > scenic.seconds) scenic = rec;
    }
    if (best) fastest.push({ from: best.from, to: best.to, characterId: best.characterId, seconds: best.seconds });
  }

  return { standings, firsts, fastest, scenic };
}
