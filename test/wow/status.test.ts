import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusDecision } from '../../src/server/wow/status.ts';

test('valid with a matching id is ok', () => {
  assert.deepEqual(statusDecision({ blizzardId: 5, isValid: true }, 5, 2), { action: 'ok' });
});

test('invalid or a changed id deletes at once', () => {
  assert.deepEqual(statusDecision({ blizzardId: 5, isValid: false }, 5, 0), { action: 'delete' });
  assert.deepEqual(statusDecision({ blizzardId: 6, isValid: true }, 5, 0), { action: 'delete' });
});

test('a 404 counts up and deletes on the third in a row', () => {
  assert.deepEqual(statusDecision(null, 5, 0), { action: 'fail', failures: 1 });
  assert.deepEqual(statusDecision(null, 5, 1), { action: 'fail', failures: 2 });
  assert.deepEqual(statusDecision(null, 5, 2), { action: 'delete' });
});
