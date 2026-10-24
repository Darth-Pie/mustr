import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRace, pickCounted, reachedAt, type RaceCharacter } from '../../src/server/wow/records.ts';

/** A character seen reaching each level in `at` (level → time), tracked from `baseline`. */
function char(characterId: number, userId: number, baseline: number, at: Record<number, number>, isMain = false): RaceCharacter {
  const levels = Object.entries(at)
    .map(([l, t]) => ({ level: Number(l), seenAt: t, sinceAt: t - 60 }))
    .sort((a, b) => a.level - b.level);
  const level = levels.length ? levels[levels.length - 1]!.level : baseline;
  return { characterId, userId, level, isMain, baselineLevel: baseline, levels };
}

test('reachedAt counts only levels seen after the baseline', () => {
  assert.equal(reachedAt(char(1, 1, 45, {}), 40), null);
  assert.equal(reachedAt(char(1, 1, 30, { 40: 100 }), 40), 100);
});

test('pickCounted: the main, else the highest level, ties to the lowest characterId; alts=true keeps all', () => {
  const chars = [
    char(10, 1, 30, {}, true),
    char(11, 1, 40, {}),
    char(21, 2, 25, {}),
    char(20, 2, 25, {}),
  ];
  assert.deepEqual(
    pickCounted(chars, false).map((c) => c.characterId).sort(),
    [10, 20],
  );
  assert.equal(pickCounted(chars, true).length, 4);
});

test('a member whose main is gone counts their highest-level character', () => {
  const chars = [char(30, 3, 12, {}), char(31, 3, 18, {})];
  assert.deepEqual(
    pickCounted(chars, false).map((c) => c.characterId),
    [31],
  );
});

test('standings: level desc, then who reached it first, never-seen last', () => {
  const a = char(1, 1, 30, { 40: 200 });
  const b = char(2, 2, 30, { 40: 100 });
  const c = char(3, 3, 45, {}); // level 45, but tracked from 45
  const d = char(4, 4, 39, {}); // level 39 baseline, never seen at 40
  const e = { ...char(5, 5, 30, {}), level: 40 }; // claims 40 with no row: never seen reaching it
  assert.deepEqual(
    computeRace([a, b, c, d, e], true).standings.map((s) => s.characterId),
    [3, 2, 1, 5, 4],
  );
});

test('firsts share within two hours', () => {
  const t = 1_000_000;
  const r = computeRace([char(1, 1, 30, { 40: t }), char(2, 2, 30, { 40: t + 7200 }), char(3, 3, 30, { 40: t + 7201 })], true);
  const f40 = r.firsts.find((f) => f.level === 40)!;
  assert.deepEqual(f40.characterIds, [1, 2]);
  assert.equal(f40.at, t);
});

test('a milestone nobody counted has reached is absent from firsts', () => {
  const r = computeRace([char(1, 1, 30, { 40: 100 })], true);
  assert.deepEqual(
    r.firsts.map((f) => f.level),
    [40],
  );
});

test('fastest needs both ends of the band observed', () => {
  const a = char(1, 1, 5, { 10: 0, 20: 1000 });
  const b = char(2, 2, 15, { 20: 500 });
  const r = computeRace([a, b], true);
  assert.deepEqual(r.fastest, [{ from: 10, to: 20, characterId: 1, seconds: 1000 }]);
});

test('scenic is the slowest completed band, or null', () => {
  const a = char(1, 1, 5, { 10: 0, 20: 1000, 30: 1500 });
  const b = char(2, 2, 5, { 10: 0, 20: 4000 });
  assert.deepEqual(computeRace([a, b], true).scenic, { from: 10, to: 20, characterId: 2, seconds: 4000 });
  assert.equal(computeRace([char(3, 3, 25, {})], true).scenic, null);
});
