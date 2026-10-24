/**
 * Turn Blizzard's profile-API JSON into the module's own types.
 *
 * Kept apart from the fetching (bnet.ts) so it can be tested against saved
 * responses. Blizzard's timestamps are milliseconds; everything mustr stores is
 * unix seconds, so the conversion happens here, once. Requests are made with
 * locale=en_US, so names arrive as plain strings rather than locale maps.
 */

import {
  QUALITY_ORDER,
  type AccountCharacter,
  type CharacterStatus,
  type CharacterSummary,
  type Gear,
  type ItemQuality,
} from '../../shared/wow';

export class BnetParseError extends Error {}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function need<T>(value: T | null, what: string): T {
  if (value === null) throw new BnetParseError(`Blizzard response is missing ${what}`);
  return value;
}

function faction(v: unknown): 'ALLIANCE' | 'HORDE' {
  return obj(v).type === 'HORDE' ? 'HORDE' : 'ALLIANCE';
}

function quality(v: unknown): ItemQuality {
  const t = obj(v).type;
  return QUALITY_ORDER.includes(t as ItemQuality) ? (t as ItemQuality) : 'COMMON';
}

export function parseSummary(json: unknown): CharacterSummary {
  const o = obj(json);
  const realm = obj(o.realm);
  const cls = obj(o.character_class);
  const login = num(o.last_login_timestamp);
  return {
    blizzardId: need(num(o.id), 'id'),
    name: need(str(o.name), 'name'),
    realmSlug: need(str(realm.slug), 'realm.slug'),
    realmName: str(realm.name) ?? need(str(realm.slug), 'realm.slug'),
    classId: need(num(cls.id), 'character_class.id'),
    className: str(cls.name) ?? '',
    raceName: str(obj(o.race).name) ?? '',
    faction: faction(o.faction),
    level: need(num(o.level), 'level'),
    itemLevel: num(o.equipped_item_level) ?? num(o.average_item_level),
    guildName: str(obj(o.guild).name),
    lastLoginAt: login === null ? null : Math.floor(login / 1000),
  };
}

export function parseEquipment(json: unknown): Gear {
  const items = obj(json).equipped_items;
  const gear: Gear = {};
  if (!Array.isArray(items)) return gear;
  for (const raw of items) {
    const it = obj(raw);
    const slot = str(obj(it.slot).type);
    const itemId = num(obj(it.item).id);
    if (!slot || itemId === null) continue;
    gear[slot] = {
      itemId,
      name: str(it.name) ?? '',
      quality: quality(it.quality),
      itemLevel: num(obj(it.level).value),
    };
  }
  return gear;
}

export function parseStatus(json: unknown): CharacterStatus {
  const o = obj(json);
  return { blizzardId: need(num(o.id), 'id'), isValid: o.is_valid === true };
}

export function parseAccountCharacters(json: unknown): AccountCharacter[] {
  const accounts = obj(json).wow_accounts;
  if (!Array.isArray(accounts)) return [];
  const out: AccountCharacter[] = [];
  for (const acct of accounts) {
    const chars = obj(acct).characters;
    if (!Array.isArray(chars)) continue;
    for (const raw of chars) {
      const c = obj(raw);
      const realm = obj(c.realm);
      const id = num(c.id);
      const name = str(c.name);
      const slug = str(realm.slug);
      const classId = num(obj(c.playable_class).id);
      const level = num(c.level);
      if (id === null || !name || !slug || classId === null || level === null) continue;
      out.push({
        blizzardId: id,
        name,
        realmSlug: slug,
        realmName: str(realm.name) ?? slug,
        classId,
        className: str(obj(c.playable_class).name) ?? '',
        raceName: str(obj(c.playable_race).name) ?? '',
        faction: faction(c.faction),
        level,
      });
    }
  }
  return out;
}

export function parseUserInfo(json: unknown): { bnetId: string; battletag: string } {
  const o = obj(json);
  const id = str(o.sub) ?? (num(o.id) === null ? null : String(o.id));
  return { bnetId: need(id, 'sub'), battletag: need(str(o.battletag), 'battletag') };
}
