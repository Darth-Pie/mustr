/**
 * Tournaments API.
 *
 * Reading: a list (public tournaments for anyone; all for members) and a full
 * tournament (bracket + entrants), gated by the tournament's isPublic flag.
 * Managing (tournaments.manage): create/edit/delete, add/remove entrants,
 * generate + reset the bracket, and report match results. Members may
 * self-register into an individual tournament while registration is open.
 */

import { Hono, type Context } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { AppContext } from '../env';
import { db, requireAuth, requireUser, requirePermission } from '../middleware/auth';
import { memberName } from '../../shared/names';
import { announceTournament } from '../discord/tournaments';
import { fanOutTournamentOffer, broadcastTournamentUpdate } from '../alliance/tournamentFederation';
import { sanitizeTournamentInput, computeStandings } from '../../shared/tournament';
import {
  addEntrant,
  addTeamMember,
  removeTeamMember,
  setTeamCaptain,
  renameTeam,
  isTeamCaptain,
  generateBracket,
  generateNextSwissRound,
  loadEntrants,
  loadMatches,
  loadTournamentSettings,
  reportMatchResult,
  resetBracket,
  isOpenForEntrants,
  tournamentSlugify,
  uniqueTournamentSlug,
  TOURNAMENTS_SETTINGS_KEY,
} from '../tournaments';

const tournaments = new Hono<AppContext>();

const nowSec = () => Math.floor(Date.now() / 1000);

/** Can the viewer share tournaments with the alliance? (Gated on top of
 *  tournaments.manage, mirroring the events "share with alliance" toggle.) */
function canAlliance(c: Context<AppContext>): boolean {
  const v = c.get('viewer');
  return !!v && (v.isGod || v.permissions.includes('alliance.manage'));
}

/** Look up a tournament by numeric id or slug. */
async function findTournament(database: ReturnType<typeof db>, key: string) {
  const asId = Number(key);
  if (Number.isInteger(asId) && asId > 0) {
    const byId = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, asId) });
    if (byId) return byId;
  }
  return database.query.tournaments.findFirst({ where: eq(s.tournaments.slug, key) });
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/** List tournaments. Anonymous visitors see public ones; members see all. */
tournaments.get('/', async (c) => {
  const viewer = c.get('viewer');
  const rows = await db(c.env)
    .select({
      id: s.tournaments.id,
      name: s.tournaments.name,
      slug: s.tournaments.slug,
      imageUrl: s.tournaments.imageUrl,
      format: s.tournaments.format,
      competitorType: s.tournaments.competitorType,
      status: s.tournaments.status,
      isPublic: s.tournaments.isPublic,
      startsAt: s.tournaments.startsAt,
      gameName: s.games.name,
      entrantCount: sql<number>`(select count(*) from tournament_entrants where tournament_entrants.tournament_id = tournaments.id)`,
    })
    .from(s.tournaments)
    .leftJoin(s.games, eq(s.games.id, s.tournaments.gameId))
    .orderBy(desc(s.tournaments.createdAt));

  const visible = viewer ? rows : rows.filter((t) => t.isPublic);
  return c.json({ tournaments: visible });
});

/** Install-wide tournament settings (the champion medal). Two-segment path so
 *  it's never captured as a tournament slug by GET /:key. */
tournaments.get('/settings/config', requirePermission('tournaments.manage'), async (c) => {
  return c.json({ settings: await loadTournamentSettings(db(c.env)) });
});

tournaments.put('/settings/config', requirePermission('tournaments.manage'), async (c) => {
  const body = await c.req.json<{ championMedalId?: number | null }>().catch(() => ({}) as { championMedalId?: number | null });
  const idNum = Number(body.championMedalId);
  const championMedalId = Number.isInteger(idNum) && idNum > 0 ? idNum : null;
  const viewer = c.get('viewer')!;
  await db(c.env)
    .insert(s.settings)
    .values({ key: TOURNAMENTS_SETTINGS_KEY, value: { championMedalId }, updatedBy: viewer.id })
    .onConflictDoUpdate({
      target: s.settings.key,
      set: { value: { championMedalId }, updatedBy: viewer.id, updatedAt: Math.floor(Date.now() / 1000) },
    });
  return c.json({ ok: true, settings: { championMedalId } });
});

/**
 * Lightweight member search for building a team roster — any full member can
 * use it (captains need it, and they may lack roster.view). Returns just enough
 * to pick someone: id, resolved name, avatar. Registered before /:key so the
 * two-segment path is never captured as a slug.
 */
tournaments.get('/members/search', requireUser, async (c) => {
  const q = (c.req.query('q') ?? '').trim().toLowerCase().slice(0, 40);
  const rows = await db(c.env)
    .select({
      id: s.users.id,
      username: s.users.username,
      globalName: s.users.globalName,
      displayName: s.users.displayName,
      avatar: s.users.avatar,
      profileImageUrl: s.users.profileImageUrl,
      discordId: s.users.discordId,
    })
    .from(s.users)
    .where(eq(s.users.status, 'active'))
    .limit(500);
  const members = rows
    .map((r) => ({
      id: r.id,
      name: memberName({ displayName: r.displayName, globalName: r.globalName, username: r.username }),
      avatar: r.avatar,
      profileImageUrl: r.profileImageUrl,
      discordId: r.discordId,
    }))
    .filter((m) => !q || m.name.toLowerCase().includes(q))
    .slice(0, 10);
  return c.json({ members });
});

/** Full tournament: settings, entrants, and the bracket. */
tournaments.get('/:key', async (c) => {
  const viewer = c.get('viewer');
  const t = await findTournament(db(c.env), c.req.param('key'));
  if (!t) return c.json({ error: 'No such tournament' }, 404);
  if (!t.isPublic && !viewer) return c.json({ error: 'Authentication required' }, 401);

  const [entrants, matches] = await Promise.all([loadEntrants(db(c.env), t.id), loadMatches(db(c.env), t.id)]);
  const canManage = !!viewer && (viewer.isGod || viewer.permissions.includes('tournaments.manage'));
  // Standings only apply to the group formats (round-robin / Swiss).
  const standings =
    t.format === 'round_robin' || t.format === 'swiss'
      ? computeStandings(entrants.map((e) => e.id), matches)
      : null;
  return c.json({ tournament: t, entrants, matches, canManage, standings });
});

/* ------------------------------------------------------------------ *
 * Managing
 * ------------------------------------------------------------------ */

tournaments.post('/', requirePermission('tournaments.manage'), async (c) => {
  const input = sanitizeTournamentInput(await c.req.json().catch(() => ({})));
  const database = db(c.env);
  const slug = await uniqueTournamentSlug(database, tournamentSlugify(input.name));
  const viewer = c.get('viewer')!;
  const created = await database
    .insert(s.tournaments)
    .values({
      name: input.name,
      slug,
      description: input.description || null,
      imageUrl: input.imageUrl || null,
      gameId: input.gameId,
      format: input.format,
      competitorType: input.competitorType,
      seedMethod: input.seedMethod,
      bestOf: input.bestOf,
      thirdPlace: input.thirdPlace,
      swissRounds: input.swissRounds,
      maxEntrants: input.maxEntrants,
      isPublic: input.isPublic,
      // Only honored for organizers who can also manage the alliance.
      shareAlliance: input.shareAlliance && canAlliance(c),
      startsAt: input.startsAt,
      status: 'registration',
      createdBy: viewer.id,
    })
    .returning();
  // Announce the new open tournament to Discord (best-effort).
  const tournament = created[0]!;
  const origin = new URL(c.req.url).origin;
  c.executionCtx.waitUntil(announceTournament(c.env, { tournamentId: tournament.id, kind: 'open', baseUrl: origin }));
  // Offer it to allied orgs so they can field entrants (best-effort).
  if (tournament.shareAlliance) c.executionCtx.waitUntil(fanOutTournamentOffer(c.env, tournament));
  return c.json({ tournament }, 201);
});

tournaments.put('/:id', requirePermission('tournaments.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const database = db(c.env);
  const existing = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, id) });
  if (!existing) return c.json({ error: 'No such tournament' }, 404);
  const input = sanitizeTournamentInput({ ...existing, ...(await c.req.json().catch(() => ({}))) });

  // Format/competitor type are locked once a bracket exists (entrants seeded).
  const locked = existing.status === 'in_progress' || existing.status === 'complete';
  // Only alliance managers can flip sharing; others keep the existing value.
  const shareAlliance = canAlliance(c) ? input.shareAlliance : existing.shareAlliance;
  const set: Record<string, unknown> = {
    name: input.name,
    description: input.description || null,
    imageUrl: input.imageUrl || null,
    gameId: input.gameId,
    seedMethod: input.seedMethod,
    bestOf: input.bestOf,
    thirdPlace: input.thirdPlace,
    swissRounds: input.swissRounds,
    maxEntrants: input.maxEntrants,
    isPublic: input.isPublic,
    shareAlliance,
    startsAt: input.startsAt,
    updatedAt: nowSec(),
  };
  if (!locked) {
    set.format = input.format;
    set.competitorType = input.competitorType;
  }
  const updated = await database.update(s.tournaments).set(set).where(eq(s.tournaments.id, id)).returning();
  const tournament = updated[0]!;
  // Keep allies in sync: (re)offer while shared, or withdraw on toggle-off.
  if (tournament.shareAlliance) c.executionCtx.waitUntil(fanOutTournamentOffer(c.env, tournament));
  else if (existing.shareAlliance) c.executionCtx.waitUntil(fanOutTournamentOffer(c.env, tournament, { closed: true }));
  return c.json({ tournament });
});

tournaments.delete('/:id', requirePermission('tournaments.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const database = db(c.env);
  const existing = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, id) });
  await database.delete(s.tournaments).where(eq(s.tournaments.id, id));
  // Withdraw the offer from allies so their mirror shows it as closed.
  if (existing?.shareAlliance) c.executionCtx.waitUntil(fanOutTournamentOffer(c.env, existing, { closed: true }));
  return c.json({ ok: true });
});

/** Organizer adds an entrant (a member, or a named team). */
tournaments.post('/:id/entrants', requirePermission('tournaments.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const database = db(c.env);
  const t = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, id) });
  if (!t) return c.json({ error: 'No such tournament' }, 404);
  const body = await c.req.json<{ userId?: number; name?: string; teamMemberIds?: number[] }>().catch(() => ({}));
  const res = await addEntrant(database, t, body);
  if (!res.ok) return c.json({ error: res.error }, res.code as 400);
  return c.json({ ok: true, entrantId: res.entrantId }, 201);
});

/**
 * Member self-registration while registration is open. For an individual
 * tournament the member enters themselves; for a team tournament they create a
 * team (given a name) and become its captain, then build the roster.
 */
tournaments.post('/:id/register', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const database = db(c.env);
  const t = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, id) });
  if (!t) return c.json({ error: 'No such tournament' }, 404);
  if (t.status !== 'registration') {
    return c.json({ error: 'Registration isn’t open for this tournament.' }, 400);
  }
  const viewer = c.get('viewer')!;

  if (t.competitorType === 'team') {
    const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
    const res = await addEntrant(database, t, { name, teamMemberIds: [viewer.id] });
    if (!res.ok) return c.json({ error: res.error }, res.code as 400);
    return c.json({ ok: true, entrantId: res.entrantId }, 201);
  }

  const res = await addEntrant(database, t, { userId: viewer.id });
  if (!res.ok) return c.json({ error: res.error }, res.code as 400);
  return c.json({ ok: true, entrantId: res.entrantId }, 201);
});

/** Member withdraws their own self-registration (before the bracket is set). */
tournaments.delete('/:id/register', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const database = db(c.env);
  const t = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, id) });
  if (!t) return c.json({ error: 'No such tournament' }, 404);
  if (!isOpenForEntrants(t.status)) return c.json({ error: 'The bracket is already set.' }, 400);
  const viewer = c.get('viewer')!;
  await database
    .delete(s.tournamentEntrants)
    .where(and(eq(s.tournamentEntrants.tournamentId, id), eq(s.tournamentEntrants.userId, viewer.id)));
  return c.json({ ok: true });
});

tournaments.delete('/:id/entrants/:entrantId', requirePermission('tournaments.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const entrantId = Number(c.req.param('entrantId'));
  const database = db(c.env);
  const t = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, id), columns: { status: true } });
  if (!t) return c.json({ error: 'No such tournament' }, 404);
  if (!isOpenForEntrants(t.status)) {
    return c.json({ error: 'Can’t remove entrants once the bracket is generated — reset it first.' }, 400);
  }
  await database
    .delete(s.tournamentEntrants)
    .where(and(eq(s.tournamentEntrants.id, entrantId), eq(s.tournamentEntrants.tournamentId, id)));
  return c.json({ ok: true });
});

/* --- Team rosters (organizer OR the team's captain, before the bracket) --- */

/**
 * Load a team entrant for a roster edit and authorize the viewer. Returns the
 * entrant on success, or a JSON error Response the caller should return.
 */
async function guardTeamEdit(c: Context<AppContext>) {
  const id = Number(c.req.param('id'));
  const entrantId = Number(c.req.param('entrantId'));
  const database = db(c.env);
  const t = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, id) });
  if (!t) return { err: c.json({ error: 'No such tournament' }, 404) };
  if (t.competitorType !== 'team') return { err: c.json({ error: 'Not a team tournament.' }, 400) };
  if (!isOpenForEntrants(t.status)) return { err: c.json({ error: 'The bracket is already set.' }, 400) };
  const entrant = await database.query.tournamentEntrants.findFirst({
    where: and(eq(s.tournamentEntrants.id, entrantId), eq(s.tournamentEntrants.tournamentId, id)),
  });
  if (!entrant || entrant.userId != null) return { err: c.json({ error: 'No such team.' }, 404) };

  const viewer = c.get('viewer')!;
  const canManage = viewer.isGod || viewer.permissions.includes('tournaments.manage');
  const captain = canManage || (await isTeamCaptain(database, entrantId, viewer.id));
  if (!captain) return { err: c.json({ error: 'Only the team captain or an organizer can edit this team.' }, 403) };
  return { database, entrantId, tournamentId: id };
}

tournaments.post('/:id/entrants/:entrantId/members', requireAuth, async (c) => {
  const g = await guardTeamEdit(c);
  if ('err' in g) return g.err;
  const { userId } = await c.req.json<{ userId?: number }>().catch(() => ({ userId: undefined }));
  if (!Number.isInteger(userId)) return c.json({ error: 'A member is required.' }, 400);
  const member = await g.database.query.users.findFirst({ where: eq(s.users.id, userId!), columns: { id: true } });
  if (!member) return c.json({ error: 'No such member.' }, 404);
  const res = await addTeamMember(g.database, g.entrantId, userId!);
  if (!res.ok) return c.json({ error: res.error }, res.code as 400);
  return c.json({ ok: true }, 201);
});

tournaments.delete('/:id/entrants/:entrantId/members/:userId', requireAuth, async (c) => {
  const g = await guardTeamEdit(c);
  if ('err' in g) return g.err;
  await removeTeamMember(g.database, g.entrantId, Number(c.req.param('userId')));
  return c.json({ ok: true });
});

tournaments.post('/:id/entrants/:entrantId/captain', requireAuth, async (c) => {
  const g = await guardTeamEdit(c);
  if ('err' in g) return g.err;
  const { userId } = await c.req.json<{ userId?: number }>().catch(() => ({ userId: undefined }));
  if (!Number.isInteger(userId)) return c.json({ error: 'A member is required.' }, 400);
  const ok = await setTeamCaptain(g.database, g.entrantId, userId!);
  if (!ok) return c.json({ error: 'That member isn’t on the team.' }, 400);
  return c.json({ ok: true });
});

tournaments.put('/:id/entrants/:entrantId', requireAuth, async (c) => {
  const g = await guardTeamEdit(c);
  if ('err' in g) return g.err;
  const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
  if (!name?.trim()) return c.json({ error: 'A team name is required.' }, 400);
  await renameTeam(g.database, g.entrantId, name);
  return c.json({ ok: true });
});

/** Open/close registration (draft ↔ registration ↔ seeding). */
tournaments.post('/:id/status', requirePermission('tournaments.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const { status } = await c.req.json<{ status?: string }>().catch(() => ({ status: undefined }));
  if (status !== 'draft' && status !== 'registration' && status !== 'seeding') {
    return c.json({ error: 'Invalid status change.' }, 400);
  }
  const database = db(c.env);
  const t = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, id), columns: { status: true } });
  if (!t) return c.json({ error: 'No such tournament' }, 404);
  if (!isOpenForEntrants(t.status)) {
    return c.json({ error: 'The bracket is already generated.' }, 400);
  }
  const updated = await database
    .update(s.tournaments)
    .set({ status, updatedAt: nowSec() })
    .where(eq(s.tournaments.id, id))
    .returning();
  // Re-offer so allies' mirrors track whether registration is open.
  if (updated[0]?.shareAlliance) c.executionCtx.waitUntil(fanOutTournamentOffer(c.env, updated[0]));
  return c.json({ ok: true, status });
});

tournaments.post('/:id/generate', requirePermission('tournaments.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const database = db(c.env);
  const t = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, id) });
  if (!t) return c.json({ error: 'No such tournament' }, 404);
  const res = await generateBracket(database, t);
  if (!res.ok) return c.json({ error: res.error }, (res.code ?? 400) as 400);
  // Tell allies registration closed and the bracket is live (no-op if unshared).
  c.executionCtx.waitUntil(broadcastTournamentUpdate(c.env, database, id));
  return c.json({ ok: true });
});

tournaments.post('/:id/reset', requirePermission('tournaments.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  await resetBracket(db(c.env), id);
  return c.json({ ok: true });
});

/** Swiss only: pair and create the next round from the current standings. */
tournaments.post('/:id/next-round', requirePermission('tournaments.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const database = db(c.env);
  const t = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, id) });
  if (!t) return c.json({ error: 'No such tournament' }, 404);
  const res = await generateNextSwissRound(database, t);
  if (!res.ok) return c.json({ error: res.error }, (res.code ?? 400) as 400);
  // Pairing the final round can itself complete the tournament (all byes, say).
  if (t.status !== 'complete') {
    const after = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, id), columns: { status: true } });
    if (after?.status === 'complete') {
      const origin = new URL(c.req.url).origin;
      c.executionCtx.waitUntil(announceTournament(c.env, { tournamentId: id, kind: 'champion', baseUrl: origin }));
    }
  }
  // Push the new standings (and champion, if it just ended) to allies.
  c.executionCtx.waitUntil(broadcastTournamentUpdate(c.env, database, id));
  return c.json({ ok: true, round: res.round });
});

tournaments.post('/:id/matches/:matchId/report', requirePermission('tournaments.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const matchId = Number(c.req.param('matchId'));
  const body = await c.req
    .json<{ winnerId?: number; score1?: number; score2?: number }>()
    .catch(() => ({}) as { winnerId?: number; score1?: number; score2?: number });
  const winnerId = Number(body.winnerId);
  if (!Number.isInteger(winnerId)) return c.json({ error: 'A winner is required.' }, 400);
  const score1 = Math.max(0, Math.round(Number(body.score1) || 0));
  const score2 = Math.max(0, Math.round(Number(body.score2) || 0));
  const database = db(c.env);
  const before = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, id), columns: { status: true } });
  const res = await reportMatchResult(database, id, matchId, winnerId, { score1, score2 }, c.get('viewer')!.id);
  if (!res.ok) return c.json({ error: res.error }, (res.code ?? 400) as 400);
  // If that result just completed the tournament, announce the champion once.
  if (before?.status !== 'complete') {
    const after = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, id), columns: { status: true } });
    if (after?.status === 'complete') {
      const origin = new URL(c.req.url).origin;
      c.executionCtx.waitUntil(announceTournament(c.env, { tournamentId: id, kind: 'champion', baseUrl: origin }));
    }
  }
  // Push updated standings / champion to allies (no-op if unshared).
  c.executionCtx.waitUntil(broadcastTournamentUpdate(c.env, database, id));
  return c.json({ ok: true, champion: res.champion ?? null });
});

export default tournaments;
