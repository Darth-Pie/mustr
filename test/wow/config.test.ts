import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanWowConfig, publicWowConfig, EMPTY_WOW_CONFIG, type WowConfig } from '../../src/shared/wow.ts';

const prev = (over: Partial<WowConfig> = {}): WowConfig => ({
  ...EMPTY_WOW_CONFIG,
  clientId: 'id',
  clientSecret: 'old',
  region: 'us',
  namespace: 'profile-classic1x',
  verifiedAt: 100,
  ...over,
});

test('a blank secret keeps the previous one', () => {
  assert.equal(cleanWowConfig({ clientSecret: '' }, prev()).clientSecret, 'old');
  assert.equal(cleanWowConfig({ clientSecret: 'new' }, prev()).clientSecret, 'new');
});

test('changing the client id, secret, region or namespace clears verifiedAt', () => {
  const same = { clientId: 'id', clientSecret: '', region: 'us', namespace: 'profile-classic1x' };
  assert.equal(cleanWowConfig(same, prev()).verifiedAt, 100);
  assert.equal(cleanWowConfig({ ...same, region: 'eu' }, prev()).verifiedAt, null);
  assert.equal(cleanWowConfig({ ...same, clientId: 'other' }, prev()).verifiedAt, null);
  assert.equal(cleanWowConfig({ ...same, clientSecret: 'new' }, prev()).verifiedAt, null);
  assert.equal(cleanWowConfig({ ...same, namespace: 'profile-classic' }, prev()).verifiedAt, null);
});

test('unknown region falls back to us; namespace is trimmed, lowercased, limited to [a-z0-9-], 64 chars', () => {
  assert.equal(cleanWowConfig({ region: 'xx' }, prev()).region, 'us');
  assert.equal(cleanWowConfig({ namespace: ' Profile-Classic1x ' }, prev()).namespace, 'profile-classic1x');
  assert.equal(cleanWowConfig({ namespace: 'bad ns!' }, prev()).namespace, '');
  assert.equal(cleanWowConfig({ namespace: 'a'.repeat(65) }, prev()).namespace, '');
});

test('verifiedAt, lastError and lastErrorAt are never taken from the input', () => {
  const c = cleanWowConfig({ verifiedAt: 5, lastError: 'x', lastErrorAt: 6 }, prev({ lastError: null, lastErrorAt: null }));
  assert.equal(c.lastError, null);
  assert.equal(c.lastErrorAt, null);
  assert.notEqual(c.verifiedAt, 5);
});

test('publicWowConfig drops the secret and reports its presence', () => {
  const p = publicWowConfig(prev());
  assert.equal('clientSecret' in p, false);
  assert.equal(p.hasSecret, true);
  assert.equal(publicWowConfig(prev({ clientSecret: '' })).hasSecret, false);
});
