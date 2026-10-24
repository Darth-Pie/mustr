import { test } from 'node:test';
import assert from 'node:assert/strict';
import { milestonePosts } from '../../src/server/wow/milestones.ts';
import type { EntryDraft } from '../../src/server/wow/diff.ts';

const SEEN = 1_000_000;
const levels = (...ls: number[]): EntryDraft[] => ls.map((level) => ({ kind: 'level', level, seenAt: SEEN, sinceAt: SEEN - 3600 }));
const base = { characterId: 7, firstCheck: false, firsts: [], now: SEEN + 100 };

test('a jump across a milestone gives one level post for the highest milestone crossed', () => {
  assert.deepEqual(milestonePosts({ ...base, entries: levels(38, 39, 40, 41) }), [
    { type: 'wowLevel', level: 40, shared: false },
  ]);
  assert.deepEqual(milestonePosts({ ...base, entries: levels(19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31) }), [
    { type: 'wowLevel', level: 30, shared: false },
  ]);
});

test('reaching 60 is a milestone', () => {
  assert.deepEqual(milestonePosts({ ...base, entries: levels(60) }), [{ type: 'wowLevel', level: 60, shared: false }]);
});

test('being first adds a wowFirst post ahead of the level post', () => {
  const firsts = [{ level: 40, characterIds: [7], at: SEEN }];
  assert.deepEqual(milestonePosts({ ...base, firsts, entries: levels(39, 40) }), [
    { type: 'wowFirst', level: 40, shared: false },
    { type: 'wowLevel', level: 40, shared: false },
  ]);
});

test('a shared first is marked shared', () => {
  const firsts = [{ level: 40, characterIds: [8, 7], at: SEEN }];
  assert.deepEqual(milestonePosts({ ...base, firsts, entries: levels(40) })[0], { type: 'wowFirst', level: 40, shared: true });
});

test('a first for a milestone not crossed in this check is not posted again', () => {
  const firsts = [{ level: 30, characterIds: [7], at: SEEN - 50_000 }];
  assert.deepEqual(milestonePosts({ ...base, firsts, entries: levels(40) }), [{ type: 'wowLevel', level: 40, shared: false }]);
});

test('a first check, no milestone, or a change seen more than 24 hours ago gives nothing', () => {
  const tracking: EntryDraft[] = [{ kind: 'tracking_started', level: 40, seenAt: SEEN, sinceAt: null }];
  assert.deepEqual(milestonePosts({ ...base, firstCheck: true, entries: tracking }), []);
  assert.deepEqual(milestonePosts({ ...base, entries: levels(41, 42) }), []);
  assert.deepEqual(milestonePosts({ ...base, now: SEEN + 86401, entries: levels(40) }), []);
});
