import { Hono } from 'hono';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { AppContext } from '../env';
import { db, requireAuth, requireUser, requirePermission } from '../middleware/auth';
import { can, outranks, permissionsWithinGrant, type Permission } from '../../shared/permissions';
import { memberName } from '../../shared/names';
import { discordAvatar } from '../../shared/avatar';
import { DiscordError } from '../discord/rest';
import { discordClient } from '../config';
import { grantRole, revokeRole, syncMemberRankRoles, reconcileMember } from '../discord/sync';
import { announce } from '../discord/announce';
import { deleteMediaByUrl } from './media';
import { emitNotification } from '../notifications';

const members = new Hono<AppContext>();

/** Bot client from resolved (DB-over-env) config, or null when unconfigured. */
const rest = (env: AppContext['Bindings']) => discordClient(env);

const MIN_REASON = 3;
const MAX_REASON = 500;
/**
 * Negative actions (demote, remove/ban, revoke an award or role) must carry a
 * written justification. Returns the trimmed reason, or null when it is missing
 * or too short — the caller turns null into a 400.
 */
function cleanReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const r = raw.trim();
  if (r.length < MIN_REASON) return null;
  return r.slice(0, MAX_REASON);
}

/** DELETE requests may arrive with no body; parse defensively. */
async function jsonBody<T>(c: { req: { json: () => Promise<unknown> } }): Promise<Partial<T>> {
  return (await c.req.json().catch(() => ({}))) as Partial<T>;
}

members.get('/', requirePermission('roster.view'), async (c) => {
  // Paginated so a page load reads one page, not the whole roster — the read
  // cost stays flat as the clan grows. The client appends pages ("load more").
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const database = db(c.env);

  // Sortable by name or rank. Name sorts on the resolved display name
  // (display → global → username), matching what the UI shows.
  const sort = c.req.query('sort') === 'name' ? 'name' : 'rank';
  const dir = c.req.query('dir') === 'asc' ? 'asc' : c.req.query('dir') === 'desc' ? 'desc' : sort === 'rank' ? 'desc' : 'asc';
  const nameExpr = sql`coalesce(${s.users.displayName}, ${s.users.globalName}, ${s.users.username})`;
  const nameOrder = dir === 'asc' ? asc(nameExpr) : desc(nameExpr);
  const orderBy =
    sort === 'name'
      ? [nameOrder]
      : [dir === 'asc' ? asc(s.ranks.sortOrder) : desc(s.ranks.sortOrder), asc(nameExpr)];

  const rows = await database
    .select({
      id: s.users.id,
      discordId: s.users.discordId,
      username: s.users.username,
      globalName: s.users.globalName,
      displayName: s.users.displayName,
      avatar: s.users.avatar,
      profileImageUrl: s.users.profileImageUrl,
      status: s.users.status,
      joinedAt: s.users.joinedAt,
      rankId: s.ranks.id,
      rankName: s.ranks.name,
      rankOrder: s.ranks.sortOrder,
    })
    .from(s.users)
    .leftJoin(s.ranks, eq(s.users.rankId, s.ranks.id))
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);

  const totalRow = await database.select({ n: sql<number>`count(*)` }).from(s.users);
  const total = Number(totalRow[0]?.n ?? 0);

  return c.json({ members: rows, total, limit, offset });
});

/**
 * People awaiting approval (status 'pending') — the applicant queue. Their bio
 * doubles as the "application". Registered before /:id so the literal path wins.
 */
members.get('/applicants', requirePermission('members.approve'), async (c) => {
  const database = db(c.env);
  const rows = await database
    .select({
      id: s.users.id,
      discordId: s.users.discordId,
      username: s.users.username,
      globalName: s.users.globalName,
      displayName: s.users.displayName,
      avatar: s.users.avatar,
      profileImageUrl: s.users.profileImageUrl,
      createdAt: s.users.createdAt,
      bio: s.profiles.bio,
    })
    .from(s.users)
    .leftJoin(s.profiles, eq(s.profiles.userId, s.users.id))
    .where(eq(s.users.status, 'pending'))
    .orderBy(asc(s.users.createdAt));
  return c.json({ applicants: rows });
});

/**
 * Approve an applicant into a full member: status → active, assign the default
 * rank if they have none, and push the rank's Discord roles (best-effort — a
 * no-op if they haven't joined the guild yet; their next login reconciles).
 */
members.post('/:id/approve', requirePermission('members.approve'), async (c) => {
  const id = Number(c.req.param('id'));
  const viewer = c.get('viewer')!;
  const database = db(c.env);

  const target = await database.query.users.findFirst({ where: eq(s.users.id, id) });
  if (!target) return c.json({ error: 'No such applicant' }, 404);
  if (target.status !== 'pending') return c.json({ error: 'This person is not awaiting approval.' }, 400);

  const defaultRank = await database.query.ranks.findFirst({ where: eq(s.ranks.isDefault, true) });
  const rankId = target.rankId ?? defaultRank?.id ?? null;
  const nowSec = Math.floor(Date.now() / 1000);

  await database
    .update(s.users)
    .set({ status: 'active', rankId, updatedAt: nowSec })
    .where(eq(s.users.id, id));

  await database.insert(s.auditLog).values({
    actorId: viewer.id,
    action: 'member.approve',
    targetType: 'user',
    targetId: String(id),
    meta: { via: 'manual' },
    ip: c.req.header('cf-connecting-ip'),
  });

  c.executionCtx.waitUntil(
    emitNotification(c.env, 'member.approved', {
      title: `Approved: ${target.username}`,
      body: 'An applicant was approved and is now a member.',
      link: '/roster',
    }),
  );

  if (rankId) {
    const client = await rest(c.env);
    if (client) {
      c.executionCtx.waitUntil(
        syncMemberRankRoles(database, client, { userId: id, rankId, actorId: viewer.id }).catch((err) =>
          console.error('Role sync on approve failed', err),
        ),
      );
    }
  }
  return c.json({ ok: true });
});

/**
 * Ban a Discord user from the site. Adds them to the ban list (the authoritative
 * re-login block that survives deleting their record), flags the record, and
 * kills their sessions so they're logged out at once. Reason required.
 */
members.post('/:id/ban', requirePermission('members.ban'), async (c) => {
  const id = Number(c.req.param('id'));
  const viewer = c.get('viewer')!;
  const { reason } = await jsonBody<{ reason?: string }>(c);
  const cleanedReason = cleanReason(reason);
  if (!cleanedReason) return c.json({ error: 'A reason is required to ban someone.' }, 400);

  const database = db(c.env);
  const target = await database.query.users.findFirst({ where: eq(s.users.id, id) });
  if (!target) return c.json({ error: 'No such member' }, 404);
  if (target.id === viewer.id) return c.json({ error: 'You cannot ban yourself.' }, 400);
  if (target.isGod) return c.json({ error: 'You cannot ban this user.' }, 403);

  const targetRank = target.rankId
    ? await database.query.ranks.findFirst({ where: eq(s.ranks.id, target.rankId) })
    : null;
  if (!outranks(viewer, targetRank?.sortOrder ?? null)) {
    return c.json({ error: 'You cannot ban someone at or above your rank.' }, 403);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  await database
    .insert(s.bans)
    .values({ discordId: target.discordId, username: target.username, reason: cleanedReason, bannedBy: viewer.id })
    .onConflictDoUpdate({
      target: s.bans.discordId,
      set: { username: target.username, reason: cleanedReason, bannedBy: viewer.id, bannedAt: nowSec },
    });
  await database.update(s.users).set({ status: 'banned', updatedAt: nowSec }).where(eq(s.users.id, id));
  await database.delete(s.sessions).where(eq(s.sessions.userId, id));

  await database.insert(s.auditLog).values({
    actorId: viewer.id,
    action: 'member.ban',
    targetType: 'user',
    targetId: String(id),
    reason: cleanedReason,
    meta: { discordId: target.discordId, username: target.username },
    ip: c.req.header('cf-connecting-ip'),
  });

  c.executionCtx.waitUntil(
    emitNotification(c.env, 'member.banned', {
      title: `Banned: ${target.username}`,
      body: cleanedReason,
      link: '/admin/admissions',
    }),
  );
  return c.json({ ok: true });
});

// requireUser so a pending applicant can load their OWN profile (to edit it); the
// self check below still blocks them from viewing anyone else (they lack roster.view).
members.get('/:id', requireUser, async (c) => {
  const id = Number(c.req.param('id'));
  const viewer = c.get('viewer')!;
  // The roster can be restricted to certain roles (roster.view). A member can
  // always see their own profile; viewing anyone else needs roster.view.
  if (id !== viewer.id && !can(viewer, 'roster.view')) {
    return c.json({ error: 'Forbidden', missing: 'roster.view' }, 403);
  }
  const database = db(c.env);

  const user = await database.query.users.findFirst({ where: eq(s.users.id, id) });
  if (!user) return c.json({ error: 'No such member' }, 404);

  const [rank, roles, medals, warRecords, profile] = await Promise.all([
    user.rankId ? database.query.ranks.findFirst({ where: eq(s.ranks.id, user.rankId) }) : null,
    database
      .select({
        id: s.roles.id,
        name: s.roles.name,
        color: s.roles.color,
        source: s.userRoles.source,
      })
      .from(s.userRoles)
      .innerJoin(s.roles, eq(s.userRoles.roleId, s.roles.id))
      .where(eq(s.userRoles.userId, id)),
    database
      .select({
        awardId: s.memberMedals.id,
        id: s.medals.id,
        name: s.medals.name,
        imageUrl: s.medals.imageUrl,
        citation: s.memberMedals.citation,
        // NULL awardedBy = handed out by the tenure sweep, not a person.
        awardedBy: s.memberMedals.awardedBy,
        awardedAt: s.memberMedals.awardedAt,
      })
      .from(s.memberMedals)
      .innerJoin(s.medals, eq(s.memberMedals.medalId, s.medals.id))
      .where(eq(s.memberMedals.userId, id))
      .orderBy(desc(s.memberMedals.awardedAt)),
    database
      .select({
        awardId: s.memberWarRecords.id,
        id: s.warRecords.id,
        name: s.warRecords.name,
        imageUrl: s.warRecords.imageUrl,
        gameName: s.games.name,
        citation: s.memberWarRecords.citation,
        awardedBy: s.memberWarRecords.awardedBy,
        awardedAt: s.memberWarRecords.awardedAt,
      })
      .from(s.memberWarRecords)
      .innerJoin(s.warRecords, eq(s.memberWarRecords.warRecordId, s.warRecords.id))
      .leftJoin(s.games, eq(s.warRecords.gameId, s.games.id))
      .where(eq(s.memberWarRecords.userId, id))
      .orderBy(desc(s.memberWarRecords.awardedAt)),
    database.query.profiles.findFirst({ where: eq(s.profiles.userId, id) }),
  ]);

  return c.json({ member: { ...user, rank, roles, medals, warRecords, bio: profile?.bio ?? null } });
});

/**
 * Edit a member's profile — display name, bio, and profile image. A member may
 * always edit their own; editing anyone else's needs roster.edit.
 *
 * Changing the display name also sets the member's Discord nickname (their
 * per-server name). Website stays the source of truth; the push is best-effort
 * and reported back, never blocking the save.
 *
 * profileImageUrl is a /media/avatars/… URL from a prior upload, or null to
 * clear it and revert to the Discord avatar. Replacing or clearing it deletes
 * the previous R2 object so orphans don't pile up.
 */
// requireUser so a pending applicant can edit their OWN profile; the self check
// below blocks editing anyone else (they lack roster.edit).
members.patch('/:id/profile', requireUser, async (c) => {
  const id = Number(c.req.param('id'));
  const viewer = c.get('viewer')!;
  const isSelf = viewer.id === id;
  if (!isSelf && !can(viewer, 'roster.edit')) {
    return c.json({ error: 'You can only edit your own profile.' }, 403);
  }

  const body = await c.req.json<{
    bio?: string;
    displayName?: string;
    profileImageUrl?: string | null;
  }>();
  const nowSec = Math.floor(Date.now() / 1000);
  const database = db(c.env);

  const target = await database.query.users.findFirst({ where: eq(s.users.id, id) });
  if (!target) return c.json({ error: 'No such member' }, 404);

  let profileImageUrl = target.profileImageUrl;
  if (body.profileImageUrl !== undefined) {
    const next = body.profileImageUrl?.trim() || null;
    // Only accept a cleared value or one of our own uploaded avatar URLs — never
    // an arbitrary off-site URL, which would let this field point <img> tags at
    // anything and bypass the raster-only upload guard.
    if (next !== null && !next.startsWith('/media/avatars/')) {
      return c.json({ error: 'Invalid profile image.' }, 400);
    }
    if (next !== target.profileImageUrl) {
      await database.update(s.users).set({ profileImageUrl: next, updatedAt: nowSec }).where(eq(s.users.id, id));
      // Drop the image it replaced (best effort, off the request path).
      c.executionCtx.waitUntil(deleteMediaByUrl(c.env, target.profileImageUrl));
      profileImageUrl = next;
    }
  }

  let bio: string | undefined;
  if (body.bio !== undefined) {
    bio = (body.bio ?? '').slice(0, 2000);
    await database
      .insert(s.profiles)
      .values({ userId: id, bio, updatedAt: nowSec })
      .onConflictDoUpdate({ target: s.profiles.userId, set: { bio, updatedAt: nowSec } });
  }

  let displayName = target.displayName;
  let discordSync: { synced: boolean; warning?: string } | undefined;

  if (body.displayName !== undefined) {
    // Display name is a required profile field: it can't be blanked out. (It
    // still defaults to the Discord name for members who've never opened the
    // editor — this only guards an explicit save.)
    const trimmed = body.displayName.trim();
    if (trimmed.length < 2) {
      return c.json({ error: 'A display name is required (at least 2 characters).' }, 400);
    }
    displayName = trimmed.slice(0, 32);
    const changed = displayName !== target.displayName;
    await database
      .update(s.users)
      .set({ displayName, updatedAt: nowSec })
      .where(eq(s.users.id, id));

    if (changed) {
      // Push the new display name as the member's Discord nickname. An empty
      // value clears the nickname, reverting them to their Discord name.
      const client = await rest(c.env);
      if (client) {
        try {
          await client.setNickname(
            target.discordId,
            displayName ?? '',
            `mustr: display name set by ${viewer.username}`,
          );
          discordSync = { synced: true };
        } catch (err) {
          discordSync = {
            synced: false,
            warning:
              err instanceof DiscordError && err.status === 403
                ? 'Saved here, but Discord refused the nickname change: the bot needs Manage Nicknames and a role above this member. (Discord also blocks changing the server owner’s nickname.)'
                : `Saved here, but the Discord nickname change failed: ${(err as Error).message}`,
          };
        }
      }

      await database.insert(s.auditLog).values({
        actorId: viewer.id,
        action: 'member.display_name',
        targetType: 'user',
        targetId: String(id),
        meta: { displayName, discordSynced: discordSync?.synced ?? false },
      });
    }
  }

  return c.json({ ok: true, bio, displayName, profileImageUrl, discordSync });
});

/**
 * Change a member's status (active/inactive/loa/retired/banned). "Remove" from
 * the roster is a status change to retired, which keeps history. Banning needs
 * the stronger roster.remove; softer states need roster.edit. You cannot change
 * the status of someone who outranks you.
 */
members.patch('/:id/status', requireAuth, async (c) => {
  const id = Number(c.req.param('id'));
  const viewer = c.get('viewer')!;
  const { status, reason } = await c.req.json<{ status: string; reason?: string }>();

  const allowed = ['active', 'inactive', 'loa', 'retired', 'banned'] as const;
  if (!allowed.includes(status as (typeof allowed)[number])) {
    return c.json({ error: 'Invalid status' }, 400);
  }

  const needsRemove = status === 'banned' || status === 'retired';
  if (!can(viewer, needsRemove ? 'roster.remove' : 'roster.edit')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Removing, retiring, or banning a member is a negative action — it demands
  // a written reason, which is recorded on the audit entry.
  const cleanedReason = cleanReason(reason);
  if (needsRemove && !cleanedReason) {
    return c.json({ error: 'A reason is required to retire or ban a member.' }, 400);
  }

  const database = db(c.env);
  const target = await database.query.users.findFirst({ where: eq(s.users.id, id) });
  if (!target) return c.json({ error: 'No such member' }, 404);

  const targetRank = target.rankId
    ? await database.query.ranks.findFirst({ where: eq(s.ranks.id, target.rankId) })
    : null;
  if (!outranks(viewer, targetRank?.sortOrder ?? null)) {
    return c.json({ error: 'You cannot change the status of someone at or above your rank.' }, 403);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  await database
    .update(s.users)
    .set({ status: status as (typeof allowed)[number], updatedAt: nowSec })
    .where(eq(s.users.id, id));

  await database.insert(s.auditLog).values({
    actorId: viewer.id,
    action: 'member.status',
    targetType: 'user',
    targetId: String(id),
    reason: cleanedReason,
    meta: { from: target.status, to: status },
    ip: c.req.header('cf-connecting-ip'),
  });

  return c.json({ ok: true, status });
});

/** Set a member's rank outright (the ladder-step version lives in Discord's /promote). */
members.put('/:id/rank', requirePermission('roster.promote'), async (c) => {
  const id = Number(c.req.param('id'));
  const { rankId, reason } = await c.req.json<{ rankId: number | null; reason?: string }>();
  const viewer = c.get('viewer')!;
  const database = db(c.env);

  const target = await database.query.users.findFirst({ where: eq(s.users.id, id) });
  if (!target) return c.json({ error: 'No such member' }, 404);

  const currentRank = target.rankId
    ? await database.query.ranks.findFirst({ where: eq(s.ranks.id, target.rankId) })
    : null;
  if (!outranks(viewer, currentRank?.sortOrder ?? null)) {
    return c.json({ error: 'You can only change ranks below your own' }, 403);
  }

  const newRank = rankId
    ? await database.query.ranks.findFirst({ where: eq(s.ranks.id, rankId) })
    : null;
  if (rankId && !newRank) return c.json({ error: 'No such rank' }, 404);
  if (newRank && !outranks(viewer, newRank.sortOrder)) {
    return c.json({ error: 'You cannot assign a rank at or above your own' }, 403);
  }

  // A demotion (or un-ranking) is negative and needs a written reason; a
  // promotion does not. Treat "no new rank while they had one" as a demotion.
  const isDemotion = !!currentRank && (!newRank || newRank.sortOrder < currentRank.sortOrder);
  const cleanedReason = cleanReason(reason);
  if (isDemotion && !cleanedReason) {
    return c.json({ error: 'A reason is required to demote or un-rank a member.' }, 400);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  await database
    .update(s.users)
    .set({ rankId: newRank?.id ?? null, promotedAt: nowSec, updatedAt: nowSec })
    .where(eq(s.users.id, id));

  await database.insert(s.auditLog).values({
    actorId: viewer.id,
    action: 'member.rank_change',
    targetType: 'user',
    targetId: String(id),
    reason: cleanedReason,
    meta: { from: currentRank?.name ?? null, to: newRank?.name ?? null, demotion: isDemotion },
    ip: c.req.header('cf-connecting-ip'),
  });

  // Apply the new rank's roles (and drop the old rank's), cascading to Discord.
  const rankRoleSync = await syncMemberRankRoles(database, await rest(c.env), {
    userId: id,
    rankId: newRank?.id ?? null,
    actorId: viewer.id,
  });

  // Announce only a move UP the ladder; demotions and un-ranking stay quiet.
  if (newRank && newRank.sortOrder > (currentRank?.sortOrder ?? -1)) {
    c.executionCtx.waitUntil(
      announce(
        c.env,
        {
          type: 'promotion',
          memberName: memberName(target),
          memberDiscordId: target.discordId,
          memberAvatarUrl: discordAvatar(target.discordId, target.avatar, 128),
          rankName: newRank.name,
          rankImageUrl: newRank.imageUrl,
          byName: memberName(viewer),
        },
        new URL(c.req.url).origin,
      ),
    );
  }

  return c.json({ ok: true, rank: newRank ?? null, rankRoleSync });
});

/**
 * Grant a role. If the role is mapped to a Discord role, this also updates
 * Discord — which is what makes website roles gate Discord channels.
 */
members.post('/:id/roles', requirePermission('roles.assign'), async (c) => {
  const userId = Number(c.req.param('id'));
  const { roleId, reason } = await c.req.json<{ roleId: number; reason?: string }>();
  const viewer = c.get('viewer')!;

  // A role can only be handed out by someone who already holds everything it
  // grants — otherwise "can assign roles" is a path to becoming an admin.
  const rolePerms = (
    await db(c.env)
      .select({ permission: s.rolePermissions.permission })
      .from(s.rolePermissions)
      .where(eq(s.rolePermissions.roleId, roleId))
  ).map((p) => p.permission as Permission);
  if (!permissionsWithinGrant(viewer, rolePerms)) {
    return c.json({ error: 'You cannot grant a role with permissions you do not have yourself.' }, 403);
  }

  const result = await grantRole(db(c.env), await rest(c.env), {
    userId,
    roleId,
    actorId: viewer.id,
    reason: reason ?? `Granted by ${viewer.username} via mustr`,
  });

  return c.json({ ok: true, ...result });
});

/**
 * Force this member's Discord roles back into line with the website now, rather
 * than waiting for the scheduled sweep. Adds mapped roles they should have,
 * removes mapped ones they shouldn't; unmanaged Discord roles are left alone.
 */
members.post('/:id/resync', requirePermission('discord.sync'), async (c) => {
  const id = Number(c.req.param('id'));
  const client = await rest(c.env);
  if (!client) {
    return c.json({ ok: false, warning: 'Discord bot is not configured.' });
  }
  try {
    const r = await reconcileMember(db(c.env), client, id);
    return c.json({ ok: true, added: r.added.length, removed: r.removed.length });
  } catch (err) {
    return c.json({ ok: false, warning: `Discord re-sync failed: ${(err as Error).message}` });
  }
});

/**
 * Award a medal to a member, with an optional citation for why. A member can
 * hold any given medal only once, so re-awarding the same one is a 409 rather
 * than a silent duplicate.
 */
members.post('/:id/medals', requirePermission('medals.award'), async (c) => {
  const userId = Number(c.req.param('id'));
  const { medalId, citation } = await c.req.json<{ medalId: number; citation?: string }>();
  const viewer = c.get('viewer')!;
  const database = db(c.env);

  const [target, medal] = await Promise.all([
    database.query.users.findFirst({ where: eq(s.users.id, userId) }),
    database.query.medals.findFirst({ where: eq(s.medals.id, medalId) }),
  ]);
  if (!target) return c.json({ error: 'No such member' }, 404);
  if (!medal) return c.json({ error: 'No such medal' }, 404);

  const already = await database
    .select({ id: s.memberMedals.id })
    .from(s.memberMedals)
    .where(and(eq(s.memberMedals.userId, userId), eq(s.memberMedals.medalId, medalId)));
  if (already.length) {
    return c.json({ error: `${target.username} already has the “${medal.name}” medal.` }, 409);
  }

  const award = (
    await database
      .insert(s.memberMedals)
      .values({
        userId,
        medalId,
        citation: citation?.trim() || null,
        awardedBy: viewer.id,
      })
      .returning()
  )[0]!;

  await database.insert(s.auditLog).values({
    actorId: viewer.id,
    action: 'medal.award',
    targetType: 'user',
    targetId: String(userId),
    meta: { medalId, medalName: medal.name, citation: citation?.trim() || null },
    ip: c.req.header('cf-connecting-ip'),
  });

  c.executionCtx.waitUntil(
    announce(
      c.env,
      {
        type: 'medalAward',
        memberName: memberName(target),
        memberDiscordId: target.discordId,
        memberAvatarUrl: discordAvatar(target.discordId, target.avatar, 128),
        medalName: medal.name,
        medalImageUrl: medal.imageUrl,
        citation: citation?.trim() || null,
      },
      new URL(c.req.url).origin,
    ),
  );

  return c.json({ ok: true, awardId: award.id }, 201);
});

/** Revoke a specific award (by member_medals id, not medal id). */
members.delete('/:id/medals/:awardId', requirePermission('medals.award'), async (c) => {
  const userId = Number(c.req.param('id'));
  const awardId = Number(c.req.param('awardId'));
  const viewer = c.get('viewer')!;
  const database = db(c.env);

  const { reason } = await jsonBody<{ reason: string }>(c);
  const cleanedReason = cleanReason(reason);
  if (!cleanedReason) {
    return c.json({ error: 'A reason is required to revoke a medal.' }, 400);
  }

  const award = await database.query.memberMedals.findFirst({
    where: and(eq(s.memberMedals.id, awardId), eq(s.memberMedals.userId, userId)),
  });
  if (!award) return c.json({ error: 'No such award on this member' }, 404);

  await database.delete(s.memberMedals).where(eq(s.memberMedals.id, awardId));

  await database.insert(s.auditLog).values({
    actorId: viewer.id,
    action: 'medal.revoke',
    targetType: 'user',
    targetId: String(userId),
    reason: cleanedReason,
    meta: { medalId: award.medalId, awardId },
    ip: c.req.header('cf-connecting-ip'),
  });

  return c.json({ ok: true });
});

/**
 * Award a war record to a member, with an optional citation. Like medals, a
 * member holds any given war record only once (re-awarding is a 409).
 */
members.post('/:id/warrecords', requirePermission('warrecords.award'), async (c) => {
  const userId = Number(c.req.param('id'));
  const { warRecordId, citation } = await c.req.json<{ warRecordId: number; citation?: string }>();
  const viewer = c.get('viewer')!;
  const database = db(c.env);

  const [target, record] = await Promise.all([
    database.query.users.findFirst({ where: eq(s.users.id, userId) }),
    database.query.warRecords.findFirst({ where: eq(s.warRecords.id, warRecordId) }),
  ]);
  if (!target) return c.json({ error: 'No such member' }, 404);
  if (!record) return c.json({ error: 'No such war record' }, 404);

  const already = await database
    .select({ id: s.memberWarRecords.id })
    .from(s.memberWarRecords)
    .where(and(eq(s.memberWarRecords.userId, userId), eq(s.memberWarRecords.warRecordId, warRecordId)));
  if (already.length) {
    return c.json({ error: `${target.username} already holds the “${record.name}” war record.` }, 409);
  }

  const award = (
    await database
      .insert(s.memberWarRecords)
      .values({ userId, warRecordId, citation: citation?.trim() || null, awardedBy: viewer.id })
      .returning()
  )[0]!;

  await database.insert(s.auditLog).values({
    actorId: viewer.id,
    action: 'warrecord.award',
    targetType: 'user',
    targetId: String(userId),
    meta: { warRecordId, name: record.name, citation: citation?.trim() || null },
    ip: c.req.header('cf-connecting-ip'),
  });

  const game = record.gameId
    ? await database.query.games.findFirst({ where: eq(s.games.id, record.gameId) })
    : null;
  c.executionCtx.waitUntil(
    announce(
      c.env,
      {
        type: 'warRecordAward',
        memberName: memberName(target),
        memberDiscordId: target.discordId,
        memberAvatarUrl: discordAvatar(target.discordId, target.avatar, 128),
        recordName: record.name,
        recordImageUrl: record.imageUrl,
        gameName: game?.name ?? null,
        citation: citation?.trim() || null,
      },
      new URL(c.req.url).origin,
    ),
  );

  return c.json({ ok: true, awardId: award.id }, 201);
});

/** Revoke a specific war-record award (by member_war_records id). */
members.delete('/:id/warrecords/:awardId', requirePermission('warrecords.award'), async (c) => {
  const userId = Number(c.req.param('id'));
  const awardId = Number(c.req.param('awardId'));
  const viewer = c.get('viewer')!;
  const database = db(c.env);

  const { reason } = await jsonBody<{ reason: string }>(c);
  const cleanedReason = cleanReason(reason);
  if (!cleanedReason) {
    return c.json({ error: 'A reason is required to revoke a war record.' }, 400);
  }

  const award = await database.query.memberWarRecords.findFirst({
    where: and(eq(s.memberWarRecords.id, awardId), eq(s.memberWarRecords.userId, userId)),
  });
  if (!award) return c.json({ error: 'No such award on this member' }, 404);

  await database.delete(s.memberWarRecords).where(eq(s.memberWarRecords.id, awardId));

  await database.insert(s.auditLog).values({
    actorId: viewer.id,
    action: 'warrecord.revoke',
    targetType: 'user',
    targetId: String(userId),
    reason: cleanedReason,
    meta: { warRecordId: award.warRecordId, awardId },
    ip: c.req.header('cf-connecting-ip'),
  });

  return c.json({ ok: true });
});

members.delete('/:id/roles/:roleId', requirePermission('roles.assign'), async (c) => {
  const userId = Number(c.req.param('id'));
  const roleId = Number(c.req.param('roleId'));
  const viewer = c.get('viewer')!;

  const { reason } = await jsonBody<{ reason: string }>(c);
  const cleanedReason = cleanReason(reason);
  if (!cleanedReason) {
    return c.json({ error: 'A reason is required to revoke a role.' }, 400);
  }

  const result = await revokeRole(db(c.env), await rest(c.env), {
    userId,
    roleId,
    actorId: viewer.id,
    reason: cleanedReason,
  });

  return c.json({ ok: true, ...result });
});

export default members;
