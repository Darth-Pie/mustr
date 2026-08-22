/**
 * Cross-org tournament federation — the host and subscriber logic for SHARED
 * tournaments, built on the alliance pipe (federation.ts) and its wire contract
 * (shared/allianceTournament.ts).
 *
 * HOST side (this org owns the tournament):
 *  - fanOutTournamentOffer: announce/withdraw an offer to all allies.
 *  - broadcastTournamentUpdate: push a status/standings/champion snapshot.
 *  - handleRemoteEntry: an ally submitted an entrant — add/withdraw a name-only
 *    entrant tagged with THAT ally's org (identity derived from the auth link,
 *    never the payload).
 *
 * SUBSCRIBER side (an ally hosts; we mirror it):
 *  - applyOffer / applyUpdate: upsert our read-only mirror from inbound messages.
 *  - submitEntry / withdrawEntry: field a competitor into the host's tournament
 *    over the same channel, tracking it locally.
 *
 * Everything inbound is untrusted: payloads are sanitized by the shared contract,
 * and the trust-sensitive "which org" is always the authenticated alliance link.
 */

import { and, eq, like, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { Env } from '../env';
import type { db as makeDb } from '../middleware/auth';
import { loadConfig } from '../config';
import { fanOutJson, postJsonToAlly } from './federation';
import { loadEntrants, loadStandings, championName } from '../tournaments';
import {
  sanitizeTournamentOffer,
  type TournamentOffer,
  type TournamentUpdate,
  type TournamentEntry,
} from '../../shared/allianceTournament';

type DB = ReturnType<typeof makeDb>;
type AllianceLink = typeof s.allianceLinks.$inferSelect;
type TournamentRow = typeof s.tournaments.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);

/** Max entrants a single ally may field into one hosted tournament. */
const REMOTE_ENTRY_CAP = 32;

const OFFER_PATH = '/api/alliance/tournament/offer';
const UPDATE_PATH = '/api/alliance/tournament/update';
const ENTRY_PATH = '/api/alliance/tournament/entry';

/* ================================================================== *
 * HOST SIDE
 * ================================================================== */

function bracketUrl(siteUrl: string | undefined, slug: string): string | undefined {
  return siteUrl ? `${siteUrl.replace(/\/$/, '')}/tournaments/${slug}` : undefined;
}

/** Build the offer describing one of OUR tournaments. */
function buildOffer(siteUrl: string | undefined, t: TournamentRow, closed = false): TournamentOffer {
  const url = bracketUrl(siteUrl, t.slug);
  return {
    v: 1,
    ref: String(t.id),
    name: t.name,
    format: t.format,
    competitorType: t.competitorType,
    status: t.status,
    startsAt: t.startsAt,
    registrationOpen: t.status === 'registration',
    ...(url ? { url } : {}),
    ...(closed ? { closed: true } : {}),
  };
}

/**
 * Announce (or, with `closed`, withdraw) an offer for one of our tournaments to
 * every allied org. Best-effort; safe inside ctx.waitUntil.
 */
export async function fanOutTournamentOffer(env: Env, t: TournamentRow, opts: { closed?: boolean } = {}): Promise<void> {
  try {
    const cfg = await loadConfig(env);
    await fanOutJson(env, OFFER_PATH, buildOffer(cfg.siteUrl, t, opts.closed));
  } catch (err) {
    console.error('Alliance tournament offer failed', err);
  }
}

/**
 * Push a status/standings/champion snapshot for one of our shared tournaments to
 * every ally. No-ops silently if the tournament isn't shared. Best-effort.
 */
export async function broadcastTournamentUpdate(env: Env, database: DB, tournamentId: number): Promise<void> {
  try {
    const t = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, tournamentId) });
    if (!t || !t.shareAlliance) return;
    const cfg = await loadConfig(env);
    const url = bracketUrl(cfg.siteUrl, t.slug);

    let standings: TournamentUpdate['standings'];
    if (t.format === 'round_robin' || t.format === 'swiss') {
      const [rows, entrants] = await Promise.all([loadStandings(database, t.id), loadEntrants(database, t.id)]);
      const nameById = new Map(entrants.map((e) => [e.id, e.name]));
      standings = rows.slice(0, 64).map((r) => ({
        name: nameById.get(r.entrantId) ?? 'Entrant',
        wins: r.wins,
        losses: r.losses,
        rank: r.rank,
      }));
    }
    const champion = t.status === 'complete' ? await championName(database, t.id) : undefined;

    const update: TournamentUpdate = {
      v: 1,
      ref: String(t.id),
      status: t.status,
      ...(standings ? { standings } : {}),
      ...(champion !== undefined ? { champion } : {}),
      ...(url ? { url } : {}),
    };
    await fanOutJson(env, UPDATE_PATH, update);
  } catch (err) {
    console.error('Alliance tournament update failed', err);
  }
}

export interface RemoteEntryResult {
  ok: boolean;
  status?: 'accepted' | 'withdrawn';
  error?: string;
  code?: number;
}

/**
 * HOST: process an entry submitted by an ally. The competitor becomes a
 * name-only entrant tagged with the ally's org (`originName` = link.name); the
 * stable `remoteRef` = "<linkId>:<entryId>" makes resends idempotent. Remote
 * entrants carry no local userId, so they never earn a local champion medal.
 */
export async function handleRemoteEntry(
  database: DB,
  link: AllianceLink,
  entry: TournamentEntry,
): Promise<RemoteEntryResult> {
  const id = Number(entry.ref);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, code: 404, error: 'No such tournament.' };
  const t = await database.query.tournaments.findFirst({ where: eq(s.tournaments.id, id) });
  if (!t || !t.shareAlliance) return { ok: false, code: 404, error: 'That tournament isn’t open to the alliance.' };

  const remoteRef = `${link.id}:${entry.entryId}`;
  const existing = await database.query.tournamentEntrants.findFirst({
    where: eq(s.tournamentEntrants.remoteRef, remoteRef),
    columns: { id: true },
  });

  // --- Withdrawal ---
  if (entry.withdraw) {
    if (existing && (t.status === 'registration' || t.status === 'seeding' || t.status === 'draft')) {
      await database.delete(s.tournamentEntrants).where(eq(s.tournamentEntrants.id, existing.id));
    }
    return { ok: true, status: 'withdrawn' };
  }

  // --- Submission ---
  if (existing) return { ok: true, status: 'accepted' }; // idempotent resend
  if (t.status !== 'registration') return { ok: false, code: 400, error: 'Registration is closed.' };

  // Cap entries from this one ally, and respect the overall entrant cap.
  const fromAlly = await database
    .select({ n: sql<number>`count(*)` })
    .from(s.tournamentEntrants)
    .where(and(eq(s.tournamentEntrants.tournamentId, t.id), like(s.tournamentEntrants.remoteRef, `${link.id}:%`)));
  if ((fromAlly[0]?.n ?? 0) >= REMOTE_ENTRY_CAP) {
    return { ok: false, code: 400, error: 'Your org has reached its entry limit for this tournament.' };
  }
  if (t.maxEntrants != null) {
    const total = await database
      .select({ n: sql<number>`count(*)` })
      .from(s.tournamentEntrants)
      .where(eq(s.tournamentEntrants.tournamentId, t.id));
    if ((total[0]?.n ?? 0) >= t.maxEntrants) return { ok: false, code: 400, error: 'This tournament is full.' };
  }

  await database.insert(s.tournamentEntrants).values({
    tournamentId: t.id,
    name: entry.name,
    originName: link.name,
    remoteRef,
  });
  return { ok: true, status: 'accepted' };
}

/* ================================================================== *
 * SUBSCRIBER SIDE
 * ================================================================== */

/** SUBSCRIBER: upsert our read-only mirror from a host's offer. */
export async function applyOffer(database: DB, link: AllianceLink, offer: TournamentOffer): Promise<void> {
  const values = {
    allianceLinkId: link.id,
    ref: offer.ref,
    name: offer.name,
    format: offer.format,
    competitorType: offer.competitorType,
    status: offer.status,
    startsAt: offer.startsAt,
    url: offer.url ?? null,
    registrationOpen: offer.registrationOpen,
    closed: offer.closed === true,
    updatedAt: nowSec(),
  };
  await database
    .insert(s.allianceTournaments)
    .values(values)
    .onConflictDoUpdate({
      target: [s.allianceTournaments.allianceLinkId, s.allianceTournaments.ref],
      set: {
        name: values.name,
        format: values.format,
        competitorType: values.competitorType,
        status: values.status,
        startsAt: values.startsAt,
        url: values.url,
        registrationOpen: values.registrationOpen,
        closed: values.closed,
        updatedAt: values.updatedAt,
      },
    });
}

/** SUBSCRIBER: refresh a mirror's snapshot from a host's update. No-op if we
 *  never received the offer for it (nothing to attach the snapshot to). */
export async function applyUpdate(database: DB, link: AllianceLink, update: TournamentUpdate): Promise<void> {
  const set: Record<string, unknown> = {
    status: update.status,
    // A tournament only takes entrants while it's in the registration phase.
    registrationOpen: update.status === 'registration',
    updatedAt: nowSec(),
  };
  if (update.standings !== undefined) set.standings = update.standings;
  if (update.champion !== undefined) set.champion = update.champion;
  if (update.url) set.url = update.url;
  await database
    .update(s.allianceTournaments)
    .set(set)
    .where(and(eq(s.allianceTournaments.allianceLinkId, link.id), eq(s.allianceTournaments.ref, update.ref)));
}

/** The alliance link (host) behind one of our mirror rows, or null. */
async function hostLinkFor(database: DB, mirror: typeof s.allianceTournaments.$inferSelect): Promise<AllianceLink | null> {
  const link = await database.query.allianceLinks.findFirst({
    where: eq(s.allianceLinks.id, mirror.allianceLinkId),
  });
  return link ?? null;
}

export interface SubmitResult {
  ok: boolean;
  error?: string;
  code?: number;
  entry?: typeof s.allianceTournamentEntries.$inferSelect;
}

/**
 * SUBSCRIBER: field a competitor into a host's tournament. Sends the entry to the
 * host synchronously and, on acceptance, records it locally so the operator can
 * see and withdraw it. `name` is the competitor's display name (their org tag is
 * added host-side).
 */
export async function submitEntry(
  database: DB,
  mirror: typeof s.allianceTournaments.$inferSelect,
  name: string,
  createdBy: number,
): Promise<SubmitResult> {
  const clean = name.trim().slice(0, 80);
  if (!clean) return { ok: false, code: 400, error: 'A name is required.' };
  if (mirror.closed || !mirror.registrationOpen) {
    return { ok: false, code: 400, error: 'Registration for this tournament is closed.' };
  }
  const link = await hostLinkFor(database, mirror);
  if (!link || !link.baseUrl || !link.outboundToken) {
    return { ok: false, code: 400, error: 'This ally link is missing the token needed to submit entries.' };
  }

  const entryId = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const payload: TournamentEntry = { v: 1, ref: mirror.ref, entryId, name: clean };
  const resp = await postJsonToAlly(link, ENTRY_PATH, payload);
  if (!resp) return { ok: false, code: 502, error: 'Couldn’t reach the host org — try again shortly.' };

  const data = (await resp.json().catch(() => ({}))) as { ok?: boolean; status?: string; error?: string };
  if (!resp.ok || !data.ok) {
    return { ok: false, code: 400, error: data.error || 'The host rejected the entry.' };
  }

  const inserted = await database
    .insert(s.allianceTournamentEntries)
    .values({ allianceTournamentId: mirror.id, entryId, name: clean, status: 'accepted', createdBy })
    .returning();
  return { ok: true, entry: inserted[0] };
}

/** SUBSCRIBER: withdraw an entry we submitted. Tells the host, then marks it. */
export async function withdrawEntry(
  database: DB,
  mirror: typeof s.allianceTournaments.$inferSelect,
  entry: typeof s.allianceTournamentEntries.$inferSelect,
): Promise<{ ok: boolean; error?: string; code?: number }> {
  const link = await hostLinkFor(database, mirror);
  if (link && link.baseUrl && link.outboundToken) {
    const payload: TournamentEntry = { v: 1, ref: mirror.ref, entryId: entry.entryId, name: entry.name, withdraw: true };
    await postJsonToAlly(link, ENTRY_PATH, payload); // best-effort; we mark it regardless
  }
  await database
    .update(s.allianceTournamentEntries)
    .set({ status: 'withdrawn' })
    .where(eq(s.allianceTournamentEntries.id, entry.id));
  return { ok: true };
}

/** Re-exported for the inbound route: the offer sanitizer double-check helper. */
export { sanitizeTournamentOffer };
