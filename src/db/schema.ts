import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import type { HangarItem } from '../shared/hangar';

const now = sql`(unixepoch())`;

/* ------------------------------------------------------------------ *
 * Identity
 *
 * Discord snowflakes exceed Number.MAX_SAFE_INTEGER, so every *_id that
 * comes from Discord is TEXT. Never parse these into a JS number.
 * ------------------------------------------------------------------ */

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    discordId: text('discord_id').notNull().unique(),
    username: text('username').notNull(),
    globalName: text('global_name'),
    // Clan/game name a member sets for themselves. When present it is shown in
    // place of the Discord name everywhere; see shared/names.ts for the order.
    displayName: text('display_name'),
    avatar: text('avatar'), // Discord avatar hash, not a URL
    // A member-chosen profile image (an R2 /media/avatars/… URL). When set it
    // overrides the Discord avatar everywhere the member is shown; NULL falls
    // back to the Discord avatar. See shared/avatar.ts for the resolution order.
    profileImageUrl: text('profile_image_url'),
    email: text('email'),

    rankId: integer('rank_id').references(() => ranks.id, { onDelete: 'set null' }),

    // Bypasses every permission check. Seeded for the founder; see seed.sql.
    isGod: integer('is_god', { mode: 'boolean' }).notNull().default(false),

    // When Discord says this member joined the guild — the authoritative basis
    // for tenure medals. Captured at login and backfilled by the reconcile
    // sweep; falls back to joinedAt (site-join) when Discord hasn't been read
    // for them yet.
    guildJoinedAt: integer('guild_joined_at'),

    // 'pending' = applied via Discord login but not yet a full member (may not be
    // in the guild yet). A pending user is authenticated but authorized like a
    // logged-out visitor (except editing their own profile) — see buildViewer.
    status: text('status', { enum: ['pending', 'active', 'inactive', 'loa', 'retired', 'banned'] })
      .notNull()
      .default('active'),

    recruiterId: integer('recruiter_id'),

    joinedAt: integer('joined_at').notNull().default(now),
    lastSeenAt: integer('last_seen_at'),
    // When the Discord reconcile sweep last checked this member. The cron
    // processes members least-recently-reconciled first, rotating through the
    // roster a bounded batch at a time (see discord/sync.ts reconcileBatch).
    lastReconciledAt: integer('last_reconciled_at'),
    promotedAt: integer('promoted_at'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    index('users_rank_idx').on(t.rankId),
    index('users_status_idx').on(t.status),
  ],
);

/**
 * The ban list — keyed by Discord id so a ban survives deleting the member's
 * record (that's the whole point: it must block re-login even with no user row).
 * Checked at the very top of the OAuth callback, before anything is created.
 * `username` is a display snapshot; removing the row un-bans the Discord id.
 */
export const bans = sqliteTable('bans', {
  discordId: text('discord_id').primaryKey(),
  username: text('username'),
  reason: text('reason'),
  bannedBy: integer('banned_by').references(() => users.id, { onDelete: 'set null' }),
  bannedAt: integer('banned_at').notNull().default(now),
});

export const profiles = sqliteTable('profiles', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  bio: text('bio'),
  location: text('location'),
  timezone: text('timezone'),
  // { "steam": "...", "xbox": "...", "psn": "..." }
  gamertags: text('gamertags', { mode: 'json' }).$type<Record<string, string>>(),
  updatedAt: integer('updated_at').notNull().default(now),
});

/**
 * A member's imported Star Citizen hangar (the SC module) — one JSON blob per
 * member, the normalised item list from the scraper. Replaced wholesale on each
 * re-import; cascades away with the member. Only used when the Star Citizen
 * module is enabled in settings.
 */
export const scHangars = sqliteTable('sc_hangars', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  items: text('items', { mode: 'json' }).$type<HangarItem[]>().notNull(),
  itemCount: integer('item_count').notNull().default(0),
  // Whether the owner has chosen to share this hangar with members who hold the
  // hangar.view permission. Off by default — sharing is opt-in per member.
  isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
  importedAt: integer('imported_at').notNull().default(now),
});

/**
 * A member's CCU (Cross Chassis Upgrade) planning board — one JSON blob per
 * member, chains of upgrade steps built on top of their imported hangar.
 *
 * The CCU planner itself is archived (see archive/ccu-planner/README.md) —
 * pulled for a UI rework, not a data problem. This table is kept declared
 * (rather than deleted from the schema) so drizzle-kit's next diff doesn't
 * emit a DROP TABLE and destroy every member's saved plans. `board` is left
 * as untyped JSON here since the shared `CcuBoard` type moved into the
 * archive with the rest of the feature; restoring the planner restores the
 * `$type<CcuBoard>()` too.
 */
export const scCcuBoards = sqliteTable('sc_ccu_boards', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  board: text('board', { mode: 'json' }).notNull(),
  // Whether the owner has shared their plans with members holding hangar.view.
  // Off by default, exactly like the hangar — sharing is opt-in per member.
  isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull().default(now),
});

/**
 * RSI account verification (the SC module's anti-poser track). A member proves
 * control of an RSI account by placing a one-time code in their public citizen
 * bio; the Worker fetches the profile, confirms the code, and records the parsed
 * org membership. `rsiHandle` is unique so two members can't claim one account
 * (multiple NULLs are allowed for the unverified). The pending_* columns hold an
 * in-flight challenge before it's confirmed. Cascades away with the member.
 */
export const scVerifications = sqliteTable('sc_verifications', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  // In-flight challenge: the code the member must place in their RSI bio and the
  // handle they claimed. Cleared once verified (or replaced on a new attempt).
  pendingCode: text('pending_code'),
  pendingHandle: text('pending_handle'),
  pendingAt: integer('pending_at'),
  // Last time we fetched RSI for this member — a light rate-limit so the confirm
  // button can't hammer RSI (politeness, set before each fetch).
  lastCheckAt: integer('last_check_at'),
  // The verified result — NULL until a confirm succeeds.
  rsiHandle: text('rsi_handle').unique(),
  verifiedAt: integer('verified_at'),
  orgSid: text('org_sid'),
  orgRank: text('org_rank'),
  // Whether the profile's org block was public (vs redacted), and whether the
  // parsed org SID matched this install's configured org.
  orgVisible: integer('org_visible', { mode: 'boolean' }),
  inOrg: integer('in_org', { mode: 'boolean' }),
});

/* ------------------------------------------------------------------ *
 * Hierarchy
 *
 * The 2003 version stored ranks as 21 fixed columns (name_0..name_20) in
 * a single row. Here they are rows: add, delete, and reorder freely.
 * ------------------------------------------------------------------ */

export const ranks = sqliteTable(
  'ranks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    abbreviation: text('abbreviation'),
    imageUrl: text('image_url'),

    // 0 = lowest. Gaps are fine; reorder by rewriting these.
    sortOrder: integer('sort_order').notNull(),

    // Carried over from the original's auto-promotion criteria. 0 = ignored.
    reqDays: integer('req_days').notNull().default(0),
    reqWins: integer('req_wins').notNull().default(0),

    // Rank handed to new recruits on first Discord login. Exactly one should be true.
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),

    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('ranks_sort_order_idx').on(t.sortOrder)],
);

/* ------------------------------------------------------------------ *
 * Permissions
 *
 * A role is a bundle of permission strings AND (optionally) the mirror of
 * a Discord role. Setting discordRoleId makes membership changes here
 * push to Discord, and lets a Discord-side change pull back in.
 * ------------------------------------------------------------------ */

export const roles = sqliteTable('roles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  description: text('description'),
  color: text('color'), // hex, for admin UI chips

  discordRoleId: text('discord_role_id').unique(),

  sortOrder: integer('sort_order').notNull().default(0),

  // System roles cannot be deleted through the admin UI (they can be renamed).
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),

  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
});

export const rolePermissions = sqliteTable(
  'role_permissions',
  {
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    // A Permission literal from src/shared/permissions.ts
    permission: text('permission').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const userRoles = sqliteTable(
  'user_roles',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    // How the member came to hold this role. 'manual' grants are permanent
    // until revoked by hand; 'rank' grants are reconciled when the member's
    // rank changes. A manual grant always wins, so promoting/demoting never
    // strips a role an admin gave on purpose.
    source: text('source', { enum: ['manual', 'rank'] })
      .notNull()
      .default('manual'),
    grantedBy: integer('granted_by').references(() => users.id, { onDelete: 'set null' }),
    grantedAt: integer('granted_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] }), index('user_roles_role_idx').on(t.roleId)],
);

/**
 * Which roles a rank confers. Assigning a member to a rank grants these roles
 * (source='rank'), and a rank change reconciles them. Many-to-many: a rank can
 * grant several roles, and a role can be granted by several ranks.
 */
export const rankRoles = sqliteTable(
  'rank_roles',
  {
    rankId: integer('rank_id')
      .notNull()
      .references(() => ranks.id, { onDelete: 'cascade' }),
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.rankId, t.roleId] }), index('rank_roles_role_idx').on(t.roleId)],
);

/* ------------------------------------------------------------------ *
 * Sessions — opaque random id in an httpOnly cookie, state kept here.
 * ------------------------------------------------------------------ */

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(), // 256-bit random, base64url
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

/* ------------------------------------------------------------------ *
 * API tokens — long-lived personal access tokens for the mobile/native app and
 * scripts. Like sessions, only the SHA-256 of the token is stored, so a database
 * dump can't be replayed. Unlike sessions they carry a user-chosen label and a
 * short display prefix, are managed from account settings, and resolve to the
 * same Viewer (rank + union of role permissions) as a web session.
 * ------------------------------------------------------------------ */

export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(), // SHA-256 (base64url) of the raw token
    label: text('label').notNull(),
    prefix: text('prefix').notNull(), // e.g. "clt_ab12cd" — shown so a token is identifiable
    expiresAt: integer('expires_at'), // null = no expiry
    lastUsedAt: integer('last_used_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('api_tokens_user_idx').on(t.userId)],
);

/* ------------------------------------------------------------------ *
 * Alliance links — cross-org federation. Each row is a trust link to ONE allied
 * org's independent mustr instance. `outboundToken` is the secret THEY issued us
 * (we send it as Bearer when we POST to their /api/alliance/inbound);
 * `inboundTokenHash` is the SHA-256 of the token WE issued them (we match it to
 * authenticate their inbound calls). Their broadcasts post to our local
 * `channelId` via our own bot. Bot tokens are never shared — only these scoped
 * alliance tokens. See src/shared/alliance.ts for the wire contract + sanitizer.
 * ------------------------------------------------------------------ */

export const allianceLinks = sqliteTable(
  'alliance_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    // The ally instance origin (https://…), used for our outbound POSTs.
    baseUrl: text('base_url').notNull(),
    // Secret the ally issued US — presented as Bearer when we call their inbound.
    // Stored as-is (we must send the plaintext), like the Discord bot token.
    outboundToken: text('outbound_token'),
    // SHA-256 (base64url) of the token WE issued them; matched to auth their inbound.
    inboundTokenHash: text('inbound_token_hash').unique(),
    inboundTokenPrefix: text('inbound_token_prefix'),
    // Local Discord channel their broadcasts get posted to (via our own bot).
    channelId: text('channel_id'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastInboundAt: integer('last_inbound_at'),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('alliance_links_enabled_idx').on(t.enabled)],
);

/* ------------------------------------------------------------------ *
 * Content
 * ------------------------------------------------------------------ */

export const news = sqliteTable(
  'news',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    slug: text('slug').notNull().unique(),
    excerpt: text('excerpt'),
    // HTML from the WYSIWYG editor (TipTap). Sanitized on save and again with
    // DOMPurify on render, so stored markup is never trusted at display time.
    body: text('body').notNull(),
    authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['draft', 'published', 'archived'] })
      .notNull()
      .default('draft'),
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    publishedAt: integer('published_at'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('news_status_published_idx').on(t.status, t.publishedAt)],
);

/**
 * Replaces the original site_info + site_prefs + templates + header tables.
 * Theme tokens live under the 'theme' key as CSS custom properties, e.g.
 * { "--color-accent": "#c0392b", "--font-body": "Inter" }
 */
/* ------------------------------------------------------------------ *
 * Training — a repository of courses (embedded Google Slides today) that can be
 * required for specific ranks and marked complete per member. Completion is
 * private (visible to the member + holders of training.view).
 * ------------------------------------------------------------------ */

/** Collapsible sections/categories a course can be grouped under in the module. */
export const trainingSections = sqliteTable('training_sections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
});

export const trainings = sqliteTable('trainings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description'),
  // Optional grouping; NULL = ungrouped. Deleting a section un-groups its courses
  // (set null), it never deletes them.
  sectionId: integer('section_id').references(() => trainingSections.id, { onDelete: 'set null' }),
  // The pasted source URL (kept for editing) and the canonical, origin-locked
  // embed src derived from it (what actually goes in the iframe). See
  // shared/trainingEmbed.ts — the src is never the raw pasted value.
  embedUrl: text('embed_url').notNull(),
  embedSrc: text('embed_src').notNull(),
  provider: text('provider'),
  // How a member gets marked done: 'self' = they can tick it off themselves;
  // 'officer' = only a training.manage holder can (verified). Chosen per course.
  completionMode: text('completion_mode', { enum: ['self', 'officer'] }).notNull().default('officer'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at').notNull().default(now),
  updatedAt: integer('updated_at').notNull().default(now),
});

/** Which ranks a training is required for (many-to-many). No rows = not required. */
export const trainingRequiredRanks = sqliteTable(
  'training_required_ranks',
  {
    trainingId: integer('training_id')
      .notNull()
      .references(() => trainings.id, { onDelete: 'cascade' }),
    rankId: integer('rank_id')
      .notNull()
      .references(() => ranks.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.trainingId, t.rankId] })],
);

/** One row per member per training they've completed. markedBy = who checked it (self or an officer). */
export const trainingCompletions = sqliteTable(
  'training_completions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    trainingId: integer('training_id')
      .notNull()
      .references(() => trainings.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    completedAt: integer('completed_at').notNull().default(now),
    markedBy: integer('marked_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('training_completion_unique').on(t.trainingId, t.userId)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedBy: integer('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: integer('updated_at').notNull().default(now),
});

/**
 * Drag-and-drop page layouts. Each standard page (home, etc.) is one row keyed
 * by a stable `slug`; `layout` is the JSON module tree (rows → columns →
 * modules) defined in src/shared/layout.ts. Any client — the web app today, a
 * native app later — renders the same data, so the layout is deliberately kept
 * as portable JSON rather than baked into components. A missing row falls back
 * to the built-in DEFAULT_LAYOUTS for that slug.
 */
export const pageLayouts = sqliteTable('page_layouts', {
  slug: text('slug').primaryKey(),
  // Human title, shown in the admin page list and used as the nav label.
  title: text('title'),
  layout: text('layout', { mode: 'json' }).$type<unknown>().notNull(),
  // Custom pages can be surfaced in the top nav. 'home' is navigated to at / and
  // is never listed here. nav_order sorts the extra links.
  showInNav: integer('show_in_nav', { mode: 'boolean' }).notNull().default(false),
  navOrder: integer('nav_order').notNull().default(0),
  // Whether logged-out visitors may view this page at all. Off by default so a
  // page never leaks by accident; the home page is seeded on (migration 0018) so
  // a fresh install has a public landing page. Even on a public page, module-level
  // visibility still applies — only modules marked "public" show to anonymous.
  isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
  updatedBy: integer('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: integer('updated_at').notNull().default(now),
});

/* ------------------------------------------------------------------ *
 * Competition
 * ------------------------------------------------------------------ */

export const games = sqliteTable('games', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  iconUrl: text('icon_url'),
  sortOrder: integer('sort_order').notNull().default(0),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull().default(now),
});

export const medals = sqliteTable(
  'medals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    description: text('description'),
    imageUrl: text('image_url'),
    // NULL = clan-wide medal. Set = specific to one game (was the game_medals table).
    gameId: integer('game_id').references(() => games.id, { onDelete: 'cascade' }),
    // Tenure medals: when set, this medal is granted automatically once a member
    // reaches this many months in the guild (6, 12, 24, …). NULL = awarded by
    // hand only. The auto-grant sweep lives in server/medals/tenure.ts.
    autoGrantMonths: integer('auto_grant_months'),
    // Activity medals: when set, granted automatically once a member has attended
    // this many events (10, 50, 100, …). NULL = not an activity medal. The
    // auto-grant sweep lives in server/medals/activity.ts.
    autoGrantAttendance: integer('auto_grant_attendance'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('medals_game_idx').on(t.gameId)],
);

export const memberMedals = sqliteTable(
  'member_medals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    medalId: integer('medal_id')
      .notNull()
      .references(() => medals.id, { onDelete: 'cascade' }),
    citation: text('citation'), // why it was awarded
    awardedBy: integer('awarded_by').references(() => users.id, { onDelete: 'set null' }),
    awardedAt: integer('awarded_at').notNull().default(now),
  },
  (t) => [
    index('member_medals_user_idx').on(t.userId),
    index('member_medals_medal_idx').on(t.medalId),
  ],
);

/* ------------------------------------------------------------------ *
 * War records — awardable "items of pride", handed to members like medals
 * but themed as clan-war honours. A definition (optionally tied to a game)
 * plus a join table of who holds it. Distinct from `matches` below, which is
 * the (currently unused) detailed battle-log design.
 * ------------------------------------------------------------------ */

export const warRecords = sqliteTable(
  'war_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    description: text('description'),
    imageUrl: text('image_url'),
    // NULL = clan-wide. Set = specific to one game.
    gameId: integer('game_id').references(() => games.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('war_records_game_idx').on(t.gameId)],
);

export const memberWarRecords = sqliteTable(
  'member_war_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    warRecordId: integer('war_record_id')
      .notNull()
      .references(() => warRecords.id, { onDelete: 'cascade' }),
    citation: text('citation'),
    awardedBy: integer('awarded_by').references(() => users.id, { onDelete: 'set null' }),
    awardedAt: integer('awarded_at').notNull().default(now),
  },
  (t) => [
    index('member_war_records_user_idx').on(t.userId),
    index('member_war_records_record_idx').on(t.warRecordId),
  ],
);

/** Replaces the original records + stat_records tables. */
export const matches = sqliteTable(
  'matches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    gameId: integer('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    opponent: text('opponent').notNull(),
    opponentTag: text('opponent_tag'),
    result: text('result', { enum: ['win', 'loss', 'draw', 'forfeit'] }).notNull(),
    scoreUs: integer('score_us'),
    scoreThem: integer('score_them'),
    map: text('map'),
    notes: text('notes'),
    playedAt: integer('played_at').notNull(),
    recordedBy: integer('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('matches_game_played_idx').on(t.gameId, t.playedAt)],
);

export const matchParticipants = sqliteTable(
  'match_participants',
  {
    matchId: integer('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Per-game shape varies, so keep it open: { "kills": 12, "deaths": 4 }
    stats: text('stats', { mode: 'json' }).$type<Record<string, number>>(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.userId] }), index('mp_user_idx').on(t.userId)],
);

/* ------------------------------------------------------------------ *
 * Events — clan happenings (war nights, tournaments, movie nights).
 * Authorised members create them; the bot mirrors each to a native Discord
 * scheduled event AND an announcement message, tracked by the id columns so
 * edits and cancellations stay in sync. Times are unix seconds (UTC).
 * ------------------------------------------------------------------ */

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    description: text('description'),
    // An optional banner image (an R2 /media/events/… URL), shown on the events
    // page and as the Discord announcement embed image.
    imageUrl: text('image_url'),
    startsAt: integer('starts_at').notNull(),
    // Discord's external scheduled events require an end time and a location.
    endsAt: integer('ends_at').notNull(),
    location: text('location').notNull(),
    gameId: integer('game_id').references(() => games.id, { onDelete: 'set null' }),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    // The native Discord scheduled event and the channel announcement message,
    // so an edit/cancel here can update or remove them.
    discordEventId: text('discord_event_id'),
    discordMessageId: text('discord_message_id'),
    status: text('status', { enum: ['scheduled', 'cancelled'] })
      .notNull()
      .default('scheduled'),
    // How often this event repeats. The event itself is the first occurrence;
    // when it ends the cron spawns the next one and clears this back to 'none'
    // on the finished row (the recurrence "baton" moves to the new occurrence).
    // So at most one future occurrence per series carries a non-'none' value.
    recurrence: text('recurrence', { enum: ['none', 'daily', 'weekly', 'biweekly', 'monthly'] })
      .notNull()
      .default('none'),
    // When true, creating (and cancelling) this event fans a broadcast out to
    // allied orgs' Discords via alliance federation (see server/alliance/*).
    // Set only by an alliance.manage holder; off by default.
    shareAlliance: integer('share_alliance', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('events_starts_idx').on(t.startsAt)],
);

/**
 * The sign-up "roles" for an event — e.g. Tank / Healer / DPS. Defined per
 * event when it's created. A member picks at most one; an optional capacity
 * caps how many can hold it. Deleting a role frees its holders back to
 * "attending, no role" (the signup's eventRoleId is set null).
 */
export const eventRoles = sqliteTable(
  'event_roles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Optional emoji shown on the Discord sign-up button (a unicode char).
    emoji: text('emoji'),
    // NULL = unlimited. Otherwise the max number of members who can hold it.
    capacity: integer('capacity'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('event_roles_event_idx').on(t.eventId)],
);

/**
 * Attendance — who ACTUALLY showed up to an event, as opposed to who RSVP'd
 * (eventSignups). One row per member per event. Fed by a member checking
 * themselves in during the check-in window, an officer marking them, or a
 * Discord "I'm here" button. Distinct from signups so "planned to come" and
 * "was there" never get confused. Powers the participation score, leaderboards,
 * and the attendance source of the activity heatmap.
 */
export const eventAttendance = sqliteTable(
  'event_attendance',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // How the check-in happened. 'self' = the member; 'officer' = someone with
    // events.manage marked them; 'discord' = the Discord check-in button.
    source: text('source', { enum: ['self', 'officer', 'discord'] }).notNull().default('self'),
    // The officer who marked it (source='officer'); null otherwise.
    markedBy: integer('marked_by').references(() => users.id, { onDelete: 'set null' }),
    checkedInAt: integer('checked_in_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('event_attendance_event_user_idx').on(t.eventId, t.userId),
    index('event_attendance_user_idx').on(t.userId),
  ],
);

/**
 * Per-member daily activity, for the profile heatmap (a GitHub-style calendar).
 * One row per member per day per source; `count` is that day's intensity. `day`
 * is the unix day number (floor(unixSeconds / 86400), UTC) so a date range is a
 * cheap integer scan. `source` is pluggable — 'web' (site visits) and 'event'
 * (attended an event that day) today, 'discord' reserved for a future gateway
 * component that can see chat activity.
 */
export const memberActivity = sqliteTable(
  'member_activity',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: integer('day').notNull(),
    source: text('source', { enum: ['web', 'event', 'discord'] }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.day, t.source] }),
    index('member_activity_user_idx').on(t.userId),
  ],
);

/**
 * A member's sign-up for an event. One row per member per event (unique), so
 * choosing a different role updates the same row and withdrawing deletes it.
 * eventRoleId NULL means "attending, no specific role". Written from both the
 * website and Discord button clicks — the two stay in sync because they share
 * this table.
 */
export const eventSignups = sqliteTable(
  'event_signups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    eventRoleId: integer('event_role_id').references(() => eventRoles.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('event_signups_event_user_idx').on(t.eventId, t.userId),
    index('event_signups_event_idx').on(t.eventId),
  ],
);

/* ------------------------------------------------------------------ *
 * Audit — replaces the original log + security tables.
 * ------------------------------------------------------------------ */

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actorId: integer('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(), // e.g. 'member.promote', 'role.grant'
    targetType: text('target_type'),
    targetId: text('target_id'),
    // A human-written justification. Required for negative actions (demote,
    // remove/ban, revoke a medal/war record/role); optional otherwise. Kept as
    // its own column — not buried in meta — so the log can show and filter on it.
    reason: text('reason'),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    // 'web' for admin portal, 'discord' for slash commands
    source: text('source', { enum: ['web', 'discord', 'system'] })
      .notNull()
      .default('web'),
    ip: text('ip'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('audit_actor_idx').on(t.actorId),
    index('audit_created_idx').on(t.createdAt),
    index('audit_action_idx').on(t.action),
  ],
);

/* ------------------------------------------------------------------ *
 * Gallery module — albums of uploaded images and embedded videos.
 *
 * Optional per-install (settings['modules'].gallery); the tables exist either
 * way, they just go unread while the module is off.
 * ------------------------------------------------------------------ */

export const galleryAlbums = sqliteTable(
  'gallery_albums',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    description: text('description'),
    // Who may see it — see canViewAlbum() in shared/gallery.ts, which is the one
    // authority. 'members' is the default so a newly created album is never
    // accidentally world-readable before its author has chosen.
    audience: text('audience', { enum: ['public', 'members', 'role'] })
      .notNull()
      .default('members'),
    // Read only when audience = 'role'. ON DELETE SET NULL rather than CASCADE:
    // deleting a role must never delete its album, and it must never *widen*
    // one either — an album left on 'role' with no role reads as closed.
    visibleToRole: integer('visible_to_role').references(() => roles.id, { onDelete: 'set null' }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('gallery_album_sort_idx').on(t.sortOrder)],
);

export const galleryItems = sqliteTable(
  'gallery_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    albumId: integer('album_id')
      .notNull()
      .references(() => galleryAlbums.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['image', 'video'] }).notNull(),
    // Images: our own /media/gallery/… object. Videos: the pasted watch URL,
    // kept for the admin UI only — `src` is the sole thing that may be framed.
    url: text('url').notNull(),
    src: text('src'),
    provider: text('provider'),
    thumbUrl: text('thumb_url'),
    // Intrinsic size, captured at upload. The justified layout needs a real
    // aspect ratio up front or every row reflows once the images decode.
    width: integer('width').notNull().default(1600),
    height: integer('height').notNull().default(1200),
    caption: text('caption'),
    alt: text('alt'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('gallery_item_album_idx').on(t.albumId, t.sortOrder)],
);

/* ------------------------------------------------------------------ *
 * Notifications — role-gated, in-app. A notification carries the set of
 * role ids that may see it (empty = nobody); read state is per member.
 * ------------------------------------------------------------------ */

export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Event key from shared/notifications.ts (e.g. 'applicant.pending'). */
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    /** Optional in-app link the card opens (e.g. /admin/admissions). */
    link: text('link'),
    /** Role ids allowed to see this; a viewer needs one of them (god bypasses). */
    roleIds: text('role_ids', { mode: 'json' }).$type<number[]>().notNull().default([]),
    // Shared "reviewed by" — the first recipient to claim it. Once set, everyone
    // who can see the notification sees who reviewed it. NULL = not yet reviewed.
    reviewedBy: integer('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: integer('reviewed_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('notification_created_idx').on(t.createdAt)],
);

/** One row per member per notification they've read. */
export const notificationReads = sqliteTable(
  'notification_reads',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    notificationId: integer('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    readAt: integer('read_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.userId, t.notificationId] })],
);

/* ------------------------------------------------------------------ *
 * Site snapshots — the God-only "restore point" safety net. Each row is a
 * full capture of the database at a moment in time; the actual JSON payload
 * lives in R2 (key in `r2Key`), deliberately NOT in D1, so restoring a
 * snapshot — which wipes and reloads every content/config/roster table —
 * can never delete the snapshots themselves. This table is excluded from
 * both capture and restore for the same reason (see server/snapshot.ts).
 * ------------------------------------------------------------------ */

export const siteSnapshots = sqliteTable(
  'site_snapshots',
  {
    id: text('id').primaryKey(), // uuid
    name: text('name').notNull(),
    note: text('note'),
    // R2 object key holding the JSON payload (under snapshots/…).
    r2Key: text('r2_key').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    // Per-table row counts at capture time, for the UI summary. { table: n }.
    tableCounts: text('table_counts', { mode: 'json' })
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    // 'manual' = a God saved it on purpose; 'auto' = the safety copy taken
    // automatically right before a restore, so a restore can itself be undone.
    kind: text('kind', { enum: ['manual', 'auto'] }).notNull().default('manual'),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('site_snapshots_created_idx').on(t.createdAt)],
);

/* ------------------------------------------------------------------ *
 * Tournaments — a competitive bracket/standings engine. A tournament has a
 * FORMAT (single/double elimination, round-robin, or Swiss) and a competitor
 * TYPE (individual members, or ad-hoc teams). ENTRANTS register (or are added
 * by an organizer), get SEEDED, and then the bracket/rounds of MATCHES are
 * generated by the pure engine in shared/tournament.ts. Reporting a match
 * result auto-advances the winner (and, for double-elim, drops the loser).
 *
 * The four tables are format-agnostic: elimination formats use the match
 * winner/loser "next match" pointers to form the tree; round-robin and Swiss
 * leave those null and derive standings from completed matches. Building all
 * four tables up front means no later migration when the other formats land.
 * ------------------------------------------------------------------ */

export const tournaments = sqliteTable(
  'tournaments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    // Stable url-safe key for the public bracket page (/tournaments/:slug).
    slug: text('slug').notNull().unique(),
    description: text('description'),
    // Optional banner (an R2 /media/tournaments/… URL).
    imageUrl: text('image_url'),
    gameId: integer('game_id').references(() => games.id, { onDelete: 'set null' }),
    format: text('format', {
      enum: ['single_elim', 'double_elim', 'round_robin', 'swiss'],
    })
      .notNull()
      .default('single_elim'),
    competitorType: text('competitor_type', { enum: ['individual', 'team'] })
      .notNull()
      .default('individual'),
    // Lifecycle: draft → registration (sign-ups open) → seeding (closed, ordering)
    // → in_progress (bracket generated, matches being played) → complete.
    status: text('status', {
      enum: ['draft', 'registration', 'seeding', 'in_progress', 'complete'],
    })
      .notNull()
      .default('draft'),
    // NULL = unlimited entrants. Otherwise the registration cap.
    maxEntrants: integer('max_entrants'),
    // How entrants get their seed when the bracket is generated: 'random',
    // 'manual' (organizer drag-orders), or 'signup' (registration order).
    seedMethod: text('seed_method', { enum: ['random', 'manual', 'signup'] })
      .notNull()
      .default('random'),
    // Matches are best-of-N (1, 3, 5, …); the winner is the first to ceil(N/2).
    bestOf: integer('best_of').notNull().default(1),
    // Single-elim only: also play a 3rd-place match between the semi-final losers.
    thirdPlace: integer('third_place', { mode: 'boolean' }).notNull().default(false),
    // Swiss only: the fixed number of rounds to run.
    swissRounds: integer('swiss_rounds').notNull().default(5),
    // Whether the bracket page is readable by logged-out visitors.
    isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
    // Offered to allied orgs: they mirror it, may field remote entrants, and
    // receive standings/champion updates over the alliance federation channel.
    shareAlliance: integer('share_alliance', { mode: 'boolean' }).notNull().default(false),
    // When play begins (informational; the bracket is generated by an organizer).
    startsAt: integer('starts_at'),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('tournaments_status_idx').on(t.status)],
);

/**
 * An entrant in a tournament — one competitor slot. For an individual-type
 * tournament `userId` links the member (and their live name/avatar is resolved
 * by join); for a team-type tournament `name` is the team name and the roster
 * lives in tournamentTeamMembers. `seed` is assigned at generation time.
 */
export const tournamentEntrants = sqliteTable(
  'tournament_entrants',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    // Set for individual entrants; NULL for team entrants.
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    // Team name (team type). For individuals it may cache the member name at
    // sign-up, but the live member name (via userId) is preferred when shown.
    name: text('name'),
    // 1-based seed, assigned when the bracket is generated; NULL until then.
    seed: integer('seed'),
    // Set for entrants fielded by an ALLIED org over federation: the ally org's
    // display name (a provenance label, NULL for local entrants) and a stable
    // "<allianceLinkId>:<entryId>" ref that makes remote submissions idempotent.
    // Remote entrants are name-only (no local userId / roster).
    originName: text('origin_name'),
    remoteRef: text('remote_ref').unique(),
    checkedIn: integer('checked_in', { mode: 'boolean' }).notNull().default(false),
    status: text('status', {
      enum: ['registered', 'withdrawn', 'disqualified'],
    })
      .notNull()
      .default('registered'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('tournament_entrants_tournament_idx').on(t.tournamentId),
    // A member can enter a given tournament at most once (individual type).
    uniqueIndex('tournament_entrants_tournament_user_idx').on(t.tournamentId, t.userId),
  ],
);

/** A member of a team entrant (team-type tournaments). One row per member. */
export const tournamentTeamMembers = sqliteTable(
  'tournament_team_members',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entrantId: integer('entrant_id')
      .notNull()
      .references(() => tournamentEntrants.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The captain manages the team's roster and (optionally) reports results.
    isCaptain: integer('is_captain', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('tournament_team_members_entrant_idx').on(t.entrantId),
    uniqueIndex('tournament_team_members_entrant_user_idx').on(t.entrantId, t.userId),
  ],
);

/**
 * A single match (a.k.a. "game" node) in a tournament. Elimination formats form
 * a tree via the winner/loser next-match pointers; round-robin and Swiss leave
 * those null and are scored from standings. `bracket` separates the winners and
 * losers sides of a double-elimination draw (single-elim uses 'winners';
 * round-robin/Swiss use 'group'). `slot` orders matches within a round for
 * layout and for the pairing math. A 'bye' match is auto-completed at
 * generation (its single entrant advances immediately).
 */
export const tournamentMatches = sqliteTable(
  'tournament_matches',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournaments.id, { onDelete: 'cascade' }),
    bracket: text('bracket', {
      enum: ['winners', 'losers', 'grand_final', 'group'],
    })
      .notNull()
      .default('winners'),
    // 1-based round number within its bracket.
    round: integer('round').notNull(),
    // 0-based position of the match within its round (top-to-bottom layout order).
    slot: integer('slot').notNull(),
    // The two entrants. NULL means "to be determined" (a feeder match hasn't
    // resolved yet) or, for the second slot, a bye.
    entrant1Id: integer('entrant1_id').references(() => tournamentEntrants.id, {
      onDelete: 'set null',
    }),
    entrant2Id: integer('entrant2_id').references(() => tournamentEntrants.id, {
      onDelete: 'set null',
    }),
    winnerId: integer('winner_id').references(() => tournamentEntrants.id, {
      onDelete: 'set null',
    }),
    score1: integer('score1').notNull().default(0),
    score2: integer('score2').notNull().default(0),
    status: text('status', { enum: ['pending', 'ready', 'live', 'complete', 'bye'] })
      .notNull()
      .default('pending'),
    // Where the winner advances to (elimination formats). NULL = this match's
    // winner is the champion (or the format derives placement from standings).
    winnerNextMatchId: integer('winner_next_match_id'),
    // Which slot (1 or 2) of the next match the winner fills.
    winnerNextSlot: integer('winner_next_slot'),
    // Double-elim: where the loser drops to (into the losers bracket). NULL in
    // single-elim (the loser is eliminated).
    loserNextMatchId: integer('loser_next_match_id'),
    loserNextSlot: integer('loser_next_slot'),
    reportedBy: integer('reported_by').references(() => users.id, { onDelete: 'set null' }),
    reportedAt: integer('reported_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('tournament_matches_tournament_idx').on(t.tournamentId),
    index('tournament_matches_round_idx').on(t.tournamentId, t.bracket, t.round),
  ],
);

/**
 * SUBSCRIBER-side mirror of a tournament HOSTED by an allied org. Populated and
 * updated by the offer/update messages that arrive over the federation channel
 * (see shared/allianceTournament.ts); read-only — the host owns the real bracket.
 * Keyed on (allianceLinkId, ref): one mirror per hosted tournament per ally. The
 * snapshot (status, standings, champion) is denormalized JSON so the local site
 * and Discord can show it without calling the host on every render.
 */
export const allianceTournaments = sqliteTable(
  'alliance_tournaments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    // The ally hosting this tournament (from our side of the pairing).
    allianceLinkId: integer('alliance_link_id')
      .notNull()
      .references(() => allianceLinks.id, { onDelete: 'cascade' }),
    // The host's opaque tournament reference (its id, as a string).
    ref: text('ref').notNull(),
    name: text('name').notNull(),
    format: text('format', { enum: ['single_elim', 'double_elim', 'round_robin', 'swiss'] })
      .notNull()
      .default('single_elim'),
    competitorType: text('competitor_type', { enum: ['individual', 'team'] })
      .notNull()
      .default('individual'),
    status: text('status', {
      enum: ['draft', 'registration', 'seeding', 'in_progress', 'complete'],
    })
      .notNull()
      .default('registration'),
    startsAt: integer('starts_at'),
    // Link to the host's public bracket page.
    url: text('url'),
    registrationOpen: integer('registration_open', { mode: 'boolean' }).notNull().default(false),
    // Latest standings snapshot (group formats): StandingSnapshot[] as JSON.
    standings: text('standings', { mode: 'json' }).$type<
      { name: string; wins: number; losses: number; rank: number }[]
    >(),
    champion: text('champion'),
    // The host withdrew the offer (tournament deleted / un-shared).
    closed: integer('closed', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('alliance_tournaments_link_ref_idx').on(t.allianceLinkId, t.ref)],
);

/**
 * An entrant WE (a subscriber) have fielded into an allied org's hosted
 * tournament. Tracks what we've submitted and its status so the operator can see
 * "you entered N — the host accepted it" and withdraw it. `entryId` is our own
 * stable id, echoed to the host so a resend is idempotent on both sides.
 */
export const allianceTournamentEntries = sqliteTable(
  'alliance_tournament_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    allianceTournamentId: integer('alliance_tournament_id')
      .notNull()
      .references(() => allianceTournaments.id, { onDelete: 'cascade' }),
    // Our stable id for this entry (sent to the host as the idempotency key).
    entryId: text('entry_id').notNull(),
    name: text('name').notNull(),
    status: text('status', { enum: ['submitted', 'accepted', 'rejected', 'withdrawn'] })
      .notNull()
      .default('submitted'),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('alliance_tournament_entries_tournament_idx').on(t.allianceTournamentId),
    uniqueIndex('alliance_tournament_entries_entry_idx').on(t.allianceTournamentId, t.entryId),
  ],
);
