/**
 * Change detection: compare what mustr last stored for a character with a fresh
 * look at it, and say what happened in between as timeline entries.
 *
 * Pure — no I/O — so every rule is unit-tested. Blizzard only updates a profile
 * when the player logs out, so a change is known to have happened between the
 * previous logout (`sinceAt`) and this one (`seenAt`), never more precisely.
 */

import {
  SLOT_ORDER,
  qualityAtLeast,
  type BadgeKey,
  type CharacterSummary,
  type Gear,
  type GearItem,
} from '../../shared/wow';

export interface StoredState {
  level: number;
  guildName: string | null;
  gear: Gear | null;
  lastLoginAt: number | null;
}

export type EntryDraft =
  | { kind: 'tracking_started'; level: number; seenAt: number; sinceAt: null }
  | { kind: 'level'; level: number; seenAt: number; sinceAt: number | null }
  | {
      kind: 'item';
      slot: string;
      item: GearItem;
      tag: 'first_rare' | 'first_epic' | null;
      seenAt: number;
      sinceAt: number | null;
    }
  | { kind: 'guild_join' | 'guild_leave'; guildName: string; seenAt: number; sinceAt: number | null };

export interface DiffInput {
  stored: StoredState;
  /** No baseline yet: record the starting point and nothing else. */
  firstCheck: boolean;
  /** Badges this character already holds; they suppress the first-rare/epic tags. */
  earned: ReadonlySet<BadgeKey>;
  summary: CharacterSummary;
  /** null when equipment wasn't fetched this time (the character hasn't logged out since). */
  gear: Gear | null;
  now: number;
}

export interface DiffResult {
  next: StoredState;
  entries: EntryDraft[];
  lowerLevelIgnored: boolean;
}

/** Known slots in paper-doll order, then any others alphabetically. */
function orderedSlots(gear: Gear): string[] {
  const known = SLOT_ORDER.filter((s) => s in gear);
  const extra = Object.keys(gear)
    .filter((s) => !SLOT_ORDER.includes(s))
    .sort();
  return [...known, ...extra];
}

export function diffCharacter(input: DiffInput): DiffResult {
  const { stored, summary, earned, now } = input;
  const seenAt = summary.lastLoginAt ?? now;
  const sinceAt = stored.lastLoginAt;
  const gear = input.gear ?? stored.gear;
  const lastLoginAt = summary.lastLoginAt ?? stored.lastLoginAt;

  if (input.firstCheck) {
    return {
      next: { level: summary.level, guildName: summary.guildName, gear, lastLoginAt },
      entries: [{ kind: 'tracking_started', level: summary.level, seenAt, sinceAt: null }],
      lowerLevelIgnored: false,
    };
  }

  const entries: EntryDraft[] = [];

  if (stored.guildName !== summary.guildName) {
    if (stored.guildName) entries.push({ kind: 'guild_leave', guildName: stored.guildName, seenAt, sinceAt });
    if (summary.guildName) entries.push({ kind: 'guild_join', guildName: summary.guildName, seenAt, sinceAt });
  }

  const lowerLevelIgnored = summary.level < stored.level;
  if (lowerLevelIgnored) {
    console.warn(`WoW: ${summary.name} reported level ${summary.level} below stored ${stored.level}; ignored`);
  }
  for (let level = stored.level + 1; level <= summary.level; level++) {
    entries.push({ kind: 'level', level, seenAt, sinceAt });
  }

  if (input.gear) {
    let rareTagged = earned.has('first_rare');
    let epicTagged = earned.has('first_epic');
    for (const slot of orderedSlots(input.gear)) {
      const cur = input.gear[slot]!;
      if (stored.gear?.[slot]?.itemId === cur.itemId) continue;
      if (!qualityAtLeast(cur.quality, 'RARE')) continue;
      let tag: 'first_rare' | 'first_epic' | null = null;
      if (qualityAtLeast(cur.quality, 'EPIC') && !epicTagged) {
        tag = 'first_epic';
        epicTagged = true;
        rareTagged = true;
      } else if (!rareTagged) {
        tag = 'first_rare';
        rareTagged = true;
      }
      entries.push({ kind: 'item', slot, item: cur, tag, seenAt, sinceAt });
    }
  }

  return {
    next: {
      level: Math.max(stored.level, summary.level),
      guildName: summary.guildName,
      gear,
      lastLoginAt,
    },
    entries,
    lowerLevelIgnored,
  };
}
