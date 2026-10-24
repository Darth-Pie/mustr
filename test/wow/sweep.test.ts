/**
 * The sweep and race loader against a real (local, throwaway) D1 — the failures
 * these guard against (D1's 100-bound-parameter cap, a stuck character blocking
 * every run, gear and namespace mix-ups) only show up in the database layer.
 * Blizzard is stood in for by a stubbed global fetch.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq } from 'drizzle-orm';
import * as s from '../../src/db/schema.ts';
import { SCHEMA_STATEMENTS } from '../../src/db/migrations.generated.ts';
import { runWowSweep } from '../../src/server/wow/poll.ts';
import { loadRaceCharacters } from '../../src/server/wow/race.ts';

const NS = 'profile-classic1x';
const NOW = 1_800_000_000;
const persist = mkdtempSync(join(tmpdir(), 'wow-d1-'));
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>;
let db: ReturnType<typeof drizzle<typeof s>>;
let env: { DB: D1Database };
const realFetch = globalThis.fetch;

before(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url)),
    persist: { path: persist },
  });
  env = proxy.env;
  for (const sql of SCHEMA_STATEMENTS) await env.DB.prepare(sql).run();
  db = drizzle(env.DB, { schema: s });
});

after(async () => {
  globalThis.fetch = realFetch;
  await proxy.dispose();
  rmSync(persist, { recursive: true, force: true });
});

beforeEach(async () => {
  globalThis.fetch = realFetch;
  await db.delete(s.users);
  await db.delete(s.settings);
  await db.insert(s.settings).values([
    { key: 'modules', value: { starcitizen: false, gallery: false, wow: true } },
    {
      key: 'wow',
      value: { clientId: 'id', clientSecret: 'secret', region: 'eu', namespace: NS, verifiedAt: 1, lastError: null, lastErrorAt: null },
    },
  ]);
  await db.insert(s.users).values({ id: 1, discordId: '900000000000000001', username: 'tess' });
});

type Row = typeof s.wowCharacters.$inferInsert;
async function character(over: Partial<Row> & { name: string; blizzardId: number }): Promise<number> {
  const [row] = await db
    .insert(s.wowCharacters)
    .values({
      userId: 1,
      region: 'eu',
      namespace: NS,
      realmSlug: 'sylvanas',
      realmName: 'Sylvanas',
      classId: 2,
      className: 'Paladin',
      raceName: 'Human',
      faction: 'ALLIANCE',
      level: 10,
      followed: true,
      baselineLevel: 10,
      lastLoginAt: 1000,
      gear: {},
      lastPolledAt: 1,
      lastValidatedAt: NOW,
      ...over,
    } as Row)
    .returning({ id: s.wowCharacters.id });
  return row!.id;
}

const rare = (itemId: number, slot: string) => ({
  item: { id: itemId },
  slot: { type: slot },
  quality: { type: 'RARE' },
  name: `Item ${itemId}`,
  level: { value: 20 },
});
const SLOTS = ['HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST', 'LEGS', 'FEET', 'FINGER_1', 'FINGER_2'];

/** Stub Blizzard: `route` answers character URLs; the token endpoint always works. */
function blizzard(route: (url: string) => { status?: number; body?: unknown } | undefined) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'T', expires_in: 86399 }));
    const r = route(url) ?? { status: 404, body: {} };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return calls;
}

const summary = (name: string, id: number, level: number, login: number) => ({
  body: {
    id,
    name,
    realm: { slug: 'sylvanas', name: 'Sylvanas' },
    character_class: { id: 2, name: 'Paladin' },
    race: { name: 'Human' },
    faction: { type: 'ALLIANCE' },
    level,
    last_login_timestamp: login * 1000,
  },
});

const timeline = (characterId: number, kind: string) =>
  db.select().from(s.wowTimeline).where(and(eq(s.wowTimeline.characterId, characterId), eq(s.wowTimeline.kind, kind as 'level')));
const stored = async (id: number) => (await db.select().from(s.wowCharacters).where(eq(s.wowCharacters.id, id)))[0]!;

test('a 25-level jump and a full gear swap are saved in one check', async () => {
  const oldGear = Object.fromEntries(SLOTS.map((slot, i) => [slot, { itemId: i + 1, name: 'old', quality: 'RARE', itemLevel: 10 }]));
  const id = await character({ name: 'Brightblade', blizzardId: 5, gear: oldGear });
  blizzard((url) => {
    if (url.includes('/equipment')) return { body: { equipped_items: SLOTS.map((slot, i) => rare(100 + i, slot)) } };
    if (url.includes('/brightblade?')) return summary('Brightblade', 5, 35, 2000);
  });
  await runWowSweep(env as never, NOW);
  assert.equal((await stored(id)).level, 35);
  assert.equal((await timeline(id, 'level')).length, 25);
  assert.equal((await timeline(id, 'item')).length, 12);
});

test('the race loads with 120 followed characters', async () => {
  for (let i = 0; i < 120; i++) await character({ name: `Char${i}`, blizzardId: 1000 + i });
  const rows = await loadRaceCharacters(db, { region: 'eu', namespace: NS });
  assert.equal(rows.length, 120);
});

test('a character whose checks keep failing does not block the others', async () => {
  const stuck = await character({ name: 'Stuck', blizzardId: 6, lastPolledAt: null });
  const fine = await character({ name: 'Fine', blizzardId: 7, lastPolledAt: 1, baselineLevel: null });
  blizzard((url) => {
    if (url.includes('/stuck?')) return { status: 503 };
    if (url.includes('/fine?')) return summary('Fine', 7, 12, 2000);
  });
  await runWowSweep(env as never, NOW);
  await runWowSweep(env as never, NOW + 300);
  assert.equal((await stored(fine)).baselineLevel, 12);
  assert.ok((await stored(stuck)).lastPolledAt! >= NOW);
});

test('a status check that keeps failing does not block other status checks', async () => {
  await character({ name: 'Stuck', blizzardId: 6, lastValidatedAt: null });
  const fine = await character({ name: 'Fine', blizzardId: 7, lastValidatedAt: null });
  blizzard((url) => {
    if (url.includes('/stuck/status')) return { status: 503 };
    if (url.includes('/fine/status')) return { body: { id: 7, is_valid: true } };
  });
  await runWowSweep(env as never, NOW);
  await runWowSweep(env as never, NOW + 300);
  assert.equal((await stored(fine)).lastValidatedAt, NOW + 300);
});

test('a 403 on one character skips it instead of ending the run', async () => {
  await character({ name: 'Hidden', blizzardId: 6, lastPolledAt: null });
  const fine = await character({ name: 'Fine', blizzardId: 7, baselineLevel: null });
  blizzard((url) => {
    if (url.includes('/hidden?')) return { status: 403 };
    if (url.includes('/fine?')) return summary('Fine', 7, 12, 2000);
  });
  const out = await runWowSweep(env as never, NOW);
  assert.equal((await stored(fine)).baselineLevel, 12);
  assert.equal(out.stoppedEarly, false);
});

test('a 401 clears the cached token and is shown on the admin card', async () => {
  await character({ name: 'Fine', blizzardId: 7, lastPolledAt: null });
  blizzard(() => ({ status: 401 }));
  await runWowSweep(env as never, NOW);
  const token = await db.select().from(s.settings).where(eq(s.settings.key, 'wow_token'));
  assert.equal(token.length, 0);
  const cfg = (await db.select().from(s.settings).where(eq(s.settings.key, 'wow')))[0]!.value as { lastError: string | null };
  assert.ok(cfg.lastError);
});

test('an equipment 404 keeps the stored gear', async () => {
  const head = { itemId: 1, name: 'Helm', quality: 'RARE', itemLevel: 20 };
  const id = await character({ name: 'Brightblade', blizzardId: 5, gear: { HEAD: head } });
  blizzard((url) => (url.includes('/brightblade?') ? summary('Brightblade', 5, 10, 2000) : undefined));
  await runWowSweep(env as never, NOW);
  assert.deepEqual((await stored(id)).gear, { HEAD: head });

  blizzard((url) => {
    if (url.includes('/equipment')) return { body: { equipped_items: [rare(1, 'HEAD'), rare(2, 'LEGS')] } };
    if (url.includes('/brightblade?')) return summary('Brightblade', 5, 10, 3000);
  });
  await runWowSweep(env as never, NOW + 300);
  assert.deepEqual(
    (await timeline(id, 'item')).map((r) => r.slot),
    ['LEGS'],
  );
});

test('characters from another data section are not swept or raced', async () => {
  const other = await character({ name: 'Classic', blizzardId: 8, namespace: 'profile-classic', lastPolledAt: null });
  const calls = blizzard(() => undefined);
  await runWowSweep(env as never, NOW);
  assert.ok(!calls.some((u) => u.includes('/classic')));
  const rows = await loadRaceCharacters(db, { region: 'eu', namespace: NS });
  assert.ok(!rows.some((r) => r.characterId === other));
});

test('a summary for a different character id is not merged into the timeline', async () => {
  const id = await character({ name: 'Brightblade', blizzardId: 5 });
  blizzard((url) => (url.includes('/brightblade?') ? summary('Brightblade', 999, 30, 2000) : undefined));
  await runWowSweep(env as never, NOW);
  assert.equal((await stored(id)).level, 10);
  assert.equal((await timeline(id, 'level')).length, 0);
});
