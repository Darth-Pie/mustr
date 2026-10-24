import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  appToken,
  authorizeUrl,
  characterPath,
  fetchSummary,
  BnetError,
  BNET_USER_AGENT,
  type BnetCreds,
  type FetchFn,
  type TokenStore,
} from '../../src/server/wow/bnet.ts';
import { parseSummary } from '../../src/server/wow/parse.ts';

const summaryJson = JSON.parse(readFileSync(new URL('../fixtures/wow/summary.json', import.meta.url), 'utf8'));
const creds: BnetCreds = { clientId: 'cid', clientSecret: 'secret', region: 'eu', namespace: 'profile-classic1x' };

/** A fetch stand-in that records each request and answers with `status` and `body`. */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f: FetchFn = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { f, calls };
}

const header = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

test('characterPath lowercases and URL-encodes the name', () => {
  assert.equal(characterPath('sylvanas', 'Ëmberwick'), '/profile/wow/character/sylvanas/%C3%ABmberwick');
});

test('authorizeUrl targets oauth.battle.net with openid and wow.profile', () => {
  const u = new URL(authorizeUrl(creds, 'https://site.example/api/wow/link/callback', 'st8'));
  assert.equal(u.origin + u.pathname, 'https://oauth.battle.net/authorize');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://site.example/api/wow/link/callback');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('scope'), 'openid wow.profile');
  assert.equal(u.searchParams.get('state'), 'st8');
});

test('fetchSummary calls the regional host with namespace, locale and a bearer token', async () => {
  const { f, calls } = fakeFetch(200, summaryJson);
  const s = await fetchSummary(creds, 'T', 'sylvanas', 'Brightblade', f);
  assert.equal(
    calls[0]!.url,
    'https://eu.api.blizzard.com/profile/wow/character/sylvanas/brightblade?namespace=profile-classic1x-eu&locale=en_US',
  );
  assert.equal(header(calls[0]!.init, 'Authorization'), 'Bearer T');
  assert.equal(header(calls[0]!.init, 'User-Agent'), BNET_USER_AGENT);
  assert.deepEqual(s, parseSummary(summaryJson));
});

test('404 returns null; 429 and 503 throw retryable; 401 throws non-retryable', async () => {
  assert.equal(await fetchSummary(creds, 'T', 'r', 'n', fakeFetch(404, {}).f), null);
  for (const [status, retryable] of [
    [429, true],
    [503, true],
    [401, false],
  ] as const) {
    await assert.rejects(fetchSummary(creds, 'T', 'r', 'n', fakeFetch(status, {}).f), (e: unknown) => {
      assert.ok(e instanceof BnetError);
      assert.equal(e.status, status);
      assert.equal(e.retryable, retryable);
      assert.ok(!String(e.message).includes('T '), 'error must not echo the token');
      return true;
    });
  }
});

test('appToken reuses a token with more than 300 s left and refreshes otherwise', async () => {
  const now = 1_000_000;
  let stored: { token: string; expiresAt: number } | null = { token: 'A', expiresAt: now + 301 };
  const store: TokenStore = {
    get: async () => stored,
    set: async (v) => {
      stored = v;
    },
  };
  const fresh = fakeFetch(200, { access_token: 'B', token_type: 'bearer', expires_in: 86399 });
  assert.equal(await appToken(creds, store, now, fresh.f), 'A');
  assert.equal(fresh.calls.length, 0);

  stored = { token: 'A', expiresAt: now + 299 };
  assert.equal(await appToken(creds, store, now, fresh.f), 'B');
  assert.equal(fresh.calls[0]!.url, 'https://oauth.battle.net/token');
  assert.equal(fresh.calls[0]!.init.method, 'POST');
  assert.equal(header(fresh.calls[0]!.init, 'Authorization'), `Basic ${btoa('cid:secret')}`);
  assert.equal(new URLSearchParams(String(fresh.calls[0]!.init.body)).get('grant_type'), 'client_credentials');
  assert.deepEqual(stored, { token: 'B', expiresAt: now + 86399 });
});
