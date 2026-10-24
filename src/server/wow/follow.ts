/**
 * What "save my character choices" means, decided without touching the database.
 *
 * Ticked characters become followed. A character that was followed and is now
 * unticked is deleted with its history at once — the member chose to stop. An
 * unticked candidate (listed at link time, never followed) is left for the
 * hourly cleanup. Exactly one followed character is main; if the requested main
 * isn't among them, the highest level is.
 */

export interface OwnedCharacter {
  id: number;
  followed: boolean;
  level: number;
}

export type FollowPlan = { follow: number[]; deleteIds: number[]; main: number | null } | { error: string };

export function planFollow(owned: OwnedCharacter[], follow: number[], main: number | null): FollowPlan {
  const byId = new Map(owned.map((c) => [c.id, c]));
  const wanted = [...new Set(follow)];
  if (wanted.some((id) => !byId.has(id))) return { error: 'Unknown character.' };

  const deleteIds = owned.filter((c) => c.followed && !wanted.includes(c.id)).map((c) => c.id);

  let chosen: number | null = main !== null && wanted.includes(main) ? main : null;
  if (chosen === null && wanted.length) {
    chosen = [...wanted].sort((a, b) => byId.get(b)!.level - byId.get(a)!.level || a - b)[0]!;
  }
  return { follow: wanted, deleteIds, main: chosen };
}
