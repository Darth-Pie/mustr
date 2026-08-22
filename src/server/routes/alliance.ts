/**
 * Alliance federation routes.
 *
 * `/inbound` is PUBLIC but authenticated by an alliance token (not a session): an
 * allied org's instance calls it to hand us a broadcast, which we sanitize and
 * post to our own Discord via our own bot. It NEVER re-fans-out (loop prevention).
 *
 * The `/links` + `/test` routes are the admin surface (alliance.manage): pair with
 * an ally, mint the token they'll use to call us, and fire a test broadcast.
 * Secrets (the outbound token, the inbound hash) are never echoed back — presence
 * only. A freshly minted inbound token is returned exactly once, at creation.
 */

import { Hono, type Context } from 'hono';
import { and, asc, desc, eq } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { AppContext } from '../env';
import { db, requirePermission } from '../middleware/auth';
import { cleanBaseUrl, sanitizeBroadcast } from '../../shared/alliance';
import {
  sanitizeTournamentOffer,
  sanitizeTournamentEntry,
  sanitizeTournamentUpdate,
} from '../../shared/allianceTournament';
import {
  mintAllianceToken,
  resolveInboundLink,
  postBroadcastLocally,
  makeBroadcast,
  fanOut,
} from '../alliance/federation';
import {
  applyOffer,
  applyUpdate,
  handleRemoteEntry,
  submitEntry,
  withdrawEntry,
} from '../alliance/tournamentFederation';

const alliance = new Hono<AppContext>();

/** Admin-safe projection of a link — no secrets, presence flags only. */
function view(r: typeof s.allianceLinks.$inferSelect) {
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.baseUrl,
    channelId: r.channelId,
    enabled: r.enabled,
    hasOutbound: !!r.outboundToken,
    inboundPrefix: r.inboundTokenPrefix,
    lastInboundAt: r.lastInboundAt,
  };
}

const now = () => Math.floor(Date.now() / 1000);
const cleanChannel = (v: unknown) => (typeof v === 'string' && /^\d{5,25}$/.test(v) ? v : null);

/** Resolve the alliance link behind an inbound Bearer token (the ally calling us). */
async function inboundLink(c: Context<AppContext>) {
  const authz = c.req.header('authorization') ?? '';
  const token = /^bearer /i.test(authz) ? authz.slice(7).trim() : '';
  return resolveInboundLink(db(c.env), token);
}

/* ------------------------------------------------------------------ *
 * INBOUND — an ally hands us a broadcast. Auth = the alliance token WE issued
 * them (matched by hash). Public route; does its own token check.
 * ------------------------------------------------------------------ */
alliance.post('/inbound', async (c) => {
  const authz = c.req.header('authorization') ?? '';
  const token = /^bearer /i.test(authz) ? authz.slice(7).trim() : '';
  const link = await resolveInboundLink(db(c.env), token);
  if (!link) return c.json({ ok: false, error: 'unauthorized' }, 401);

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid json' }, 400);
  }
  const broadcast = sanitizeBroadcast(payload);
  if (!broadcast) return c.json({ ok: false, error: 'empty broadcast' }, 422);

  // Post to OUR Discord via OUR bot. Deliberately does NOT fan out again.
  const posted = await postBroadcastLocally(c.env, db(c.env), link, broadcast).catch(() => false);
  await db(c.env)
    .update(s.allianceLinks)
    .set({ lastInboundAt: now() })
    .where(eq(s.allianceLinks.id, link.id))
    .catch(() => {});

  return c.json({ ok: true, posted });
});

/* ------------------------------------------------------------------ *
 * ADMIN — manage links + send a test. alliance.manage.
 * ------------------------------------------------------------------ */
alliance.get('/links', requirePermission('alliance.manage'), async (c) => {
  const rows = await db(c.env).query.allianceLinks.findMany();
  return c.json({ links: rows.map(view) });
});

alliance.post('/links', requirePermission('alliance.manage'), async (c) => {
  const viewer = c.get('viewer')!;
  const body = await c.req.json<{ name?: unknown; baseUrl?: unknown; outboundToken?: unknown; channelId?: unknown }>();

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  const baseUrl = cleanBaseUrl(body.baseUrl);
  if (!name || !baseUrl) return c.json({ error: 'A name and a valid https base URL are required.' }, 400);

  const outboundToken = typeof body.outboundToken === 'string' ? body.outboundToken.trim().slice(0, 200) : '';
  const minted = await mintAllianceToken();

  const inserted = await db(c.env)
    .insert(s.allianceLinks)
    .values({
      name,
      baseUrl,
      outboundToken: outboundToken || null,
      channelId: cleanChannel(body.channelId),
      inboundTokenHash: minted.hash,
      inboundTokenPrefix: minted.prefix,
      createdBy: viewer.id,
    })
    .returning();

  // The raw inbound token is shown ONCE — the admin sends it to the ally so they
  // can call us. It's never retrievable again (only its hash is stored).
  return c.json({ link: view(inserted[0]!), inboundToken: minted.token });
});

alliance.patch('/links/:id', requirePermission('alliance.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ name?: unknown; baseUrl?: unknown; outboundToken?: unknown; channelId?: unknown; enabled?: unknown }>();

  const patch: Partial<typeof s.allianceLinks.$inferInsert> = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 80);
  if (body.baseUrl !== undefined) {
    const u = cleanBaseUrl(body.baseUrl);
    if (u) patch.baseUrl = u;
  }
  if (body.outboundToken !== undefined) {
    patch.outboundToken = typeof body.outboundToken === 'string' && body.outboundToken.trim()
      ? body.outboundToken.trim().slice(0, 200)
      : null;
  }
  if (body.channelId !== undefined) patch.channelId = cleanChannel(body.channelId);
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;

  if (Object.keys(patch).length) {
    await db(c.env).update(s.allianceLinks).set(patch).where(eq(s.allianceLinks.id, id));
  }
  const row = await db(c.env).query.allianceLinks.findFirst({ where: eq(s.allianceLinks.id, id) });
  return c.json({ link: row ? view(row) : null });
});

/** Regenerate the inbound token an ally uses to call us (invalidates the old one). */
alliance.post('/links/:id/rotate', requirePermission('alliance.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const minted = await mintAllianceToken();
  await db(c.env)
    .update(s.allianceLinks)
    .set({ inboundTokenHash: minted.hash, inboundTokenPrefix: minted.prefix })
    .where(eq(s.allianceLinks.id, id));
  return c.json({ inboundToken: minted.token, prefix: minted.prefix });
});

alliance.delete('/links/:id', requirePermission('alliance.manage'), async (c) => {
  await db(c.env).delete(s.allianceLinks).where(eq(s.allianceLinks.id, Number(c.req.param('id'))));
  return c.json({ ok: true });
});

/** Fire a test broadcast out to every enabled ally (verifies the whole pipe). */
alliance.post('/test', requirePermission('alliance.manage'), async (c) => {
  const b = await makeBroadcast(
    c.env,
    'test',
    'Alliance test',
    'This is a test alliance broadcast. If you can see it, cross-org federation is working.',
  );
  c.executionCtx.waitUntil(fanOut(c.env, b));
  return c.json({ ok: true });
});

/* ------------------------------------------------------------------ *
 * TOURNAMENT FEDERATION — inbound (token-authed, host↔subscriber).
 *
 * offer/update are host→subscriber pushes (we upsert a mirror); entry is a
 * subscriber→host submission we act on synchronously. All authed by the alliance
 * token, and "which org" is always the resolved link, never the payload.
 * ------------------------------------------------------------------ */

/** Host → us: an offer to take part in a hosted tournament. We mirror it. */
alliance.post('/tournament/offer', async (c) => {
  const link = await inboundLink(c);
  if (!link) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const offer = sanitizeTournamentOffer(await c.req.json().catch(() => null));
  if (!offer) return c.json({ ok: false, error: 'invalid offer' }, 422);
  await applyOffer(db(c.env), link, offer).catch(() => {});
  await db(c.env).update(s.allianceLinks).set({ lastInboundAt: now() }).where(eq(s.allianceLinks.id, link.id)).catch(() => {});
  return c.json({ ok: true });
});

/** Host → us: a status/standings/champion snapshot for a mirrored tournament. */
alliance.post('/tournament/update', async (c) => {
  const link = await inboundLink(c);
  if (!link) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const update = sanitizeTournamentUpdate(await c.req.json().catch(() => null));
  if (!update) return c.json({ ok: false, error: 'invalid update' }, 422);
  await applyUpdate(db(c.env), link, update).catch(() => {});
  return c.json({ ok: true });
});

/** Subscriber → us (we host): field a competitor. Acted on synchronously. */
alliance.post('/tournament/entry', async (c) => {
  const link = await inboundLink(c);
  if (!link) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const entry = sanitizeTournamentEntry(await c.req.json().catch(() => null));
  if (!entry) return c.json({ ok: false, error: 'invalid entry' }, 422);
  const res = await handleRemoteEntry(db(c.env), link, entry);
  if (!res.ok) return c.json({ ok: false, error: res.error }, (res.code ?? 400) as 400);
  return c.json({ ok: true, status: res.status });
});

/* ------------------------------------------------------------------ *
 * TOURNAMENT FEDERATION — subscriber admin (alliance.manage). Browse the
 * tournaments allies are hosting, and field/withdraw our entrants.
 * ------------------------------------------------------------------ */

alliance.get('/tournament/mirrors', requirePermission('alliance.manage'), async (c) => {
  const database = db(c.env);
  const rows = await database
    .select({
      id: s.allianceTournaments.id,
      host: s.allianceLinks.name,
      allianceLinkId: s.allianceTournaments.allianceLinkId,
      ref: s.allianceTournaments.ref,
      name: s.allianceTournaments.name,
      format: s.allianceTournaments.format,
      competitorType: s.allianceTournaments.competitorType,
      status: s.allianceTournaments.status,
      startsAt: s.allianceTournaments.startsAt,
      url: s.allianceTournaments.url,
      registrationOpen: s.allianceTournaments.registrationOpen,
      standings: s.allianceTournaments.standings,
      champion: s.allianceTournaments.champion,
      closed: s.allianceTournaments.closed,
      updatedAt: s.allianceTournaments.updatedAt,
    })
    .from(s.allianceTournaments)
    .innerJoin(s.allianceLinks, eq(s.allianceLinks.id, s.allianceTournaments.allianceLinkId))
    .orderBy(asc(s.allianceTournaments.closed), desc(s.allianceTournaments.updatedAt));

  const entries = await database
    .select()
    .from(s.allianceTournamentEntries);
  const byTournament = new Map<number, typeof entries>();
  for (const e of entries) {
    const list = byTournament.get(e.allianceTournamentId) ?? [];
    list.push(e);
    byTournament.set(e.allianceTournamentId, list);
  }

  return c.json({
    tournaments: rows.map((r) => ({
      ...r,
      entries: (byTournament.get(r.id) ?? []).map((e) => ({ id: e.id, name: e.name, status: e.status })),
    })),
  });
});

alliance.post('/tournament/mirrors/:id/entries', requirePermission('alliance.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const database = db(c.env);
  const mirror = await database.query.allianceTournaments.findFirst({ where: eq(s.allianceTournaments.id, id) });
  if (!mirror) return c.json({ error: 'No such tournament.' }, 404);
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  const res = await submitEntry(database, mirror, name ?? '', c.get('viewer')!.id);
  if (!res.ok) return c.json({ error: res.error }, (res.code ?? 400) as 400);
  return c.json({ ok: true, entry: res.entry ? { id: res.entry.id, name: res.entry.name, status: res.entry.status } : null }, 201);
});

alliance.delete('/tournament/mirrors/:id/entries/:entryId', requirePermission('alliance.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const entryRowId = Number(c.req.param('entryId'));
  const database = db(c.env);
  const mirror = await database.query.allianceTournaments.findFirst({ where: eq(s.allianceTournaments.id, id) });
  if (!mirror) return c.json({ error: 'No such tournament.' }, 404);
  const entry = await database.query.allianceTournamentEntries.findFirst({
    where: and(eq(s.allianceTournamentEntries.id, entryRowId), eq(s.allianceTournamentEntries.allianceTournamentId, id)),
  });
  if (!entry) return c.json({ error: 'No such entry.' }, 404);
  await withdrawEntry(database, mirror, entry);
  return c.json({ ok: true });
});

export default alliance;
