/**
 * Runtime configuration — the layer that lets an operator reconfigure Discord
 * and site identity from the admin panel (or a first-run setup wizard) instead
 * of editing wrangler.jsonc and redeploying.
 *
 * Resolution is DB-over-env: a value saved in settings['identity'] wins; when it
 * is blank or unset, the wrangler var/secret in `env` is used. So a fresh,
 * env-only deploy keeps working, and the moment someone saves config in the UI
 * it takes effect without a redeploy. This is the seam that makes the product
 * deployable by other groups: they set their own Discord app + domain here.
 *
 * SECURITY: the stored blob can hold secrets (Discord client secret, bot token).
 * They live in D1, so they are readable by anything with DB access and by god
 * admins — unlike wrangler secrets, which are encrypted and unreadable. That is
 * an accepted trade for self-serve configuration; the admin API never echoes a
 * secret value back to a client (presence only). See settings.get('/identity').
 */

import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import * as s from '../db/schema';
import type { Env } from './env';
import { DiscordRest } from './discord/rest';
import { sanitizeSiteSigil } from '../shared/sigil';

/** settings key under which the identity/Discord blob is stored. */
export const IDENTITY_KEY = 'identity';

export interface DiscordConfig {
  clientId: string;
  guildId: string;
  publicKey: string;
  clientSecret: string;
  botToken: string;
}

export interface AppConfig {
  siteName: string;
  siteUrl: string;
  discord: DiscordConfig;
  /** Hosted PNG of the org's Sigil Forge mark, but only when the sigil is
   *  enabled — blank otherwise. Used as static brand art (Discord embed
   *  thumbnails, OG image fallback). Same-origin "/media/…" path. */
  siteSigilPng: string;
  /** Animated (GIF) form of the same mark, when one has been rendered. Discord
   *  embeds animate it; still-image consumers (OG/link previews) use the PNG. */
  siteSigilGif: string;
}

/** The shape persisted in settings['identity']. Every field optional — a blank
 *  or missing value falls through to the matching env var in loadConfig(). */
export interface StoredIdentity {
  siteName?: string;
  siteUrl?: string;
  discord?: Partial<DiscordConfig>;
}

type DB = ReturnType<typeof drizzle<typeof schema>>;

/** First non-empty (after trim) of the candidates, else ''. */
function firstNonEmpty(...vals: (string | undefined | null)[]): string {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
}

/**
 * Resolve the effective configuration: DB overrides (settings['identity']) first,
 * then the env fallbacks. Never throws — a missing row or table (first boot)
 * degrades cleanly to "env only".
 */
export async function loadConfig(env: Env, database?: DB): Promise<AppConfig> {
  const dbi = database ?? drizzle(env.DB, { schema });
  let stored: StoredIdentity = {};
  try {
    const row = await dbi.query.settings.findFirst({ where: eq(s.settings.key, IDENTITY_KEY) });
    if (row?.value && typeof row.value === 'object') stored = row.value as StoredIdentity;
  } catch {
    // No settings row/table yet (fresh install) → fall back to env entirely.
  }
  // The org's sigil PNG, but only while the sigil is enabled (so turning the
  // sigil on/off toggles all its brand-kit surfaces together). Never throws.
  let siteSigilPng = '';
  let siteSigilGif = '';
  try {
    const srow = await dbi.query.settings.findFirst({ where: eq(s.settings.key, 'sigil') });
    if (srow?.value) {
      const sg = sanitizeSiteSigil(srow.value);
      if (sg.enabled) { siteSigilPng = sg.pngUrl; siteSigilGif = sg.gifUrl; }
    }
  } catch {
    // no settings row/table yet
  }

  const d = stored.discord ?? {};
  return {
    siteName: firstNonEmpty(stored.siteName, env.SITE_NAME, 'mustr'),
    siteUrl: firstNonEmpty(stored.siteUrl, env.SITE_URL),
    siteSigilPng,
    siteSigilGif,
    discord: {
      clientId: firstNonEmpty(d.clientId, env.DISCORD_CLIENT_ID),
      guildId: firstNonEmpty(d.guildId, env.DISCORD_GUILD_ID),
      publicKey: firstNonEmpty(d.publicKey, env.DISCORD_PUBLIC_KEY),
      clientSecret: firstNonEmpty(d.clientSecret, env.DISCORD_CLIENT_SECRET),
      botToken: firstNonEmpty(d.botToken, env.DISCORD_BOT_TOKEN),
    },
  };
}

/** Build a bot REST client from resolved config, or null when the bot isn't set up. */
export function discordRestFromConfig(cfg: AppConfig): DiscordRest | null {
  if (!cfg.discord.botToken || !cfg.discord.guildId) return null;
  return new DiscordRest(cfg.discord.botToken, cfg.discord.guildId);
}

/**
 * Resolve config and build the bot client in one step. Replaces the ~nine
 * duplicated `env.DISCORD_BOT_TOKEN && env.DISCORD_GUILD_ID ? new DiscordRest(…)`
 * blocks, so every surface (web routes, cron, background) reads the same config.
 */
export async function discordClient(env: Env, database?: DB): Promise<DiscordRest | null> {
  return discordRestFromConfig(await loadConfig(env, database));
}

/** Thrown by mergeStoredIdentity on malformed input; the route maps it to 400. */
export class ConfigValidationError extends Error {}

/** Raw client payload for a config save — every field untrusted. */
export interface StoredIdentityInput {
  siteName?: unknown;
  siteUrl?: unknown;
  discord?: {
    clientId?: unknown;
    guildId?: unknown;
    publicKey?: unknown;
    clientSecret?: unknown;
    botToken?: unknown;
  };
}

function trimmed(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/**
 * Validate a config update and merge it onto what's stored. Semantics:
 *  - Non-secret fields are stored as given; a blank clears the override (so the
 *    env value shows through again). Blanks are harmless — loadConfig() skips
 *    empty strings.
 *  - Secret fields (clientSecret, botToken) are write-only from the UI: the form
 *    only ever knows whether one is set, never its value. A non-empty value
 *    replaces the stored secret; a blank LEAVES THE EXISTING SECRET INTACT.
 * Malformed non-empty ids/keys throw ConfigValidationError rather than silently
 * corrupting the config.
 */
export function mergeStoredIdentity(
  existing: StoredIdentity,
  incoming: StoredIdentityInput,
): StoredIdentity {
  const inD = incoming.discord ?? {};
  const exD = existing.discord ?? {};

  const siteName = trimmed(incoming.siteName, 80);
  const siteUrl = trimmed(incoming.siteUrl, 200);
  if (siteUrl && !/^https?:\/\//i.test(siteUrl)) {
    throw new ConfigValidationError('Site URL must start with http:// or https://.');
  }

  const clientId = trimmed(inD.clientId, 40);
  const guildId = trimmed(inD.guildId, 40);
  const publicKey = trimmed(inD.publicKey, 100);

  const snowflakeOk = (v: string) => v === '' || /^\d{5,25}$/.test(v);
  if (!snowflakeOk(clientId)) throw new ConfigValidationError('Discord Client ID must be numeric.');
  if (!snowflakeOk(guildId)) throw new ConfigValidationError('Discord Server (Guild) ID must be numeric.');
  if (!(publicKey === '' || /^[0-9a-fA-F]{64}$/.test(publicKey))) {
    throw new ConfigValidationError('Discord Public Key must be 64 hexadecimal characters.');
  }

  // Secrets: only overwrite when a fresh non-empty value arrives.
  const clientSecretIn = trimmed(inD.clientSecret, 200);
  const botTokenIn = trimmed(inD.botToken, 200);

  return {
    siteName,
    siteUrl,
    discord: {
      clientId,
      guildId,
      publicKey,
      clientSecret: clientSecretIn || exD.clientSecret || '',
      botToken: botTokenIn || exD.botToken || '',
    },
  };
}

/* ------------------------------------------------------------------ *
 * Analytics — the Cloudflare account/token/script/db the usage dashboard
 * queries for live request & query rates. Same DB-over-env pattern as
 * identity, so an operator can wire up (or fix) their own analytics from the
 * admin panel instead of `wrangler secret put` + redeploy.
 * ------------------------------------------------------------------ */

/** settings key under which the analytics blob is stored. */
export const ANALYTICS_KEY = 'analytics';

// Fallback defaults for this install — the worker name and D1 database id from
// wrangler.jsonc. Another group's deploy overrides these in the Analytics panel.
const DEFAULT_SCRIPT_NAME = 'clantek';
const DEFAULT_D1_DATABASE_ID = '19d7ebe6-e379-411b-8597-17b630cb8394';

export interface AnalyticsConfig {
  /** Cloudflare account id (not secret — appears in dashboard URLs). */
  accountId: string;
  /** Read-only "Account Analytics: Read" API token (secret). */
  apiToken: string;
  /** Worker script name whose invocations are counted. */
  scriptName: string;
  /** D1 database id whose rows-read/written are counted. */
  d1DatabaseId: string;
}

/** Persisted shape in settings['analytics']. Blank/missing → env or default. */
export interface StoredAnalytics {
  accountId?: string;
  apiToken?: string;
  scriptName?: string;
  d1DatabaseId?: string;
}

/** Resolve analytics config: DB overrides first, then env vars, then defaults. */
export async function loadAnalytics(env: Env, database?: DB): Promise<AnalyticsConfig> {
  const dbi = database ?? drizzle(env.DB, { schema });
  let stored: StoredAnalytics = {};
  try {
    const row = await dbi.query.settings.findFirst({ where: eq(s.settings.key, ANALYTICS_KEY) });
    if (row?.value && typeof row.value === 'object') stored = row.value as StoredAnalytics;
  } catch {
    // No settings row/table yet → env/defaults only.
  }
  return {
    accountId: firstNonEmpty(stored.accountId, env.CLOUDFLARE_ACCOUNT_ID),
    apiToken: firstNonEmpty(stored.apiToken, env.CLOUDFLARE_API_TOKEN),
    scriptName: firstNonEmpty(stored.scriptName, DEFAULT_SCRIPT_NAME),
    d1DatabaseId: firstNonEmpty(stored.d1DatabaseId, DEFAULT_D1_DATABASE_ID),
  };
}

/** Raw client payload for an analytics save — every field untrusted. */
export interface StoredAnalyticsInput {
  accountId?: unknown;
  apiToken?: unknown;
  scriptName?: unknown;
  d1DatabaseId?: unknown;
}

/**
 * Validate and merge an analytics update. Non-secret fields store as given
 * (blank clears the override); the apiToken is write-only (blank keeps existing).
 */
export function mergeStoredAnalytics(
  existing: StoredAnalytics,
  incoming: StoredAnalyticsInput,
): StoredAnalytics {
  const accountId = trimmed(incoming.accountId, 40);
  const scriptName = trimmed(incoming.scriptName, 64);
  const d1DatabaseId = trimmed(incoming.d1DatabaseId, 64);
  const apiTokenIn = trimmed(incoming.apiToken, 200);

  if (accountId && !/^[0-9a-fA-F]{32}$/.test(accountId)) {
    throw new ConfigValidationError('Cloudflare Account ID must be 32 hexadecimal characters.');
  }
  if (scriptName && !/^[a-zA-Z0-9_-]{1,64}$/.test(scriptName)) {
    throw new ConfigValidationError('Worker name may only contain letters, numbers, hyphens and underscores.');
  }
  if (d1DatabaseId && !/^[0-9a-fA-F-]{36}$/.test(d1DatabaseId)) {
    throw new ConfigValidationError('D1 Database ID must be a 36-character UUID.');
  }

  return {
    accountId,
    scriptName,
    d1DatabaseId,
    apiToken: apiTokenIn || existing.apiToken || '',
  };
}
