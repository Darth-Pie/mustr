/**
 * One-step alliance pairing — invites + the connect handshake.
 *
 * The fiddly way (still supported) is a two-way manual token exchange. This is
 * the easy way: one org mints an INVITE, hands the ally a single "connect
 * string" (their base URL + the invite token, bundled), and the ally pastes it
 * once. Redeeming performs a live handshake that establishes the FULL two-way
 * link in a single step:
 *
 *   inviter A                                   joiner B
 *   ─ mints invite (stores only its hash) ───▶  ─ pastes the connect string
 *                                               ─ mints token T_B (for A→B)
 *                        POST /connect  ◀─────  ─ sends {name,baseUrl,inboundToken:T_B}
 *   ─ validates invite, stores B's link,
 *     mints token T_A (for B→A), consumes ───▶  ─ stores A's link with T_A
 *
 * Both ends finish with a link whose outboundToken is the OTHER side's inbound
 * token (plaintext, to call them) and whose inboundTokenHash authenticates the
 * calls they make to us — exactly the shape the manual flow produces. The invite
 * is single-use and expiring, so a leaked code can't be replayed.
 */

import { and, eq, isNull, gt } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { Env } from '../env';
import type { db as makeDb } from '../middleware/auth';
import { loadConfig } from '../config';
import { randomToken, sha256Base64url } from '../auth/crypto';
import { mintAllianceToken, postJsonToAlly } from './federation';
import { ALLIANCE_INVITE_PREFIX, cleanBaseUrl, encodeConnectString } from '../../shared/alliance';

type DB = ReturnType<typeof makeDb>;
type AllianceLink = typeof s.allianceLinks.$inferSelect;

const nowSec = () => Math.floor(Date.now() / 1000);
const INVITE_TTL_DAYS = 7;

/* ------------------------------------------------------------------ *
 * Invite lifecycle
 * ------------------------------------------------------------------ */

export interface MintedInvite {
  id: number;
  token: string;
  prefix: string;
  connectString: string;
  expiresAt: number;
}

/** Mint an invite, returning the plaintext token + connect string (shown once). */
export async function mintInvite(env: Env, database: DB, createdBy: number, label: string): Promise<MintedInvite> {
  const token = `${ALLIANCE_INVITE_PREFIX}${randomToken()}`;
  const prefix = token.slice(0, ALLIANCE_INVITE_PREFIX.length + 6);
  const hash = await sha256Base64url(token);
  const expiresAt = nowSec() + INVITE_TTL_DAYS * 86400;

  const inserted = await database
    .insert(s.allianceInvites)
    .values({ tokenHash: hash, tokenPrefix: prefix, label: label || null, expiresAt, createdBy })
    .returning({ id: s.allianceInvites.id });

  const cfg = await loadConfig(env, database);
  const connectString = encodeConnectString(cfg.siteUrl, token);
  return { id: inserted[0]!.id, token, prefix, connectString, expiresAt };
}

/** Resolve a valid (unexpired, unconsumed) invite by its token, or null. */
export async function resolveInvite(database: DB, token: string | undefined) {
  if (!token || !token.startsWith(ALLIANCE_INVITE_PREFIX)) return null;
  const hash = await sha256Base64url(token);
  const invite = await database.query.allianceInvites.findFirst({
    where: and(
      eq(s.allianceInvites.tokenHash, hash),
      isNull(s.allianceInvites.consumedAt),
      gt(s.allianceInvites.expiresAt, nowSec()),
    ),
  });
  return invite ?? null;
}

/* ------------------------------------------------------------------ *
 * Link upsert — one link per ally base URL, so re-pairing refreshes rather
 * than duplicates. Channel + id are preserved on update.
 * ------------------------------------------------------------------ */

interface LinkFields {
  name: string;
  baseUrl: string;
  outboundToken: string;
  inboundTokenHash: string;
  inboundTokenPrefix: string;
  createdBy: number | null;
}

async function upsertLink(database: DB, f: LinkFields): Promise<AllianceLink> {
  const existing = await database.query.allianceLinks.findFirst({ where: eq(s.allianceLinks.baseUrl, f.baseUrl) });
  if (existing) {
    const updated = await database
      .update(s.allianceLinks)
      .set({
        name: f.name,
        outboundToken: f.outboundToken,
        inboundTokenHash: f.inboundTokenHash,
        inboundTokenPrefix: f.inboundTokenPrefix,
        enabled: true,
      })
      .where(eq(s.allianceLinks.id, existing.id))
      .returning();
    return updated[0]!;
  }
  const inserted = await database
    .insert(s.allianceLinks)
    .values({
      name: f.name,
      baseUrl: f.baseUrl,
      outboundToken: f.outboundToken,
      inboundTokenHash: f.inboundTokenHash,
      inboundTokenPrefix: f.inboundTokenPrefix,
      createdBy: f.createdBy,
    })
    .returning();
  return inserted[0]!;
}

/* ------------------------------------------------------------------ *
 * INVITER side — handle an ally redeeming our invite (public /connect).
 * ------------------------------------------------------------------ */

export interface ConnectResult {
  ok: boolean;
  error?: string;
  code?: number;
  response?: { name: string; inboundToken: string };
}

/**
 * Redeem an invite: the joiner sent us their name/baseUrl and the token WE use to
 * call them. We store their link, mint the token THEY use to call us, consume the
 * invite, and return our name + that token. Identity is what they present here;
 * the invite is the authorization, and it's burned on success.
 */
export async function handleConnect(
  env: Env,
  database: DB,
  invite: typeof s.allianceInvites.$inferSelect,
  payload: { name?: unknown; baseUrl?: unknown; inboundToken?: unknown },
): Promise<ConnectResult> {
  const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 80) : '';
  const baseUrl = cleanBaseUrl(payload.baseUrl);
  const theirToken = typeof payload.inboundToken === 'string' ? payload.inboundToken.trim().slice(0, 200) : '';
  if (!name || !baseUrl || !theirToken) {
    return { ok: false, code: 400, error: 'Malformed connect request.' };
  }

  const mine = await mintAllianceToken(); // the token THEY will use to call US
  const link = await upsertLink(database, {
    name,
    baseUrl,
    outboundToken: theirToken,
    inboundTokenHash: mine.hash,
    inboundTokenPrefix: mine.prefix,
    createdBy: invite.createdBy,
  });

  await database
    .update(s.allianceInvites)
    .set({ consumedAt: nowSec(), consumedLinkId: link.id })
    .where(eq(s.allianceInvites.id, invite.id));

  const cfg = await loadConfig(env, database);
  return { ok: true, response: { name: cfg.siteName || 'an allied org', inboundToken: mine.token } };
}

/* ------------------------------------------------------------------ *
 * JOINER side — redeem a connect string against the inviting org.
 * ------------------------------------------------------------------ */

export interface JoinResult {
  ok: boolean;
  error?: string;
  code?: number;
  link?: AllianceLink;
}

/**
 * Redeem a connect string: mint the token the inviter will use to call us, POST
 * it (with our identity) to their /connect authenticated by the invite token,
 * and on success store the finished two-way link from their response.
 */
export async function joinAlliance(
  env: Env,
  database: DB,
  target: { url: string; token: string },
  createdBy: number,
): Promise<JoinResult> {
  const cfg = await loadConfig(env, database);
  if (!cfg.siteUrl) {
    return { ok: false, code: 400, error: 'Set this site’s public URL (Settings → Identity) before joining an alliance.' };
  }

  const mine = await mintAllianceToken(); // the token the INVITER will use to call US
  const resp = await postJsonToAlly(
    { baseUrl: target.url, outboundToken: target.token },
    '/api/alliance/connect',
    { name: cfg.siteName || 'an allied org', baseUrl: cfg.siteUrl, inboundToken: mine.token },
  );
  if (!resp) return { ok: false, code: 502, error: 'Couldn’t reach that org — check the code and that their site is live.' };
  if (!resp.ok) {
    const data = (await resp.json().catch(() => ({}))) as { error?: string };
    return { ok: false, code: 400, error: data.error || 'That invite was rejected (it may be used or expired).' };
  }

  const data = (await resp.json().catch(() => ({}))) as { name?: string; inboundToken?: string };
  if (!data.inboundToken) return { ok: false, code: 502, error: 'The host didn’t complete the handshake.' };

  const link = await upsertLink(database, {
    name: (data.name || 'an allied org').slice(0, 80),
    baseUrl: target.url,
    outboundToken: data.inboundToken, // the token WE use to call THEM
    inboundTokenHash: mine.hash, // authenticates THEIR calls to us
    inboundTokenPrefix: mine.prefix,
    createdBy,
  });
  return { ok: true, link };
}
