/**
 * Capture real Blizzard responses for one character as test fixtures.
 *
 * The WoW parsers were written against Blizzard's documented response shape;
 * this saves the real thing so the tests can prove the parsers read it. Names,
 * realm, guild, links and the character id are replaced with placeholders
 * before anything is written, so the fixtures are safe to commit.
 *
 * Usage (needs a Battle.net API client from develop.battle.net):
 *   BNET_CLIENT_ID=… BNET_CLIENT_SECRET=… BNET_REGION=eu BNET_NAMESPACE=profile-classic1x \
 *     npx tsx scripts/wow-capture.ts <realm-slug> <character-name>
 *
 * Writes test/fixtures/wow/live-{summary,equipment,status}.json.
 */

import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appToken, characterPath, BNET_USER_AGENT, type BnetCreds } from '../src/server/wow/bnet';
import { WOW_REGIONS, type WowRegion } from '../src/shared/wow';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test', 'fixtures', 'wow');

const [realmSlug, name] = process.argv.slice(2);
const { BNET_CLIENT_ID, BNET_CLIENT_SECRET, BNET_REGION = 'us', BNET_NAMESPACE = 'profile-classic1x' } = process.env;
if (!realmSlug || !name || !BNET_CLIENT_ID || !BNET_CLIENT_SECRET || !WOW_REGIONS.includes(BNET_REGION as WowRegion)) {
  console.error('Usage: BNET_CLIENT_ID=… BNET_CLIENT_SECRET=… [BNET_REGION=us] [BNET_NAMESPACE=profile-classic1x] npx tsx scripts/wow-capture.ts <realm-slug> <character-name>');
  process.exit(1);
}

const creds: BnetCreds = {
  clientId: BNET_CLIENT_ID,
  clientSecret: BNET_CLIENT_SECRET,
  region: BNET_REGION as WowRegion,
  namespace: BNET_NAMESPACE,
};

let memo: { token: string; expiresAt: number } | null = null;
const token = await appToken(creds, { get: async () => memo, set: async (v) => void (memo = v) }, Math.floor(Date.now() / 1000));

async function get(path: string): Promise<unknown> {
  const params = new URLSearchParams({ namespace: `${creds.namespace}-${creds.region}`, locale: 'en_US' });
  const res = await fetch(`https://${creds.region}.api.blizzard.com${path}?${params}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': BNET_USER_AGENT },
  });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

const base = characterPath(realmSlug, name);
const summary = (await get(base)) as Record<string, unknown>;
const equipment = await get(`${base}/equipment`);
const status = await get(`${base}/status`);

// Everything that could identify the player, mapped to placeholders.
const realm = (summary.realm ?? {}) as Record<string, unknown>;
const guild = (summary.guild ?? {}) as Record<string, unknown>;
const swaps = new Map<string, string>();
const addSwap = (from: unknown, to: string) => {
  if (typeof from === 'string' && from) swaps.set(from.toLowerCase(), to);
};
addSwap(summary.name, 'Examplechar');
addSwap(realm.name, 'Example Realm');
addSwap(realm.slug, 'example-realm');
addSwap(guild.name, 'Example Guild');
const realId = summary.id;

function scrub(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => scrub(x));
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => k !== '_links')
        .map(([k, x]) => [k, scrub(x, k)]),
    );
  }
  if (key === 'href' && typeof v === 'string') return 'https://example.invalid/';
  if (typeof v === 'string') return swaps.get(v.toLowerCase()) ?? v;
  if (typeof v === 'number' && v === realId) return 201234567;
  return v;
}

for (const [file, data] of [
  ['live-summary.json', summary],
  ['live-equipment.json', equipment],
  ['live-status.json', status],
] as const) {
  await writeFile(join(outDir, file), JSON.stringify(scrub(data), null, 2) + '\n');
  console.log('wrote', join('test', 'fixtures', 'wow', file));
}
