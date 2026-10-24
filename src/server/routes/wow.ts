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
import { db, requireAuth } from '../middleware/auth';
import { loadModules, loadWowConfig } from '../modules';
import { newState } from '../auth/discord';
import { authorizeUrl, exchangeCode, fetchAccountCharacters, fetchUserInfo } from '../wow/bnet';
import { planFollow } from '../wow/follow';
import type {
  AccountCandidate,
  BadgeKey,
  CharacterCard,
  ItemQuality,
  MemberWowData,
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

export default wow;
