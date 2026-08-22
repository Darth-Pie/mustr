/**
 * Alliance federation — the engine behind cross-org broadcasts.
 *
 * Two directions:
 *  - OUTBOUND (fanOut): when this org originates an alliance broadcast, POST it to
 *    every enabled ally's `/api/alliance/inbound`, authenticated with the token
 *    THEY issued us. Fire-and-forget, per-ally isolated, short timeout — one dead
 *    or slow ally never blocks the others or the action that triggered it.
 *  - INBOUND (postBroadcastLocally): a sanitized broadcast arrived from an ally;
 *    post it to OUR configured channel via OUR own bot, labelled "via {origin}",
 *    with mentions fully disabled.
 *
 * Loop-prevention: only an originating action calls fanOut. The inbound route
 * posts locally and NEVER re-fans-out, so an A→B link can't ping-pong.
 */

import { drizzle } from 'drizzle-orm/d1';
import { and, eq } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { Env } from '../env';
import { discordClient, loadConfig } from '../config';
import { randomToken, sha256Base64url } from '../auth/crypto';
import { ALLIANCE_TOKEN_PREFIX, type AllianceBroadcast, type AllianceKind } from '../../shared/alliance';

type DB = ReturnType<typeof drizzle<typeof s>>;
type AllianceLink = typeof s.allianceLinks.$inferSelect;

/** How long we wait on a single ally before giving up (ms). */
const OUTBOUND_TIMEOUT_MS = 6000;

/** Mint a fresh scoped alliance token (the credential we hand an ally to call us). */
export async function mintAllianceToken(): Promise<{ token: string; prefix: string; hash: string }> {
  const token = `${ALLIANCE_TOKEN_PREFIX}${randomToken()}`;
  const prefix = token.slice(0, ALLIANCE_TOKEN_PREFIX.length + 6); // e.g. allc_ab12cd
  return { token, prefix, hash: await sha256Base64url(token) };
}

/**
 * Resolve an inbound Bearer token to the alliance link that issued it (i.e. which
 * ally is calling us), or null if unknown / the link is disabled. This is the
 * authentication for `/api/alliance/inbound`.
 */
export async function resolveInboundLink(db: DB, rawBearer: string | undefined): Promise<AllianceLink | null> {
  if (!rawBearer || !rawBearer.startsWith(ALLIANCE_TOKEN_PREFIX)) return null;
  const hash = await sha256Base64url(rawBearer);
  const link = await db.query.allianceLinks.findFirst({
    where: and(eq(s.allianceLinks.inboundTokenHash, hash), eq(s.allianceLinks.enabled, true)),
  });
  return link ?? null;
}

/** Build a broadcast originating from THIS org (stamps origin name + a fresh id). */
export async function makeBroadcast(
  env: Env,
  kind: AllianceKind,
  title: string,
  body: string,
  url?: string,
): Promise<AllianceBroadcast> {
  const cfg = await loadConfig(env);
  return {
    v: 1,
    id: crypto.randomUUID(),
    kind,
    origin: cfg.siteName || 'an allied org',
    title,
    body,
    ...(url ? { url } : {}),
  };
}

/**
 * Post an already-sanitized broadcast to our local Discord via our own bot.
 * Returns true if it was posted. No-ops (false) without a bot or a channel on the
 * link. Mentions are hard-disabled so an ally can never ping our members.
 */
export async function postBroadcastLocally(env: Env, db: DB, link: AllianceLink, b: AllianceBroadcast): Promise<boolean> {
  if (!link.channelId) return false;
  const rest = await discordClient(env, db);
  if (!rest) return false;

  const description = [b.body, b.url].filter(Boolean).join('\n\n') || undefined;
  await rest.createMessage(link.channelId, {
    embeds: [
      {
        author: { name: `via ${b.origin}` },
        color: 0x6433c8,
        ...(b.title ? { title: b.title } : {}),
        ...(description ? { description } : {}),
        footer: { text: 'Alliance broadcast' },
      },
    ],
    // The whole point of the trust boundary: an inbound broadcast pings nobody.
    allowed_mentions: { parse: [] },
  });
  return true;
}

/**
 * POST a JSON payload to one ally at `path`, authenticated with the token they
 * issued us. Bounded by a timeout; returns the Response, or null on network
 * error/timeout. The caller decides whether to read the body (synchronous
 * request/response, e.g. submitting a tournament entry) or ignore it (fire-and-
 * forget fan-out). Never throws.
 */
export async function postJsonToAlly(
  link: Pick<AllianceLink, 'baseUrl' | 'outboundToken'>,
  path: string,
  payload: unknown,
  timeoutMs = OUTBOUND_TIMEOUT_MS,
): Promise<Response | null> {
  if (!link.baseUrl || !link.outboundToken) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${link.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${link.outboundToken}` },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch {
    // Isolate: one dead/slow ally must never block the rest or the triggering action.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fan the same JSON payload out to every enabled, two-way ally at `path`. Safe to
 * call inside ctx.waitUntil — it isolates each ally, bounds each request, and
 * never throws. Used for broadcasts and for host→subscriber tournament pushes.
 */
export async function fanOutJson(env: Env, path: string, payload: unknown): Promise<void> {
  try {
    const db = drizzle(env.DB, { schema: s });
    const links = await db.query.allianceLinks.findMany({ where: eq(s.allianceLinks.enabled, true) });
    const targets = links.filter((l) => l.baseUrl && l.outboundToken);
    await Promise.allSettled(targets.map((l) => postJsonToAlly(l, path, payload)));
  } catch (err) {
    console.error(`Alliance fan-out (${path}) failed`, err);
  }
}

/**
 * Fan an originated broadcast out to every enabled ally. Safe to call inside
 * ctx.waitUntil — it isolates each ally, bounds each request with a timeout, and
 * never throws.
 */
export async function fanOut(env: Env, broadcast: AllianceBroadcast): Promise<void> {
  await fanOutJson(env, '/api/alliance/inbound', broadcast);
}
