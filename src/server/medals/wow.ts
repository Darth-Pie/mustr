/**
 * World of Warcraft medals: granted when a member's character earns a WoW badge,
 * for any medal whose `autoGrantRule` is `wow:<badge>`. Mirrors the tenure and
 * activity sweeps — idempotent (a medal already held is skipped), no awarding
 * officer, and the same `medal.auto_award` audit row. Only the WoW sweep calls
 * this, so nothing is awarded while the module is off.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as s from '../../db/schema';
import { BADGES, type BadgeKey } from '../../shared/wow';

type DB = DrizzleD1Database<typeof s>;

export const wowRule = (badge: BadgeKey) => `wow:${badge}`;

export interface WowMedalAward {
  medalName: string;
  medalImageUrl: string | null;
  citation: string;
}

export async function awardWowMedals(
  db: DB,
  userId: number,
  characterName: string,
  badges: BadgeKey[],
  firstCheck: boolean,
): Promise<WowMedalAward[]> {
  if (!badges.length) return [];
  const medals = await db
    .select({ id: s.medals.id, name: s.medals.name, imageUrl: s.medals.imageUrl, rule: s.medals.autoGrantRule })
    .from(s.medals)
    .where(inArray(s.medals.autoGrantRule, badges.map(wowRule)));
  if (!medals.length) return [];

  const held = await db
    .select({ medalId: s.memberMedals.medalId })
    .from(s.memberMedals)
    .where(
      and(
        eq(s.memberMedals.userId, userId),
        inArray(
          s.memberMedals.medalId,
          medals.map((m) => m.id),
        ),
      ),
    );
  const heldIds = new Set(held.map((h) => h.medalId));

  const citation = firstCheck ? `${characterName} already had it when tracking started` : `Earned by ${characterName}`;
  const awarded: WowMedalAward[] = [];
  for (const medal of medals) {
    if (heldIds.has(medal.id)) continue;
    await db.insert(s.memberMedals).values({ userId, medalId: medal.id, citation, awardedBy: null });
    await db.insert(s.auditLog).values({
      action: 'medal.auto_award',
      targetType: 'user',
      targetId: String(userId),
      meta: { medalId: medal.id, medalName: medal.name, rule: medal.rule, character: characterName },
      source: 'system',
    });
    heldIds.add(medal.id);
    awarded.push({ medalName: medal.name, medalImageUrl: medal.imageUrl, citation });
  }
  return awarded;
}

/** The five starter medals, one per badge, created on request from the admin card. */
export async function createWowMedals(db: DB): Promise<number> {
  const existing = await db
    .select({ rule: s.medals.autoGrantRule })
    .from(s.medals)
    .where(inArray(s.medals.autoGrantRule, (Object.keys(BADGES) as BadgeKey[]).map(wowRule)));
  const have = new Set(existing.map((e) => e.rule));
  const missing = (Object.keys(BADGES) as BadgeKey[]).filter((k) => !have.has(wowRule(k)));
  for (const k of missing) {
    await db.insert(s.medals).values({ name: BADGES[k].name, description: BADGES[k].description, autoGrantRule: wowRule(k) });
  }
  return missing.length;
}
