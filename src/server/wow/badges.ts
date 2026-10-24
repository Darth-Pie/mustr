/**
 * WoW badges — the moments worth a cheer, worked out from a character's gear and
 * the levels mustr saw it gain. Pure, so each rule's edge is unit-tested.
 *
 * Gear badges can be earned on the very first check (the character may already
 * wear a blue). Time badges only count levels seen after tracking started, and
 * judge conservatively: ten levels "within seven days" must fit between the
 * logout before the first of them and the logout after the last.
 */

import { BADGE_ORDER, qualityAtLeast, type BadgeKey, type Gear, type LevelRow } from '../../shared/wow';

/** Must all be filled for "All in blue". Off-hand isn't required (two-handers). */
export const ALL_RARE_REQUIRED_SLOTS: readonly string[] = [
  'HEAD',
  'SHOULDER',
  'CHEST',
  'WRIST',
  'HANDS',
  'WAIST',
  'LEGS',
  'FEET',
  'MAIN_HAND',
];

/** Cosmetic slots that never count against "All in blue". */
export const ALL_RARE_IGNORED_SLOTS: readonly string[] = ['SHIRT', 'TABARD'];

const WEEK = 7 * 86400;

function allRare(gear: Gear): boolean {
  if (!ALL_RARE_REQUIRED_SLOTS.every((s) => gear[s])) return false;
  return Object.entries(gear).every(
    ([slot, item]) => ALL_RARE_IGNORED_SLOTS.includes(slot) || qualityAtLeast(item.quality, 'RARE'),
  );
}

function weekOfGrind(levels: LevelRow[]): boolean {
  const rows = [...levels].sort((a, b) => a.level - b.level);
  for (let i = 0; i + 9 < rows.length; i++) {
    const first = rows[i]!;
    const last = rows[i + 9]!;
    if (last.seenAt - (first.sinceAt ?? first.seenAt) <= WEEK) return true;
  }
  return false;
}

function steadyClimber(levels: LevelRow[]): boolean {
  const days = [...new Set(levels.map((r) => Math.floor(r.seenAt / 86400)))].sort((a, b) => a - b);
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1]! + 1 ? run + 1 : 1;
    if (run >= 7) return true;
  }
  return false;
}

export function newBadges(input: { gear: Gear | null; levels: LevelRow[]; earned: ReadonlySet<BadgeKey> }): BadgeKey[] {
  const { gear, levels, earned } = input;
  const items = gear ? Object.values(gear) : [];
  const has: Record<BadgeKey, boolean> = {
    first_rare: items.some((i) => qualityAtLeast(i.quality, 'RARE')),
    first_epic: items.some((i) => qualityAtLeast(i.quality, 'EPIC')),
    all_rare: !!gear && allRare(gear),
    week_of_grind: weekOfGrind(levels),
    steady_climber: steadyClimber(levels),
  };
  return BADGE_ORDER.filter((k) => has[k] && !earned.has(k));
}
