import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newBadges, ALL_RARE_REQUIRED_SLOTS } from '../../src/server/wow/badges.ts';
import type { BadgeKey, Gear, ItemQuality, LevelRow } from '../../src/shared/wow.ts';

const it = (quality: ItemQuality) => ({ itemId: 1, name: 'x', quality, itemLevel: 30 });
const none = new Set<BadgeKey>();
const DAY = 86400;

const tenRows = (firstSince: number, lastSeen: number): LevelRow[] =>
  Array.from({ length: 10 }, (_, i) => ({
    level: 11 + i,
    seenAt: i === 9 ? lastSeen : firstSince + 1 + i,
    sinceAt: i === 0 ? firstSince : firstSince + i,
  }));

const allRare = (): Gear => Object.fromEntries(ALL_RARE_REQUIRED_SLOTS.map((s) => [s, it('RARE')]));

test('first_rare and first_epic from equipped quality', () => {
  assert.deepEqual(newBadges({ gear: { HEAD: it('RARE') }, levels: [], earned: none }), ['first_rare']);
  assert.deepEqual(newBadges({ gear: { MAIN_HAND: it('EPIC') }, levels: [], earned: none }), [
    'first_rare',
    'first_epic',
  ]);
});

test('all_rare needs every required slot filled and every non-ignored item rare or better', () => {
  const ok = { ...allRare(), SHIRT: it('COMMON'), TABARD: it('COMMON') };
  assert.ok(newBadges({ gear: ok, levels: [], earned: none }).includes('all_rare'));
  assert.ok(!newBadges({ gear: { ...ok, NECK: it('UNCOMMON') }, levels: [], earned: none }).includes('all_rare'));
  const { WRIST: _w, ...missing } = allRare();
  assert.ok(!newBadges({ gear: missing, levels: [], earned: none }).includes('all_rare'));
});

test('earned badges are not returned again', () => {
  const earned = new Set<BadgeKey>(['first_rare', 'all_rare']);
  assert.deepEqual(newBadges({ gear: allRare(), levels: [], earned }), []);
});

test("week_of_grind: ten levels between the first row's sinceAt and the last row's seenAt, at most 7 days", () => {
  assert.ok(newBadges({ gear: null, levels: tenRows(0, 7 * DAY), earned: none }).includes('week_of_grind'));
  assert.ok(!newBadges({ gear: null, levels: tenRows(0, 7 * DAY + 1), earned: none }).includes('week_of_grind'));
});

test('week_of_grind is not earned by one jump after three weeks away', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ level: 11 + i, seenAt: 21 * DAY, sinceAt: 0 }));
  assert.ok(!newBadges({ gear: null, levels: rows, earned: none }).includes('week_of_grind'));
});

test('steady_climber needs level rows on seven consecutive UTC dates', () => {
  const noon = (d: number) => Date.UTC(2026, 10, d, 12) / 1000;
  const rows = (days: number[]) => days.map((d, i) => ({ level: 10 + i, seenAt: noon(d), sinceAt: noon(d) - 3600 }));
  assert.ok(newBadges({ gear: null, levels: rows([4, 5, 6, 7, 8, 9, 10]), earned: none }).includes('steady_climber'));
  assert.ok(!newBadges({ gear: null, levels: rows([4, 5, 6, 7, 8, 9, 11]), earned: none }).includes('steady_climber'));
  // Two levels on the same date count as one day.
  assert.ok(!newBadges({ gear: null, levels: rows([4, 4, 5, 6, 7, 8, 9]), earned: none }).includes('steady_climber'));
});

test('no level rows means no time badges and gear null means no gear badges', () => {
  assert.deepEqual(newBadges({ gear: null, levels: [], earned: none }), []);
});
