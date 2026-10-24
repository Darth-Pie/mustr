import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseSummary,
  parseEquipment,
  parseStatus,
  parseAccountCharacters,
  parseUserInfo,
  BnetParseError,
} from '../../src/server/wow/parse.ts';
import { qualityAtLeast } from '../../src/shared/wow.ts';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/wow/${n}.json`, import.meta.url), 'utf8'));

test('parseSummary maps the documented fields and converts ms to seconds', () => {
  assert.deepEqual(parseSummary(fx('summary')), {
    blizzardId: 201234567,
    name: 'Brightblade',
    realmSlug: 'sylvanas',
    realmName: 'Sylvanas',
    classId: 2,
    className: 'Paladin',
    raceName: 'Human',
    faction: 'ALLIANCE',
    level: 42,
    itemLevel: 36,
    guildName: 'The Cabbage Crew',
    lastLoginAt: 1760000000,
  });
});

test('parseSummary: no guild, no logout time, average item level fallback', () => {
  const { guild: _g, last_login_timestamp: _l, equipped_item_level: _e, ...rest } = fx('summary');
  const s = parseSummary(rest);
  assert.equal(s.guildName, null);
  assert.equal(s.lastLoginAt, null);
  assert.equal(s.itemLevel, 35);
});

test('parseSummary throws BnetParseError when required fields are missing', () => {
  assert.throws(() => parseSummary({}), BnetParseError);
});

test('parseEquipment keys items by slot type', () => {
  const g = parseEquipment(fx('equipment'));
  assert.deepEqual(Object.keys(g).sort(), ['CHEST', 'HEAD', 'MAIN_HAND', 'SHIRT']);
  assert.deepEqual(g.MAIN_HAND, { itemId: 19019, name: 'Example Blade', quality: 'EPIC', itemLevel: 44 });
});

test('parseEquipment: empty or missing list is an empty object; unknown quality reads as COMMON', () => {
  assert.deepEqual(parseEquipment({ equipped_items: [] }), {});
  assert.deepEqual(parseEquipment({}), {});
  const odd = parseEquipment({
    equipped_items: [{ item: { id: 1 }, slot: { type: 'HEAD' }, quality: { type: 'MYSTERY' }, name: 'X' }],
  });
  assert.equal(odd.HEAD!.quality, 'COMMON');
  assert.equal(odd.HEAD!.itemLevel, null);
});

test('parseStatus, parseUserInfo, parseAccountCharacters', () => {
  assert.deepEqual(parseStatus(fx('status')), { blizzardId: 201234567, isValid: true });
  assert.deepEqual(parseUserInfo(fx('userinfo')), { bnetId: '9001', battletag: 'Example#1234' });
  const chars = parseAccountCharacters(fx('account'));
  assert.equal(chars.length, 2);
  assert.deepEqual(chars[1], {
    blizzardId: 201234999,
    name: 'Quickpaw',
    realmSlug: 'sylvanas',
    realmName: 'Sylvanas',
    classId: 11,
    className: 'Druid',
    raceName: 'Night Elf',
    faction: 'ALLIANCE',
    level: 28,
  });
  assert.deepEqual(parseAccountCharacters({ id: 1 }), []);
});

test('qualityAtLeast follows QUALITY_ORDER', () => {
  assert.equal(qualityAtLeast('EPIC', 'RARE'), true);
  assert.equal(qualityAtLeast('UNCOMMON', 'RARE'), false);
  assert.equal(qualityAtLeast('RARE', 'RARE'), true);
});
