/**
 * Rank management.
 *
 * The whole point of this rewrite: ranks are rows, created and destroyed at
 * will. The 2003 version had exactly 21, baked into column names.
 */

import { Hono } from 'hono';
import { asc, eq, inArray, ne, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { AppContext } from '../env';
import { db, requirePermission } from '../middleware/auth';
import { discordClient } from '../config';
import { syncRankHolders } from '../discord/sync';
import { permissionsWithinGrant, type Permission } from '../../shared/permissions';
import { deleteMediaByUrl } from './media';

const ranks = new Hono<AppContext>();

/** Bot client from resolved (DB-over-env) config, or null when unconfigured. */
const rest = (env: AppContext['Bindings']) => discordClient(env);

/** Public: the ladder is visible to anyone. Includes the roles each rank grants. */
ranks.get('/', async (c) => {
  const database = db(c.env);
  const rows = await database
    .select({
      id: s.ranks.id,
      name: s.ranks.name,
      abbreviation: s.ranks.abbreviation,
      imageUrl: s.ranks.imageUrl,
      sortOrder: s.ranks.sortOrder,
      reqDays: s.ranks.reqDays,
      reqWins: s.ranks.reqWins,
      isDefault: s.ranks.isDefault,
      memberCount: sql<number>`(select count(*) from users where users.rank_id = ranks.id)`,
    })
    .from(s.ranks)
    .orderBy(asc(s.ranks.sortOrder));

  const rankRoles = await database.select().from(s.rankRoles);
  const roleIdsByRank = new Map<number, number[]>();
  for (const rr of rankRoles) {
    const list = roleIdsByRank.get(rr.rankId) ?? [];
    list.push(rr.roleId);
    roleIdsByRank.set(rr.rankId, list);
  }

  return c.json({
    ranks: rows.map((r) => ({ ...r, roleIds: roleIdsByRank.get(r.id) ?? [] })),
  });
});

/**
 * Set the roles a rank grants, then re-apply to everyone at that rank so the
 * change reaches current members (and Discord) immediately.
 */
// Deciding which roles a rank hands out is a role-granting policy, so it needs
// roles.manage rather than merely ranks.manage.
ranks.put('/:id/roles', requirePermission('roles.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const { roleIds } = await c.req.json<{ roleIds: number[] }>();
  if (!Array.isArray(roleIds)) {
    return c.json({ error: 'Expected a roleIds array' }, 400);
  }

  const database = db(c.env);
  const rank = await database.query.ranks.findFirst({ where: eq(s.ranks.id, id) });
  if (!rank) return c.json({ error: 'No such rank' }, 404);

  const unique = [...new Set(roleIds)];

  // A rank auto-grants these roles to everyone who holds it, including the
  // editor — so attaching a role here is granting it, and is capped the same
  // way: only roles whose permissions the editor already holds themselves.
  if (unique.length) {
    const grantedPerms = (
      await database
        .select({ permission: s.rolePermissions.permission })
        .from(s.rolePermissions)
        .where(inArray(s.rolePermissions.roleId, unique))
    ).map((p) => p.permission as Permission);
    if (!permissionsWithinGrant(c.get('viewer')!, grantedPerms)) {
      return c.json({ error: 'You cannot attach a role with permissions you do not have yourself.' }, 403);
    }
  }

  await database.batch([
    database.delete(s.rankRoles).where(eq(s.rankRoles.rankId, id)),
    ...(unique.length
      ? [database.insert(s.rankRoles).values(unique.map((roleId) => ({ rankId: id, roleId })))]
      : []),
  ] as never);

  await database.insert(s.auditLog).values({
    actorId: c.get('viewer')!.id,
    action: 'rank.set_roles',
    targetType: 'rank',
    targetId: String(id),
    meta: { roleIds: unique },
  });

  // Reconcile current holders so the mapping change takes effect now.
  const applied = await syncRankHolders(database, await rest(c.env), id);

  return c.json({ ok: true, roleIds: unique, applied });
});

ranks.post('/', requirePermission('ranks.manage'), async (c) => {
  const body = await c.req.json<{
    name: string;
    abbreviation?: string;
    imageUrl?: string;
    reqDays?: number;
    reqWins?: number;
  }>();

  if (!body.name?.trim()) return c.json({ error: 'Name is required' }, 400);

  const database = db(c.env);
  const highest = await database
    .select({ max: sql<number | null>`max(${s.ranks.sortOrder})` })
    .from(s.ranks);

  const inserted = await database
    .insert(s.ranks)
    .values({
      name: body.name.trim(),
      abbreviation: body.abbreviation?.trim() || null,
      imageUrl: body.imageUrl?.trim() || null,
      sortOrder: (highest[0]?.max ?? -1) + 1,
      reqDays: body.reqDays ?? 0,
      reqWins: body.reqWins ?? 0,
    })
    .returning();

  const created = inserted[0];
  if (!created) return c.json({ error: 'Failed to create rank' }, 500);

  await database.insert(s.auditLog).values({
    actorId: c.get('viewer')!.id,
    action: 'rank.create',
    targetType: 'rank',
    targetId: String(created.id),
    meta: { name: created.name },
  });

  return c.json({ rank: created }, 201);
});

ranks.patch('/:id', requirePermission('ranks.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<Partial<typeof s.ranks.$inferInsert>>();
  const database = db(c.env);

  // The image being replaced, so we can free it once the update commits.
  const previousImageUrl =
    body.imageUrl !== undefined
      ? ((await database.query.ranks.findFirst({ where: eq(s.ranks.id, id) }))?.imageUrl ?? null)
      : null;

  // Exactly one default rank, or new recruits land nowhere.
  if (body.isDefault) {
    await database.update(s.ranks).set({ isDefault: false }).where(ne(s.ranks.id, id));
  }

  const updated = await database
    .update(s.ranks)
    .set({ ...body, id: undefined, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(s.ranks.id, id))
    .returning();

  if (!updated.length) return c.json({ error: 'No such rank' }, 404);

  if (body.imageUrl !== undefined && previousImageUrl !== updated[0]!.imageUrl) {
    c.executionCtx.waitUntil(deleteMediaByUrl(c.env, previousImageUrl));
  }

  return c.json({ rank: updated[0] });
});

/**
 * Reordering rewrites every sortOrder in one shot, which avoids the unique
 * constraint tripping over an intermediate state.
 */
ranks.put('/order', requirePermission('ranks.manage'), async (c) => {
  const { order } = await c.req.json<{ order: number[] }>(); // ids, lowest rank first
  if (!Array.isArray(order) || !order.length) {
    return c.json({ error: 'Expected a non-empty array of rank ids' }, 400);
  }

  const database = db(c.env);
  // Park them out of the way first so no two rows collide mid-update.
  await database.batch([
    database.update(s.ranks).set({ sortOrder: sql`${s.ranks.sortOrder} + 10000` }),
    ...order.map((id, index) =>
      database.update(s.ranks).set({ sortOrder: index }).where(eq(s.ranks.id, id)),
    ),
  ] as never);

  return c.json({ ok: true });
});

/**
 * Delete a rank. When members still hold it, the caller must say where they go
 * via `reassignTo` (another rank id, or null for "unranked") plus a `reason`.
 *
 * The move is set-based and keyed on the rank being deleted — no per-member
 * loop or inline Discord call — so it scales to any roster size. Rank-derived
 * roles are reconciled to the target (manual grants are left alone), affected
 * members are pushed to the front of the reconcile sweep so Discord catches up
 * shortly after, and the default-rank flag is handed off if this was it.
 */
ranks.delete('/:id', requirePermission('ranks.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const database = db(c.env);
  const actorId = c.get('viewer')!.id;

  const rank = await database.query.ranks.findFirst({ where: eq(s.ranks.id, id) });
  if (!rank) return c.json({ error: 'No such rank' }, 404);

  const body = await c.req
    .json<{ reassignTo?: number | null; reason?: string }>()
    .catch(() => ({}) as { reassignTo?: number | null; reason?: string });

  const holders = await database
    .select({ n: sql<number>`count(*)` })
    .from(s.users)
    .where(eq(s.users.rankId, id));
  const memberCount = Number(holders[0]?.n ?? 0);

  let target: typeof s.ranks.$inferSelect | null = null;
  if (memberCount > 0) {
    if (!Object.prototype.hasOwnProperty.call(body, 'reassignTo')) {
      return c.json(
        { error: `${memberCount} member(s) hold this rank. Choose where to move them.`, memberCount },
        409,
      );
    }
    if (!body.reason?.trim()) {
      return c.json({ error: 'A reason is required to delete a rank that has members.' }, 400);
    }
    if (body.reassignTo != null) {
      if (Number(body.reassignTo) === id) {
        return c.json({ error: 'Cannot reassign members to the rank being deleted.' }, 400);
      }
      target =
        (await database.query.ranks.findFirst({ where: eq(s.ranks.id, Number(body.reassignTo)) })) ??
        null;
      if (!target) return c.json({ error: 'The rank to move members to does not exist.' }, 400);
    }

    // Reconcile rank-derived roles while the members still carry the old rank,
    // so the same code path serves "move to a rank" and "make unranked".
    const oldRoleIds = (
      await database.select({ roleId: s.rankRoles.roleId }).from(s.rankRoles).where(eq(s.rankRoles.rankId, id))
    ).map((r) => r.roleId);
    const newRoleIds = target
      ? (
          await database
            .select({ roleId: s.rankRoles.roleId })
            .from(s.rankRoles)
            .where(eq(s.rankRoles.rankId, target.id))
        ).map((r) => r.roleId)
      : [];
    const staleRoleIds = oldRoleIds.filter((r) => !newRoleIds.includes(r));

    // Front-of-queue the affected members so the reconcile sweep pushes their
    // Discord role changes soon.
    await database.update(s.users).set({ lastReconciledAt: 0 }).where(eq(s.users.rankId, id));

    // Drop old rank-granted roles the new rank doesn't grant (source='manual'
    // grants are never matched, so an admin's explicit grant survives).
    if (staleRoleIds.length) {
      await database.run(
        sql`delete from user_roles where source = 'rank'
            and role_id in (${sql.join(
              staleRoleIds.map((r) => sql`${r}`),
              sql`, `,
            )})
            and user_id in (select id from users where rank_id = ${id})`,
      );
    }
    // Add the target rank's roles (skips any the member already holds).
    for (const roleId of newRoleIds) {
      await database.run(
        sql`insert into user_roles (user_id, role_id, source, granted_by)
            select id, ${roleId}, 'rank', ${actorId} from users where rank_id = ${id}
            on conflict(user_id, role_id) do nothing`,
      );
    }

    // Finally move the members off the rank we're about to delete.
    await database.update(s.users).set({ rankId: target ? target.id : null }).where(eq(s.users.rankId, id));
  }

  // Never leave the roster without a default rank for new recruits.
  if (rank.isDefault) {
    const fallback =
      target?.id ??
      (
        await database
          .select({ id: s.ranks.id })
          .from(s.ranks)
          .where(ne(s.ranks.id, id))
          .orderBy(asc(s.ranks.sortOrder))
          .limit(1)
      )[0]?.id;
    if (fallback) await database.update(s.ranks).set({ isDefault: true }).where(eq(s.ranks.id, fallback));
  }

  await database.delete(s.ranks).where(eq(s.ranks.id, id));
  c.executionCtx.waitUntil(deleteMediaByUrl(c.env, rank.imageUrl));

  await database.insert(s.auditLog).values({
    actorId,
    action: 'rank.delete',
    targetType: 'rank',
    targetId: String(id),
    reason: body.reason?.trim() || null,
    meta: {
      name: rank.name,
      memberCount,
      reassignedTo: target?.id ?? null,
      unranked: memberCount > 0 && !target,
    },
  });

  return c.json({ ok: true, memberCount, reassignedTo: target?.id ?? null });
});

export default ranks;
