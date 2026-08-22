/**
 * Client-side shapes for the tournaments API responses, plus small display
 * helpers. The wire shapes mirror what src/server/routes/tournaments.ts returns
 * (tournament row, resolved entrants, raw match rows).
 */

import type { TournamentFormat, CompetitorType, TournamentStatus } from '../../shared/tournament';

export interface Tournament {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  gameId: number | null;
  format: TournamentFormat;
  competitorType: CompetitorType;
  status: TournamentStatus;
  maxEntrants: number | null;
  seedMethod: 'random' | 'manual' | 'signup';
  bestOf: number;
  thirdPlace: boolean;
  swissRounds: number;
  isPublic: boolean;
  startsAt: number | null;
}

export interface TournamentSummary {
  id: number;
  name: string;
  slug: string;
  imageUrl: string | null;
  format: TournamentFormat;
  competitorType: CompetitorType;
  status: TournamentStatus;
  isPublic: boolean;
  startsAt: number | null;
  gameName: string | null;
  entrantCount: number;
}

export interface Entrant {
  id: number;
  seed: number | null;
  name: string;
  userId: number | null;
  avatar: string | null;
  profileImageUrl: string | null;
  discordId: string | null;
  status: string;
  checkedIn: boolean;
  /** Set when the entrant was fielded by an allied org (federation). */
  originName: string | null;
  team: { userId: number; name: string; isCaptain: boolean }[];
}

export interface Match {
  id: number;
  tournamentId: number;
  bracket: 'winners' | 'losers' | 'grand_final' | 'group';
  round: number;
  slot: number;
  entrant1Id: number | null;
  entrant2Id: number | null;
  winnerId: number | null;
  score1: number;
  score2: number;
  status: 'pending' | 'ready' | 'live' | 'complete' | 'bye';
  winnerNextMatchId: number | null;
  winnerNextSlot: number | null;
  loserNextMatchId: number | null;
  loserNextSlot: number | null;
  reportedBy: number | null;
  reportedAt: number | null;
}

export interface StandingRow {
  entrantId: number;
  played: number;
  wins: number;
  losses: number;
  points: number;
  scoreFor: number;
  buchholz: number;
  rank: number;
}

export const STATUS_LABELS: Record<TournamentStatus, string> = {
  draft: 'Draft',
  registration: 'Registration open',
  seeding: 'Seeding',
  in_progress: 'In progress',
  complete: 'Complete',
};

/**
 * Name the winners-bracket round from the back: the last round is the Final,
 * the one before it the Semifinals, etc. Falls back to "Round N".
 */
export function roundName(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - round; // 0 = final
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinals';
  if (fromEnd === 2) return 'Quarterfinals';
  return `Round ${round}`;
}
