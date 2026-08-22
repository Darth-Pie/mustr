/**
 * Cross-org tournament federation — the wire contract for SHARED tournaments,
 * layered on top of the alliance pipe (see shared/alliance.ts).
 *
 * One org HOSTS a tournament; its own tournament tables are the source of truth.
 * Allied orgs SUBSCRIBE: they keep a read-only MIRROR of the tournament, field
 * entrants into it, and receive standings/champion snapshots back. Three message
 * types travel the token-authed federation channel:
 *
 *  - offer  (host → subscribers): "I'm hosting T." Subscriber upserts a mirror.
 *  - entry  (subscriber → host):  "We field this competitor." Host adds a
 *                                 name-only entrant tagged with the ally's org.
 *  - update (host → subscribers): status + standings snapshot + champion.
 *
 * Like alliance.ts this is the trust boundary for inbound data: every string is
 * length-capped and stripped of live Discord mentions, and identity fields that
 * matter for authorization (which org an entry is FROM, which org is the host)
 * are NEVER read from the payload — they're derived from the authenticated
 * alliance link server-side. The sanitizers here only shape the display data.
 */

import { neutralizeMentions } from './alliance';
import {
  TOURNAMENT_FORMATS,
  COMPETITOR_TYPES,
  type TournamentFormat,
  type CompetitorType,
  type TournamentStatus,
} from './tournament';

/** Contract version — receivers can reject incompatible senders later. */
export const ALLIANCE_TOURNAMENT_V = 1 as const;

const TOURNAMENT_STATUSES: TournamentStatus[] = ['draft', 'registration', 'seeding', 'in_progress', 'complete'];

/** Host → subscribers: an offer to take part in a hosted tournament. */
export interface TournamentOffer {
  v: 1;
  /** The host's opaque tournament reference (its numeric id, stringified). */
  ref: string;
  name: string;
  format: TournamentFormat;
  competitorType: CompetitorType;
  status: TournamentStatus;
  startsAt: number | null;
  /** True while entrants may still be submitted. */
  registrationOpen: boolean;
  /** Absolute link to the host's bracket page. */
  url?: string;
  /** The offer is withdrawn (tournament deleted or un-shared). */
  closed?: boolean;
}

/** Subscriber → host: field a competitor in the hosted tournament. */
export interface TournamentEntry {
  v: 1;
  ref: string;
  /** Subscriber-unique id for this entry, so retries are idempotent. */
  entryId: string;
  /** Display name of the competitor (team name, or a player's name). */
  name: string;
  /** Pull a previously-submitted entry. */
  withdraw?: boolean;
}

/** One row of a standings snapshot shipped to subscribers. */
export interface StandingSnapshot {
  name: string;
  wins: number;
  losses: number;
  rank: number;
}

/** Host → subscribers: a status / standings / champion snapshot. */
export interface TournamentUpdate {
  v: 1;
  ref: string;
  status: TournamentStatus;
  /** Group-format standings (round-robin / Swiss); omitted for elimination. */
  standings?: StandingSnapshot[];
  /** Champion display name once complete. */
  champion?: string | null;
  url?: string;
}

/* ------------------------------------------------------------------ *
 * Sanitizers — coerce untrusted inbound JSON into safe shapes, or null.
 * ------------------------------------------------------------------ */

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? neutralizeMentions(v.slice(0, max)) : '';
}

function ref(v: unknown): string {
  // A ref is an opaque short token (we use a numeric id). Keep it tight.
  return typeof v === 'string' ? v.slice(0, 64).replace(/[^\w:-]/g, '') : '';
}

function httpUrl(v: unknown): string | undefined {
  const t = typeof v === 'string' ? v.slice(0, 500).trim() : '';
  return /^https?:\/\//i.test(t) ? t : undefined;
}

function intOrNull(v: unknown): number | null {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function sanitizeTournamentOffer(raw: unknown): TournamentOffer | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) return null;
  const r = ref(o.ref);
  if (!r) return null;
  const name = str(o.name, 120).trim();
  if (!name) return null;
  const format = TOURNAMENT_FORMATS.includes(o.format as TournamentFormat)
    ? (o.format as TournamentFormat)
    : 'single_elim';
  const competitorType = COMPETITOR_TYPES.includes(o.competitorType as CompetitorType)
    ? (o.competitorType as CompetitorType)
    : 'individual';
  const status = TOURNAMENT_STATUSES.includes(o.status as TournamentStatus)
    ? (o.status as TournamentStatus)
    : 'registration';
  const url = httpUrl(o.url);
  return {
    v: 1,
    ref: r,
    name,
    format,
    competitorType,
    status,
    startsAt: intOrNull(o.startsAt),
    registrationOpen: o.registrationOpen === true,
    ...(url ? { url } : {}),
    ...(o.closed === true ? { closed: true } : {}),
  };
}

export function sanitizeTournamentEntry(raw: unknown): TournamentEntry | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) return null;
  const r = ref(o.ref);
  const entryId = ref(o.entryId);
  if (!r || !entryId) return null;
  const name = str(o.name, 80).trim();
  const withdraw = o.withdraw === true;
  // A withdraw needs no name; a submission does.
  if (!withdraw && !name) return null;
  return { v: 1, ref: r, entryId, name, ...(withdraw ? { withdraw: true } : {}) };
}

export function sanitizeTournamentUpdate(raw: unknown): TournamentUpdate | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) return null;
  const r = ref(o.ref);
  if (!r) return null;
  const status = TOURNAMENT_STATUSES.includes(o.status as TournamentStatus)
    ? (o.status as TournamentStatus)
    : 'in_progress';
  const url = httpUrl(o.url);
  const championRaw = str(o.champion, 80).trim();
  const champion = championRaw || (o.champion === null ? null : undefined);

  let standings: StandingSnapshot[] | undefined;
  if (Array.isArray(o.standings)) {
    standings = o.standings
      .slice(0, 64)
      .map((row) => {
        const rr = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
        return {
          name: str(rr.name, 80).trim() || 'Entrant',
          wins: Math.max(0, Math.round(Number(rr.wins) || 0)),
          losses: Math.max(0, Math.round(Number(rr.losses) || 0)),
          rank: Math.max(0, Math.round(Number(rr.rank) || 0)),
        };
      });
  }

  return {
    v: 1,
    ref: r,
    status,
    ...(standings ? { standings } : {}),
    ...(champion !== undefined ? { champion } : {}),
    ...(url ? { url } : {}),
  };
}
