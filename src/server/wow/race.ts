/**
 * Load everyone in the level race from D1: followed characters of non-banned
 * members in the site's current region and Blizzard data section, each with its
 * observed level rows, plus what the cards and charts need to show. Shared by
 * the Discord "guild first" check and GET /race.
 *
 * The timeline is fetched with a join, never an IN (…) of character ids: D1 caps
 * a statement at 100 bound parameters, which a guild passes easily.
 */

import { drizzle } from 'drizzle-orm/d1';
import { and, eq, inArray, ne } from 'drizzle-orm';
import * as s from '../../db/schema';
import { memberName } from '../../shared/names';
import type { CharacterCard, LevelRow, WowConfig } from '../../shared/wow';
import type { RaceCharacter } from './records';

type DB = ReturnType<typeof drizzle<typeof s>>;

export type RaceRow = RaceCharacter & {
  card: CharacterCard;
  memberName: string;
  /** When tracking started — the first point of the character's chart line. */
  trackedSince: number | null;
};

export type RaceScope = Pick<WowConfig, 'region' | 'namespace'>;

export async function loadRaceCharacters(database: DB, scope: RaceScope): Promise<RaceRow[]> {
  const inRace = and(
    eq(s.wowCharacters.followed, true),
    eq(s.wowCharacters.region, scope.region),
    eq(s.wowCharacters.namespace, scope.namespace),
    ne(s.users.status, 'banned'),
  );
  const rows = await database
    .select({
      c: s.wowCharacters,
      username: s.users.username,
      globalName: s.users.globalName,
      displayName: s.users.displayName,
    })
    .from(s.wowCharacters)
    .innerJoin(s.users, eq(s.users.id, s.wowCharacters.userId))
    .where(inRace);
  if (!rows.length) return [];

  const timeline = await database
    .select({
      characterId: s.wowTimeline.characterId,
      kind: s.wowTimeline.kind,
      level: s.wowTimeline.level,
      seenAt: s.wowTimeline.seenAt,
      sinceAt: s.wowTimeline.sinceAt,
    })
    .from(s.wowTimeline)
    .innerJoin(s.wowCharacters, eq(s.wowCharacters.id, s.wowTimeline.characterId))
    .innerJoin(s.users, eq(s.users.id, s.wowCharacters.userId))
    .where(and(inRace, inArray(s.wowTimeline.kind, ['level', 'tracking_started'])));
  const levels = new Map<number, LevelRow[]>();
  const started = new Map<number, number>();
  for (const t of timeline) {
    if (t.kind === 'tracking_started') started.set(t.characterId, t.seenAt);
    else (levels.get(t.characterId) ?? levels.set(t.characterId, []).get(t.characterId)!).push({
      level: t.level ?? 0,
      seenAt: t.seenAt,
      sinceAt: t.sinceAt,
    });
  }

  return rows.map(({ c, ...u }) => ({
    characterId: c.id,
    userId: c.userId,
    level: c.level,
    isMain: c.isMain,
    baselineLevel: c.baselineLevel,
    levels: (levels.get(c.id) ?? []).sort((a, b) => a.level - b.level),
    memberName: memberName(u),
    trackedSince: started.get(c.id) ?? null,
    card: {
      id: c.id,
      name: c.name,
      realmName: c.realmName,
      classId: c.classId,
      className: c.className,
      raceName: c.raceName,
      level: c.level,
      itemLevel: c.itemLevel,
      guildName: c.guildName,
      isMain: c.isMain,
      lastLoginAt: c.lastLoginAt,
    },
  }));
}
