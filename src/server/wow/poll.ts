/**
 * The World of Warcraft sweep — runs on its own five-minute cron (WOW_CRON), so
 * its Blizzard calls get their own 50-request budget instead of sharing the
 * Discord reconcile's.
 *
 * Each run: refresh the app token if needed, spend up to WOW_STATUS_CALLS_PER_RUN
 * calls on daily status checks (Blizzard's data-retention rule, see status.ts),
 * then check followed characters, least recently checked first, until
 * WOW_CALL_BUDGET calls are spent. Only characters in the site's current region
 * and Blizzard data section are touched. Equipment is only fetched when the
 * character has logged out since the last look. What changed becomes timeline
 * rows and badges, and is returned as events for medals and Discord (events.ts).
 *
 * Failures never pin the queue: every attempt is stamped before anything can
 * end the run, so a character whose requests keep failing moves to the back.
 * A 429 or Blizzard-side error ends the run (the next one carries on) and shows
 * on the admin card. A 401 means the app token went bad: it's dropped, so the
 * next run asks for a fresh one. Anything else wrong with one character —
 * including a 403 for a single profile — is logged and skipped.
 */

import { drizzle } from 'drizzle-orm/d1';
import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { Env } from '../env';
import { loadWowConfig, saveWowConfig, wowReady } from '../modules';
import type { BadgeKey, LevelRow, WowConfig } from '../../shared/wow';
import { appToken, BnetError, fetchEquipment, fetchStatus, fetchSummary, type FetchFn, type TokenStore } from './bnet';
import { diffCharacter, type EntryDraft } from './diff';
import { newBadges } from './badges';
import { statusDecision } from './status';
import { chunkByParams } from './d1';

type DB = ReturnType<typeof drizzle<typeof s>>;

export const WOW_CALL_BUDGET = 40;
export const WOW_STATUS_CALLS_PER_RUN = 10;
export const WOW_CRON = '2-59/5 * * * *';

const TOKEN_KEY = 'wow_token';
const HOUR = 3600;
const DAY = 86400;

export interface WowEvent {
  userId: number;
  characterId: number;
  characterName: string;
  className: string;
  firstCheck: boolean;
  /** Gear was read for the first time this check; its badges predate tracking. */
  gearBaseline: boolean;
  entries: EntryDraft[];
  badges: BadgeKey[];
}

export interface SweepOutcome {
  polled: number;
  statusChecked: number;
  deleted: number;
  stoppedEarly: boolean;
  events: WowEvent[];
}

/** Thrown by the counting fetch once the run's call budget is spent. */
class BudgetSpent extends Error {}

/** The site's app token, cached in settings until it nears expiry. */
export function settingsTokenStore(database: DB): TokenStore {
  return {
    async get() {
      const row = await database.query.settings.findFirst({ where: eq(s.settings.key, TOKEN_KEY) });
      const v = row?.value as { token?: unknown; expiresAt?: unknown } | undefined;
      return v && typeof v.token === 'string' && typeof v.expiresAt === 'number'
        ? { token: v.token, expiresAt: v.expiresAt }
        : null;
    },
    async set(v) {
      await database
        .insert(s.settings)
        .values({ key: TOKEN_KEY, value: v })
        .onConflictDoUpdate({ target: s.settings.key, set: { value: v } });
    },
  };
}

/** An error that should end the whole run rather than skip one character. */
const endsRun = (err: unknown) =>
  err instanceof BudgetSpent || (err instanceof BnetError && (err.retryable || err.status === 401));

/** Record (or clear) the sweep's last error without overwriting an admin's concurrent edit. */
async function recordError(env: Env, error: string | null, now: number) {
  const cfg = await loadWowConfig(env);
  if (cfg.lastError === error) return;
  await saveWowConfig(env, { ...cfg, lastError: error, lastErrorAt: error ? now : null }, null);
}

function timelineRow(characterId: number, e: EntryDraft): typeof s.wowTimeline.$inferInsert {
  const base = { characterId, kind: e.kind, seenAt: e.seenAt, sinceAt: e.sinceAt };
  switch (e.kind) {
    case 'tracking_started':
    case 'level':
      return { ...base, level: e.level };
    case 'item':
      return {
        ...base,
        slot: e.slot,
        itemId: e.item.itemId,
        itemName: e.item.name,
        itemQuality: e.item.quality,
        itemLevel: e.item.itemLevel,
        tag: e.tag,
      };
    case 'guild_join':
    case 'guild_leave':
      return { ...base, guildName: e.guildName };
  }
}

/** Followed characters in the site's current region and data section. */
const inScope = (cfg: WowConfig) =>
  and(
    eq(s.wowCharacters.followed, true),
    eq(s.wowCharacters.region, cfg.region),
    eq(s.wowCharacters.namespace, cfg.namespace),
  );

async function statusPass(database: DB, cfg: WowConfig, token: string, f: FetchFn, now: number, out: SweepOutcome) {
  const due = await database
    .select({
      id: s.wowCharacters.id,
      blizzardId: s.wowCharacters.blizzardId,
      realmSlug: s.wowCharacters.realmSlug,
      name: s.wowCharacters.name,
      statusFailures: s.wowCharacters.statusFailures,
    })
    .from(s.wowCharacters)
    .where(
      and(
        inScope(cfg),
        or(isNull(s.wowCharacters.lastValidatedAt), lt(s.wowCharacters.lastValidatedAt, now - DAY)),
        // A check that errored waits an hour, so it can't hog the queue.
        or(isNull(s.wowCharacters.statusAttemptAt), lt(s.wowCharacters.statusAttemptAt, now - HOUR)),
      ),
    )
    // SQLite sorts NULL first ascending: never-checked characters go first.
    .orderBy(asc(s.wowCharacters.statusAttemptAt))
    .limit(WOW_STATUS_CALLS_PER_RUN);

  for (const ch of due) {
    await database.update(s.wowCharacters).set({ statusAttemptAt: now }).where(eq(s.wowCharacters.id, ch.id));
    try {
      const decision = statusDecision(await fetchStatus(cfg, token, ch.realmSlug, ch.name, f), ch.blizzardId, ch.statusFailures);
      out.statusChecked++;
      if (decision.action === 'delete') {
        await database.delete(s.wowCharacters).where(eq(s.wowCharacters.id, ch.id));
        out.deleted++;
      } else {
        // A 404 also stamps the check time, so the next attempt is a day later —
        // three failures means three days, not three runs.
        await database
          .update(s.wowCharacters)
          .set({
            lastValidatedAt: now,
            statusFailures: decision.action === 'ok' ? 0 : decision.failures,
          })
          .where(eq(s.wowCharacters.id, ch.id));
      }
    } catch (err) {
      if (endsRun(err)) throw err;
      console.error(`WoW status check failed for character ${ch.id}:`, err instanceof Error ? err.message : err);
    }
  }
}

async function pollCharacter(
  database: DB,
  cfg: WowConfig,
  token: string,
  f: FetchFn,
  now: number,
  ch: typeof s.wowCharacters.$inferSelect,
): Promise<WowEvent | null> {
  const summary = await fetchSummary(cfg, token, ch.realmSlug, ch.name, f);
  // Not found, or a different character now answers to this name (deleted and
  // recreated, or transferred): leave the stored history alone. The daily status
  // check sees the changed id and deletes the old character.
  if (!summary || summary.blizzardId !== ch.blizzardId) {
    await database.update(s.wowCharacters).set({ lastPolledAt: now }).where(eq(s.wowCharacters.id, ch.id));
    return null;
  }

  const needGear = summary.lastLoginAt !== ch.lastLoginAt || ch.gear === null;
  // Gear that can't be read (404) stays as stored; it's never mistaken for "nothing".
  const gear = needGear ? await fetchEquipment(cfg, token, ch.realmSlug, ch.name, f) : null;

  const earnedRows = await database
    .select({ badgeKey: s.wowTimeline.badgeKey })
    .from(s.wowTimeline)
    .where(and(eq(s.wowTimeline.characterId, ch.id), eq(s.wowTimeline.kind, 'badge')));
  const earned = new Set(earnedRows.map((r) => r.badgeKey as BadgeKey));

  const firstCheck = ch.baselineLevel === null;
  const diff = diffCharacter({
    stored: { level: ch.level, guildName: ch.guildName, gear: ch.gear, lastLoginAt: ch.lastLoginAt },
    firstCheck,
    earned,
    summary,
    gear,
    now,
  });

  const rows = diff.entries.map((e) => timelineRow(ch.id, e));
  const update = database
    .update(s.wowCharacters)
    .set({
      name: summary.name,
      realmName: summary.realmName,
      classId: summary.classId,
      className: summary.className,
      raceName: summary.raceName,
      faction: summary.faction,
      level: diff.next.level,
      itemLevel: summary.itemLevel ?? ch.itemLevel,
      guildName: diff.next.guildName,
      gear: diff.next.gear,
      lastLoginAt: diff.next.lastLoginAt,
      lastPolledAt: now,
      ...(firstCheck ? { baselineLevel: summary.level } : {}),
    })
    .where(eq(s.wowCharacters.id, ch.id));
  // D1 binds at most 100 values per statement: split the timeline insert, but
  // keep it in one batch with the character update so the two land together.
  const inserts = chunkByParams(rows).map((part) => database.insert(s.wowTimeline).values(part));
  await database.batch([update, ...inserts]);

  const levels: LevelRow[] = await database
    .select({ level: s.wowTimeline.level, seenAt: s.wowTimeline.seenAt, sinceAt: s.wowTimeline.sinceAt })
    .from(s.wowTimeline)
    .where(and(eq(s.wowTimeline.characterId, ch.id), eq(s.wowTimeline.kind, 'level')))
    .then((r) => r.map((x) => ({ level: x.level ?? 0, seenAt: x.seenAt, sinceAt: x.sinceAt })));

  const badges = newBadges({ gear: diff.next.gear, levels, earned });
  if (badges.length) {
    const seenAt = summary.lastLoginAt ?? now;
    await database.insert(s.wowTimeline).values(
      badges.map((badgeKey) => ({
        characterId: ch.id,
        kind: 'badge' as const,
        badgeKey,
        seenAt,
        sinceAt: firstCheck ? null : ch.lastLoginAt,
      })),
    );
  }

  if (!diff.entries.length && !badges.length) return null;
  return {
    userId: ch.userId,
    characterId: ch.id,
    characterName: summary.name,
    className: summary.className,
    firstCheck,
    gearBaseline: diff.gearBaseline,
    entries: diff.entries,
    badges,
  };
}

export async function runWowSweep(env: Env, now = Math.floor(Date.now() / 1000)): Promise<SweepOutcome> {
  const out: SweepOutcome = { polled: 0, statusChecked: 0, deleted: 0, stoppedEarly: false, events: [] };
  const database = drizzle(env.DB, { schema: s });
  const cfg = await wowReady(env, database);
  if (!cfg) return out;

  let calls = 0;
  const counted: FetchFn = (input, init) => {
    if (calls >= WOW_CALL_BUDGET) throw new BudgetSpent();
    calls++;
    return fetch(input, init);
  };

  try {
    const token = await appToken(cfg, settingsTokenStore(database), now, counted);
    await statusPass(database, cfg, token, counted, now, out);

    const chars = await database
      .select()
      .from(s.wowCharacters)
      .where(inScope(cfg))
      .orderBy(asc(s.wowCharacters.lastPolledAt))
      .limit(WOW_CALL_BUDGET);
    for (const ch of chars) {
      try {
        const event = await pollCharacter(database, cfg, token, counted, now, ch);
        out.polled++;
        if (event) out.events.push(event);
      } catch (err) {
        // Stamp the attempt first, so a character that keeps failing moves to
        // the back of the queue instead of being first in every run.
        if (!(err instanceof BudgetSpent)) {
          await database.update(s.wowCharacters).set({ lastPolledAt: now }).where(eq(s.wowCharacters.id, ch.id));
        }
        if (endsRun(err)) throw err;
        console.error(`WoW check failed for character ${ch.id}:`, err instanceof Error ? err.message : err);
      }
    }
    await recordError(env, null, now);
  } catch (err) {
    if (err instanceof BudgetSpent) {
      await recordError(env, null, now);
      return out;
    }
    if (!(err instanceof BnetError)) throw err;
    out.stoppedEarly = true;
    if (err.status === 401) {
      // The cached app token stopped working; drop it so the next run asks for a
      // new one. If the key itself was revoked, that request fails here too.
      await database.delete(s.settings).where(eq(s.settings.key, TOKEN_KEY));
      await recordError(env, `Blizzard rejected the sweep's credentials (401). Test the connection if this repeats.`, now);
    } else {
      await recordError(env, `Blizzard returned ${err.status}; the sweep will retry.`, now);
    }
  }
  return out;
}

/**
 * DB-only retention, run hourly whether or not the module is on: drop followed
 * characters whose status hasn't been checked in 30 days (Blizzard's limit) and
 * candidates nobody chose within a day. Timelines go with them (cascade).
 */
export async function cleanupWowData(database: DB, now: number): Promise<number> {
  const stale = now - 30 * DAY;
  const [old, unchosen] = await database.batch([
    database
      .delete(s.wowCharacters)
      .where(
        and(
          eq(s.wowCharacters.followed, true),
          or(
            lt(s.wowCharacters.lastValidatedAt, stale),
            and(isNull(s.wowCharacters.lastValidatedAt), lt(s.wowCharacters.createdAt, stale)),
          ),
        ),
      )
      .returning({ id: s.wowCharacters.id }),
    database
      .delete(s.wowCharacters)
      .where(and(eq(s.wowCharacters.followed, false), lt(s.wowCharacters.createdAt, now - DAY)))
      .returning({ id: s.wowCharacters.id }),
  ]);
  return old.length + unchosen.length;
}
