/**
 * Optional modules — per-install features an operator turns on in Settings.
 *
 * Star Citizen (a game module) was the first; Gallery is the first that isn't
 * game-specific. Stored as one flags blob in settings['modules']; everything
 * defaults OFF so a fresh install ships lean. Resolved DB-over-nothing (there's
 * no env fallback — modules are purely an admin choice). Same shape as the other
 * settings-backed config so it reads consistently.
 */

import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import * as s from '../db/schema';
import type { Env } from './env';
import { EMPTY_WOW_CONFIG, WOW_REGIONS, type WowConfig, type WowRegion } from '../shared/wow';

export const MODULES_KEY = 'modules';

export interface ModuleFlags {
  starcitizen: boolean;
  gallery: boolean;
  wow: boolean;
}

type DB = ReturnType<typeof drizzle<typeof schema>>;

/** The enabled-module flags, all false unless an admin turned one on. */
export async function loadModules(env: Env, database?: DB): Promise<ModuleFlags> {
  const dbi = database ?? drizzle(env.DB, { schema });
  let stored: Record<string, unknown> = {};
  try {
    const row = await dbi.query.settings.findFirst({ where: eq(s.settings.key, MODULES_KEY) });
    if (row?.value && typeof row.value === 'object') stored = row.value as Record<string, unknown>;
  } catch {
    // No settings row/table yet → everything off.
  }
  return { starcitizen: stored.starcitizen === true, gallery: stored.gallery === true, wow: stored.wow === true };
}

/** Sanitise an incoming flags payload to exactly the known booleans. */
export function cleanModuleFlags(raw: unknown): ModuleFlags {
  const o = (raw ?? {}) as Record<string, unknown>;
  return { starcitizen: o.starcitizen === true, gallery: o.gallery === true, wow: o.wow === true };
}

/* ------------------------------------------------------------------ *
 * Star Citizen module config — settings that only matter when the SC module is
 * on. Kept in its own settings key so the module flags stay pure booleans. The
 * org SID lets account verification confirm a member's RSI profile lists THIS
 * install's org (each buyer sets their own).
 * ------------------------------------------------------------------ */

export const SC_KEY = 'sc';

export interface ScConfig {
  /** This org's RSI Spectrum Identification (SID), e.g. "F919". Case-insensitive. */
  orgSid: string;
  /**
   * Per-feature kill switches for the two things that touch RSI. Both default
   * ON; an admin can turn either off instantly (e.g. if CIG/RSI ever asks) —
   * `hangarEnabled` gates the member's own hangar import + display, and
   * `verifyEnabled` gates the account-verification profile fetch. The whole SC
   * module toggle remains the master switch above these.
   */
  hangarEnabled: boolean;
  verifyEnabled: boolean;
}

export async function loadScConfig(env: Env, database?: DB): Promise<ScConfig> {
  const dbi = database ?? drizzle(env.DB, { schema });
  let stored: Record<string, unknown> = {};
  try {
    const row = await dbi.query.settings.findFirst({ where: eq(s.settings.key, SC_KEY) });
    if (row?.value && typeof row.value === 'object') stored = row.value as Record<string, unknown>;
  } catch {
    // No settings row/table yet → no org, features default on.
  }
  return {
    orgSid: typeof stored.orgSid === 'string' ? stored.orgSid : '',
    // Absent (older config) or true ⇒ on; only an explicit false disables.
    hangarEnabled: stored.hangarEnabled !== false,
    verifyEnabled: stored.verifyEnabled !== false,
  };
}

export function cleanScConfig(raw: unknown): ScConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    orgSid: (typeof o.orgSid === 'string' ? o.orgSid : '').trim().slice(0, 20),
    hangarEnabled: o.hangarEnabled !== false,
    verifyEnabled: o.verifyEnabled !== false,
  };
}

/* ------------------------------------------------------------------ *
 * Gallery module config — the few settings that only matter once the gallery is
 * on. Its own settings key, so the module flags above stay pure booleans (same
 * split as the SC config).
 * ------------------------------------------------------------------ */

export const GALLERY_KEY = 'gallery';

export interface GalleryConfig {
  /**
   * The scroll-driven hero at the top of /gallery, which samples images from
   * PUBLIC albums only. Off → the page opens straight into the album list.
   * Defaults on; an operator with no public albums simply gets no hero, since
   * the page hides it when there's nothing safe to sample.
   */
  heroEnabled: boolean;
  /** Hero copy. Blank falls back to the page's built-in wording. */
  heroTitle: string;
  heroTagline: string;
}

export async function loadGalleryConfig(env: Env, database?: DB): Promise<GalleryConfig> {
  const dbi = database ?? drizzle(env.DB, { schema });
  let stored: Record<string, unknown> = {};
  try {
    const row = await dbi.query.settings.findFirst({ where: eq(s.settings.key, GALLERY_KEY) });
    if (row?.value && typeof row.value === 'object') stored = row.value as Record<string, unknown>;
  } catch {
    // No settings row/table yet → hero on, default copy.
  }
  return {
    // Absent (older config) or true ⇒ on; only an explicit false disables.
    heroEnabled: stored.heroEnabled !== false,
    heroTitle: typeof stored.heroTitle === 'string' ? stored.heroTitle : '',
    heroTagline: typeof stored.heroTagline === 'string' ? stored.heroTagline : '',
  };
}

export function cleanGalleryConfig(raw: unknown): GalleryConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    heroEnabled: o.heroEnabled !== false,
    heroTitle: (typeof o.heroTitle === 'string' ? o.heroTitle : '').trim().slice(0, 80),
    heroTagline: (typeof o.heroTagline === 'string' ? o.heroTagline : '').trim().slice(0, 200),
  };
}

/* ------------------------------------------------------------------ *
 * World of Warcraft module config — the site's Battle.net API client, region
 * and Blizzard data section, plus the server-owned verification and last-error
 * fields. Own settings key, like SC and Gallery. The secret lives in D1 under
 * the same accepted trade as the Discord secret (see config.ts) and is never
 * returned to a browser (publicWowConfig).
 * ------------------------------------------------------------------ */

export const WOW_KEY = 'wow';

export async function loadWowConfig(env: Env, database?: DB): Promise<WowConfig> {
  const dbi = database ?? drizzle(env.DB, { schema });
  let o: Record<string, unknown> = {};
  try {
    const row = await dbi.query.settings.findFirst({ where: eq(s.settings.key, WOW_KEY) });
    if (row?.value && typeof row.value === 'object') o = row.value as Record<string, unknown>;
  } catch {
    // No settings row/table yet → unconfigured.
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    clientId: str(o.clientId),
    clientSecret: str(o.clientSecret),
    region: WOW_REGIONS.includes(o.region as WowRegion) ? (o.region as WowRegion) : EMPTY_WOW_CONFIG.region,
    // A stored blank falls back to the built-in default, so publishing Forever's
    // namespace in code reaches installs that never typed one.
    namespace: str(o.namespace) || EMPTY_WOW_CONFIG.namespace,
    verifiedAt: num(o.verifiedAt),
    lastError: typeof o.lastError === 'string' ? o.lastError : null,
    lastErrorAt: num(o.lastErrorAt),
  };
}

export async function saveWowConfig(env: Env, cfg: WowConfig, updatedBy: number | null): Promise<void> {
  await drizzle(env.DB, { schema })
    .insert(s.settings)
    .values({ key: WOW_KEY, value: cfg, updatedBy })
    .onConflictDoUpdate({
      target: s.settings.key,
      set: { value: cfg, updatedBy, updatedAt: Math.floor(Date.now() / 1000) },
    });
}

/**
 * The config, only when the sweep and member features may run: the module is on,
 * Test connection has succeeded for these credentials, and a namespace is set.
 */
export async function wowReady(env: Env, database?: DB): Promise<WowConfig | null> {
  const [mods, cfg] = await Promise.all([loadModules(env, database), loadWowConfig(env, database)]);
  return mods.wow && cfg.verifiedAt !== null && cfg.namespace !== '' ? cfg : null;
}
