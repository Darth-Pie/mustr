import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffCharacter, type DiffInput } from '../../src/server/wow/diff.ts';
import type { BadgeKey, CharacterSummary, Gear, GearItem, ItemQuality } from '../../src/shared/wow.ts';

const item = (itemId: number, quality: ItemQuality): GearItem => ({ itemId, name: `Item ${itemId}`, quality, itemLevel: 30 });

const summary = (over: Partial<CharacterSummary> = {}): CharacterSummary => ({
  blizzardId: 1,
  name: 'Brightblade',
  realmSlug: 'sylvanas',
  realmName: 'Sylvanas',
  classId: 2,
  className: 'Paladin',
  raceName: 'Human',
  faction: 'ALLIANCE',
  level: 20,
  itemLevel: 20,
  guildName: 'A',
  lastLoginAt: 1000,
  ...over,
});

function make(over: { stored?: Partial<DiffInput['stored']>; summary?: Partial<CharacterSummary>; gear?: Gear | null; firstCheck?: boolean; earned?: BadgeKey[] } = {}): DiffInput {
  return {
    stored: { level: 20, guildName: 'A', gear: {}, lastLoginAt: 500, ...over.stored },
    firstCheck: over.firstCheck ?? false,
    earned: new Set(over.earned ?? []),
    summary: summary(over.summary),
    gear: over.gear === undefined ? {} : over.gear,
    now: 9999,
  };
}

const items = (r: ReturnType<typeof diffCharacter>) => r.entries.filter((e) => e.kind === 'item');

test('first check writes only tracking_started and keeps the gear as the baseline', () => {
  const gear = { HEAD: item(1, 'RARE') };
  const r = diffCharacter(make({ firstCheck: true, summary: { level: 15 }, gear }));
  assert.deepEqual(r.entries, [{ kind: 'tracking_started', level: 15, seenAt: 1000, sinceAt: null }]);
  assert.deepEqual(r.next.gear, gear);
  assert.equal(r.next.level, 15);
});

test('a multi-level jump writes one row per level with shared times', () => {
  const r = diffCharacter(make({ stored: { level: 38 }, summary: { level: 41 } }));
  assert.deepEqual(r.entries, [
    { kind: 'level', level: 39, seenAt: 1000, sinceAt: 500 },
    { kind: 'level', level: 40, seenAt: 1000, sinceAt: 500 },
    { kind: 'level', level: 41, seenAt: 1000, sinceAt: 500 },
  ]);
  assert.equal(r.next.level, 41);
});

test('gear below rare is not logged but is stored', () => {
  const r = diffCharacter(make({ gear: { CHEST: item(2, 'UNCOMMON') } }));
  assert.equal(items(r).length, 0);
  assert.deepEqual(r.next.gear!.CHEST, item(2, 'UNCOMMON'));
});

test('the first rare and first epic are tagged once, in SLOT_ORDER', () => {
  const r = diffCharacter(
    make({ gear: { MAIN_HAND: item(3, 'EPIC'), LEGS: item(4, 'RARE'), HEAD: item(5, 'RARE') } }),
  );
  assert.deepEqual(
    items(r).map((e) => e.kind === 'item' && [e.slot, e.tag]),
    [
      ['HEAD', 'first_rare'],
      ['LEGS', null],
      ['MAIN_HAND', 'first_epic'],
    ],
  );
});

test('earned badges suppress the tags', () => {
  const r = diffCharacter(
    make({ earned: ['first_rare', 'first_epic'], gear: { HEAD: item(5, 'RARE'), MAIN_HAND: item(3, 'EPIC') } }),
  );
  assert.deepEqual(
    items(r).map((e) => e.kind === 'item' && e.tag),
    [null, null],
  );
});

test('the same item in a slot is not logged again', () => {
  const r = diffCharacter(make({ stored: { gear: { HEAD: item(5, 'RARE') } }, gear: { HEAD: item(5, 'RARE') } }));
  assert.equal(items(r).length, 0);
});

test('gear not fetched leaves stored gear unchanged', () => {
  const stored = { HEAD: item(5, 'RARE') };
  const r = diffCharacter(make({ stored: { gear: stored }, gear: null }));
  assert.equal(r.next.gear, stored);
  assert.equal(items(r).length, 0);
});

test('guild changes write leave and/or join', () => {
  const kinds = (from: string | null, to: string | null) =>
    diffCharacter(make({ stored: { guildName: from }, summary: { guildName: to } })).entries.map(
      (e) => (e.kind === 'guild_join' || e.kind === 'guild_leave') && [e.kind, e.guildName],
    );
  assert.deepEqual(kinds('A', 'B'), [
    ['guild_leave', 'A'],
    ['guild_join', 'B'],
  ]);
  assert.deepEqual(kinds(null, 'B'), [['guild_join', 'B']]);
  assert.deepEqual(kinds('A', null), [['guild_leave', 'A']]);
});

test('a lower level is ignored', () => {
  const r = diffCharacter(make({ stored: { level: 20 }, summary: { level: 19 } }));
  assert.equal(r.lowerLevelIgnored, true);
  assert.equal(r.entries.filter((e) => e.kind === 'level').length, 0);
  assert.equal(r.next.level, 20);
});

test('a missing logout time falls back to now', () => {
  const r = diffCharacter(make({ summary: { level: 21, lastLoginAt: null } }));
  assert.deepEqual(r.entries, [{ kind: 'level', level: 21, seenAt: 9999, sinceAt: 500 }]);
  assert.equal(r.next.lastLoginAt, 500);
});
