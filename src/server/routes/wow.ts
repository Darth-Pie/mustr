/**
 * World of Warcraft module routes.
 *
 * Member routes (linking, choosing characters, reading a profile's characters)
 * sit behind `requireWowModule`, which 404s while the module is off. It is
 * attached per route rather than with `use('*')` so the /admin/* routes stay
 * reachable: an admin must save and test the Battle.net key before the module
 * can be switched on.
 *
 * The Battle.net sign-in token is used inside the callback to list the member's
 * characters and is never written anywhere — not to D1, a cookie, or a log.
 */

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { and, desc, eq, inArray } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { AppContext } from '../env';
import { db, requireAuth, requirePermission } from '../middleware/auth';
import { loadModules, loadWowConfig, saveWowConfig } from '../modules';
import { newState } from '../auth/discord';
import { appToken, authorizeUrl, BnetError, exchangeCode, fetchAccountCharacters, fetchUserInfo } from '../wow/bnet';
import { settingsTokenStore } from '../wow/poll';
import { planFollow } from '../wow/follow';
import { createWowMedals } from '../medals/wow';
import { computeRace, pickCounted } from '../wow/records';
import { loadRaceCharacters } from '../wow/race';
import { loadPageAccess } from '../pageAccess';
import { cleanWowConfig, publicWowConfig } from '../../shared/wow';
import type {
  AccountCandidate,
  BadgeKey,
  CharacterCard,
  ItemQuality,
  MemberWowData,
  RaceData,
  TimelineEntry,
} from '../../shared/wow';

const wow = new Hono<AppContext>();

const STATE_COOKIE = 'wow_oauth_state';
const stateCookie = (v: string, maxAge: number) =>
  `${STATE_COOKIE}=${v}; Path=/api/wow; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** 404 unless the World of Warcraft module is on. Runs before auth on purpose. */
const requireWowModule = createMiddleware<AppContext>(async (c, next) => {
  if (!(await loadModules(c.env, db(c.env))).wow) return c.json({ error: 'Not found' }, 404);
  await next();
});

const callbackUrl = (reqUrl: string) => new URL('/api/wow/link/callback', reqUrl).toString();

/* ------------------------------------------------------------------ *
 * Linking
 * ------------------------------------------------------------------ */

wow.get('/link/start', requireWowModule, requireAuth, async (c) => {
  const viewer = c.get('viewer')!;
  const cfg = await loadWowConfig(c.env, db(c.env));
  if (!cfg.clientId || cfg.verifiedAt === null) return c.redirect(`/members/${viewer.id}?wow=error&reason=blizzard`);
  const state = newState();
  c.header('Set-Cookie', stateCookie(state, 600));
  return c.redirect(authorizeUrl(cfg, callbackUrl(c.req.url), state));
});

wow.get('/link/callback', requireWowModule, requireAuth, async (c) => {
  const viewer = c.get('viewer')!;
  c.header('Set-Cookie', stateCookie('', 0));
  const back = (q: string) => c.redirect(`/members/${viewer.id}?wow=${q}`);

  if (c.req.query('error')) return back('error&reason=denied');
  const code = c.req.query('code');
  const state = c.req.query('state');
  const expected = getCookie(c, STATE_COOKIE);
  if (!code || !state || !expected || state !== expected) return back('error&reason=state');

  const database = db(c.env);
  const cfg = await loadWowConfig(c.env, database);

  let bnetId: string;
  let battletag: string;
  let chars: Awaited<ReturnType<typeof fetchAccountCharacters>>;
  try {
    const userToken = await exchangeCode(cfg, code, callbackUrl(c.req.url));
    ({ bnetId, battletag } = await fetchUserInfo(userToken));
    chars = await fetchAccountCharacters(cfg, userToken);
  } catch (err) {
    console.error('WoW link failed:', err instanceof Error ? err.message : 'unknown error');
    return back('error&reason=blizzard');
  }

  const taken = await database.query.wowLinks.findFirst({ where: eq(s.wowLinks.bnetId, bnetId) });
  if (taken && taken.userId !== viewer.id) return back('error&reason=conflict');
  if (!chars.length) return back('error&reason=none');

  const existing = await database
    .select({ id: s.wowCharacters.id, userId: s.wowCharacters.userId, blizzardId: s.wowCharacters.blizzardId })
    .from(s.wowCharacters)
    .where(
      and(
        eq(s.wowCharacters.region, cfg.region),
        inArray(
          s.wowCharacters.blizzardId,
          chars.map((ch) => ch.blizzardId),
        ),
      ),
    );
  const byBlizzardId = new Map(existing.map((e) => [e.blizzardId, e]));

  const writes = [];
  writes.push(
    database
      .insert(s.wowLinks)
      .values({ userId: viewer.id, bnetId, battletag })
      .onConflictDoUpdate({
        target: s.wowLinks.userId,
        set: { bnetId, battletag, linkedAt: Math.floor(Date.now() / 1000) },
      }),
  );
  for (const ch of chars) {
    const fields = {
      realmSlug: ch.realmSlug,
      realmName: ch.realmName,
      name: ch.name,
      classId: ch.classId,
      className: ch.className,
      raceName: ch.raceName,
      faction: ch.faction,
    };
    const row = byBlizzardId.get(ch.blizzardId);
    if (!row) {
      writes.push(
        database
          .insert(s.wowCharacters)
          .values({ ...fields, userId: viewer.id, region: cfg.region, blizzardId: ch.blizzardId, level: ch.level }),
      );
    } else if (row.userId === viewer.id) {
      // Refresh the listing details; level and history belong to the sweep.
      writes.push(database.update(s.wowCharacters).set(fields).where(eq(s.wowCharacters.id, row.id)));
    }
    // A row owned by another member is left alone; its status checks settle it.
  }
  await database.batch(writes as [(typeof writes)[number], ...(typeof writes)[number][]]);
  return back('choose');
});

wow.post('/characters/follow', requireWowModule, requireAuth, async (c) => {
  const viewer = c.get('viewer')!;
  const body = await c.req.json<{ follow?: unknown; main?: unknown }>().catch(() => ({}) as { follow?: unknown; main?: unknown });
  const follow = Array.isArray(body.follow) ? body.follow.filter((v): v is number => Number.isInteger(v)) : [];
  const main = Number.isInteger(body.main) ? (body.main as number) : null;

  const database = db(c.env);
  const owned = await database
    .select({ id: s.wowCharacters.id, followed: s.wowCharacters.followed, level: s.wowCharacters.level })
    .from(s.wowCharacters)
    .where(eq(s.wowCharacters.userId, viewer.id));
  const plan = planFollow(owned, follow, main);
  if ('error' in plan) return c.json({ error: plan.error }, 400);

  const writes = [];
  for (const ch of owned) {
    if (plan.deleteIds.includes(ch.id)) {
      writes.push(database.delete(s.wowCharacters).where(eq(s.wowCharacters.id, ch.id)));
    } else {
      writes.push(
        database
          .update(s.wowCharacters)
          .set({ followed: plan.follow.includes(ch.id), isMain: ch.id === plan.main })
          .where(eq(s.wowCharacters.id, ch.id)),
      );
    }
  }
  if (writes.length) await database.batch(writes as [(typeof writes)[number], ...(typeof writes)[number][]]);
  return c.json({ ok: true, main: plan.main });
});

wow.delete('/link', requireWowModule, requireAuth, async (c) => {
  const viewer = c.get('viewer')!;
  const database = db(c.env);
  await database.batch([
    database.delete(s.wowCharacters).where(eq(s.wowCharacters.userId, viewer.id)),
    database.delete(s.wowLinks).where(eq(s.wowLinks.userId, viewer.id)),
  ]);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * A member's characters, for their profile
 * ------------------------------------------------------------------ */

wow.get('/members/:userId', requireWowModule, requireAuth, async (c) => {
  const viewer = c.get('viewer')!;
  const userId = Number(c.req.param('userId'));
  if (!Number.isInteger(userId)) return c.json({ error: 'Not found' }, 404);
  const self = viewer.id === userId;
  const database = db(c.env);

  const [link, rows] = await Promise.all([
    database.query.wowLinks.findFirst({ where: eq(s.wowLinks.userId, userId) }),
    database.select().from(s.wowCharacters).where(eq(s.wowCharacters.userId, userId)),
  ]);

  const followed = rows
    .filter((r) => r.followed)
    .sort((a, b) => Number(b.isMain) - Number(a.isMain) || b.level - a.level || a.id - b.id);
  const characters: CharacterCard[] = followed.map((r) => ({
    id: r.id,
    name: r.name,
    realmName: r.realmName,
    classId: r.classId,
    className: r.className,
    raceName: r.raceName,
    level: r.level,
    itemLevel: r.itemLevel,
    guildName: r.guildName,
    isMain: r.isMain,
    lastLoginAt: r.lastLoginAt,
  }));

  const timeline: Record<number, TimelineEntry[]> = {};
  if (followed.length) {
    const entries = await database
      .select()
      .from(s.wowTimeline)
      .where(
        inArray(
          s.wowTimeline.characterId,
          followed.map((r) => r.id),
        ),
      )
      .orderBy(desc(s.wowTimeline.seenAt), desc(s.wowTimeline.id));
    for (const e of entries) {
      (timeline[e.characterId] ??= []).push({
        kind: e.kind,
        level: e.level,
        itemName: e.itemName,
        itemQuality: e.itemQuality as ItemQuality | null,
        itemLevel: e.itemLevel,
        slot: e.slot,
        tag: e.tag as TimelineEntry['tag'],
        guildName: e.guildName,
        badgeKey: e.badgeKey as BadgeKey | null,
        seenAt: e.seenAt,
        sinceAt: e.sinceAt,
      });
    }
  }

  const candidates: AccountCandidate[] = self
    ? rows
        .sort((a, b) => b.level - a.level || a.id - b.id)
        .map((r) => ({
          id: r.id,
          name: r.name,
          realmName: r.realmName,
          className: r.className,
          level: r.level,
          followed: r.followed,
          isMain: r.isMain,
        }))
    : [];

  const body: MemberWowData = {
    linked: !!link,
    battletag: self ? (link?.battletag ?? null) : null,
    characters,
    timeline,
    candidates,
  };
  return c.json(body);
});

/* ------------------------------------------------------------------ *
 * The level race, for the Leveling page. Members-only unless an admin made
 * the page public (page access 'leveling'), like News.
 * ------------------------------------------------------------------ */

wow.get('/race', requireWowModule, async (c) => {
  const database = db(c.env);
  if (c.get('viewer') == null && (await loadPageAccess(c.env, database)).leveling !== 'public') {
    return c.json({ error: 'Authentication required' }, 401);
  }
  const alts = c.req.query('alts') === '1';
  const rows = await loadRaceCharacters(database);
  const counted = pickCounted(rows, alts) as typeof rows;
  const now = Math.floor(Date.now() / 1000);
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const itemLevels = counted.map((r) => r.card.itemLevel).filter((v): v is number => v !== null);

  const body: RaceData = {
    summary: {
      members: new Set(rows.map((r) => r.userId)).size,
      avgLevel: mean(counted.map((r) => r.level)) ?? 0,
      avgItemLevel: mean(itemLevels),
      activeThisWeek: counted.filter((r) => (r.card.lastLoginAt ?? 0) >= now - 7 * 86400).length,
    },
    characters: counted.map((r) => ({ ...r.card, memberName: r.memberName })),
    records: computeRace(rows, alts),
    series: counted.map((r) => ({
      characterId: r.characterId,
      points: [
        ...(r.trackedSince !== null && r.baselineLevel !== null ? [{ t: r.trackedSince, level: r.baselineLevel }] : []),
        ...r.levels.map((l) => ({ t: l.seenAt, level: l.level })),
      ],
    })),
  };
  return c.json(body);
});

/* ------------------------------------------------------------------ *
 * Admin — reachable while the module is off (no requireWowModule)
 * ------------------------------------------------------------------ */

wow.get('/admin/config', requirePermission('settings.manage'), async (c) => {
  const cfg = await loadWowConfig(c.env, db(c.env));
  return c.json({ wow: publicWowConfig(cfg), redirectUri: callbackUrl(c.req.url) });
});

wow.put('/admin/config', requirePermission('settings.manage'), async (c) => {
  const body = await c.req.json<{ wow?: unknown }>().catch(() => ({}) as { wow?: unknown });
  const prev = await loadWowConfig(c.env, db(c.env));
  const next = cleanWowConfig(body.wow, prev);
  await saveWowConfig(c.env, next, c.get('viewer')!.id);
  return c.json({ wow: publicWowConfig(next) });
});

/**
 * Test connection: ask Blizzard for a fresh app token with the saved key. Success
 * marks the config verified (the module may now be switched on) and replaces the
 * sweep's cached token, so a changed key takes effect at once.
 */
wow.post('/admin/test', requirePermission('settings.manage'), async (c) => {
  const database = db(c.env);
  const cfg = await loadWowConfig(c.env, database);
  const now = Math.floor(Date.now() / 1000);
  if (!cfg.clientId || !cfg.clientSecret) return c.json({ ok: false, error: 'Enter the client ID and secret first.' });
  if (!cfg.namespace) return c.json({ ok: false, error: "Enter Blizzard's data section first." });
  const cache = settingsTokenStore(database);
  try {
    let fresh: { token: string; expiresAt: number } | null = null;
    await appToken(cfg, { get: async () => null, set: async (v) => void (fresh = v) }, now);
    if (fresh) await cache.set(fresh);
    await saveWowConfig(c.env, { ...cfg, verifiedAt: now, lastError: null, lastErrorAt: null }, c.get('viewer')!.id);
    return c.json({ ok: true, verifiedAt: now });
  } catch (err) {
    const error =
      err instanceof BnetError && (err.status === 400 || err.status === 401)
        ? 'Blizzard refused the client ID or secret.'
        : err instanceof Error
          ? err.message
          : 'Could not reach Blizzard.';
    await saveWowConfig(c.env, { ...cfg, verifiedAt: null, lastError: error, lastErrorAt: now }, c.get('viewer')!.id);
    return c.json({ ok: false, error });
  }
});

/** Create the five starter WoW medals (one per badge) that don't exist yet. */
wow.post('/admin/medals', requirePermission('medals.manage'), async (c) => {
  return c.json({ created: await createWowMedals(db(c.env)) });
});

export default wow;
