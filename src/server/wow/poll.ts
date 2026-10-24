/**
 * The World of Warcraft sweep — runs on its own five-minute cron (WOW_CRON), so
 * its Blizzard calls get their own 50-request budget instead of sharing the
 * Discord reconcile's.
 *
 * Each run: refresh the app token if needed, spend up to WOW_STATUS_CALLS_PER_RUN
 * calls on daily status checks (Blizzard's data-retention rule, see status.ts),
 * then check followed characters, least recently checked first, until
 * WOW_CALL_BUDGET calls are spent. Equipment is only fetched when the character
 * has logged out since the last look. What changed becomes timeline rows and
 * badges, and is returned as events for medals and Discord (events.ts).
 *
 * A 429 or Blizzard-side error ends the run (the next one carries on). A bad key
 * (401/403) ends it and is shown on the admin card. Anything else wrong with one
 * character is logged and skipped.
 */

import { drizzle } from 'drizzle-orm/d1';
import { and, asc, eq, isNull, lt, or } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { Env } from '../env';
import { saveWowConfig, wowReady } from '../modules';
import type { BadgeKey, LevelRow, WowConfig } from '../../shared/wow';
import { appToken, BnetError, fetchEquipment, fetchStatus, fetchSummary, type FetchFn, type TokenStore } from './bnet';
import { diffCharacter, type EntryDraft } from './diff';
import { newBadges } from './badges';
import { statusDecision } from './status';

type DB = ReturnType<typeof drizzle<typeof s>>;

export const WOW_CALL_BUDGET = 40;
export const WOW_STATUS_CALLS_PER_RUN = 10;
export const WOW_CRON = '2-59/5 * * * *';

const TOKEN_KEY = 'wow_token';
const DAY = 86400;

export interface WowEvent {
  userId: number;
  characterId: number;
  characterName: string;
  className: string;
  firstCheck: boolean;
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
  err instanceof BudgetSpent || (err instanceof BnetError && (err.retryable || err.status === 401 || err.status === 403));

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
        eq(s.wowCharacters.followed, true),
        or(isNull(s.wowCharacters.lastValidatedAt), lt(s.wowCharacters.lastValidatedAt, now - DAY)),
      ),
    )
    // SQLite sorts NULL first ascending: never-checked characters go first.
    .orderBy(asc(s.wowCharacters.lastValidatedAt))
    .limit(WOW_STATUS_CALLS_PER_RUN);

  for (const ch of due) {
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
  if (!summary) {
    await database.update(s.wowCharacters).set({ lastPolledAt: now }).where(eq(s.wowCharacters.id, ch.id));
    return null;
  }

  const needGear = summary.lastLoginAt !== ch.lastLoginAt || ch.gear === null;
  // Asked for gear and got "not found": treat as wearing nothing, not "unknown".
  const gear = needGear ? ((await fetchEquipment(cfg, token, ch.realmSlug, ch.name, f)) ?? {}) : null;

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
  if (rows.length) await database.batch([database.insert(s.wowTimeline).values(rows), update]);
  else await update;

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
      .where(eq(s.wowCharacters.followed, true))
      .orderBy(asc(s.wowCharacters.lastPolledAt))
      .limit(WOW_CALL_BUDGET);
    for (const ch of chars) {
      try {
        const event = await pollCharacter(database, cfg, token, counted, now, ch);
        out.polled++;
        if (event) out.events.push(event);
      } catch (err) {
        if (endsRun(err)) throw err;
        console.error(`WoW check failed for character ${ch.id}:`, err instanceof Error ? err.message : err);
        await database.update(s.wowCharacters).set({ lastPolledAt: now }).where(eq(s.wowCharacters.id, ch.id));
      }
    }
    if (cfg.lastError !== null) await saveWowConfig(env, { ...cfg, lastError: null, lastErrorAt: null }, null);
  } catch (err) {
    if (err instanceof BudgetSpent) return out;
    out.stoppedEarly = true;
    if (err instanceof BnetError && (err.status === 401 || err.status === 403)) {
      await saveWowConfig(env, { ...cfg, lastError: `Blizzard refused the key (${err.status})`, lastErrorAt: now }, null);
    } else if (!(err instanceof BnetError && err.retryable)) {
      throw err;
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
