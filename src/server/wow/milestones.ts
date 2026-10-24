/**
 * Which Discord posts one character's check deserves.
 *
 * At most one post per character per check: the caller posts the first entry
 * whose announcement is switched on, so a guild first wins over a plain level
 * milestone when both are enabled. A big jump across a milestone gives a single
 * post for the highest milestone crossed. Nothing posts from a first check (that
 * level was reached before mustr was watching) or for a change older than a day
 * (enabling the module late, or recovering from an outage, mustn't flood).
 */

import { MILESTONES } from '../../shared/wow';
import type { EntryDraft } from './diff';
import type { FirstRecord } from './records';

export interface MilestonePost {
  type: 'wowFirst' | 'wowLevel';
  level: number;
  shared: boolean;
}

const STALE_AFTER = 86400;

export function milestonePosts(input: {
  characterId: number;
  firstCheck: boolean;
  entries: EntryDraft[];
  firsts: FirstRecord[];
  now: number;
}): MilestonePost[] {
  if (input.firstCheck) return [];
  const crossed = input.entries
    .filter((e) => e.kind === 'level' && MILESTONES.includes(e.level) && input.now - e.seenAt <= STALE_AFTER)
    .map((e) => (e.kind === 'level' ? e.level : 0))
    .sort((a, b) => b - a);
  if (!crossed.length) return [];

  const posts: MilestonePost[] = [];
  for (const level of crossed) {
    const first = input.firsts.find((f) => f.level === level && f.characterIds.includes(input.characterId));
    if (first) {
      posts.push({ type: 'wowFirst', level, shared: first.characterIds.length > 1 });
      break;
    }
  }
  posts.push({ type: 'wowLevel', level: crossed[0]!, shared: false });
  return posts;
}
