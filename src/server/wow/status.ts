/**
 * What to do with a character after its daily Blizzard status check.
 *
 * Blizzard's API terms let a WoW app keep data past 30 days only by checking
 * each character's status and deleting it when Blizzard says it's gone (404),
 * invalid, or a different character (changed id). A single 404 can also mean
 * the player turned off third-party sharing, or a blip — so a 404 only deletes
 * on the third check in a row, comfortably inside the 30 days.
 */

import type { CharacterStatus } from '../../shared/wow';

export const STATUS_FAILURE_LIMIT = 3;

export type StatusDecision = { action: 'ok' } | { action: 'fail'; failures: number } | { action: 'delete' };

export function statusDecision(status: CharacterStatus | null, storedBlizzardId: number, failures: number): StatusDecision {
  if (status === null) {
    const next = failures + 1;
    return next >= STATUS_FAILURE_LIMIT ? { action: 'delete' } : { action: 'fail', failures: next };
  }
  if (!status.isValid || status.blizzardId !== storedBlizzardId) return { action: 'delete' };
  return { action: 'ok' };
}
