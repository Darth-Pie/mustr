/**
 * World of Warcraft module — the shared vocabulary.
 *
 * Types and constants used by both the Worker (Blizzard client, sweep, records)
 * and the client (profile journey, the Leveling page). Pure on purpose: nothing
 * here imports drizzle, Hono or the Worker env, so the unit tests under test/
 * can import it straight into Node.
 */

export type WowRegion = 'us' | 'eu' | 'kr' | 'tw';
export const WOW_REGIONS: readonly WowRegion[] = ['us', 'eu', 'kr', 'tw'];

/* ------------------------------------------------------------------ *
 * Items
 * ------------------------------------------------------------------ */

export type ItemQuality = 'POOR' | 'COMMON' | 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY' | 'ARTIFACT' | 'HEIRLOOM';

/** Lowest first. */
export const QUALITY_ORDER: readonly ItemQuality[] = [
  'POOR',
  'COMMON',
  'UNCOMMON',
  'RARE',
  'EPIC',
  'LEGENDARY',
  'ARTIFACT',
  'HEIRLOOM',
];

export function qualityAtLeast(q: ItemQuality, min: ItemQuality): boolean {
  return QUALITY_ORDER.indexOf(q) >= QUALITY_ORDER.indexOf(min);
}

/** The in-game item colours, used for item names on the journey. */
export const QUALITY_COLORS: Record<ItemQuality, string> = {
  POOR: '#9d9d9d',
  COMMON: '#ffffff',
  UNCOMMON: '#1eff00',
  RARE: '#0070dd',
  EPIC: '#a335ee',
  LEGENDARY: '#ff8000',
  ARTIFACT: '#e6cc80',
  HEIRLOOM: '#00ccff',
};

export interface GearItem {
  itemId: number;
  name: string;
  quality: ItemQuality;
  itemLevel: number | null;
}

/** Equipped items keyed by Blizzard's slot type, e.g. 'HEAD', 'MAIN_HAND'. */
export type Gear = Record<string, GearItem>;

/** Paper-doll order, so timeline rows from one check always come out the same way. */
export const SLOT_ORDER: readonly string[] = [
  'HEAD',
  'NECK',
  'SHOULDER',
  'BACK',
  'CHEST',
  'SHIRT',
  'TABARD',
  'WRIST',
  'HANDS',
  'WAIST',
  'LEGS',
  'FEET',
  'FINGER_1',
  'FINGER_2',
  'TRINKET_1',
  'TRINKET_2',
  'MAIN_HAND',
  'OFF_HAND',
  'RANGED',
];

/* ------------------------------------------------------------------ *
 * Characters, as read from Blizzard
 * ------------------------------------------------------------------ */

export interface CharacterSummary {
  blizzardId: number;
  name: string;
  realmSlug: string;
  realmName: string;
  classId: number;
  className: string;
  raceName: string;
  faction: 'ALLIANCE' | 'HORDE';
  level: number;
  itemLevel: number | null;
  guildName: string | null;
  /** Blizzard's last-logout time, unix seconds. */
  lastLoginAt: number | null;
}

/** A character as listed on the member's own Battle.net account. */
export interface AccountCharacter {
  blizzardId: number;
  name: string;
  realmSlug: string;
  realmName: string;
  classId: number;
  className: string;
  raceName: string;
  faction: 'ALLIANCE' | 'HORDE';
  level: number;
}

export interface CharacterStatus {
  blizzardId: number;
  isValid: boolean;
}

/* ------------------------------------------------------------------ *
 * Badges, levels and records
 * ------------------------------------------------------------------ */

export type BadgeKey = 'first_rare' | 'first_epic' | 'all_rare' | 'week_of_grind' | 'steady_climber';

export const BADGE_ORDER: readonly BadgeKey[] = ['first_rare', 'first_epic', 'all_rare', 'week_of_grind', 'steady_climber'];

export const BADGES: Record<BadgeKey, { name: string; description: string }> = {
  first_rare: { name: 'First blue', description: 'Equipped a rare item or better.' },
  first_epic: { name: 'First purple', description: 'Equipped an epic item or better.' },
  all_rare: { name: 'All in blue', description: 'Every gear slot filled with rare or better.' },
  week_of_grind: { name: 'Week of the grind', description: 'Gained ten levels within seven days.' },
  steady_climber: { name: 'Steady climber', description: 'Gained a level seven days in a row.' },
};

export const MILESTONES: readonly number[] = [10, 20, 30, 40, 50, 60];
export const MAX_LEVEL = 60;

/** Blizzard only reports logouts, so anyone within two hours of the first shares it. */
export const TIE_WINDOW_SECONDS = 7200;

/** The in-game class colours, by Blizzard class id. */
export const CLASS_COLORS: Record<number, string> = {
  1: '#C69B6D', // Warrior
  2: '#F48CBA', // Paladin
  3: '#AAD372', // Hunter
  4: '#FFF468', // Rogue
  5: '#FFFFFF', // Priest
  7: '#0070DD', // Shaman
  8: '#3FC7EB', // Mage
  9: '#8788EE', // Warlock
  11: '#FF7C0A', // Druid
};

/** For a class this table doesn't know yet (Forever may add one). */
export const FALLBACK_CLASS_COLOR = '#c8b88a';

/**
 * One level a character was seen reaching. The level was gained somewhere
 * between `sinceAt` (the previous logout) and `seenAt` (this logout).
 */
export interface LevelRow {
  level: number;
  seenAt: number;
  sinceAt: number | null;
}

/* ------------------------------------------------------------------ *
 * Module config — the site's own Battle.net API client
 *
 * Stored in settings['wow']. Each site registers its own client at
 * develop.battle.net, as it does its own Discord app, so the operator is
 * Blizzard's licensee. The secret never goes back to a browser.
 * ------------------------------------------------------------------ */

/**
 * Blizzard's profile namespace for WoW: Forever, without the region suffix.
 * Unpublished as of 2026-10-24; empty means "not set" and keeps the sweep idle.
 * Set it here once Blizzard documents it. Admins can enter 'profile-classic1x'
 * meanwhile to test against Classic Era.
 */
export const DEFAULT_WOW_NAMESPACE = '';

export interface WowConfig {
  clientId: string;
  clientSecret: string;
  region: WowRegion;
  namespace: string;
  /** When Test connection last succeeded with these exact credentials. */
  verifiedAt: number | null;
  /** The last error the sweep or Test connection hit, for the admin card. */
  lastError: string | null;
  lastErrorAt: number | null;
}

export const EMPTY_WOW_CONFIG: WowConfig = {
  clientId: '',
  clientSecret: '',
  region: 'us',
  namespace: DEFAULT_WOW_NAMESPACE,
  verifiedAt: null,
  lastError: null,
  lastErrorAt: null,
};

const NAMESPACE_RE = /^[a-z0-9-]{1,64}$/;

/**
 * Sanitise an admin's edit. A blank secret keeps the stored one (the form never
 * sees it). Any change to what Blizzard is asked with drops the verification,
 * so the module can't stay switched on with credentials nobody has tested.
 * Status fields are server-owned and never read from the input.
 */
export function cleanWowConfig(raw: unknown, previous: WowConfig): WowConfig {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const clientId = 'clientId' in o ? text(o.clientId, 128) : previous.clientId;
  const secretIn = text(o.clientSecret, 256);
  const clientSecret = secretIn || previous.clientSecret;
  const region = WOW_REGIONS.includes(o.region as WowRegion) ? (o.region as WowRegion) : 'region' in o ? 'us' : previous.region;
  const nsIn = 'namespace' in o ? text(o.namespace, 1000).toLowerCase() : previous.namespace;
  const namespace = nsIn === '' || NAMESPACE_RE.test(nsIn) ? nsIn : '';
  const unchanged =
    clientId === previous.clientId &&
    clientSecret === previous.clientSecret &&
    region === previous.region &&
    namespace === previous.namespace;
  return {
    clientId,
    clientSecret,
    region,
    namespace,
    verifiedAt: unchanged ? previous.verifiedAt : null,
    lastError: previous.lastError,
    lastErrorAt: previous.lastErrorAt,
  };
}

export type PublicWowConfig = Omit<WowConfig, 'clientSecret'> & { hasSecret: boolean };

export function publicWowConfig(cfg: WowConfig): PublicWowConfig {
  const { clientSecret, ...rest } = cfg;
  return { ...rest, hasSecret: clientSecret.length > 0 };
}
