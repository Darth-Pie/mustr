/**
 * Tournaments — the shared contract and the pure bracket engine.
 *
 * Everything here is DB-free and deterministic: given a list of seeded
 * entrants it produces the full set of match nodes (with the winner/loser
 * "next match" wiring that forms the bracket), and given a reported result it
 * computes how the bracket advances. The server (server/tournaments.ts) is the
 * only thing that touches D1; it calls these functions and persists the result.
 * Keeping the math pure is what makes an engine this size testable in isolation
 * (see scripts/test-tournament — the same pattern as the snapshot ordering and
 * attendance sanitizer checks).
 *
 * Phase 1 implements SINGLE ELIMINATION. The types and table shape already
 * cover double-elim / round-robin / Swiss so later phases add generators here
 * without touching the schema or the server plumbing.
 */

export type TournamentFormat = 'single_elim' | 'double_elim' | 'round_robin' | 'swiss';
export const TOURNAMENT_FORMATS: TournamentFormat[] = [
  'single_elim',
  'double_elim',
  'round_robin',
  'swiss',
];

export type CompetitorType = 'individual' | 'team';
export const COMPETITOR_TYPES: CompetitorType[] = ['individual', 'team'];

export type TournamentStatus = 'draft' | 'registration' | 'seeding' | 'in_progress' | 'complete';

export type SeedMethod = 'random' | 'manual' | 'signup';
export const SEED_METHODS: SeedMethod[] = ['random', 'manual', 'signup'];

export type BracketSide = 'winners' | 'losers' | 'grand_final' | 'group';

export type MatchStatus = 'pending' | 'ready' | 'live' | 'complete' | 'bye';

/** Human labels for the palette / admin UI. */
export const FORMAT_LABELS: Record<TournamentFormat, string> = {
  single_elim: 'Single elimination',
  double_elim: 'Double elimination',
  round_robin: 'Round robin',
  swiss: 'Swiss',
};

export const FORMAT_BLURBS: Record<TournamentFormat, string> = {
  single_elim: 'One bracket — lose once and you’re out.',
  double_elim: 'Winners + losers bracket — you’re out after two losses.',
  round_robin: 'Everyone plays everyone; ranked by a standings table.',
  swiss: 'A fixed number of rounds, paired by record; no elimination.',
};

/* ------------------------------------------------------------------ *
 * Config shape + sanitizer — the authority on a tournament's settings,
 * shared by the create/edit route and the admin form. Mirrors the pattern
 * of sanitizeAttendanceConfig: coerce arbitrary JSON into a valid shape,
 * clamping numbers and rejecting unknown enum values.
 * ------------------------------------------------------------------ */

export interface TournamentInput {
  name: string;
  format: TournamentFormat;
  competitorType: CompetitorType;
  seedMethod: SeedMethod;
  /** Best-of-N per match: an odd number 1..9. */
  bestOf: number;
  /** Single-elim: also play a third-place match. */
  thirdPlace: boolean;
  /** Swiss: number of rounds. */
  swissRounds: number;
  /** NULL/undefined = unlimited. */
  maxEntrants: number | null;
  isPublic: boolean;
  /** Offered to allied orgs over federation (only honored for alliance.manage). */
  shareAlliance: boolean;
  description: string;
  imageUrl: string;
  gameId: number | null;
  startsAt: number | null;
}

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Best-of must be a positive ODD number so a match can't tie. */
export function normalizeBestOf(v: unknown): number {
  const n = clampInt(v, 1, 9, 1);
  return n % 2 === 0 ? n - 1 : n; // 4 → 3, 6 → 5, …
}

/** Wins needed to take a best-of-N match. */
export function winsNeeded(bestOf: number): number {
  return Math.floor(normalizeBestOf(bestOf) / 2) + 1;
}

function cleanStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function cleanUrl(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t) return '';
  if (t.startsWith('/') && !t.startsWith('//')) return t.slice(0, 500);
  if (/^https?:\/\//i.test(t)) return t.slice(0, 500);
  return '';
}

export function sanitizeTournamentInput(raw: unknown): TournamentInput {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const format = TOURNAMENT_FORMATS.includes(o.format as TournamentFormat)
    ? (o.format as TournamentFormat)
    : 'single_elim';
  const competitorType = COMPETITOR_TYPES.includes(o.competitorType as CompetitorType)
    ? (o.competitorType as CompetitorType)
    : 'individual';
  const seedMethod = SEED_METHODS.includes(o.seedMethod as SeedMethod)
    ? (o.seedMethod as SeedMethod)
    : 'random';
  const maxRaw = o.maxEntrants;
  const maxEntrants =
    maxRaw == null || maxRaw === '' ? null : clampInt(maxRaw, 2, 1024, 2);
  const gameRaw = Number(o.gameId);
  const startRaw = Number(o.startsAt);
  return {
    name: cleanStr(o.name, 120).trim() || 'Untitled tournament',
    format,
    competitorType,
    seedMethod,
    bestOf: normalizeBestOf(o.bestOf),
    thirdPlace: o.thirdPlace === true,
    swissRounds: clampInt(o.swissRounds, 1, 20, 5),
    maxEntrants,
    isPublic: o.isPublic === true,
    shareAlliance: o.shareAlliance === true,
    description: cleanStr(o.description, 4000),
    imageUrl: cleanUrl(o.imageUrl),
    gameId: Number.isInteger(gameRaw) && gameRaw > 0 ? gameRaw : null,
    startsAt: Number.isFinite(startRaw) && startRaw > 0 ? Math.round(startRaw) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Seeding math — the standard single-elimination bracket order.
 *
 * For a bracket of size 2^k, `seedOrder(k)` returns the seed that sits at each
 * top-to-bottom slot so that #1 and #2 can only meet in the final, #1 meets the
 * lowest seed first, favourites are spread across the bracket, etc. This is the
 * canonical "1, N, N/2, …" fold used by every bracket generator.
 * ------------------------------------------------------------------ */

/**
 * Seed positions (1-based) for a single-elim bracket of `size` = 2^k slots, in
 * top-to-bottom order — the conventional layout with seed 1 at the very top and
 * seed 2 at the very bottom, so the two favourites can only meet in the final.
 *
 * Built by an alternating fold: each seed `s` at index `i` in a bracket of size
 * `L/2` splits into two slots of the size-`L` bracket — `[s, L+1−s]` at even
 * indices and `[L+1−s, s]` at odd indices. The alternation is what pushes seed 2
 * to the bottom (a plain fold leaves it mid-bracket): [1,2] → [1,4,3,2] →
 * [1,8,5,4,3,6,7,2] → …
 */
export function seedOrder(size: number): number[] {
  let rounds = [1, 2];
  while (rounds.length < size) {
    const L = rounds.length * 2;
    const next: number[] = [];
    rounds.forEach((s, i) => {
      if (i % 2 === 0) {
        next.push(s, L + 1 - s);
      } else {
        next.push(L + 1 - s, s);
      }
    });
    rounds = next;
  }
  return rounds.slice(0, size);
}

/** Smallest power of two >= n (min 1). */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return Math.max(1, p);
}

/* ------------------------------------------------------------------ *
 * Match plan — the pure, DB-free description of a generated bracket.
 *
 * `key` is a stable within-plan identifier (e.g. "W1-0" = winners round 1,
 * slot 0). The server maps keys → real row ids after inserting, then rewrites
 * the *NextKey pointers into *NextMatchId. Entrant references are the entrant
 * ids passed in (or null for a TBD/bye slot).
 * ------------------------------------------------------------------ */

export interface PlannedMatch {
  key: string;
  bracket: BracketSide;
  round: number;
  slot: number;
  entrant1Id: number | null;
  entrant2Id: number | null;
  status: MatchStatus;
  winnerId: number | null;
  /** Key of the match the winner advances into, and which slot (1|2). */
  winnerNextKey: string | null;
  winnerNextSlot: 1 | 2 | null;
  /** Double-elim only (null in single-elim). */
  loserNextKey: string | null;
  loserNextSlot: 1 | 2 | null;
}

export interface SeededEntrant {
  id: number;
  seed: number; // 1-based
}

export interface BracketPlan {
  matches: PlannedMatch[];
  /** Total rounds in the winners bracket (for layout). */
  rounds: number;
}

/**
 * Generate a SINGLE-ELIMINATION bracket for the given seeded entrants.
 *
 * Entrants are placed into a 2^k bracket by the canonical seed order; empty
 * slots are byes. A first-round match with one entrant is auto-completed as a
 * 'bye' and its entrant is pre-advanced into the round-2 slot, so the bracket
 * the organizer sees never shows a "vs. (bye)" match to play. Optionally adds a
 * third-place match fed by the two semi-final losers.
 */
export function planSingleElim(
  entrants: SeededEntrant[],
  opts: { thirdPlace?: boolean } = {},
): BracketPlan {
  const n = entrants.length;
  if (n < 2) return { matches: [], rounds: 0 };

  const size = nextPow2(n);
  const rounds = Math.log2(size); // number of winners rounds
  const bySeed = new Map(entrants.map((e) => [e.seed, e.id]));
  const order = seedOrder(size); // seed at each of the `size` slots

  const matches: PlannedMatch[] = [];
  const keyOf = (round: number, slot: number) => `W${round}-${slot}`;

  // Round 1: pair adjacent slots. A slot with no entrant (seed > n) is a bye.
  const r1Count = size / 2;
  for (let slot = 0; slot < r1Count; slot++) {
    const e1 = bySeed.get(order[slot * 2]!) ?? null;
    const e2 = bySeed.get(order[slot * 2 + 1]!) ?? null;
    const round = 1;
    const nextRound = 2;
    const nextSlot = Math.floor(slot / 2);
    const winnerNextKey = rounds >= 2 ? keyOf(nextRound, nextSlot) : null;
    const winnerNextSlot: 1 | 2 = slot % 2 === 0 ? 1 : 2;

    const isBye = (e1 === null) !== (e2 === null); // exactly one present
    matches.push({
      key: keyOf(round, slot),
      bracket: 'winners',
      round,
      slot,
      entrant1Id: e1,
      entrant2Id: e2,
      status: isBye ? 'bye' : e1 !== null && e2 !== null ? 'ready' : 'pending',
      winnerId: isBye ? (e1 ?? e2) : null,
      winnerNextKey,
      winnerNextSlot: winnerNextKey ? winnerNextSlot : null,
      loserNextKey: null,
      loserNextSlot: null,
    });
  }

  // Rounds 2..rounds: empty shells wired to the next round (final has none).
  for (let round = 2; round <= rounds; round++) {
    const count = size / 2 ** round;
    for (let slot = 0; slot < count; slot++) {
      const isFinal = round === rounds;
      const nextSlot = Math.floor(slot / 2);
      const winnerNextKey = isFinal ? null : keyOf(round + 1, nextSlot);
      const winnerNextSlot: 1 | 2 = slot % 2 === 0 ? 1 : 2;
      matches.push({
        key: keyOf(round, slot),
        bracket: 'winners',
        round,
        slot,
        entrant1Id: null,
        entrant2Id: null,
        status: 'pending',
        winnerId: null,
        winnerNextKey,
        winnerNextSlot: winnerNextKey ? winnerNextSlot : null,
        loserNextKey: null,
        loserNextSlot: null,
      });
    }
  }

  // Pre-advance byes into round 2 (so the organizer never plays a bye match).
  // Safe because round-2 shells already exist above.
  const byKey = new Map(matches.map((m) => [m.key, m]));
  for (const m of matches) {
    if (m.status === 'bye' && m.winnerId != null && m.winnerNextKey) {
      const next = byKey.get(m.winnerNextKey)!;
      if (m.winnerNextSlot === 1) next.entrant1Id = m.winnerId;
      else next.entrant2Id = m.winnerId;
    }
  }
  // A round-2 match that received two byes is itself immediately playable; a
  // match that received one is half-filled (pending the real round-1 result).
  markReady(matches);

  // Optional third-place match, fed by the two semi-final losers. Only
  // meaningful with >= 4 slots (a real pair of semis exists).
  if (opts.thirdPlace && rounds >= 2) {
    const semis = matches.filter((m) => m.bracket === 'winners' && m.round === rounds - 1);
    const tpKey = 'W3P-0';
    matches.push({
      key: tpKey,
      bracket: 'winners',
      round: rounds, // laid out alongside the final
      slot: 1, // below the final (slot 0)
      entrant1Id: null,
      entrant2Id: null,
      status: 'pending',
      winnerId: null,
      winnerNextKey: null,
      winnerNextSlot: null,
      loserNextKey: null,
      loserNextSlot: null,
    });
    // Wire each semi's LOSER into the third-place match.
    semis.forEach((semi, i) => {
      semi.loserNextKey = tpKey;
      semi.loserNextSlot = (i === 0 ? 1 : 2) as 1 | 2;
    });
  }

  return { matches, rounds };
}

/** Re-derive 'ready' status: a match with both entrants and no winner is ready. */
function markReady(matches: PlannedMatch[]): void {
  for (const m of matches) {
    if (m.status === 'bye' || m.status === 'complete') continue;
    m.status = m.entrant1Id != null && m.entrant2Id != null ? 'ready' : 'pending';
  }
}

/* ------------------------------------------------------------------ *
 * Double elimination.
 *
 * A winners bracket (identical to single-elim) plus a losers bracket that
 * catches everyone once: each winners-bracket loser "drops" into the losers
 * bracket, and a second loss there eliminates them. The two bracket champions
 * meet in a single grand final (no bracket reset — the losers champion needs
 * only to win once; see the P3 scope decision).
 *
 * Structure for a 2^k bracket: the losers bracket alternates "minor" rounds
 * (losers-bracket survivors play each other) and "major" rounds (a survivor
 * plays the freshly-dropped winners-bracket loser), for 2(k−1) rounds total.
 *
 * Byes (non-power-of-two fields) are handled by a normalization pass: winners
 * byes stay visible (as in single-elim), while a losers-bracket match that can
 * only ever receive one competitor is a walkover and is COLLAPSED — its feeder
 * is rewired straight to the next round, so no "vs. nobody" match is ever shown
 * or has to be played. This is what keeps arbitrary entrant counts valid.
 * ------------------------------------------------------------------ */

interface BuildMatch {
  key: string;
  bracket: BracketSide;
  round: number;
  slot: number;
  e1: number | null;
  e2: number | null;
  live1: boolean;
  live2: boolean;
  winnerNextKey: string | null;
  winnerNextSlot: 1 | 2 | null;
  loserNextKey: string | null;
  loserNextSlot: 1 | 2 | null;
  status: MatchStatus;
  winnerId: number | null;
  removed?: boolean;
}

export function planDoubleElim(entrants: SeededEntrant[]): BracketPlan {
  const n = entrants.length;
  if (n < 2) return { matches: [], rounds: 0 };

  const size = nextPow2(n);
  const k = Math.log2(size);
  const bySeed = new Map(entrants.map((e) => [e.seed, e.id]));
  const order = seedOrder(size);
  const lastLB = 2 * (k - 1); // 0 when k === 1

  const wKey = (r: number, s: number) => `W${r}-${s}`;
  const lKey = (r: number, s: number) => `L${r}-${s}`;
  const GF = 'GF-0';

  const build: BuildMatch[] = [];
  const push = (m: Partial<BuildMatch> & { key: string; bracket: BracketSide; round: number; slot: number }) =>
    build.push({
      e1: null, e2: null, live1: false, live2: false,
      winnerNextKey: null, winnerNextSlot: null, loserNextKey: null, loserNextSlot: null,
      status: 'pending', winnerId: null, ...m,
    });

  // --- Winners bracket shells + seeds ---
  for (let r = 1; r <= k; r++) {
    const count = size / 2 ** r;
    for (let s = 0; s < count; s++) {
      const winnerNextKey = r < k ? wKey(r + 1, Math.floor(s / 2)) : GF;
      const winnerNextSlot: 1 | 2 = r < k ? (s % 2 === 0 ? 1 : 2) : 1; // WB champ → GF slot 1
      // Loser drop: R1 → LB R1 (paired); Rr≥2 → LB round 2(r−1) slot 2.
      // With no losers bracket (k===1) the WB final loser drops straight to GF.
      let loserNextKey: string | null;
      let loserNextSlot: 1 | 2;
      if (k === 1) {
        loserNextKey = GF;
        loserNextSlot = 2;
      } else if (r === 1) {
        loserNextKey = lKey(1, Math.floor(s / 2));
        loserNextSlot = s % 2 === 0 ? 1 : 2;
      } else {
        loserNextKey = lKey(2 * (r - 1), s);
        loserNextSlot = 2;
      }
      const m: Partial<BuildMatch> & { key: string; bracket: BracketSide; round: number; slot: number } = {
        key: wKey(r, s), bracket: 'winners', round: r, slot: s,
        winnerNextKey, winnerNextSlot, loserNextKey, loserNextSlot,
      };
      if (r === 1) {
        const a = bySeed.get(order[s * 2]!) ?? null;
        const b = bySeed.get(order[s * 2 + 1]!) ?? null;
        m.e1 = a; m.e2 = b; m.live1 = a != null; m.live2 = b != null;
      }
      push(m);
    }
  }

  // --- Losers bracket shells ---
  for (let j = 1; j <= k - 1; j++) {
    const cnt = size / 2 ** (j + 1);
    const minor = 2 * j - 1; // survivors (or WB R1 losers when j===1)
    const major = 2 * j; // survivor vs freshly-dropped WB loser
    for (let s = 0; s < cnt; s++) {
      // minor winner → major, same index, slot 1
      push({
        key: lKey(minor, s), bracket: 'losers', round: minor, slot: s,
        winnerNextKey: lKey(major, s), winnerNextSlot: 1,
      });
    }
    for (let s = 0; s < cnt; s++) {
      // major winner → next minor (half count), or the grand final on the last round
      const isLast = major === lastLB;
      const winnerNextKey = isLast ? GF : lKey(major + 1, Math.floor(s / 2));
      const winnerNextSlot: 1 | 2 = isLast ? 2 : s % 2 === 0 ? 1 : 2; // LB champ → GF slot 2
      push({ key: lKey(major, s), bracket: 'losers', round: major, slot: s, winnerNextKey, winnerNextSlot });
    }
  }

  // --- Grand final ---
  push({ key: GF, bracket: 'grand_final', round: 1, slot: 0 });

  // --- Normalization: pre-advance byes, collapse losers-bracket walkovers ---
  const byKey = new Map(build.map((m) => [m.key, m]));
  const deliver = (targetKey: string | null, slot: 1 | 2 | null, entrant: number | null) => {
    if (!targetKey || !slot) return;
    const t = byKey.get(targetKey);
    if (!t || t.removed) return;
    if (slot === 1) { t.live1 = true; if (entrant != null) t.e1 = entrant; }
    else { t.live2 = true; if (entrant != null) t.e2 = entrant; }
  };
  // Rewire the single feeder that points at `deadKey` slot to point at `newKey`/`newSlot`.
  const rewire = (deadKey: string, deadSlot: 1 | 2, newKey: string | null, newSlot: 1 | 2 | null) => {
    for (const f of build) {
      if (f.winnerNextKey === deadKey && f.winnerNextSlot === deadSlot) { f.winnerNextKey = newKey; f.winnerNextSlot = newSlot; }
      if (f.loserNextKey === deadKey && f.loserNextSlot === deadSlot) { f.loserNextKey = newKey; f.loserNextSlot = newSlot; }
    }
  };

  // Process in dependency order: WB rounds, then LB rounds, then GF (build order).
  for (const m of build) {
    if (m.removed) continue;
    const liveCount = (m.live1 ? 1 : 0) + (m.live2 ? 1 : 0);

    if (liveCount === 0) {
      // Nothing will ever reach this match — drop it (its outgoing edges deliver nothing).
      m.removed = true;
      continue;
    }

    if (liveCount === 2) {
      // A real match: it will produce a winner and a loser. Mark both targets live.
      deliver(m.winnerNextKey, m.winnerNextSlot, null);
      deliver(m.loserNextKey, m.loserNextSlot, null);
      continue;
    }

    // liveCount === 1 — a bye/walkover.
    const liveSlot: 1 | 2 = m.live1 ? 1 : 2;
    const entrant = liveSlot === 1 ? m.e1 : m.e2;
    if (m.bracket === 'winners') {
      // Keep winners byes visible; the entrant advances, but a bye has no loser.
      m.status = 'bye';
      m.winnerId = entrant;
      m.e1 = liveSlot === 1 ? entrant : null;
      m.e2 = liveSlot === 2 ? entrant : null;
      deliver(m.winnerNextKey, m.winnerNextSlot, entrant);
      // loserNext gets nothing (byes drop no one).
    } else {
      // Collapse a losers-bracket / grand-final walkover: rewire its feeder past it.
      rewire(m.key, liveSlot, m.winnerNextKey, m.winnerNextSlot);
      deliver(m.winnerNextKey, m.winnerNextSlot, entrant);
      m.removed = true;
    }
  }

  // --- Emit the surviving matches as a plan ---
  const matches: PlannedMatch[] = build
    .filter((m) => !m.removed)
    .map((m) => ({
      key: m.key,
      bracket: m.bracket,
      round: m.round,
      slot: m.slot,
      entrant1Id: m.e1,
      entrant2Id: m.e2,
      status: m.status,
      winnerId: m.winnerId,
      winnerNextKey: m.winnerNextKey,
      winnerNextSlot: m.winnerNextSlot,
      loserNextKey: m.loserNextKey,
      loserNextSlot: m.loserNextSlot,
    }));
  markReady(matches);

  return { matches, rounds: k };
}

/* ------------------------------------------------------------------ *
 * Round-robin & Swiss — standings-based formats (bracket 'group'). There is no
 * tree: matches carry no winner/loser next pointers, and the winner is the top
 * of the STANDINGS once the schedule is complete. Round-robin schedules every
 * pairing up front (circle method); Swiss generates one round at a time, pairing
 * players on similar records and avoiding rematches, for a fixed number of
 * rounds. Both share computeStandings.
 * ------------------------------------------------------------------ */

function groupMatch(a: number | null, b: number | null, round: number, slot: number): PlannedMatch {
  const isBye = (a == null) !== (b == null);
  return {
    key: `G${round}-${slot}`,
    bracket: 'group',
    round,
    slot,
    entrant1Id: a,
    entrant2Id: b,
    status: isBye ? 'bye' : 'ready',
    winnerId: isBye ? (a ?? b) : null,
    winnerNextKey: null,
    winnerNextSlot: null,
    loserNextKey: null,
    loserNextSlot: null,
  };
}

/** A stable key for an unordered pair, so rematches are easy to detect. */
export function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Round-robin schedule via the circle method: everyone plays everyone once. An
 * odd field gets a rotating bye each round. Returns `rounds` = number of rounds.
 */
export function planRoundRobin(entrants: SeededEntrant[]): BracketPlan {
  const ids = [...entrants].sort((a, b) => a.seed - b.seed).map((e) => e.id);
  if (ids.length < 2) return { matches: [], rounds: 0 };

  const arr: (number | null)[] = [...ids];
  if (arr.length % 2 === 1) arr.push(null); // phantom bye
  const m = arr.length;
  const rounds = m - 1;
  const matches: PlannedMatch[] = [];

  const fixed = arr[0]!;
  let rot = arr.slice(1);
  for (let r = 1; r <= rounds; r++) {
    const roundArr = [fixed, ...rot];
    let slot = 0;
    for (let i = 0; i < m / 2; i++) {
      const a = roundArr[i]!;
      const b = roundArr[m - 1 - i]!;
      if (a == null || b == null) continue; // pairing against the phantom = a bye; drop it
      matches.push(groupMatch(a, b, r, slot++));
    }
    rot = [rot[rot.length - 1]!, ...rot.slice(0, -1)]; // rotate all but the fixed player
  }
  return { matches, rounds };
}

export interface StandingRow {
  entrantId: number;
  played: number;
  wins: number;
  losses: number;
  /** Match points (win = 1). The primary ranking key. */
  points: number;
  /** Total game score for — a secondary tiebreak and a nice stat. */
  scoreFor: number;
  /** Buchholz: sum of opponents' match points (Swiss strength-of-schedule). */
  buchholz: number;
  rank: number;
}

interface StandingMatch {
  entrant1Id: number | null;
  entrant2Id: number | null;
  winnerId: number | null;
  score1: number;
  score2: number;
  status: string;
}

/**
 * Compute standings from played matches. Ranks by match points, then Buchholz
 * (opponent strength), then game score, then seed order (the input id order).
 * Byes count as a win with no opponent. Undecided matches are ignored.
 */
export function computeStandings(entrantIds: number[], matches: StandingMatch[]): StandingRow[] {
  const rows = new Map<number, StandingRow & { opponents: number[] }>();
  const seedIndex = new Map(entrantIds.map((id, i) => [id, i]));
  for (const id of entrantIds) {
    rows.set(id, { entrantId: id, played: 0, wins: 0, losses: 0, points: 0, scoreFor: 0, buchholz: 0, rank: 0, opponents: [] });
  }

  for (const mt of matches) {
    if (mt.status === 'bye' && mt.winnerId != null) {
      const w = rows.get(mt.winnerId);
      if (w) { w.wins += 1; w.played += 1; w.points += 1; }
      continue;
    }
    if (mt.status !== 'complete' || mt.winnerId == null || mt.entrant1Id == null || mt.entrant2Id == null) continue;
    const a = rows.get(mt.entrant1Id);
    const b = rows.get(mt.entrant2Id);
    if (!a || !b) continue;
    a.played += 1; b.played += 1;
    a.scoreFor += mt.score1; b.scoreFor += mt.score2;
    a.opponents.push(mt.entrant2Id); b.opponents.push(mt.entrant1Id);
    if (mt.winnerId === mt.entrant1Id) { a.wins += 1; a.points += 1; b.losses += 1; }
    else { b.wins += 1; b.points += 1; a.losses += 1; }
  }

  // Buchholz needs everyone's points first.
  for (const row of rows.values()) {
    row.buchholz = row.opponents.reduce((sum, oid) => sum + (rows.get(oid)?.points ?? 0), 0);
  }

  const sorted = [...rows.values()].sort(
    (x, y) =>
      y.points - x.points ||
      y.buchholz - x.buchholz ||
      y.scoreFor - x.scoreFor ||
      (seedIndex.get(x.entrantId)! - seedIndex.get(y.entrantId)!),
  );
  sorted.forEach((row, i) => (row.rank = i + 1));
  return sorted.map(({ opponents: _opponents, ...r }) => r);
}

/**
 * Find a rematch-free perfect pairing of an ordered, even-length list, or null
 * if none exists. Backtracking: pair the top unpaired player with the nearest
 * (standings-closest) opponent they haven't faced, and recurse — so the result
 * both avoids rematches and stays close to standings order. Swiss fields are
 * small, so the search is cheap in practice.
 */
function findSwissMatching(list: number[], playedPairs: Set<string>): [number, number][] | null {
  if (list.length === 0) return [];
  const a = list[0]!;
  for (let j = 1; j < list.length; j++) {
    const b = list[j]!;
    if (playedPairs.has(pairKey(a, b))) continue;
    const rest = list.filter((_, idx) => idx !== 0 && idx !== j);
    const sub = findSwissMatching(rest, playedPairs);
    if (sub) return [[a, b], ...sub];
  }
  return null;
}

/**
 * Pair an ordered list of entrants (by seed for round 1, by standings after) for
 * one Swiss round. A bye goes to the lowest-ranked player without one when the
 * field is odd; the rest are paired rematch-free if any such pairing exists
 * (backtracking search), otherwise greedily allowing a rematch as a last resort
 * so no player is ever stranded.
 */
export function planSwissRound(
  ordered: number[],
  round: number,
  playedPairs: Set<string>,
  byeGiven: Set<number>,
): PlannedMatch[] {
  const matches: PlannedMatch[] = [];
  let slot = 0;
  let pool = [...ordered];

  if (pool.length % 2 === 1) {
    // Bye to the lowest-ranked player who hasn't had one (else the very last).
    let byePlayer = pool[pool.length - 1]!;
    for (let i = pool.length - 1; i >= 0; i--) {
      if (!byeGiven.has(pool[i]!)) { byePlayer = pool[i]!; break; }
    }
    matches.push(groupMatch(byePlayer, null, round, slot++));
    pool = pool.filter((id) => id !== byePlayer);
  }

  const matching = findSwissMatching(pool, playedPairs);
  if (matching) {
    for (const [a, b] of matching) matches.push(groupMatch(a, b, round, slot++));
    return matches;
  }

  // No rematch-free pairing exists — greedily pair in order, allowing rematches.
  const used = new Set<number>();
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i]!;
    if (used.has(a)) continue;
    let opp = -1;
    for (let j = i + 1; j < pool.length; j++) {
      const b = pool[j]!;
      if (!used.has(b)) { opp = b; break; }
    }
    if (opp === -1) continue;
    used.add(a);
    used.add(opp);
    matches.push(groupMatch(a, opp, round, slot++));
  }
  return matches;
}

/* ------------------------------------------------------------------ *
 * Advancement — pure computation of what a reported result changes.
 *
 * The server loads the affected match rows, calls `applyResult`, and persists
 * the returned patches. This keeps the "when X wins, advance to Y slot Z, and
 * if Z now has both entrants mark it ready; if this was the final, the winner
 * is champion" logic in one tested place.
 * ------------------------------------------------------------------ */

export interface MatchNode {
  id: number;
  bracket: BracketSide;
  /** Position within the round. The championship match is slot 0; a single-elim
   *  third-place match sits at slot 1 and must NOT be mistaken for the final. */
  slot: number;
  entrant1Id: number | null;
  entrant2Id: number | null;
  winnerId: number | null;
  status: MatchStatus;
  winnerNextMatchId: number | null;
  winnerNextSlot: number | null; // 1 | 2
  loserNextMatchId: number | null;
  loserNextSlot: number | null; // 1 | 2
}

export interface MatchPatch {
  id: number;
  entrant1Id?: number | null;
  entrant2Id?: number | null;
  winnerId?: number | null;
  score1?: number;
  score2?: number;
  status?: MatchStatus;
}

export interface ResultOutcome {
  patches: MatchPatch[];
  /** True when the completed match was the grand final / championship match. */
  champion: number | null;
}

/**
 * Apply a reported result to a match and compute the downstream patches.
 *
 * `match` is the match being reported; `feed` maps match id → that match's
 * current row for any node the winner/loser advances into (the server passes
 * the one or two "next" rows). Returns the patch for the reported match plus a
 * patch for each next match whose slot gets filled, and the champion entrant id
 * when this match had no winnerNext pointer (i.e. it was the final).
 */
export function applyResult(
  match: MatchNode,
  winnerEntrantId: number,
  score: { score1: number; score2: number },
  feed: Map<number, MatchNode>,
): ResultOutcome {
  const loserEntrantId =
    match.entrant1Id === winnerEntrantId ? match.entrant2Id : match.entrant1Id;

  const patches: MatchPatch[] = [
    {
      id: match.id,
      winnerId: winnerEntrantId,
      score1: score.score1,
      score2: score.score2,
      status: 'complete',
    },
  ];

  const advance = (
    nextId: number | null,
    nextSlot: number | null,
    entrantId: number | null,
  ) => {
    if (nextId == null || nextSlot == null || entrantId == null) return;
    const next = feed.get(nextId);
    if (!next) return;
    const patch: MatchPatch = patches.find((p) => p.id === nextId) ?? { id: nextId };
    if (!patches.includes(patch)) patches.push(patch);
    // Read from the patch first, so a second advance into the SAME next match
    // within this call (the n=2 grand final, where one match feeds both slots)
    // sees the entrant the first advance already placed — otherwise the match
    // would never be marked ready.
    const filled = {
      e1: 'entrant1Id' in patch ? patch.entrant1Id : next.entrant1Id,
      e2: 'entrant2Id' in patch ? patch.entrant2Id : next.entrant2Id,
    };
    if (nextSlot === 1) {
      patch.entrant1Id = entrantId;
      filled.e1 = entrantId;
    } else {
      patch.entrant2Id = entrantId;
      filled.e2 = entrantId;
    }
    // Ready once both slots are filled (and it isn't already decided/bye).
    if (filled.e1 != null && filled.e2 != null && next.status !== 'complete' && next.status !== 'bye') {
      patch.status = 'ready';
    }
  };

  advance(match.winnerNextMatchId, match.winnerNextSlot, winnerEntrantId);
  advance(match.loserNextMatchId, match.loserNextSlot, loserEntrantId);

  // The champion is the winner of the CHAMPIONSHIP match: a terminal match
  // (no winnerNext pointer) that is the final itself — slot 0 of an elimination
  // bracket. A single-elim third-place match is also terminal but sits at slot
  // 1, so gating on slot 0 keeps it from being mistaken for the final. Group
  // (round-robin / Swiss) matches never crown a champion on their own.
  const champion =
    match.winnerNextMatchId == null && match.bracket !== 'group' && match.slot === 0
      ? winnerEntrantId
      : null;
  return { patches, champion };
}
