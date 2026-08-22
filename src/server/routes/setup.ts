/**
 * First-run setup wizard API — mounted at /api/setup.
 *
 * Solves the two bootstrap problems a brand-new install has (no schema, no god
 * admin, and Discord-only login that needs credentials nobody can enter yet):
 *
 *  1. /status        — always available; tells the client whether to show the
 *                      wizard or bounce to the app.
 *  2. /unlock        — verifies the SETUP_TOKEN, builds the database in-Worker
 *                      (behind the token), and mints the "unlocked" cookie.
 *  3. /identity      — saves site + Discord config to settings['identity'].
 *  4. /validate-discord — checks the bot token + guild access against Discord.
 *  5. /claim/start + /claim/callback — Discord OAuth; the person who completes it
 *                      becomes the god admin, and setup permanently closes.
 *
 * Every mutating route refuses once the install is claimed (410), so the wizard
 * can never be replayed to seize control of a live site.
 */

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq, desc } from 'drizzle-orm';
import type { AppContext } from '../env';
import * as s from '../../db/schema';
import { db } from '../middleware/auth';
import { isRateLimited } from '../rateLimit';
import {
  loadConfig,
  mergeStoredIdentity,
  ConfigValidationError,
  IDENTITY_KEY,
  type StoredIdentity,
  type StoredIdentityInput,
} from '../config';
import { ensureSchema } from '../setup/schema';
import { botInviteUrl } from '../../shared/botPermissions';
import { registerGuildCommands } from '../discord/commandDefs';
import {
  isClaimed,
  isUnlocked,
  mintSetupCookie,
  clearedSetupCookie,
  markSetupComplete,
  timingSafeEqual,
  SETUP_COOKIE,
} from '../setup/state';
import {
  authorizeUrl,
  exchangeCode,
  fetchUser,
  newState,
  stateCookie,
  clearedStateCookie,
  OAUTH_STATE_COOKIE,
} from '../auth/discord';
import { createSession, sessionCookie } from '../auth/session';

const setup = new Hono<AppContext>();

/** The absolute URL of a path on the current origin (for redirect_uri + copy blocks). */
const abs = (c: { req: { url: string } }, path: string) => new URL(path, c.req.url).toString();

/* ------------------------------------------------------------------ *
 * Status — safe to call in any state (does not mutate, never 410s).
 * ------------------------------------------------------------------ */
setup.get('/status', async (c) => {
  const database = db(c.env);
  const claimed = await isClaimed(database, c.env.DB);
  // On a claimed (live) install, reveal nothing else — the client only needs to
  // know the wizard is closed. Avoids exposing config on a running site.
  if (claimed) return c.json({ claimed: true });

  const unlocked = await isUnlocked(c.env.SESSION_SECRET, getCookie(c, SETUP_COOKIE));
  const cfg = await loadConfig(c.env);

  return c.json({
    claimed,
    tokenConfigured: !!c.env.SETUP_TOKEN,
    unlocked,
    identity: {
      siteName: cfg.siteName,
      siteUrl: cfg.siteUrl,
      discord: {
        clientId: cfg.discord.clientId,
        guildId: cfg.discord.guildId,
        publicKeySet: !!cfg.discord.publicKey,
        clientSecretSet: !!cfg.discord.clientSecret,
        botTokenSet: !!cfg.discord.botToken,
      },
    },
    urls: {
      redirect: abs(c, '/api/auth/callback'),
      claimRedirect: abs(c, '/api/setup/claim/callback'),
      interactions: abs(c, '/api/discord/interactions'),
      // Pre-scoped, least-privilege bot invite — empty until the Client ID is set.
      // The buyer must invite the bot (with applications.commands) before the
      // connection test / command registration can succeed.
      botInvite: botInviteUrl(cfg.discord.clientId),
    },
  });
});

/* ------------------------------------------------------------------ *
 * Gates for the mutating routes.
 * ------------------------------------------------------------------ */
const requireUnclaimed = async (c: any, next: any) => {
  if (await isClaimed(db(c.env), c.env.DB)) {
    return c.json({ error: 'Setup is already complete on this install.' }, 410);
  }
  return next();
};

const requireUnlocked = async (c: any, next: any) => {
  if (!(await isUnlocked(c.env.SESSION_SECRET, getCookie(c, SETUP_COOKIE)))) {
    return c.json({ error: 'Enter the setup token first.' }, 401);
  }
  return next();
};

/* ------------------------------------------------------------------ *
 * Unlock — verify the token, build the DB, mint the unlocked cookie.
 * ------------------------------------------------------------------ */
setup.post('/unlock', requireUnclaimed, async (c) => {
  if (!c.env.SETUP_TOKEN) {
    return c.json(
      {
        error:
          'No SETUP_TOKEN is set on this deployment. Add a secret named SETUP_TOKEN in your Cloudflare dashboard (Workers & Pages → your Worker → Settings → Variables), then reload this page.',
      },
      400,
    );
  }
  // A freshly-deployed-but-unclaimed instance is reachable by anyone who finds
  // its URL, and the token is buyer-chosen (so its strength isn't guaranteed) —
  // this bounds how many guesses an attacker gets before the site owner claims
  // it. Keyed by IP; checked before comparing so a flood doesn't even reach the
  // (already constant-time) comparison.
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  if (await isRateLimited(db(c.env), `setup-unlock:${ip}`, { max: 8, windowSeconds: 300 })) {
    return c.json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  }

  const body = (await c.req.json<{ token?: string }>().catch(() => ({}))) as { token?: string };
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token || !timingSafeEqual(token, c.env.SETUP_TOKEN)) {
    return c.json({ error: 'Incorrect setup token.' }, 401);
  }

  try {
    await ensureSchema(c.env.DB); // idempotent; builds schema + seed on an empty DB
  } catch (e) {
    return c.json({ error: `Database initialization failed: ${(e as Error).message}` }, 500);
  }

  c.header('Set-Cookie', await mintSetupCookie(c.env.SESSION_SECRET));
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Identity — persist site + Discord config (reuses the admin validator).
 * ------------------------------------------------------------------ */
setup.post('/identity', requireUnclaimed, requireUnlocked, async (c) => {
  const database = db(c.env);
  const body = (await c.req.json<{ identity?: StoredIdentityInput }>().catch(() => ({}))) as {
    identity?: StoredIdentityInput;
  };

  const existingRow = await database.query.settings.findFirst({ where: eq(s.settings.key, IDENTITY_KEY) });
  const existing = (existingRow?.value as StoredIdentity | undefined) ?? {};

  let clean: StoredIdentity;
  try {
    clean = mergeStoredIdentity(existing, body.identity ?? {});
  } catch (err) {
    if (err instanceof ConfigValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }

  await database
    .insert(s.settings)
    .values({ key: IDENTITY_KEY, value: clean })
    .onConflictDoUpdate({
      target: s.settings.key,
      set: { value: clean, updatedAt: Math.floor(Date.now() / 1000) },
    });

  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * Validate Discord — confirm the bot token works and can see the guild.
 * ------------------------------------------------------------------ */
setup.post('/validate-discord', requireUnclaimed, requireUnlocked, async (c) => {
  const cfg = await loadConfig(c.env);
  if (!cfg.discord.botToken || !cfg.discord.guildId) {
    return c.json({ ok: false, error: 'Save the bot token and server ID first.' }, 400);
  }
  const auth = { Authorization: `Bot ${cfg.discord.botToken}` };
  try {
    const me = await fetch('https://discord.com/api/v10/users/@me', { headers: auth });
    if (!me.ok) return c.json({ ok: false, error: `Discord rejected the bot token (HTTP ${me.status}).` });
    const bot = (await me.json()) as { username?: string };

    const g = await fetch(`https://discord.com/api/v10/guilds/${cfg.discord.guildId}`, { headers: auth });
    if (!g.ok) {
      return c.json({
        ok: false,
        error: `Bot token is valid, but it can't see server ${cfg.discord.guildId} — is the bot invited to it? (HTTP ${g.status})`,
      });
    }
    const guild = (await g.json()) as { name?: string };

    // The bot works and can see the guild — register its slash commands now, so
    // the buyer's /whois, /roster, /event, … work the moment setup finishes. A
    // registration failure (usually: bot lacks the applications.commands scope)
    // is reported but does NOT fail the connection test — the fix is a re-invite.
    const reg = await registerGuildCommands(cfg.discord.clientId, cfg.discord.guildId, cfg.discord.botToken);

    return c.json({
      ok: true,
      bot: bot.username ?? 'bot',
      guild: guild.name ?? cfg.discord.guildId,
      commands: reg.ok
        ? { ok: true, count: reg.count }
        : { ok: false, error: reg.error },
    });
  } catch (e) {
    return c.json({ ok: false, error: `Could not reach Discord: ${(e as Error).message}` });
  }
});

/* ------------------------------------------------------------------ *
 * Claim ownership via Discord OAuth. The first person to complete this
 * becomes the god admin; setup then closes permanently.
 * ------------------------------------------------------------------ */
setup.get('/claim/start', async (c) => {
  if (await isClaimed(db(c.env), c.env.DB)) return c.redirect('/login');
  if (!(await isUnlocked(c.env.SESSION_SECRET, getCookie(c, SETUP_COOKIE)))) {
    return c.redirect('/setup?error=locked');
  }
  const { discord } = await loadConfig(c.env);
  if (!discord.clientId || !discord.clientSecret) return c.redirect('/setup?error=discord');

  const state = newState();
  c.header('Set-Cookie', stateCookie(state));
  return c.redirect(authorizeUrl(discord.clientId, abs(c, '/api/setup/claim/callback'), state));
});

setup.get('/claim/callback', async (c) => {
  const database = db(c.env);
  if (await isClaimed(database, c.env.DB)) return c.redirect('/login'); // someone already claimed
  if (!(await isUnlocked(c.env.SESSION_SECRET, getCookie(c, SETUP_COOKIE)))) {
    return c.redirect('/setup?error=locked');
  }

  const discordError = c.req.query('error');
  if (discordError) return c.redirect(`/setup?error=discord&detail=${encodeURIComponent(discordError)}`);

  const code = c.req.query('code');
  const state = c.req.query('state');
  const expected = getCookie(c, OAUTH_STATE_COOKIE);
  if (!code || !state || !expected || state !== expected) return c.redirect('/setup?error=state');

  const { discord } = await loadConfig(c.env);
  const token = await exchangeCode(discord.clientId, discord.clientSecret, code, abs(c, '/api/setup/claim/callback'));
  const discordUser = await fetchUser(token.access_token);

  // Mint the owner: highest rank + the Command role, god flag on.
  const topRank = await database.query.ranks.findFirst({ orderBy: [desc(s.ranks.sortOrder)] });
  const commandRole = await database.query.roles.findFirst({ where: eq(s.roles.name, 'Command') });
  const now = Math.floor(Date.now() / 1000);

  const existing = await database.query.users.findFirst({ where: eq(s.users.discordId, discordUser.id) });
  let userId: number;
  if (existing) {
    await database
      .update(s.users)
      .set({
        username: discordUser.username,
        globalName: discordUser.global_name,
        avatar: discordUser.avatar,
        email: discordUser.email ?? existing.email,
        isGod: true,
        status: 'active',
        rankId: existing.rankId ?? topRank?.id ?? null,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(eq(s.users.id, existing.id));
    userId = existing.id;
  } else {
    const inserted = await database
      .insert(s.users)
      .values({
        discordId: discordUser.id,
        username: discordUser.username,
        globalName: discordUser.global_name,
        avatar: discordUser.avatar,
        email: discordUser.email ?? null,
        isGod: true,
        status: 'active',
        rankId: topRank?.id ?? null,
      })
      .returning({ id: s.users.id });
    userId = inserted[0]!.id;
  }

  if (commandRole) {
    await database
      .insert(s.userRoles)
      .values({ userId, roleId: commandRole.id })
      .onConflictDoNothing();
  }

  await markSetupComplete(database, userId);
  await database.insert(s.auditLog).values({
    actorId: userId,
    action: 'setup.claim',
    targetType: 'user',
    targetId: String(userId),
    meta: { via: 'setup-wizard' },
    source: 'system',
  });

  // Safety net: if the owner skipped the "test Discord" step, their slash
  // commands were never registered. Do it now (best-effort — never throws, and
  // must not block a successful claim). It's a no-op if it already ran.
  if (discord.clientId && discord.guildId && discord.botToken) {
    await registerGuildCommands(discord.clientId, discord.guildId, discord.botToken);
  }

  // Log the owner straight in, and clear the setup + oauth-state cookies.
  const session = await createSession(database, userId, {
    userAgent: c.req.header('user-agent') ?? null,
    ip: c.req.header('cf-connecting-ip') ?? null,
  });
  c.header('Set-Cookie', sessionCookie(session.token, 60 * 60 * 24 * 30));
  c.header('Set-Cookie', clearedSetupCookie, { append: true });
  c.header('Set-Cookie', clearedStateCookie, { append: true });
  return c.redirect('/admin');
});

export default setup;
