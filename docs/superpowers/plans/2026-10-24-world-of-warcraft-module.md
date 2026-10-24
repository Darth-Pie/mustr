# World of Warcraft Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An optional World of Warcraft module for mustr: members link Battle.net, mustr follows their
characters, and the guild gets a timeline, a level-race page with charts and records, Discord
milestone posts and game-earned medals.

**Architecture:** Pure, unit-tested logic (parsing, change detection, badges, records, grouping)
sits behind thin I/O layers: a Blizzard client, a cron sweep, Hono routes and React pages. Every
member-facing piece is gated by the `wow` module flag, following the Star Citizen module's pattern.

**Tech Stack:** Cloudflare Workers, Hono, D1 with drizzle-orm, React 19 with Vite, Chart.js 4 (new,
loaded only on `/leveling`), Node's built-in test runner run through `tsx`.

**Spec:** `docs/superpowers/specs/2026-10-24-world-of-warcraft-module-design.md`

## Global Constraints

- Everything member-facing is gated by `ModuleFlags.wow`; member routes return 404 when it's off.
  Admin settings routes under `/api/wow/admin/*` stay available to `settings.manage`.
- A Battle.net user token is never stored: not in D1, not in a cookie, not in a log line.
- Per sweep run: at most 40 Blizzard calls (`WOW_CALL_BUDGET`) and at most 8 Discord posts
  (`WOW_POST_BUDGET`).
- All stored times are unix seconds. Blizzard's millisecond timestamps are converted in `parse.ts`.
- Pure modules import only from `src/shared/` and each other, never from drizzle, Hono or `env`, so
  Node tests can import them: `src/shared/wow.ts`, `src/server/wow/{parse,diff,badges,records,
  milestones,status,follow}.ts`, `src/client/lib/{wowJourney,wowSeries}.ts`.
- Tests live in `test/` (outside `tsconfig.json`'s `include`, like `scripts/`, because `@types/node`
  conflicts with the Workers types) and run with `npm test`.
- Level cap 60. Milestones are 10, 20, 30, 40, 50 and 60. Ties are within 7200 seconds.
- Dates in the UI read "around 8 October" or "between 5 and 6 October".
- The public page lives at `/leveling`; the module is labelled **World of Warcraft** only inside
  the admin panel.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01K6hf45xLKSvh1AMgb4ZBZF
  ```

## Review Focus

1. **Character names with accents or capitals** (for example "Ëmberwick"): requests must lowercase
   and URL-encode the name, or every call 404s. Pinned in Task 7.
2. **A level gained late in the evening, including around the US clock change on 1 November 2026**,
   must land on the viewer's own local day in the charts. Pinned in Task 13.
3. **A member whose main was unfollowed or deleted** must still appear in the mains-only race
   through their highest-level character. Pinned in Tasks 4 and 8.
4. **A single "not found" from the status check** (privacy setting or a blip) must not delete
   history; the third in a row must. Pinned in Task 9.
5. **A character that jumps several levels across a milestone in one check** gets exactly one
   Discord post. Pinned in Task 10.

---

### Task 1: Test runner, shared WoW types, and Blizzard response parsing

**Files:**
- Modify: `package.json` (scripts)
- Create: `src/shared/wow.ts`
- Create: `src/server/wow/parse.ts`
- Create: `test/fixtures/wow/summary.json`, `equipment.json`, `status.json`, `account.json`, `userinfo.json`
- Test: `test/wow/parse.test.ts`

**Interfaces:**
- Produces, in `src/shared/wow.ts`:
  ```ts
  export type WowRegion = 'us' | 'eu' | 'kr' | 'tw';
  export const WOW_REGIONS: readonly WowRegion[];
  export type ItemQuality = 'POOR' | 'COMMON' | 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY' | 'ARTIFACT' | 'HEIRLOOM';
  export const QUALITY_ORDER: readonly ItemQuality[]; // the order above, lowest first
  export function qualityAtLeast(q: ItemQuality, min: ItemQuality): boolean;
  export const QUALITY_COLORS: Record<ItemQuality, string>; // POOR #9d9d9d, COMMON #ffffff, UNCOMMON #1eff00, RARE #0070dd, EPIC #a335ee, LEGENDARY #ff8000, ARTIFACT #e6cc80, HEIRLOOM #00ccff
  export interface GearItem { itemId: number; name: string; quality: ItemQuality; itemLevel: number | null }
  export type Gear = Record<string, GearItem>; // keyed by Blizzard slot type, e.g. 'HEAD', 'MAIN_HAND'
  export const SLOT_ORDER: readonly string[]; // HEAD NECK SHOULDER BACK CHEST SHIRT TABARD WRIST HANDS WAIST LEGS FEET FINGER_1 FINGER_2 TRINKET_1 TRINKET_2 MAIN_HAND OFF_HAND RANGED
  export interface CharacterSummary { blizzardId: number; name: string; realmSlug: string; realmName: string; classId: number; className: string; raceName: string; faction: 'ALLIANCE' | 'HORDE'; level: number; itemLevel: number | null; guildName: string | null; lastLoginAt: number | null }
  export interface AccountCharacter { blizzardId: number; name: string; realmSlug: string; realmName: string; classId: number; className: string; raceName: string; faction: 'ALLIANCE' | 'HORDE'; level: number }
  export interface CharacterStatus { blizzardId: number; isValid: boolean }
  export type BadgeKey = 'first_rare' | 'first_epic' | 'all_rare' | 'week_of_grind' | 'steady_climber';
  export const BADGE_ORDER: readonly BadgeKey[]; // the order above
  export const BADGES: Record<BadgeKey, { name: string; description: string }>;
  export const MILESTONES: readonly number[]; // [10, 20, 30, 40, 50, 60]
  export const MAX_LEVEL = 60;
  export const TIE_WINDOW_SECONDS = 7200;
  export const CLASS_COLORS: Record<number, string>; // by class id; see Step 3
  export const FALLBACK_CLASS_COLOR = '#c8b88a';
  export interface LevelRow { level: number; seenAt: number; sinceAt: number | null }
  ```
- Produces, in `src/server/wow/parse.ts`:
  ```ts
  export class BnetParseError extends Error {}
  export function parseSummary(json: unknown): CharacterSummary;
  export function parseEquipment(json: unknown): Gear;
  export function parseStatus(json: unknown): CharacterStatus;
  export function parseAccountCharacters(json: unknown): AccountCharacter[];
  export function parseUserInfo(json: unknown): { bnetId: string; battletag: string };
  ```

- [ ] **Step 1: Install dependencies and add the test script**

Run `npm ci`. Add to `package.json` scripts: `"test": "node --import tsx --test \"test/**/*.test.ts\""`.

- [ ] **Step 2: Write the fixtures in Blizzard's documented shape**

`summary.json`:
```json
{ "id": 201234567, "name": "Brightblade", "faction": { "type": "ALLIANCE", "name": "Alliance" },
  "race": { "id": 1, "name": "Human" }, "character_class": { "id": 2, "name": "Paladin" },
  "realm": { "id": 5001, "name": "Sylvanas", "slug": "sylvanas" },
  "guild": { "id": 77, "name": "The Cabbage Crew" }, "level": 42,
  "last_login_timestamp": 1760000000000, "average_item_level": 35, "equipped_item_level": 36 }
```
`equipment.json`: an `equipped_items` array of four entries, each shaped
`{ "item": { "id": N }, "slot": { "type": T, "name": "…" }, "quality": { "type": Q, "name": "…" }, "name": "…", "level": { "value": L } }`:
HEAD 10001 RARE "Helm of Example" 40; CHEST 10002 UNCOMMON "Tunic of Example" 38;
MAIN_HAND 19019 EPIC "Example Blade" 44; SHIRT 10003 COMMON "Plain Shirt" 1.
`status.json`: `{ "id": 201234567, "is_valid": true }`.
`account.json`: `{ "id": 9001, "wow_accounts": [ { "id": 1, "characters": [ C1 ] }, { "id": 2, "characters": [ C2 ] } ] }`
where each character is `{ "id", "name", "realm": { "id", "name", "slug" }, "playable_class": { "id", "name" }, "playable_race": { "id", "name" }, "faction": { "type", "name" }, "level" }`:
C1 = 201234567 Brightblade, Sylvanas/sylvanas, Paladin 2, Human, ALLIANCE, 42;
C2 = 201234999 Quickpaw, Sylvanas/sylvanas, Druid 11, Night Elf, ALLIANCE, 28.
`userinfo.json`: `{ "sub": "9001", "id": 9001, "battletag": "Example#1234" }`.

- [ ] **Step 3: Write the failing tests**

```ts
// test/wow/parse.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSummary, parseEquipment, parseStatus, parseAccountCharacters, parseUserInfo, BnetParseError } from '../../src/server/wow/parse.ts';
import { qualityAtLeast } from '../../src/shared/wow.ts';
const fx = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/wow/${n}.json`, import.meta.url), 'utf8'));

test('parseSummary maps the documented fields and converts ms to seconds', () => {
  assert.deepEqual(parseSummary(fx('summary')), {
    blizzardId: 201234567, name: 'Brightblade', realmSlug: 'sylvanas', realmName: 'Sylvanas',
    classId: 2, className: 'Paladin', raceName: 'Human', faction: 'ALLIANCE', level: 42,
    itemLevel: 36, guildName: 'The Cabbage Crew', lastLoginAt: 1760000000,
  });
});
test('parseSummary: no guild, no logout time, average item level fallback', () => {
  const { guild, last_login_timestamp, equipped_item_level, ...rest } = fx('summary');
  const s = parseSummary(rest);
  assert.equal(s.guildName, null); assert.equal(s.lastLoginAt, null); assert.equal(s.itemLevel, 35);
});
test('parseSummary throws BnetParseError when required fields are missing', () => {
  assert.throws(() => parseSummary({}), BnetParseError);
});
test('parseEquipment keys items by slot type', () => {
  const g = parseEquipment(fx('equipment'));
  assert.deepEqual(Object.keys(g).sort(), ['CHEST', 'HEAD', 'MAIN_HAND', 'SHIRT']);
  assert.deepEqual(g.MAIN_HAND, { itemId: 19019, name: 'Example Blade', quality: 'EPIC', itemLevel: 44 });
});
test('parseEquipment: empty or missing list is an empty object; unknown quality reads as COMMON', () => {
  assert.deepEqual(parseEquipment({ equipped_items: [] }), {});
  assert.deepEqual(parseEquipment({}), {});
  const odd = parseEquipment({ equipped_items: [{ item: { id: 1 }, slot: { type: 'HEAD' }, quality: { type: 'MYSTERY' }, name: 'X' }] });
  assert.equal(odd.HEAD!.quality, 'COMMON'); assert.equal(odd.HEAD!.itemLevel, null);
});
test('parseStatus, parseUserInfo, parseAccountCharacters', () => {
  assert.deepEqual(parseStatus(fx('status')), { blizzardId: 201234567, isValid: true });
  assert.deepEqual(parseUserInfo(fx('userinfo')), { bnetId: '9001', battletag: 'Example#1234' });
  const chars = parseAccountCharacters(fx('account'));
  assert.equal(chars.length, 2);
  assert.deepEqual(chars[1], { blizzardId: 201234999, name: 'Quickpaw', realmSlug: 'sylvanas', realmName: 'Sylvanas',
    classId: 11, className: 'Druid', raceName: 'Night Elf', faction: 'ALLIANCE', level: 28 });
  assert.deepEqual(parseAccountCharacters({ id: 1 }), []);
});
test('qualityAtLeast follows QUALITY_ORDER', () => {
  assert.equal(qualityAtLeast('EPIC', 'RARE'), true);
  assert.equal(qualityAtLeast('UNCOMMON', 'RARE'), false);
  assert.equal(qualityAtLeast('RARE', 'RARE'), true);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find module `src/server/wow/parse.ts`.

- [ ] **Step 5: Implement `src/shared/wow.ts` and `src/server/wow/parse.ts`**

`BADGES` copy: first_rare "First blue" / "Equipped a rare item or better."; first_epic "First
purple" / "Equipped an epic item or better."; all_rare "All in blue" / "Every gear slot filled with
rare or better."; week_of_grind "Week of the grind" / "Gained ten levels within seven days.";
steady_climber "Steady climber" / "Gained a level seven days in a row."
`CLASS_COLORS`: 1 #C69B6D, 2 #F48CBA, 3 #AAD372, 4 #FFF468, 5 #FFFFFF, 7 #0070DD, 8 #3FC7EB,
9 #8788EE, 11 #FF7C0A.
`itemLevel` prefers `equipped_item_level`, then `average_item_level`, else null. A missing `id`,
`name`, `level`, `realm.slug` or `character_class.id` throws `BnetParseError`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all parse tests PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add package.json src/shared/wow.ts src/server/wow/parse.ts test/
git commit -m "Add WoW types, Blizzard response parsing and a test runner"
```

---

### Task 2: Change detection

**Files:**
- Create: `src/server/wow/diff.ts`
- Test: `test/wow/diff.test.ts`

**Interfaces:**
- Consumes: `CharacterSummary`, `Gear`, `GearItem`, `BadgeKey`, `SLOT_ORDER`, `qualityAtLeast` (Task 1).
- Produces:
  ```ts
  export interface StoredState { level: number; guildName: string | null; gear: Gear | null; lastLoginAt: number | null }
  export type EntryDraft =
    | { kind: 'tracking_started'; level: number; seenAt: number; sinceAt: null }
    | { kind: 'level'; level: number; seenAt: number; sinceAt: number | null }
    | { kind: 'item'; slot: string; item: GearItem; tag: 'first_rare' | 'first_epic' | null; seenAt: number; sinceAt: number | null }
    | { kind: 'guild_join' | 'guild_leave'; guildName: string; seenAt: number; sinceAt: number | null };
  export interface DiffInput { stored: StoredState; firstCheck: boolean; earned: ReadonlySet<BadgeKey>; summary: CharacterSummary; gear: Gear | null; now: number }
  export interface DiffResult { next: StoredState; entries: EntryDraft[]; lowerLevelIgnored: boolean }
  export function diffCharacter(input: DiffInput): DiffResult;
  ```

- [ ] **Step 1: Write the failing tests**

Build inputs with a small `make(overrides)` helper that starts from stored `{ level: 20, guildName: 'A', gear: {}, lastLoginAt: 500 }`,
summary level 20 guild 'A' `lastLoginAt: 1000`, `earned: new Set()`, `firstCheck: false`, `now: 9999`.
```ts
test('first check writes only tracking_started and keeps the gear as the baseline', ...)
  // firstCheck: true, summary level 15, gear { HEAD: rare } →
  // entries deepEqual [{ kind: 'tracking_started', level: 15, seenAt: 1000, sinceAt: null }]; next.gear deepEqual that gear
test('a multi-level jump writes one row per level with shared times', ...)
  // stored level 38, summary level 41 → level rows 39, 40, 41, each seenAt 1000, sinceAt 500
test('gear below rare is not logged but is stored', ...)
  // gear { CHEST: UNCOMMON new } → no item entries; next.gear.CHEST is the new item
test('the first rare and first epic are tagged once, in SLOT_ORDER', ...)
  // new HEAD RARE, LEGS RARE, MAIN_HAND EPIC, earned empty →
  // item tags: HEAD 'first_rare', LEGS null, MAIN_HAND 'first_epic'
test('earned badges suppress the tags', ...)
  // same gear, earned { first_rare, first_epic } → all tags null
test('the same item in a slot is not logged again', ...)
test('gear not fetched leaves stored gear unchanged', ...)
  // gear: null → next.gear === stored.gear; no item entries
test('guild changes write leave and/or join', ...)
  // 'A'→'B': [guild_leave A, guild_join B]; null→'B': [guild_join B]; 'A'→null: [guild_leave A]
test('a lower level is ignored', ...)
  // stored 20, summary 19 → lowerLevelIgnored true; no level entries; next.level 20
test('a missing logout time falls back to now', ...)
  // summary.lastLoginAt null, stored 25 → level rows seenAt 9999; next.lastLoginAt stays 500
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find module `src/server/wow/diff.ts`.

- [ ] **Step 3: Implement `diffCharacter` in `src/server/wow/diff.ts`**

`seenAt = summary.lastLoginAt ?? now`; `sinceAt = stored.lastLoginAt`. Entry order: guild entries,
level rows ascending, item rows in `SLOT_ORDER` (unknown slots after, alphabetically). An item row
needs a new `itemId` in that slot and `qualityAtLeast(item.quality, 'RARE')`. Tag rule: epic-or-better
and `first_epic` not earned and not yet tagged in this diff → `'first_epic'`; else rare-or-better and
`first_rare` not earned and not yet tagged → `'first_rare'`; else null. An item tagged `first_epic` also
counts as the `first_rare` tag having been used. `next.lastLoginAt = summary.lastLoginAt ?? stored.lastLoginAt`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/wow/diff.ts test/wow/diff.test.ts
git commit -m "Detect WoW character changes for the timeline"
```

---

### Task 3: Badges

**Files:**
- Create: `src/server/wow/badges.ts`
- Test: `test/wow/badges.test.ts`

**Interfaces:**
- Consumes: `Gear`, `BadgeKey`, `BADGE_ORDER`, `LevelRow`, `qualityAtLeast` (Task 1).
- Produces:
  ```ts
  export const ALL_RARE_REQUIRED_SLOTS: readonly string[]; // HEAD SHOULDER CHEST WRIST HANDS WAIST LEGS FEET MAIN_HAND
  export const ALL_RARE_IGNORED_SLOTS: readonly string[]; // SHIRT TABARD
  export function newBadges(input: { gear: Gear | null; levels: LevelRow[]; earned: ReadonlySet<BadgeKey> }): BadgeKey[]; // in BADGE_ORDER
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test('first_rare and first_epic from equipped quality', ...)
  // gear { HEAD: RARE } → ['first_rare']; gear { MAIN_HAND: EPIC } → ['first_rare', 'first_epic']
test('all_rare needs every required slot filled and every non-ignored item rare or better', ...)
  // all 9 required slots RARE + SHIRT COMMON + TABARD COMMON → includes 'all_rare'
  // same plus NECK UNCOMMON → excludes 'all_rare'; required set minus WRIST → excludes 'all_rare'
test('earned badges are not returned again', ...)
test('week_of_grind: ten levels between the first row\'s sinceAt and the last row\'s seenAt, at most 7 days', ...)
  // rows L11..L20; first sinceAt 0, last seenAt 604800 → includes; last seenAt 604801 → excludes
test('week_of_grind is not earned by one jump after three weeks away', ...)
  // rows L11..L20 all sinceAt 0, seenAt 1814400 → excludes
test('steady_climber needs level rows on seven consecutive UTC dates', ...)
  // seenAt at 12:00 UTC on 2026-11-04..10 → includes; 2026-11-04..09 plus 11-11 → excludes;
  // two rows on the same date count once
test('no level rows means no time badges and gear null means no gear badges', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find module `src/server/wow/badges.ts`.

- [ ] **Step 3: Implement `newBadges`**

Week of the grind: sort rows by level; for each window of 10 consecutive rows,
`last.seenAt - (first.sinceAt ?? first.seenAt) <= 604800`. Steady climber: distinct UTC dates
(`Math.floor(seenAt / 86400)`) with a run of 7 consecutive days.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/wow/badges.ts test/wow/badges.test.ts
git commit -m "Award WoW badges from gear and level history"
```

---

### Task 4: Records

**Files:**
- Create: `src/server/wow/records.ts`
- Test: `test/wow/records.test.ts`

**Interfaces:**
- Consumes: `LevelRow`, `MILESTONES`, `TIE_WINDOW_SECONDS` (Task 1).
- Produces:
  ```ts
  export interface RaceCharacter { characterId: number; userId: number; level: number; isMain: boolean; baselineLevel: number | null; levels: LevelRow[] }
  export interface Standing { characterId: number; level: number; reachedAt: number | null }
  export interface FirstRecord { level: number; characterIds: number[]; at: number }
  export interface BandRecord { from: number; to: number; characterId: number; seconds: number }
  export interface RaceRecords { standings: Standing[]; firsts: FirstRecord[]; fastest: BandRecord[]; scenic: BandRecord | null }
  export function reachedAt(c: RaceCharacter, level: number): number | null;
  export function pickCounted(chars: RaceCharacter[], alts: boolean): RaceCharacter[];
  export function computeRace(chars: RaceCharacter[], alts: boolean): RaceRecords;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test('reachedAt counts only levels seen after the baseline', ...)
  // baselineLevel 45 → reachedAt(c, 40) === null; baselineLevel 30 with row L40 seenAt 100 → 100
test('pickCounted: the main, else the highest level, ties to the lowest characterId; alts=true keeps all', ...)
  // user 1: chars 10 (lvl 30, main) and 11 (lvl 40) → [10]
  // user 2: chars 20 (lvl 25) and 21 (lvl 25), no main → [20]
test('standings: level desc, then who reached it first, never-seen last', ...)
test('firsts share within two hours', ...)
  // A reaches 40 at t, B at t+7200, C at t+7201 → firsts[40].characterIds [A, B], at t
test('a milestone nobody counted has reached is absent from firsts', ...)
test('fastest needs both ends of the band observed', ...)
  // A: 10 at 0, 20 at 1000; B: baseline 15, 20 at 500 → fastest 10→20 is A, 1000 s
test('scenic is the slowest completed band, or null', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find module `src/server/wow/records.ts`.

- [ ] **Step 3: Implement the four functions**

Bands are `[10,20], [20,30], [30,40], [40,50], [50,60]`. Fastest per band: smallest seconds; a tie
goes to the earlier `reachedAt(to)`. Bands nobody completed are omitted from `fastest`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/wow/records.ts test/wow/records.test.ts
git commit -m "Compute WoW standings, firsts and level records"
```

---

### Task 5: Database tables

**Files:**
- Modify: `src/db/schema.ts` (new tables after `scVerifications`; `medals` column)
- Create: `drizzle/0035_*.sql` (generated) and its `drizzle/meta` snapshot
- Modify: `src/db/migrations.generated.ts` (generated)

**Interfaces:**
- Produces drizzle tables `wowLinks`, `wowCharacters`, `wowTimeline` with the spec's columns
  (camelCase in TS, snake_case in SQL) and `medals.autoGrantRule`. Types:
  - `wowLinks`: `userId` integer primary key → users.id cascade; `bnetId` text unique not null;
    `battletag` text not null; `linkedAt` integer not null default now.
  - `wowCharacters`: `id` integer primary key autoincrement; `userId` → users.id cascade not null;
    `region` text enum WowRegion not null; `blizzardId` integer not null; `realmSlug`, `realmName`,
    `name`, `className`, `raceName` text not null; `classId` integer not null; `faction` text enum
    `['ALLIANCE','HORDE']` not null; `level` integer not null; `itemLevel` integer; `guildName` text;
    `gear` `text('gear', { mode: 'json' }).$type<Gear>()`; `followed` and `isMain` boolean not null
    default false; `baselineLevel` integer; `lastLoginAt`, `lastPolledAt`, `lastValidatedAt` integer;
    `statusFailures` integer not null default 0; `createdAt` integer not null default now. Unique
    index `wow_characters_region_blizzard_idx (region, blizzard_id)`; index
    `wow_characters_poll_idx (followed, last_polled_at)`; index `wow_characters_user_idx (user_id)`.
  - `wowTimeline`: `id`; `characterId` → wow_characters.id cascade not null; `kind` text enum
    `['tracking_started','level','item','guild_join','guild_leave','badge']` not null; `level`,
    `itemId`, `itemLevel` integer; `itemName`, `itemQuality`, `slot`, `tag`, `guildName`, `badgeKey`
    text; `seenAt` integer not null; `sinceAt` integer; `createdAt` default now. Index
    `wow_timeline_character_idx (character_id, seen_at)`.
  - `medals.autoGrantRule`: `text('auto_grant_rule')`, nullable.

- [ ] **Step 1: Add the tables and column to `src/db/schema.ts`**

Follow the comment style of `scVerifications` (a short block comment per table saying what it holds
and that it is part of the World of Warcraft module).

- [ ] **Step 2: Generate and bundle the migration**

Run: `npm run db:generate && npm run db:bundle`
Expected: a new `drizzle/0035_*.sql` containing `CREATE TABLE \`wow_links\``,
`CREATE TABLE \`wow_characters\``, `CREATE TABLE \`wow_timeline\`` and
`ALTER TABLE \`medals\` ADD \`auto_grant_rule\` text`, and nothing else.

- [ ] **Step 3: Verify the migration applies**

Run: `npx wrangler d1 migrations apply mustr --local && npm run typecheck`
Expected: all migrations apply, ending with 0035; typecheck exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/ src/db/migrations.generated.ts
git commit -m "Add the World of Warcraft module tables"
```

---

### Task 6: Module flag, config, menu item and page access

**Files:**
- Modify: `src/shared/wow.ts` (config type and cleaner)
- Modify: `src/server/modules.ts`
- Modify: `src/server/routes/settings.ts:80-95` (`/modules`)
- Modify: `src/client/lib/modules.ts`
- Modify: `src/client/pages/ModulesAdmin.tsx:33-48` (module list and `NO_MODULES`)
- Modify: `src/shared/nav.ts` (`module` union, `BUILTIN_TARGETS`, `defaultNavConfig`)
- Modify: `src/shared/pageAccess.ts`, `src/client/pages/BuiltinPagesAdmin.tsx:17-21`
- Test: `test/wow/config.test.ts`

**Interfaces:**
- Produces, in `src/shared/wow.ts`:
  ```ts
  export const DEFAULT_WOW_NAMESPACE = ''; // set to Forever's profile namespace once Blizzard publishes it
  export interface WowConfig { clientId: string; clientSecret: string; region: WowRegion; namespace: string; verifiedAt: number | null; lastError: string | null; lastErrorAt: number | null }
  export const EMPTY_WOW_CONFIG: WowConfig; // blanks, region 'us', namespace DEFAULT_WOW_NAMESPACE, nulls
  export function cleanWowConfig(raw: unknown, previous: WowConfig): WowConfig;
  export type PublicWowConfig = Omit<WowConfig, 'clientSecret'> & { hasSecret: boolean };
  export function publicWowConfig(cfg: WowConfig): PublicWowConfig;
  ```
- Produces, in `src/server/modules.ts`: `ModuleFlags.wow: boolean`; `WOW_KEY = 'wow'`;
  `loadWowConfig(env, database?): Promise<WowConfig>`; `saveWowConfig(env, cfg, updatedBy: number | null): Promise<void>`;
  `wowReady(env, database?): Promise<WowConfig | null>` (non-null only when the flag is on,
  `verifiedAt` is set and `namespace` is non-empty).
- Produces: `BUILTIN_TARGETS.leveling = { key: 'leveling', path: '/leveling', label: 'Leveling', module: 'wow' }`;
  `BuiltinContentPage` gains `'leveling'`, default `'members'`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a blank secret keeps the previous one', ...)
  // cleanWowConfig({ clientSecret: '' }, { ...EMPTY, clientSecret: 'old' }).clientSecret === 'old'
test('changing the client id, secret, region or namespace clears verifiedAt', ...)
  // previous verifiedAt 100; same values → 100; region 'eu' → null
test('unknown region falls back to us; namespace is trimmed, lowercased, limited to [a-z0-9-], 64 chars', ...)
  // { region: 'xx' } → 'us'; ' Profile-Classic1x ' → 'profile-classic1x'; 'bad ns!' → ''
test('verifiedAt, lastError and lastErrorAt are never taken from the input', ...)
test('publicWowConfig drops the secret and reports its presence', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, `cleanWowConfig` is not exported.

- [ ] **Step 3: Implement the config functions and the flag plumbing**

`cleanModuleFlags` and `loadModules` read `wow` like `gallery`. `PUT /api/settings/modules` returns
400 `{ error: 'Test the Battle.net connection in the World of Warcraft settings first.' }` when the
body turns `wow` on and `loadWowConfig` has no `verifiedAt`. Add the module to `MODULES` in
`ModulesAdmin.tsx` with label "World of Warcraft" and description "Members link Battle.net and the
guild gets a leveling race: character timelines, charts, records, Discord milestones and medals."
Add `leveling` to the default menu after `gallery`, and to `PAGES` in `BuiltinPagesAdmin.tsx` with
label "Leveling", path `/leveling`, hint "The World of Warcraft level race. Needs the module on."

- [ ] **Step 4: Run tests, typecheck and build**

Run: `npm test && npm run build`
Expected: PASS; build exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/shared/wow.ts src/server/modules.ts src/server/routes/settings.ts src/client/lib/modules.ts src/client/pages/ModulesAdmin.tsx src/shared/nav.ts src/shared/pageAccess.ts src/client/pages/BuiltinPagesAdmin.tsx test/wow/config.test.ts
git commit -m "Add the World of Warcraft module flag, config and Leveling page entry"
```

---

### Task 7: Blizzard client

**Files:**
- Create: `src/server/wow/bnet.ts`
- Test: `test/wow/bnet.test.ts`

**Interfaces:**
- Consumes: Task 1 parsers and types; `WowConfig` (Task 6).
- Produces:
  ```ts
  export const BNET_OAUTH = 'https://oauth.battle.net';
  export const BNET_USER_AGENT = 'Mozilla/5.0 (compatible; mustr.gg-wow/1.0; +https://mustr.gg)';
  export class BnetError extends Error { readonly status: number; get retryable(): boolean /* 429 or >= 500 */ }
  export type BnetCreds = Pick<WowConfig, 'clientId' | 'clientSecret' | 'region' | 'namespace'>;
  export interface TokenStore { get(): Promise<{ token: string; expiresAt: number } | null>; set(v: { token: string; expiresAt: number }): Promise<void> }
  export type FetchFn = typeof fetch;
  export function characterPath(realmSlug: string, name: string): string;
  export function authorizeUrl(c: BnetCreds, redirectUri: string, state: string): string;
  export function exchangeCode(c: BnetCreds, code: string, redirectUri: string, f?: FetchFn): Promise<string>;
  export function fetchUserInfo(userToken: string, f?: FetchFn): Promise<{ bnetId: string; battletag: string }>;
  export function fetchAccountCharacters(c: BnetCreds, userToken: string, f?: FetchFn): Promise<AccountCharacter[]>;
  export function appToken(c: BnetCreds, store: TokenStore, now: number, f?: FetchFn): Promise<string>;
  export function fetchSummary(c: BnetCreds, token: string, realmSlug: string, name: string, f?: FetchFn): Promise<CharacterSummary | null>;
  export function fetchEquipment(c: BnetCreds, token: string, realmSlug: string, name: string, f?: FetchFn): Promise<Gear | null>;
  export function fetchStatus(c: BnetCreds, token: string, realmSlug: string, name: string, f?: FetchFn): Promise<CharacterStatus | null>;
  ```

- [ ] **Step 1: Write the failing tests** (a fake `FetchFn` records the request and returns a canned `Response`)

```ts
test('characterPath lowercases and URL-encodes the name', () => {
  assert.equal(characterPath('sylvanas', 'Ëmberwick'), '/profile/wow/character/sylvanas/%C3%ABmberwick');
});
test('authorizeUrl targets oauth.battle.net with openid and wow.profile', ...)
  // URL origin+path https://oauth.battle.net/authorize; params client_id, redirect_uri,
  // response_type=code, scope 'openid wow.profile', state
test('fetchSummary calls the regional host with namespace, locale and a bearer token', ...)
  // creds region 'eu', namespace 'profile-classic1x' → request URL
  // https://eu.api.blizzard.com/profile/wow/character/sylvanas/brightblade?namespace=profile-classic1x-eu&locale=en_US
  // header Authorization 'Bearer T', User-Agent BNET_USER_AGENT; returns parseSummary(fixture)
test('404 returns null; 429 and 503 throw retryable; 401 throws non-retryable', ...)
test('appToken reuses a token with more than 300 s left and refreshes otherwise', ...)
  // store holds { token: 'A', expiresAt: now + 301 } → 'A', fake fetch not called
  // expiresAt now + 299 → POST https://oauth.battle.net/token with Basic auth and
  // grant_type=client_credentials; returns 'B'; store.set called with { token: 'B', expiresAt: now + 86399 }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find module `src/server/wow/bnet.ts`.

- [ ] **Step 3: Implement `bnet.ts`**

Account characters: `GET /profile/user/wow` with the user token. User info: `GET ${BNET_OAUTH}/userinfo`.
Code exchange: `POST ${BNET_OAUTH}/token` with `grant_type=authorization_code`, the code and
`redirect_uri`, Basic auth. Every function defaults `f` to the global `fetch`. A non-OK response other
than 404 throws `BnetError(status, 'Blizzard returned <status>')`, never including the token.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/wow/bnet.ts test/wow/bnet.test.ts
git commit -m "Add the Battle.net API client for the WoW module"
```

---

### Task 8: Linking and the member endpoints

**Files:**
- Create: `src/server/wow/follow.ts`
- Create: `src/server/routes/wow.ts`
- Modify: `src/server/index.ts:449-476` (mount `app.route('/api/wow', wowRoutes)`)
- Test: `test/wow/follow.test.ts`

**Interfaces:**
- Consumes: Task 7 client; `loadWowConfig`, `loadModules` (Task 6); tables (Task 5); `requireAuth`, `db` from `src/server/middleware/auth.ts`.
- Produces, in `follow.ts`:
  ```ts
  export interface OwnedCharacter { id: number; followed: boolean; level: number }
  export type FollowPlan = { follow: number[]; deleteIds: number[]; main: number | null } | { error: string };
  export function planFollow(owned: OwnedCharacter[], follow: number[], main: number | null): FollowPlan;
  ```
- Produces routes. Each one takes a `requireWowModule` middleware, placed before `requireAuth`, that
  returns 404 unless `ModuleFlags.wow`. Attach it per route rather than with `use('*')`, so the
  `/admin/*` routes added in Tasks 10 and 11 stay reachable while the module is off.
  - `GET /api/wow/link/start` (`requireAuth`): sets cookie `wow_oauth_state` (HttpOnly, Secure,
    SameSite=Lax, Max-Age=600) and redirects to `authorizeUrl` with redirect URI
    `new URL('/api/wow/link/callback', c.req.url)`.
  - `GET /api/wow/link/callback` (`requireAuth`): on success redirects to `/members/<viewerId>?wow=choose`;
    on failure to `/members/<viewerId>?wow=error&reason=<denied|state|conflict|none|blizzard>`.
  - `POST /api/wow/characters/follow` (`requireAuth`), body `{ follow: number[]; main: number | null }`.
  - `DELETE /api/wow/link` (`requireAuth`).
  - `GET /api/wow/members/:userId` (`requireAuth`), returns
    `{ battletag: string | null; linked: boolean; characters: CharacterCard[]; timeline: Record<number, TimelineEntry[]>; candidates: AccountCandidate[] }`,
    where `battletag` and `candidates` are only filled for the member themselves. Types exported from `src/shared/wow.ts`:
    ```ts
    export interface CharacterCard { id: number; name: string; realmName: string; classId: number; className: string; raceName: string; level: number; itemLevel: number | null; guildName: string | null; isMain: boolean; lastLoginAt: number | null }
    export interface TimelineEntry { kind: 'tracking_started' | 'level' | 'item' | 'guild_join' | 'guild_leave' | 'badge'; level: number | null; itemName: string | null; itemQuality: ItemQuality | null; itemLevel: number | null; slot: string | null; tag: 'first_rare' | 'first_epic' | null; guildName: string | null; badgeKey: BadgeKey | null; seenAt: number; sinceAt: number | null }
    export interface AccountCandidate { id: number; name: string; realmName: string; className: string; level: number; followed: boolean; isMain: boolean }
    ```

- [ ] **Step 1: Write the failing tests for `planFollow`**

```ts
test('follows the listed characters and deletes previously followed ones left out', ...)
  // owned [1 followed, 2 followed, 3 candidate]; follow [2, 3] → follow [2, 3], deleteIds [1]
test('candidates left out are kept for the daily cleanup, not deleted', ...)
test('main must be followed; otherwise the highest level is main', ...)
  // follow [2, 3], main 1 → main is the higher of 2 and 3; follow [] → main null
test('ids the member does not own are an error', ...)
  // follow [99] → { error: 'Unknown character.' }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find module `src/server/wow/follow.ts`.

- [ ] **Step 3: Implement `planFollow`, then the routes**

Callback order: Blizzard `error` param → `denied`; missing or mismatched state → `state`; exchange
code, `fetchUserInfo`, `fetchAccountCharacters` (any `BnetError` → `blizzard`); a `wow_links` row
with this `bnetId` for another user → `conflict`; no characters → `none`. Then upsert the link,
insert new characters with `followed = false`, update name, level and class on characters the
member already has, clear the state cookie, and redirect. The user token goes out of scope at the
end of the handler and is never written anywhere. The follow route applies `planFollow` in one
`db.batch`, so a member has at most one main. Timeline rows are returned newest first.

- [ ] **Step 4: Run tests, typecheck and build**

Run: `npm test && npm run build`
Expected: PASS; build exits 0.

- [ ] **Step 5: Check the module gate by hand**

Run `npm run dev`, then `curl -i http://localhost:8787/api/wow/members/1` with no session.
Expected: 404 while the module is off, because the gate runs before `requireAuth`.

- [ ] **Step 6: Commit**

```bash
git add src/server/wow/follow.ts src/server/routes/wow.ts src/server/index.ts src/shared/wow.ts test/wow/follow.test.ts
git commit -m "Link Battle.net accounts and choose characters to follow"
```

---

### Task 9: The character sweep

**Files:**
- Create: `src/server/wow/status.ts`
- Create: `src/server/wow/poll.ts`
- Modify: `src/server/index.ts:681-735` (`scheduled`)
- Modify: `wrangler.jsonc` and `wrangler.mustr.jsonc` (crons)
- Test: `test/wow/status.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 5, 6, 7.
- Produces, in `status.ts`:
  ```ts
  export const STATUS_FAILURE_LIMIT = 3;
  export type StatusDecision = { action: 'ok' } | { action: 'fail'; failures: number } | { action: 'delete' };
  export function statusDecision(status: CharacterStatus | null, storedBlizzardId: number, failures: number): StatusDecision;
  ```
- Produces, in `poll.ts`:
  ```ts
  export const WOW_CALL_BUDGET = 40;
  export const WOW_STATUS_CALLS_PER_RUN = 10;
  export const WOW_CRON = '2-59/5 * * * *';
  export interface WowEvent { userId: number; characterId: number; characterName: string; className: string; firstCheck: boolean; entries: EntryDraft[]; badges: BadgeKey[] }
  export interface SweepOutcome { polled: number; statusChecked: number; deleted: number; stoppedEarly: boolean; events: WowEvent[] }
  export function runWowSweep(env: Env, now?: number): Promise<SweepOutcome>;
  export function cleanupWowData(database: DB, now: number): Promise<number>; // rows deleted
  export function settingsTokenStore(database: DB): TokenStore; // settings key 'wow_token'
  ```

- [ ] **Step 1: Write the failing tests for `statusDecision`**

```ts
test('valid with a matching id is ok', ...)          // ({ blizzardId: 5, isValid: true }, 5, 2) → { action: 'ok' }
test('invalid or a changed id deletes at once', ...)  // isValid false → delete; blizzardId 6 vs 5 → delete
test('a 404 counts up and deletes on the third in a row', ...)
  // (null, 5, 0) → { action: 'fail', failures: 1 }; (null, 5, 1) → fail 2; (null, 5, 2) → delete
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find module `src/server/wow/status.ts`.

- [ ] **Step 3: Implement `statusDecision`, then the sweep**

`runWowSweep`:
1. `wowReady(env)`; null → return an empty outcome.
2. Wrap `fetch` in a counter that throws a private `BudgetSpent` error once `WOW_CALL_BUDGET` calls are used.
3. `appToken` with `settingsTokenStore`.
4. Status pass: followed characters with `lastValidatedAt` null or older than `now - 86400`, oldest
   first, up to `WOW_STATUS_CALLS_PER_RUN`, then apply `statusDecision`. `ok` sets
   `lastValidatedAt = now` and `statusFailures = 0`.
5. Poll pass: followed characters by `lastPolledAt` ascending (nulls first). For each: `fetchSummary`;
   null → set `lastPolledAt`, next. Fetch gear when `summary.lastLoginAt !== stored.lastLoginAt` or
   `stored.gear === null`; an equipment 404 counts as `{}`. Load the character's earned badge keys from
   `wow_timeline`, run `diffCharacter` (`firstCheck = baselineLevel === null`), insert the entries, and
   update the character (level, itemLevel, guild, gear, lastLoginAt, lastPolledAt, and
   `baselineLevel` on a first check). Then load its `level` rows and run `newBadges`. Write one
   `badge` row per new badge with `seenAt` equal to the diff's seenAt, and push a `WowEvent` when
   entries or badges are non-empty.
6. `BudgetSpent` ends the run normally. A retryable `BnetError` sets `stoppedEarly`. A 401 or 403
   saves `lastError` and `lastErrorAt` to the config and ends the run.

`cleanupWowData` deletes followed characters with `lastValidatedAt` older than `now - 30 * 86400`
(or null with `createdAt` that old) and unfollowed characters with `createdAt` older than
`now - 86400`.
Cron: add `"2-59/5 * * * *"` to both wrangler files. In `scheduled`, branch on `WOW_CRON` before the
5-minute reconcile and log the outcome with `console.log('WoW sweep:', JSON.stringify(...))` minus
`events`. Add `cleanupWowData` to the hourly branch, which runs whether or not the module is on.

- [ ] **Step 4: Run tests, typecheck and build**

Run: `npm test && npm run build`
Expected: PASS; build exits 0.

- [ ] **Step 5: Check the cron no-op by hand**

Run `npx wrangler dev --test-scheduled`, then
`curl "http://localhost:8787/__scheduled?cron=2-59%2F5+*+*+*+*"`.
Expected: logs an empty outcome (the module is off) and no error.

- [ ] **Step 6: Commit**

```bash
git add src/server/wow/status.ts src/server/wow/poll.ts src/server/index.ts wrangler.jsonc wrangler.mustr.jsonc test/wow/status.test.ts
git commit -m "Sweep followed WoW characters on their own five-minute schedule"
```

---

### Task 10: Medals and Discord posts

**Files:**
- Create: `src/server/wow/milestones.ts`
- Create: `src/server/wow/race.ts`
- Create: `src/server/medals/wow.ts`
- Create: `src/server/wow/events.ts`
- Modify: `src/server/discord/announce.ts` (keys, event variants, placeholders, colours, defaults)
- Modify: `src/client/pages/Announcements.tsx:16-40`
- Modify: `src/server/routes/wow.ts` (`POST /admin/medals`)
- Modify: `src/server/index.ts` (pass sweep events to `handleWowEvents`)
- Test: `test/wow/milestones.test.ts`

**Interfaces:**
- Consumes: `EntryDraft` (Task 2); `FirstRecord`, `computeRace`, `RaceCharacter` (Task 4); `WowEvent` (Task 9); `announce`, `loadAnnouncementConfig`.
- Produces:
  ```ts
  // milestones.ts
  export interface MilestonePost { type: 'wowFirst' | 'wowLevel'; level: number; shared: boolean }
  export function milestonePosts(input: { characterId: number; firstCheck: boolean; entries: EntryDraft[]; firsts: FirstRecord[]; now: number }): MilestonePost[]; // in preference order
  // race.ts
  export function loadRaceCharacters(database: DB): Promise<(RaceCharacter & { card: CharacterCard; memberName: string })[]>;
  // medals/wow.ts
  export function awardWowMedals(database: DB, userId: number, characterName: string, badges: BadgeKey[], firstCheck: boolean): Promise<{ medalName: string; medalImageUrl: string | null; citation: string }[]>;
  // events.ts
  export const WOW_POST_BUDGET = 8;
  export function handleWowEvents(env: Env, events: WowEvent[], now: number): Promise<{ posted: number; medals: number }>;
  ```
- New announcement keys `wowLevel` (placeholders `{member}`, `{character}`, `{level}`, `{class}`) and
  `wowFirst` (`{member}`, `{character}`, `{level}`), both off by default.

- [ ] **Step 1: Write the failing tests for `milestonePosts`**

```ts
test('a jump across a milestone gives one level post for the highest milestone crossed', ...)
  // level rows 38, 39, 40, 41 → [{ type: 'wowLevel', level: 40, shared: false }]
test('reaching 60 is a milestone', ...)
test('being first adds a wowFirst post ahead of the level post', ...)
  // firsts [{ level: 40, characterIds: [7], at }] for character 7 → [wowFirst 40, wowLevel 40]
test('a shared first is marked shared', ...)   // characterIds [7, 8] → shared: true
test('a first check, no milestone, or a change seen more than 24 hours ago gives nothing', ...)
  // tracking_started only → []; rows 41, 42 → []; seenAt < now - 86400 → []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find module `src/server/wow/milestones.ts`.

- [ ] **Step 3: Implement `milestonePosts`, the announcement keys, medals and the handler**

Announcement defaults: `wowLevel` title "✨ Level milestone", body
"**{character}** ({class}) reached level **{level}**."; `wowFirst` title "🥇 Guild first", body
"**{character}** is the first in the guild to reach level **{level}**." (or "shares first place to
level **{level}**." when `shared`). Colours: `wowLevel` 0x4a90d9, `wowFirst` 0xe6a23c.
`Announcements.tsx` labels: "WoW level milestone" / "Posts when a character reaches a tenth level or
level 60 (World of Warcraft module)." and "WoW guild first" / "Posts when a character is the guild's
first to reach a tenth level (World of Warcraft module)."
`awardWowMedals` finds medals whose `autoGrantRule` is `wow:<badge>`, skips any the member holds,
inserts `member_medals` with `awardedBy` null and citation "Earned by <character>" (or "<character>
already had it when tracking started" on a first check), and writes the same `medal.auto_award`
audit row as the tenure sweep.
`handleWowEvents` loads the announcement config and `computeRace(loadRaceCharacters(db), false).firsts`
once. For each event it posts the first `milestonePosts` entry whose key is enabled, then posts a
`medalAward` for each new medal while posts remain. Posts stop at `WOW_POST_BUDGET`. The base URL
comes from `loadConfig(env).siteUrl`. Member name, Discord ID and avatar come from `memberName` and
`discordAvatar`, as in the medal award route (`src/server/routes/members.ts:633-646`).
`POST /api/wow/admin/medals` (`medals.manage`) creates one medal per `BADGE_ORDER` key whose rule
doesn't exist yet, using `BADGES` names and descriptions, and returns `{ created: number }`.

- [ ] **Step 4: Run tests, typecheck and build**

Run: `npm test && npm run build`
Expected: PASS; build exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/server/wow/milestones.ts src/server/wow/race.ts src/server/medals/wow.ts src/server/wow/events.ts src/server/discord/announce.ts src/client/pages/Announcements.tsx src/server/routes/wow.ts src/server/index.ts test/wow/milestones.test.ts
git commit -m "Post WoW milestones to Discord and award WoW medals"
```

---

### Task 11: Admin settings card

**Files:**
- Modify: `src/server/routes/wow.ts` (admin routes, outside the module gate)
- Modify: `src/client/pages/ModulesAdmin.tsx`
- Modify: `src/client/styles.css`

**Interfaces:**
- Consumes: `cleanWowConfig`, `publicWowConfig`, `loadWowConfig`, `saveWowConfig` (Task 6); `appToken` (Task 7).
- Produces routes (all `requirePermission('settings.manage')`):
  - `GET /api/wow/admin/config` → `{ wow: PublicWowConfig; redirectUri: string }`, where `redirectUri` is
    `new URL('/api/wow/link/callback', c.req.url)`.
  - `PUT /api/wow/admin/config` body `{ wow: unknown }` → `{ wow: PublicWowConfig }`.
  - `POST /api/wow/admin/test` → `{ ok: true; verifiedAt: number } | { ok: false; error: string }`.
    An empty namespace returns `{ ok: false, error: "Enter Blizzard's data section first." }`.
    Otherwise it requests a fresh app token with an in-memory `TokenStore`. Success saves
    `verifiedAt = now` and clears `lastError`; failure clears `verifiedAt` and saves `lastError`.

- [ ] **Step 1: Implement the routes**

- [ ] **Step 2: Add the World of Warcraft option set to `ModulesAdmin.tsx`**

Unlike the other modules, it shows whether or not the module is on, since the key must be tested
before the module can be switched on. Fields:
- Client ID and Client secret. The secret is a password input; when `hasSecret` its placeholder reads
  "Saved. Leave blank to keep it."
- Region: US, Europe, Korea or Taiwan.
- Blizzard data section, with placeholder "profile-classic1x (Classic Era, for testing)".

Under the fields, a read-only line: "Add this redirect URL to your Battle.net client:
<redirectUri>". Then **Save**, **Test connection**, a status line ("Connection verified on <date>" or
the last error and its time), and, when the module is on, **Create WoW medals**.

- [ ] **Step 3: Typecheck and build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 4: Check by hand** (needs a signed-in admin session locally; if none is available,
  do this check in Task 14 instead)

In `npm run dev`, save bogus credentials and click **Test connection**.
Expected: the card shows Blizzard's error. Switching the module on shows "Test the Battle.net
connection in the World of Warcraft settings first."

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/wow.ts src/client/pages/ModulesAdmin.tsx src/client/styles.css
git commit -m "Add the World of Warcraft settings card"
```

---

### Task 12: Characters on the member profile

**Files:**
- Create: `src/client/lib/wowJourney.ts`
- Create: `src/client/components/WowCharacters.tsx`
- Modify: `src/client/pages/MemberDetail.tsx:625` (render next to the Star Citizen block)
- Modify: `src/client/styles.css`
- Test: `test/wow/journey.test.ts`

**Interfaces:**
- Consumes: `GET /api/wow/members/:userId`, `POST /api/wow/characters/follow`, `DELETE /api/wow/link` (Task 8); `TimelineEntry`, `CLASS_COLORS`, `QUALITY_COLORS`, `BADGES` (shared).
- Produces, in `wowJourney.ts`:
  ```ts
  export type JourneyItem =
    | { kind: 'levels'; from: number; to: number; milestone: boolean; seenAt: number; sinceAt: number | null }
    | { kind: 'entry'; entry: TimelineEntry };
  export interface JourneyMonth { key: string /* 'YYYY-MM' */; label: string /* 'October 2026' */; items: JourneyItem[] }
  export function groupJourney(entries: TimelineEntry[], timeZone: string): JourneyMonth[]; // newest first
  export function aroundPhrase(seenAt: number, sinceAt: number | null, timeZone: string): string;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
test('level rows from one check become one levels item', ...)
  // rows 39, 40, 41 sharing seenAt → { kind: 'levels', from: 39, to: 41, milestone: true }
test('level rows from different checks stay separate', ...)
test('months follow the viewer time zone', ...)
  // seenAt 2026-11-01T02:00Z with 'America/Los_Angeles' → month key '2026-10'; with 'UTC' → '2026-11'
test('aroundPhrase reads around one day or between two', ...)
  // same local day → 'around 8 October'; 5th and 6th → 'between 5 and 6 October';
  // 31 Oct and 1 Nov → 'between 31 October and 1 November'; sinceAt null → 'around …'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find module `src/client/lib/wowJourney.ts`.

- [ ] **Step 3: Implement `wowJourney.ts` with `Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'long' })`**

- [ ] **Step 4: Build `WowCharacters`**

Cards show a class-colour border via `--class-color`, level, item level, guild, "online <around
phrase>", and a Main marker. Clicking a card shows its journey: every tenth level is highlighted;
items are coloured by quality with their item level and a "First epic" or "First blue" tag; badge
rows use `BADGES` names. A badge row whose `seenAt` equals the `tracking_started` row's reads
"already had it when tracking started". The member's own profile shows:
- **Link Battle.net**, a plain link to `/api/wow/link/start`.
- **Choose characters**, a checklist plus a main radio, which saves through
  `POST /characters/follow` and opens automatically on `?wow=choose`.
- **Unlink**, which asks to confirm and then calls `DELETE /link`.

The `?wow=error&reason=` messages:
- `denied`: "Battle.net sign-in was cancelled."
- `state`: "That sign-in link expired. Try again."
- `conflict`: "That Battle.net account is already linked to another member."
- `none`: "No World of Warcraft: Forever characters found in this region on that account. Log in
  once with the character, then try again."
- `blizzard`: "Blizzard didn't respond. Try again in a few minutes."

Under the cards, a note reads: "History starts when you link Battle.net."

- [ ] **Step 5: Run tests and build**

Run: `npm test && npm run build`
Expected: PASS; build exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/client/lib/wowJourney.ts src/client/components/WowCharacters.tsx src/client/pages/MemberDetail.tsx src/client/styles.css test/wow/journey.test.ts
git commit -m "Show WoW characters and their journey on member profiles"
```

---

### Task 13: The Leveling page

**Files:**
- Modify: `package.json` (add `chart.js`)
- Modify: `src/server/routes/wow.ts` (`GET /race`)
- Create: `src/client/lib/wowSeries.ts`
- Create: `src/client/lib/wowCharts.ts`
- Create: `src/client/pages/Leveling.tsx`
- Modify: `src/client/App.tsx` (lazy import; route wrapped in `PublicOr pageKey="leveling"`)
- Modify: `src/client/styles.css`
- Test: `test/wow/series.test.ts`

**Interfaces:**
- Consumes: `loadRaceCharacters` (Task 10); `computeRace` (Task 4); `loadPageAccess`.
- Produces `GET /api/wow/race?alts=0|1` (module-gated; a logged-out viewer gets 401 unless
  `pageAccess.leveling === 'public'`), returning:
  ```ts
  { summary: { members: number; avgLevel: number; avgItemLevel: number | null; activeThisWeek: number };
    characters: (CharacterCard & { memberName: string })[];
    records: RaceRecords;
    series: { characterId: number; points: { t: number; level: number }[] }[] } // baseline point, then each level row
  ```
- Produces, in `wowSeries.ts`:
  ```ts
  export interface SeriesInput { characterId: number; points: { t: number; level: number }[] }
  export interface Bucketed { labels: string[]; lines: { characterId: number; levels: (number | null)[]; gained: number[] }[] }
  export function bucketSeries(series: SeriesInput[], period: 'day' | 'week', timeZone: string, now: number): Bucketed;
  ```
- Produces, in `wowCharts.ts`: `renderLevelCharts(line: HTMLCanvasElement, bars: HTMLCanvasElement, data: Bucketed, styles: { characterId: number; label: string; color: string; dash: number[] }[]): { update(data: Bucketed): void; destroy(): void }`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a level gained at 23:30 local lands on that local day', ...)
  // 'America/Los_Angeles': point at 2026-10-20T06:30Z (23:30 on the 19th) → gained counted on the label for 19 Oct
test('day buckets span the clock change on 1 November 2026 without a missing or doubled day', ...)
  // points from 2026-10-30 to 2026-11-03 in 'America/Los_Angeles' → labels for 30, 31, 1, 2, 3 exactly once each
test('levels step forward and are null before the first point', ...)
test('week buckets start on Monday and sum gained levels', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find module `src/client/lib/wowSeries.ts`.

- [ ] **Step 3: Implement `bucketSeries`**

Bucket keys come from `Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })`
(which gives `YYYY-MM-DD`). Walk calendar dates from the earliest point's local date to `now`'s local
date. Labels read like "19 Oct" for days and "Wk of 19 Oct" for weeks.

- [ ] **Step 4: Add Chart.js and build the page**

Run: `npm install chart.js@^4.5.0`. `wowCharts.ts` is the only file that imports `chart.js`. It
registers only the line and bar controllers, their elements, the category and linear scales,
Legend and Tooltip. The line chart is stepped with no points; the bar chart is stacked. Colours come
from `CLASS_COLORS[classId] ?? FALLBACK_CLASS_COLOR`. Characters sharing a class take dash patterns
in turn from `[[], [6, 4], [2, 3], [10, 3, 2, 3]]`. Axis and grid colours read the theme's CSS
variables.

`Leveling.tsx` shows, in order:
- The header numbers.
- The alts toggle ("Show alts").
- The per day / per week toggle.
- The two charts.
- Standings.
- Records: Firsts, Fastest ten levels, The scenic route.
- The note "History starts when each member links Battle.net. Times are within a logout of the real
  moment."

Each record names the character and member, and durations read like "3d 1h" or "1w 3d".

- [ ] **Step 5: Run tests and build, and check the chunk**

Run: `npm test && npm run build`
Expected: PASS; build exits 0. Chart.js code appears only in the `Leveling` chunk under
`dist/client/assets`. Check with `grep -l '\$chartjs' dist/client/assets/*.js`, which should list
one file.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/server/routes/wow.ts src/client/lib/wowSeries.ts src/client/lib/wowCharts.ts src/client/pages/Leveling.tsx src/client/App.tsx src/client/styles.css test/wow/series.test.ts
git commit -m "Add the Leveling page with level-race charts and records"
```

---

### Task 14: Live check against Classic with a real key

Needs the owner's Battle.net API client. Create one at develop.battle.net (it requires an
authenticator on the Battle.net account), with the redirect URL shown on the admin card.

**Files:**
- Create: `scripts/wow-capture.ts`
- Create: `test/fixtures/wow/live-summary.json`, `live-equipment.json`, `live-status.json` (captured, names changed)
- Modify: `test/wow/parse.test.ts`

- [ ] **Step 1: Write `scripts/wow-capture.ts`**

It reads `BNET_CLIENT_ID`, `BNET_CLIENT_SECRET`, `BNET_REGION` and `BNET_NAMESPACE` from the
environment, and the realm and character name from its arguments. It fetches the summary, equipment
and status with an app token, replaces every character, guild and realm name with placeholders, and
writes the three `live-*.json` fixtures.

- [ ] **Step 2: Capture, then add a test that the live fixtures parse without throwing and give a level between 1 and 60**

Run: `npx tsx scripts/wow-capture.ts <realm-slug> <character>` with the env vars set, then `npm test`.
Expected: PASS. If a field name differs from the documented shape, fix `parse.ts` and keep both fixture sets passing.

- [ ] **Step 3: Walk through the feature on a deployed test site with the data section set to `profile-classic1x`**

- Link Battle.net and follow a character, then wait for a sweep: the profile shows "Started tracking
  at level N".
- Gain a level and log out, then wait for the next sweep: a level row and, at a tenth level, a
  Discord post.
- Equip a rare item and log out: an item row, the First blue badge, and the medal post when the
  medals exist.
- View `/leveling` with the browser set to two different time zones: the charts move the level to
  the right local day.
- Unlink: the characters and timeline are gone from the profile and from `/leveling`.

- [ ] **Step 4: Commit**

```bash
git add scripts/wow-capture.ts test/fixtures/wow/live-*.json test/wow/parse.test.ts
git commit -m "Capture live Classic responses and test the parsers against them"
```
