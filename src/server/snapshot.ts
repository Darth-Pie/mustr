/**
 * Site snapshot & restore — the engine behind the God-only "Backups" tool.
 *
 * A snapshot is a full capture of every content / configuration / roster table
 * as JSON. A restore wipes those tables and reloads them from a snapshot, in one
 * atomic D1 batch, so a half-applied restore can never happen.
 *
 * Deliberately EXCLUDED from both capture and restore:
 *  - `sessions` / `api_tokens` — transient auth artifacts, not "site standing".
 *    (Restoring users cascade-deletes sessions anyway; the acting God's session
 *    is re-minted by the route after a restore so they stay signed in.)
 *  - `site_snapshots` — the snapshots themselves, so a restore can't delete the
 *    very restore points it's chosen from (and the payloads live in R2 besides).
 *
 * The one authority on all of this is TABLES below: an ordered list, PARENTS
 * FIRST. Capture reads in this order; restore inserts in this order and deletes
 * in reverse (children first), which keeps every foreign key satisfied at each
 * step regardless of whether D1 is enforcing them.
 */

import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as s from '../db/schema';

type DB = DrizzleD1Database<typeof s>;

/**
 * Every table that makes up "the site", in dependency order (a table appears
 * after every table it references). The `name` is the stable key used in the
 * JSON payload — changing one would orphan older snapshots, so don't.
 */
const TABLES: { name: string; table: SQLiteTable }[] = [
  // Roots — referenced by others, reference nothing (or only set-null self).
  { name: 'ranks', table: s.ranks },
  { name: 'roles', table: s.roles },
  { name: 'games', table: s.games },
  { name: 'trainingSections', table: s.trainingSections },
  // Users depend on ranks (rankId → set null).
  { name: 'users', table: s.users },
  // First-generation dependents (on users / games / sections).
  { name: 'medals', table: s.medals },
  { name: 'warRecords', table: s.warRecords },
  { name: 'matches', table: s.matches },
  { name: 'events', table: s.events },
  { name: 'news', table: s.news },
  { name: 'trainings', table: s.trainings },
  { name: 'pageLayouts', table: s.pageLayouts },
  { name: 'galleryAlbums', table: s.galleryAlbums },
  { name: 'notifications', table: s.notifications },
  { name: 'tournaments', table: s.tournaments },
  { name: 'settings', table: s.settings },
  { name: 'auditLog', table: s.auditLog },
  { name: 'bans', table: s.bans },
  { name: 'profiles', table: s.profiles },
  { name: 'scHangars', table: s.scHangars },
  { name: 'scCcuBoards', table: s.scCcuBoards },
  { name: 'scVerifications', table: s.scVerifications },
  { name: 'memberActivity', table: s.memberActivity },
  // Join / leaf tables (depend on the above).
  { name: 'rolePermissions', table: s.rolePermissions },
  { name: 'userRoles', table: s.userRoles },
  { name: 'rankRoles', table: s.rankRoles },
  { name: 'roleChannels', table: s.roleChannels },
  { name: 'trainingRequiredRanks', table: s.trainingRequiredRanks },
  { name: 'trainingCompletions', table: s.trainingCompletions },
  { name: 'memberMedals', table: s.memberMedals },
  { name: 'memberWarRecords', table: s.memberWarRecords },
  { name: 'matchParticipants', table: s.matchParticipants },
  { name: 'eventRoles', table: s.eventRoles },
  { name: 'eventSignups', table: s.eventSignups },
  { name: 'eventAttendance', table: s.eventAttendance },
  { name: 'galleryItems', table: s.galleryItems },
  { name: 'notificationReads', table: s.notificationReads },
  // Tournament entrants/roster/matches (entrants before matches, which
  // reference them via entrant1/2/winner → set null).
  { name: 'tournamentEntrants', table: s.tournamentEntrants },
  { name: 'tournamentTeamMembers', table: s.tournamentTeamMembers },
  { name: 'tournamentMatches', table: s.tournamentMatches },
];

export const SNAPSHOT_VERSION = 1 as const;

export interface SnapshotPayload {
  version: number;
  capturedAt: number;
  /** table name → its rows, exactly as drizzle selects them. */
  tables: Record<string, Record<string, unknown>[]>;
}

export interface CaptureResult {
  payload: SnapshotPayload;
  counts: Record<string, number>;
  rowTotal: number;
}

/**
 * A safety ceiling. A restore has to fit in a single D1 batch to stay atomic;
 * far below that, an install this size should use D1 Time Travel, not an
 * in-app JSON snapshot. This keeps the feature honest about its scope.
 */
const MAX_ROWS = 50_000;

/** Read every in-scope table into a portable JSON payload. */
export async function captureSnapshot(db: DB): Promise<CaptureResult> {
  const tables: Record<string, Record<string, unknown>[]> = {};
  const counts: Record<string, number> = {};
  let rowTotal = 0;

  for (const { name, table } of TABLES) {
    const rows = (await db.select().from(table)) as Record<string, unknown>[];
    tables[name] = rows;
    counts[name] = rows.length;
    rowTotal += rows.length;
  }

  return {
    payload: { version: SNAPSHOT_VERSION, capturedAt: Math.floor(Date.now() / 1000), tables },
    counts,
    rowTotal,
  };
}

export class SnapshotError extends Error {}

/** True if the payload includes a god-flagged row for `userId` — the guard that
 *  stops a God restoring a snapshot that would strip their own access. */
export function payloadHasGod(payload: SnapshotPayload, userId: number): boolean {
  const users = payload.tables?.users;
  if (!Array.isArray(users)) return false;
  return users.some((u) => Number(u.id) === userId && Boolean(u.isGod));
}

/** Total rows a payload will write — used for the batch-size guard and the UI. */
export function payloadRowTotal(payload: SnapshotPayload): number {
  let n = 0;
  for (const { name } of TABLES) n += payload.tables[name]?.length ?? 0;
  return n;
}

/**
 * Chunk multi-row inserts so no single statement blows past SQLite's bound-
 * parameter ceiling (32766). With ~30 columns on the widest table, 500 rows is
 * a comfortable margin; narrow tables just get bigger effective chunks for free.
 */
const INSERT_CHUNK = 500;

/**
 * Replace the entire in-scope database with a snapshot's contents, atomically.
 *
 * Builds one D1 batch: delete every table (children first), then insert every
 * table (parents first), chunked. D1 runs a batch in an implicit transaction —
 * all statements commit together or none do — so the site is never left half
 * restored. The caller is responsible for re-establishing the acting user's
 * session afterward (their old one is cascade-deleted with the users wipe).
 */
export async function restoreSnapshot(db: DB, payload: SnapshotPayload): Promise<void> {
  if (payload.version !== SNAPSHOT_VERSION) {
    throw new SnapshotError(
      `This snapshot was made by a different version (v${payload.version}) and can't be restored by this build.`,
    );
  }
  if (payloadRowTotal(payload) > MAX_ROWS) {
    throw new SnapshotError(
      'This snapshot is too large to restore in one atomic step. Use Cloudflare D1 Time Travel for a database this size.',
    );
  }

  // drizzle's D1 batch wants a non-empty tuple; assemble as a plain array and
  // cast at the call. Each entry is a prepared drizzle query (not awaited).
  const stmts: unknown[] = [];

  // 1) Wipe, children first (reverse dependency order).
  for (let i = TABLES.length - 1; i >= 0; i--) {
    stmts.push(db.delete(TABLES[i]!.table));
  }

  // 2) Reload, parents first, chunked.
  for (const { name, table } of TABLES) {
    const rows = payload.tables[name];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      stmts.push(db.insert(table).values(chunk as never));
    }
  }

  if (stmts.length === 0) return;
  await db.batch(stmts as unknown as Parameters<DB['batch']>[0]);
}
