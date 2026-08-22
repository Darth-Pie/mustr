/**
 * Tournament persistence — the only layer that touches D1. It wraps the pure
 * engine (shared/tournament.ts): create a tournament, register/seed entrants,
 * generate the bracket (insert match rows, then rewire the winner/loser "next
 * match" pointers now that rows have real ids), and report a result (compute
 * the advancement patches with applyResult and persist them atomically).
 *
 * Phase 1 supports SINGLE ELIMINATION generation. Other formats can be created
 * and seeded, but generateBracket rejects them until their generators land.
 */

import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import * as s from '../db/schema';
import type { db as makeDb } from './middleware/auth';
import { memberName } from '../shared/names';
import {
  planSingleElim,
  planDoubleElim,
  planRoundRobin,
  planSwissRound,
  computeStandings,
  pairKey,
  applyResult,
  type SeededEntrant,
  type MatchNode,
  type BracketSide,
  type MatchStatus,
  type BracketPlan,
  type StandingRow,
} from '../shared/tournament';

type DB = ReturnType<typeof makeDb>;

const nowSec = () => Math.floor(Date.now() / 1000);

/* ------------------------------------------------------------------ *
 * Slugs
 * ------------------------------------------------------------------ */

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'tournament'
  );
}

async function uniqueSlug(database: DB, base: string, ignoreId?: number): Promise<string> {
  let slug = base;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const clash = await database.query.tournaments.findFirst({
      where: ignoreId
        ? and(eq(s.tournaments.slug, slug), ne(s.tournaments.id, ignoreId))
        : eq(s.tournaments.slug, slug),
      columns: { id: true },
    });
    if (!clash) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

/* ------------------------------------------------------------------ *
 * Entrant labels — resolve a display name/avatar for each entrant. For an
 * individual the live member name (via userId) wins; for a team the stored
 * team name is used, with its roster attached.
 * ------------------------------------------------------------------ */

export interface EntrantView {
  id: number;
  seed: number | null;
  name: string;
  userId: number | null;
  avatar: string | null;
  profileImageUrl: string | null;
  discordId: string | null;
  status: string;
  checkedIn: boolean;
  /** Set when the entrant was fielded by an allied org (federation). */
  originName: string | null;
  team: { userId: number; name: string; isCaptain: boolean }[];
}

export async function loadEntrants(database: DB, tournamentId: number): Promise<EntrantView[]> {
  const rows = await database
    .select({
      id: s.tournamentEntrants.id,
      seed: s.tournamentEntrants.seed,
      name: s.tournamentEntrants.name,
      status: s.tournamentEntrants.status,
      checkedIn: s.tournamentEntrants.checkedIn,
      originName: s.tournamentEntrants.originName,
      userId: s.tournamentEntrants.userId,
      username: s.users.username,
      globalName: s.users.globalName,
      displayName: s.users.displayName,
      avatar: s.users.avatar,
      profileImageUrl: s.users.profileImageUrl,
      discordId: s.users.discordId,
    })
    .from(s.tournamentEntrants)
    .leftJoin(s.users, eq(s.users.id, s.tournamentEntrants.userId))
    .where(eq(s.tournamentEntrants.tournamentId, tournamentId))
    .orderBy(asc(s.tournamentEntrants.seed), asc(s.tournamentEntrants.id));

  const entrantIds = rows.map((r) => r.id);
  // One query for every team roster in this tournament.
  const teamRows = entrantIds.length
    ? await database
        .select({
          entrantId: s.tournamentTeamMembers.entrantId,
          userId: s.tournamentTeamMembers.userId,
          isCaptain: s.tournamentTeamMembers.isCaptain,
          username: s.users.username,
          globalName: s.users.globalName,
          displayName: s.users.displayName,
        })
        .from(s.tournamentTeamMembers)
        .innerJoin(s.users, eq(s.users.id, s.tournamentTeamMembers.userId))
        .where(inArray(s.tournamentTeamMembers.entrantId, entrantIds))
    : [];
  const teamByEntrant = new Map<number, EntrantView['team']>();
  for (const t of teamRows) {
    const list = teamByEntrant.get(t.entrantId) ?? [];
    list.push({
      userId: t.userId,
      name: memberName({ displayName: t.displayName, globalName: t.globalName, username: t.username }),
      isCaptain: t.isCaptain,
    });
    teamByEntrant.set(t.entrantId, list);
  }

  return rows.map((r) => ({
    id: r.id,
    seed: r.seed,
    name: r.userId
      ? memberName({ displayName: r.displayName, globalName: r.globalName, username: r.username ?? '' })
      : (r.name ?? 'TBD'),
    userId: r.userId,
    avatar: r.avatar,
    profileImageUrl: r.profileImageUrl,
    discordId: r.discordId,
    status: r.status,
    checkedIn: r.checkedIn,
    originName: r.originName,
    team: teamByEntrant.get(r.id) ?? [],
  }));
}

export async function loadMatches(database: DB, tournamentId: number) {
  return database
    .select()
    .from(s.tournamentMatches)
    .where(eq(s.tournamentMatches.tournamentId, tournamentId))
    .orderBy(asc(s.tournamentMatches.round), asc(s.tournamentMatches.slot));
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

/** True while entrants may still be added/removed (before the bracket exists). */
export function isOpenForEntrants(status: string): boolean {
  return status === 'draft' || status === 'registration' || status === 'seeding';
}

export interface AddEntrantInput {
  userId?: number | null;
  name?: string | null;
  teamMemberIds?: number[];
}

export async function addEntrant(
  database: DB,
  tournament: { id: number; competitorType: string; status: string; maxEntrants: number | null },
  input: AddEntrantInput,
): Promise<{ ok: true; entrantId: number } | { ok: false; error: string; code: number }> {
  if (!isOpenForEntrants(tournament.status)) {
    return { ok: false, error: 'Registration is closed — the bracket is already set.', code: 400 };
  }
  const count = await database
    .select({ n: sql<number>`count(*)` })
    .from(s.tournamentEntrants)
    .where(eq(s.tournamentEntrants.tournamentId, tournament.id));
  const current = count[0]?.n ?? 0;
  if (tournament.maxEntrants != null && current >= tournament.maxEntrants) {
    return { ok: false, error: 'This tournament is full.', code: 400 };
  }

  if (tournament.competitorType === 'individual') {
    const userId = Number(input.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return { ok: false, error: 'A member is required.', code: 400 };
    }
    const dup = await database.query.tournamentEntrants.findFirst({
      where: and(eq(s.tournamentEntrants.tournamentId, tournament.id), eq(s.tournamentEntrants.userId, userId)),
      columns: { id: true },
    });
    if (dup) return { ok: false, error: 'That member is already entered.', code: 409 };
    const user = await database.query.users.findFirst({
      where: eq(s.users.id, userId),
      columns: { id: true, username: true, globalName: true, displayName: true },
    });
    if (!user) return { ok: false, error: 'No such member.', code: 404 };
    const inserted = await database
      .insert(s.tournamentEntrants)
      .values({
        tournamentId: tournament.id,
        userId,
        name: memberName({ displayName: user.displayName, globalName: user.globalName, username: user.username }),
      })
      .returning({ id: s.tournamentEntrants.id });
    return { ok: true, entrantId: inserted[0]!.id };
  }

  // Team entrant.
  const teamName = (input.name ?? '').trim().slice(0, 80);
  if (!teamName) return { ok: false, error: 'A team name is required.', code: 400 };
  const inserted = await database
    .insert(s.tournamentEntrants)
    .values({ tournamentId: tournament.id, name: teamName })
    .returning({ id: s.tournamentEntrants.id });
  const entrantId = inserted[0]!.id;

  const memberIds = [...new Set((input.teamMemberIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50);
  if (memberIds.length) {
    await database.insert(s.tournamentTeamMembers).values(
      memberIds.map((uid, i) => ({ entrantId, userId: uid, isCaptain: i === 0 })),
    );
  }
  return { ok: true, entrantId };
}

/* ------------------------------------------------------------------ *
 * Team rosters — managing the members of a team entrant. Allowed for an
 * organizer (tournaments.manage) or the team's own captain, and only while
 * the tournament is still open for entrants (before the bracket is set).
 * ------------------------------------------------------------------ */

/** Is this member the captain of this team entrant? */
export async function isTeamCaptain(database: DB, entrantId: number, userId: number): Promise<boolean> {
  const row = await database.query.tournamentTeamMembers.findFirst({
    where: and(
      eq(s.tournamentTeamMembers.entrantId, entrantId),
      eq(s.tournamentTeamMembers.userId, userId),
      eq(s.tournamentTeamMembers.isCaptain, true),
    ),
    columns: { id: true },
  });
  return !!row;
}

export async function addTeamMember(
  database: DB,
  entrantId: number,
  userId: number,
): Promise<{ ok: true } | { ok: false; error: string; code: number }> {
  const dup = await database.query.tournamentTeamMembers.findFirst({
    where: and(eq(s.tournamentTeamMembers.entrantId, entrantId), eq(s.tournamentTeamMembers.userId, userId)),
    columns: { id: true },
  });
  if (dup) return { ok: false, error: 'They’re already on the team.', code: 409 };
  const count = await database
    .select({ n: sql<number>`count(*)` })
    .from(s.tournamentTeamMembers)
    .where(eq(s.tournamentTeamMembers.entrantId, entrantId));
  // First member added becomes captain by default (e.g. organizer-built teams).
  const isFirst = (count[0]?.n ?? 0) === 0;
  await database.insert(s.tournamentTeamMembers).values({ entrantId, userId, isCaptain: isFirst });
  return { ok: true };
}

export async function removeTeamMember(database: DB, entrantId: number, userId: number): Promise<void> {
  await database
    .delete(s.tournamentTeamMembers)
    .where(and(eq(s.tournamentTeamMembers.entrantId, entrantId), eq(s.tournamentTeamMembers.userId, userId)));
  // If that removed the captain and members remain, promote the earliest-joined.
  const remaining = await database
    .select({ id: s.tournamentTeamMembers.id, isCaptain: s.tournamentTeamMembers.isCaptain })
    .from(s.tournamentTeamMembers)
    .where(eq(s.tournamentTeamMembers.entrantId, entrantId))
    .orderBy(asc(s.tournamentTeamMembers.id));
  if (remaining.length && !remaining.some((m) => m.isCaptain)) {
    await database
      .update(s.tournamentTeamMembers)
      .set({ isCaptain: true })
      .where(eq(s.tournamentTeamMembers.id, remaining[0]!.id));
  }
}

export async function setTeamCaptain(database: DB, entrantId: number, userId: number): Promise<boolean> {
  const member = await database.query.tournamentTeamMembers.findFirst({
    where: and(eq(s.tournamentTeamMembers.entrantId, entrantId), eq(s.tournamentTeamMembers.userId, userId)),
    columns: { id: true },
  });
  if (!member) return false;
  // Exactly one captain: clear all, then set the chosen member.
  await database
    .update(s.tournamentTeamMembers)
    .set({ isCaptain: false })
    .where(eq(s.tournamentTeamMembers.entrantId, entrantId));
  await database
    .update(s.tournamentTeamMembers)
    .set({ isCaptain: true })
    .where(and(eq(s.tournamentTeamMembers.entrantId, entrantId), eq(s.tournamentTeamMembers.userId, userId)));
  return true;
}

export async function renameTeam(database: DB, entrantId: number, name: string): Promise<void> {
  await database
    .update(s.tournamentEntrants)
    .set({ name: name.trim().slice(0, 80) })
    .where(eq(s.tournamentEntrants.id, entrantId));
}

/* ------------------------------------------------------------------ *
 * Bracket generation
 * ------------------------------------------------------------------ */

/** Deterministic-enough shuffle (Fisher–Yates) for random seeding. */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface GenerateResult {
  ok: boolean;
  error?: string;
  code?: number;
}

export async function generateBracket(
  database: DB,
  tournament: {
    id: number;
    format: string;
    status: string;
    seedMethod: string;
    thirdPlace: boolean;
    swissRounds: number;
  },
): Promise<GenerateResult> {
  const known = ['single_elim', 'double_elim', 'round_robin', 'swiss'];
  if (!known.includes(tournament.format)) {
    return { ok: false, code: 400, error: 'Unknown tournament format.' };
  }
  if (tournament.status === 'in_progress' || tournament.status === 'complete') {
    return { ok: false, code: 400, error: 'The bracket has already been generated.' };
  }

  const entrants = await database
    .select({ id: s.tournamentEntrants.id, seed: s.tournamentEntrants.seed })
    .from(s.tournamentEntrants)
    .where(
      and(eq(s.tournamentEntrants.tournamentId, tournament.id), eq(s.tournamentEntrants.status, 'registered')),
    )
    .orderBy(asc(s.tournamentEntrants.id));

  if (entrants.length < 2) {
    return { ok: false, code: 400, error: 'At least two entrants are needed.' };
  }

  // Assign seeds by the chosen method.
  let ordered: { id: number }[];
  if (tournament.seedMethod === 'random') {
    ordered = shuffle(entrants);
  } else if (tournament.seedMethod === 'manual') {
    // Respect any manually-set seed; unseeded fall to the end by id.
    ordered = [...entrants].sort((a, b) => {
      const sa = a.seed ?? Number.MAX_SAFE_INTEGER;
      const sb = b.seed ?? Number.MAX_SAFE_INTEGER;
      return sa - sb || a.id - b.id;
    });
  } else {
    // 'signup' — registration order (already id-ordered).
    ordered = entrants;
  }

  const seeded: SeededEntrant[] = ordered.map((e, i) => ({ id: e.id, seed: i + 1 }));
  let plan: BracketPlan;
  if (tournament.format === 'double_elim') {
    plan = planDoubleElim(seeded);
  } else if (tournament.format === 'round_robin') {
    plan = planRoundRobin(seeded);
  } else if (tournament.format === 'swiss') {
    // Swiss generates one round at a time; seed the first round now.
    const round1 = planSwissRound(seeded.map((e) => e.id), 1, new Set(), new Set());
    plan = { matches: round1, rounds: tournament.swissRounds };
  } else {
    plan = planSingleElim(seeded, { thirdPlace: tournament.thirdPlace });
  }
  if (!plan.matches.length) {
    return { ok: false, code: 400, error: 'Could not build a bracket from these entrants.' };
  }

  // Persist the seeds.
  for (const e of seeded) {
    await database
      .update(s.tournamentEntrants)
      .set({ seed: e.seed })
      .where(eq(s.tournamentEntrants.id, e.id));
  }

  // Insert matches WITHOUT next pointers (entrant ids and byes are already in
  // the plan), capturing key → real id, then rewire the pointers.
  const keyToId = new Map<string, number>();
  for (const m of plan.matches) {
    const inserted = await database
      .insert(s.tournamentMatches)
      .values({
        tournamentId: tournament.id,
        bracket: m.bracket,
        round: m.round,
        slot: m.slot,
        entrant1Id: m.entrant1Id,
        entrant2Id: m.entrant2Id,
        winnerId: m.winnerId,
        status: m.status,
      })
      .returning({ id: s.tournamentMatches.id });
    keyToId.set(m.key, inserted[0]!.id);
  }

  // Second pass: wire winner/loser next-match pointers.
  const updates = plan.matches
    .filter((m) => m.winnerNextKey || m.loserNextKey)
    .map((m) =>
      database
        .update(s.tournamentMatches)
        .set({
          winnerNextMatchId: m.winnerNextKey ? keyToId.get(m.winnerNextKey)! : null,
          winnerNextSlot: m.winnerNextSlot,
          loserNextMatchId: m.loserNextKey ? keyToId.get(m.loserNextKey)! : null,
          loserNextSlot: m.loserNextSlot,
        })
        .where(eq(s.tournamentMatches.id, keyToId.get(m.key)!)),
    );
  if (updates.length) await database.batch(updates as [typeof updates[number], ...typeof updates]);

  await database
    .update(s.tournaments)
    .set({ status: 'in_progress', updatedAt: nowSec() })
    .where(eq(s.tournaments.id, tournament.id));

  return { ok: true };
}

/** Wipe a generated bracket and clear seeds — back to registration. */
export async function resetBracket(database: DB, tournamentId: number): Promise<void> {
  await database.delete(s.tournamentMatches).where(eq(s.tournamentMatches.tournamentId, tournamentId));
  await database
    .update(s.tournamentEntrants)
    .set({ seed: null })
    .where(eq(s.tournamentEntrants.tournamentId, tournamentId));
  await database
    .update(s.tournaments)
    .set({ status: 'seeding', updatedAt: nowSec() })
    .where(eq(s.tournaments.id, tournamentId));
}

/* ------------------------------------------------------------------ *
 * Group formats (round-robin & Swiss) — standings, completion, and Swiss's
 * per-round generation.
 * ------------------------------------------------------------------ */

/** Standings for a group-format tournament, computed from its played matches. */
export async function loadStandings(database: DB, tournamentId: number): Promise<StandingRow[]> {
  const entrants = await database
    .select({ id: s.tournamentEntrants.id })
    .from(s.tournamentEntrants)
    .where(and(eq(s.tournamentEntrants.tournamentId, tournamentId), eq(s.tournamentEntrants.status, 'registered')))
    .orderBy(asc(s.tournamentEntrants.seed), asc(s.tournamentEntrants.id));
  const matches = await database
    .select({
      entrant1Id: s.tournamentMatches.entrant1Id,
      entrant2Id: s.tournamentMatches.entrant2Id,
      winnerId: s.tournamentMatches.winnerId,
      score1: s.tournamentMatches.score1,
      score2: s.tournamentMatches.score2,
      status: s.tournamentMatches.status,
    })
    .from(s.tournamentMatches)
    .where(eq(s.tournamentMatches.tournamentId, tournamentId));
  return computeStandings(entrants.map((e) => e.id), matches);
}

/** The display name of a completed tournament's champion, or null. Champion is
 *  the top of standings (group formats) or the deciding-match winner (elim). */
export async function championName(database: DB, tournamentId: number): Promise<string | null> {
  const t = await database.query.tournaments.findFirst({
    where: eq(s.tournaments.id, tournamentId),
    columns: { status: true, format: true },
  });
  if (!t || t.status !== 'complete') return null;

  let championEntrantId: number | null = null;
  if (t.format === 'round_robin' || t.format === 'swiss') {
    const standings = await loadStandings(database, tournamentId);
    championEntrantId = standings[0]?.entrantId ?? null;
  } else {
    const matches = await loadMatches(database, tournamentId);
    const decider =
      matches.find((m) => m.bracket === 'grand_final') ??
      matches.filter((m) => m.bracket === 'winners' && m.slot === 0).sort((a, b) => b.round - a.round)[0];
    championEntrantId = decider?.winnerId ?? null;
  }
  if (championEntrantId == null) return null;
  const entrants = await loadEntrants(database, tournamentId);
  return entrants.find((e) => e.id === championEntrantId)?.name ?? null;
}

/** Mark a group-format tournament complete once every scheduled match is in and
 *  (for Swiss) the last round has been played. Returns true if it completed. */
async function maybeCompleteGroup(
  database: DB,
  tournament: { id: number; format: string; swissRounds: number },
): Promise<boolean> {
  const rows = await database
    .select({ status: s.tournamentMatches.status, round: s.tournamentMatches.round })
    .from(s.tournamentMatches)
    .where(eq(s.tournamentMatches.tournamentId, tournament.id));
  if (!rows.length) return false;
  const allDone = rows.every((r) => r.status === 'complete' || r.status === 'bye');
  if (!allDone) return false;
  if (tournament.format === 'swiss') {
    const maxRound = Math.max(...rows.map((r) => r.round));
    if (maxRound < tournament.swissRounds) return false; // more rounds to pair
  }
  await database
    .update(s.tournaments)
    .set({ status: 'complete', updatedAt: nowSec() })
    .where(eq(s.tournaments.id, tournament.id));
  // The winner is the top of the final standings.
  const standings = await loadStandings(database, tournament.id);
  if (standings[0]) await awardChampionMedal(database, tournament.id, standings[0].entrantId);
  return true;
}

/** Generate the next Swiss round from the current standings, avoiding rematches. */
export async function generateNextSwissRound(
  database: DB,
  tournament: { id: number; format: string; status: string; swissRounds: number },
): Promise<{ ok: boolean; error?: string; code?: number; round?: number }> {
  if (tournament.format !== 'swiss') return { ok: false, code: 400, error: 'Only Swiss tournaments generate rounds.' };
  if (tournament.status !== 'in_progress') return { ok: false, code: 400, error: 'The tournament isn’t running.' };

  const matches = await database
    .select({
      round: s.tournamentMatches.round,
      entrant1Id: s.tournamentMatches.entrant1Id,
      entrant2Id: s.tournamentMatches.entrant2Id,
      winnerId: s.tournamentMatches.winnerId,
      score1: s.tournamentMatches.score1,
      score2: s.tournamentMatches.score2,
      status: s.tournamentMatches.status,
    })
    .from(s.tournamentMatches)
    .where(eq(s.tournamentMatches.tournamentId, tournament.id));

  const maxRound = matches.length ? Math.max(...matches.map((m) => m.round)) : 0;
  if (maxRound >= tournament.swissRounds) return { ok: false, code: 400, error: 'All Swiss rounds have been played.' };
  const current = matches.filter((m) => m.round === maxRound);
  if (!current.every((m) => m.status === 'complete' || m.status === 'bye')) {
    return { ok: false, code: 400, error: 'Finish the current round before generating the next.' };
  }

  const entrants = await database
    .select({ id: s.tournamentEntrants.id })
    .from(s.tournamentEntrants)
    .where(and(eq(s.tournamentEntrants.tournamentId, tournament.id), eq(s.tournamentEntrants.status, 'registered')))
    .orderBy(asc(s.tournamentEntrants.seed), asc(s.tournamentEntrants.id));
  const ids = entrants.map((e) => e.id);
  const ordered = computeStandings(ids, matches).map((r) => r.entrantId);

  const played = new Set<string>();
  const byeGiven = new Set<number>();
  for (const m of matches) {
    if (m.entrant1Id != null && m.entrant2Id == null) byeGiven.add(m.entrant1Id);
    else if (m.entrant1Id != null && m.entrant2Id != null) played.add(pairKey(m.entrant1Id, m.entrant2Id));
  }

  const newRound = planSwissRound(ordered, maxRound + 1, played, byeGiven);
  if (newRound.length) {
    await database.insert(s.tournamentMatches).values(
      newRound.map((m) => ({
        tournamentId: tournament.id,
        bracket: 'group' as const,
        round: m.round,
        slot: m.slot,
        entrant1Id: m.entrant1Id,
        entrant2Id: m.entrant2Id,
        winnerId: m.winnerId,
        status: m.status,
      })),
    );
  }
  // A round of only byes (shouldn't happen) still counts; check completion.
  await maybeCompleteGroup(database, tournament);
  return { ok: true, round: maxRound + 1 };
}

/* ------------------------------------------------------------------ *
 * Champion medal — an optional, install-wide setting: award a chosen medal to
 * the winner of every tournament when it completes. For a team champion, every
 * member of the team gets it. Idempotent (a held medal is skipped).
 * ------------------------------------------------------------------ */

export const TOURNAMENTS_SETTINGS_KEY = 'tournaments';

export interface TournamentSettings {
  championMedalId: number | null;
}

export async function loadTournamentSettings(database: DB): Promise<TournamentSettings> {
  const row = await database.query.settings.findFirst({ where: eq(s.settings.key, TOURNAMENTS_SETTINGS_KEY) });
  const v = (row?.value ?? {}) as { championMedalId?: unknown };
  const id = Number(v.championMedalId);
  return { championMedalId: Number.isInteger(id) && id > 0 ? id : null };
}

/** The member user-ids that make up an entrant (one for individuals, the whole
 *  roster for a team). */
async function entrantUserIds(database: DB, entrantId: number): Promise<number[]> {
  const entrant = await database.query.tournamentEntrants.findFirst({
    where: eq(s.tournamentEntrants.id, entrantId),
    columns: { userId: true },
  });
  if (entrant?.userId) return [entrant.userId];
  const members = await database
    .select({ userId: s.tournamentTeamMembers.userId })
    .from(s.tournamentTeamMembers)
    .where(eq(s.tournamentTeamMembers.entrantId, entrantId));
  return members.map((m) => m.userId);
}

/** Award the configured champion medal to a tournament's winner, if one is set. */
export async function awardChampionMedal(database: DB, tournamentId: number, championEntrantId: number): Promise<void> {
  const { championMedalId } = await loadTournamentSettings(database);
  if (!championMedalId) return;
  const medal = await database.query.medals.findFirst({ where: eq(s.medals.id, championMedalId), columns: { id: true } });
  if (!medal) return;

  const userIds = await entrantUserIds(database, championEntrantId);
  if (!userIds.length) return;
  const tournament = await database.query.tournaments.findFirst({
    where: eq(s.tournaments.id, tournamentId),
    columns: { name: true },
  });
  const citation = `Won ${tournament?.name ?? 'a tournament'}`;

  const existing = await database
    .select({ userId: s.memberMedals.userId })
    .from(s.memberMedals)
    .where(and(eq(s.memberMedals.medalId, championMedalId), inArray(s.memberMedals.userId, userIds)));
  const held = new Set(existing.map((e) => e.userId));

  const toAward = userIds.filter((id) => !held.has(id));
  if (!toAward.length) return;
  await database.insert(s.memberMedals).values(
    toAward.map((userId) => ({ userId, medalId: championMedalId, citation, awardedBy: null })),
  );
}

/* ------------------------------------------------------------------ *
 * Reporting a result
 * ------------------------------------------------------------------ */

export interface ReportResult {
  ok: boolean;
  error?: string;
  code?: number;
  champion?: number | null;
}

export async function reportMatchResult(
  database: DB,
  tournamentId: number,
  matchId: number,
  winnerEntrantId: number,
  scores: { score1: number; score2: number },
  reportedBy: number,
): Promise<ReportResult> {
  const match = await database.query.tournamentMatches.findFirst({
    where: and(eq(s.tournamentMatches.id, matchId), eq(s.tournamentMatches.tournamentId, tournamentId)),
  });
  if (!match) return { ok: false, code: 404, error: 'No such match.' };
  if (match.status === 'bye') return { ok: false, code: 400, error: 'A bye has no result to report.' };
  if (match.entrant1Id == null || match.entrant2Id == null) {
    return { ok: false, code: 400, error: 'Both competitors must be decided before reporting.' };
  }
  if (winnerEntrantId !== match.entrant1Id && winnerEntrantId !== match.entrant2Id) {
    return { ok: false, code: 400, error: 'The winner must be one of the two competitors.' };
  }
  // Guard against changing a result whose winner has already advanced and
  // played on — that would desync the downstream bracket. Re-reporting is only
  // allowed while the next match hasn't been decided.
  if (match.status === 'complete' && match.winnerNextMatchId != null) {
    const next = await database.query.tournamentMatches.findFirst({
      where: eq(s.tournamentMatches.id, match.winnerNextMatchId),
      columns: { status: true },
    });
    if (next && next.status === 'complete') {
      return { ok: false, code: 409, error: 'Can’t change this result — a later match already depends on it.' };
    }
  }

  const node: MatchNode = {
    id: match.id,
    bracket: match.bracket as BracketSide,
    slot: match.slot,
    entrant1Id: match.entrant1Id,
    entrant2Id: match.entrant2Id,
    winnerId: match.winnerId,
    status: match.status as MatchStatus,
    winnerNextMatchId: match.winnerNextMatchId,
    winnerNextSlot: match.winnerNextSlot,
    loserNextMatchId: match.loserNextMatchId,
    loserNextSlot: match.loserNextSlot,
  };

  // Load the one or two "next" rows the winner/loser advance into.
  const feed = new Map<number, MatchNode>();
  for (const nextId of [match.winnerNextMatchId, match.loserNextMatchId]) {
    if (nextId == null) continue;
    const row = await database.query.tournamentMatches.findFirst({ where: eq(s.tournamentMatches.id, nextId) });
    if (row) {
      feed.set(row.id, {
        id: row.id,
        bracket: row.bracket as BracketSide,
        slot: row.slot,
        entrant1Id: row.entrant1Id,
        entrant2Id: row.entrant2Id,
        winnerId: row.winnerId,
        status: row.status as MatchStatus,
        winnerNextMatchId: row.winnerNextMatchId,
        winnerNextSlot: row.winnerNextSlot,
        loserNextMatchId: row.loserNextMatchId,
        loserNextSlot: row.loserNextSlot,
      });
    }
  }

  const outcome = applyResult(node, winnerEntrantId, scores, feed);

  const stmts = outcome.patches.map((p) => {
    const set: Record<string, unknown> = {};
    if ('entrant1Id' in p) set.entrant1Id = p.entrant1Id;
    if ('entrant2Id' in p) set.entrant2Id = p.entrant2Id;
    if ('winnerId' in p) set.winnerId = p.winnerId;
    if ('score1' in p) set.score1 = p.score1;
    if ('score2' in p) set.score2 = p.score2;
    if ('status' in p) set.status = p.status;
    if (p.id === match.id) {
      set.reportedBy = reportedBy;
      set.reportedAt = nowSec();
    }
    return database.update(s.tournamentMatches).set(set).where(eq(s.tournamentMatches.id, p.id));
  });
  if (stmts.length) await database.batch(stmts as [typeof stmts[number], ...typeof stmts]);

  if (outcome.champion != null) {
    await database
      .update(s.tournaments)
      .set({ status: 'complete', updatedAt: nowSec() })
      .where(eq(s.tournaments.id, tournamentId));
    await awardChampionMedal(database, tournamentId, outcome.champion);
  } else if (match.bracket === 'group') {
    // Group formats have no per-match champion; the tournament completes when
    // the whole schedule is in (and, for Swiss, the last round is played).
    const t = await database.query.tournaments.findFirst({
      where: eq(s.tournaments.id, tournamentId),
      columns: { format: true, swissRounds: true },
    });
    if (t) await maybeCompleteGroup(database, { id: tournamentId, format: t.format, swissRounds: t.swissRounds });
  }

  return { ok: true, champion: outcome.champion };
}

export { slugify as tournamentSlugify, uniqueSlug as uniqueTournamentSlug };
