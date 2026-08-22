/**
 * A minimal fixed-window rate limiter backed by D1's rate_limit_hits table.
 *
 * Only meant for the handful of routes reachable without an existing
 * session/permission check: the setup-token unlock (brute-forceable if a buyer
 * picks a short SETUP_TOKEN) and the public alliance-federation endpoints
 * (authed by a bearer token, but nothing previously bounded how often a valid
 * or fabricated token could be thrown at them). It is deliberately crude —
 * fixed windows, not sliding, and a plain D1 read+write rather than an atomic
 * increment — because the goal is raising the cost of abuse, not perfect
 * accuracy; a determined attacker with many source IPs isn't stopped by this
 * (that needs Cloudflare-level WAF rules, which a self-hosted buyer may or may
 * not configure). It IS enough to shut down a naive brute-force loop or a
 * misbehaving/compromised alliance peer hammering one endpoint.
 */

import { eq, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as s from '../db/schema';

type DB = DrizzleD1Database<typeof s>;

/**
 * True if `key` has exceeded `max` hits within the current `windowSeconds`
 * window, in which case the caller should reject the request. Otherwise
 * records this hit and returns false. A window resets (rather than sliding)
 * once `windowSeconds` has elapsed since it started.
 *
 * Self-healing: the setup-unlock caller needs this to work on a completely
 * empty, freshly-deployed D1 — before ensureSchema() has ever run, so before
 * rate_limit_hits (or any other table) exists. Rather than fail open in that
 * state (which would make this a no-op for exactly the brute-force attempts
 * it exists to stop, since the DB stays empty for every WRONG guess), create
 * the table on demand and retry once.
 */
export async function isRateLimited(
  db: DB,
  key: string,
  opts: { max: number; windowSeconds: number },
): Promise<boolean> {
  try {
    return await attempt(db, key, opts);
  } catch {
    await db.run(sql`
      create table if not exists rate_limit_hits (
        key text primary key not null,
        window_start integer not null,
        count integer not null default 1
      )
    `);
    return await attempt(db, key, opts);
  }
}

async function attempt(db: DB, key: string, opts: { max: number; windowSeconds: number }): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.query.rateLimitHits.findFirst({ where: eq(s.rateLimitHits.key, key) });

  if (!row || now - row.windowStart >= opts.windowSeconds) {
    await db
      .insert(s.rateLimitHits)
      .values({ key, windowStart: now, count: 1 })
      .onConflictDoUpdate({ target: s.rateLimitHits.key, set: { windowStart: now, count: 1 } });
    return false;
  }

  if (row.count >= opts.max) return true;

  await db
    .update(s.rateLimitHits)
    .set({ count: row.count + 1 })
    .where(eq(s.rateLimitHits.key, key));
  return false;
}
