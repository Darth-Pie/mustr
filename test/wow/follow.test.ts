import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFollow, type OwnedCharacter } from '../../src/server/wow/follow.ts';

const owned: OwnedCharacter[] = [
  { id: 1, followed: true, level: 40 },
  { id: 2, followed: true, level: 25 },
  { id: 3, followed: false, level: 30 },
];

test('follows the listed characters and deletes previously followed ones left out', () => {
  const p = planFollow(owned, [2, 3], 2);
  assert.ok(!('error' in p));
  assert.deepEqual(p.follow, [2, 3]);
  assert.deepEqual(p.deleteIds, [1]);
});

test('candidates left out are kept for the daily cleanup, not deleted', () => {
  const p = planFollow(owned, [1, 2], 1);
  assert.ok(!('error' in p));
  assert.deepEqual(p.deleteIds, []);
});

test('main must be followed; otherwise the highest level is main', () => {
  const p = planFollow(owned, [2, 3], 1);
  assert.ok(!('error' in p));
  assert.equal(p.main, 3);
  const none = planFollow(owned, [], null);
  assert.ok(!('error' in none));
  assert.equal(none.main, null);
  assert.deepEqual(none.deleteIds, [1, 2]);
});

test('ids the member does not own are an error', () => {
  assert.deepEqual(planFollow(owned, [99], null), { error: 'Unknown character.' });
});
