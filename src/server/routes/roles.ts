/**
 * Role management — the capability side of the permission model.
 *
 * A role bundles permission strings and, optionally, mirrors a Discord role.
 * Setting discordRoleId is what lets granting a role here also grant it in
 * Discord (see discord/sync.ts and the member role routes).
 */

import { Hono } from 'hono';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { AppContext } from '../env';
import { db, requireAuth, requirePermission } from '../middleware/auth';
import { can, isPermission, permissionsWithinGrant, type Permission } from '../../shared/permissions';
import { DiscordError } from '../discord/rest';
import { discordClient } from '../config';
import { applyRoleChannelOverwrites, type ChannelSyncFailure } from '../discord/channelVisibility';

const roles = new Hono<AppContext>();

/** Bot client from resolved (DB-over-env) config, or null when unconfigured. */
const rest = (env: AppContext['Bindings']) => discordClient(env);

/** "#c0392b" → 12597931. Null/blank/invalid → 0, which Discord shows as no colour. */
function hexToInt(hex: string | null): number {
  if (!hex) return 0;
  const n = parseInt(hex.replace(/^#/, ''), 16);
  return Number.isNaN(n) ? 0 : n;
}

/** Every role with its permission list and how many members hold it. */
roles.get('/', requirePermission('roles.manage'), async (c) => {
  const database = db(c.env);

  const rows = await database
    .select({
      id: s.roles.id,
      name: s.roles.name,
      description: s.roles.description,
      color: s.roles.color,
      discordRoleId: s.roles.discordRoleId,
      sortOrder: s.roles.sortOrder,
      isSystem: s.roles.isSystem,
      memberCount: sql<number>`(select count(*) from user_roles where user_roles.role_id = roles.id)`,
    })
    .from(s.roles)
    .orderBy(asc(s.roles.sortOrder), asc(s.roles.name));

  const perms = await database.select().from(s.rolePermissions);
  const byRole = new Map<number, Permission[]>();
  for (const p of perms) {
    const list = byRole.get(p.roleId) ?? [];
    list.push(p.permission as Permission);
    byRole.set(p.roleId, list);
  }

  return c.json({
    roles: rows.map((r) => ({ ...r, permissions: byRole.get(r.id) ?? [] })),
  });
});

/**
 * A minimal role list for people who can assign roles but not necessarily
 * manage them (an Officer has roles.assign but not roles.manage). Used by the
 * member page's grant control.
 */
roles.get('/assignable', requireAuth, async (c) => {
  const viewer = c.get('viewer');
  if (!can(viewer, 'roles.assign') && !can(viewer, 'roles.manage')) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const list = await db(c.env)
    .select({ id: s.roles.id, name: s.roles.name, color: s.roles.color })
    .from(s.roles)
    .orderBy(asc(s.roles.sortOrder), asc(s.roles.name));
  return c.json({ roles: list });
});

/**
 * The guild's assignable Discord roles, for the mapping dropdown.
 *
 * Excludes @everyone and managed roles (bot/integration roles Discord won't
 * let anyone assign by hand). Returns [] with a reason when the bot isn't
 * configured or lacks access, so the UI can explain rather than just break.
 */
roles.get('/discord-roles', requirePermission('roles.manage'), async (c) => {
  const client = await rest(c.env);
  if (!client) {
    return c.json({ roles: [], warning: 'Discord bot token or guild ID is not configured.' });
  }

  try {
    const all = await client.listRoles();
    const assignable = all
      .filter((r) => r.name !== '@everyone' && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        id: r.id,
        name: r.name,
        // Discord stores role colour as a 24-bit int; 0 means "no colour".
        color: r.color ? `#${r.color.toString(16).padStart(6, '0')}` : null,
        position: r.position,
      }));
    return c.json({ roles: assignable });
  } catch (err) {
    const warning =
      err instanceof DiscordError && err.status === 403
        ? 'The bot cannot read this server’s roles — check it has been invited and has the View Server permission.'
        : `Could not load Discord roles: ${(err as Error).message}`;
    return c.json({ roles: [], warning });
  }
});

/**
 * Every channel in the guild (any type, categories included), for the
 * channel-visibility picker on a role. Same "empty + warning" shape as
 * /discord-roles when the bot isn't reachable.
 */
roles.get('/discord-channels', requirePermission('roles.manage'), async (c) => {
  const client = await rest(c.env);
  if (!client) {
    return c.json({ channels: [], warning: 'Discord bot token or guild ID is not configured.' });
  }
  try {
    const channels = await client.listAllChannels();
    return c.json({ channels });
  } catch (err) {
    const warning =
      err instanceof DiscordError && err.status === 403
        ? 'The bot cannot read this server’s channels — check it has been invited and has the View Channels permission.'
        : `Could not load Discord channels: ${(err as Error).message}`;
    return c.json({ channels: [], warning });
  }
});

/** Which channels a role currently grants its mirrored Discord role View Channel on. */
roles.get('/:id/channels', requirePermission('roles.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const rows = await db(c.env).select().from(s.roleChannels).where(eq(s.roleChannels.roleId, id));
  return c.json({ channels: rows.map((r) => ({ id: r.channelId, name: r.channelName })) });
});

function describeChannelFailures(failures: ChannelSyncFailure[], names: Map<string, string>): string[] {
  return failures.map((f) => `${names.get(f.channelId) ?? `Channel ${f.channelId}`}: ${f.error}`);
}

/**
 * Replaces the set of channels a role's mirrored Discord role can view.
 * mustr grants (or revokes) ONLY its own overwrite for that role on the
 * channels in the diff — see discord/channelVisibility.ts for why that's
 * the whole safety story here. The website list is authoritative even if a
 * given channel push fails; failures come back as warnings, not a 500.
 */
roles.put('/:id/channels', requirePermission('roles.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ channelIds: string[] }>();
  if (!Array.isArray(body.channelIds)) return c.json({ error: 'Expected a channelIds array' }, 400);

  const database = db(c.env);
  const role = await database.query.roles.findFirst({ where: eq(s.roles.id, id) });
  if (!role) return c.json({ error: 'No such role' }, 404);
  if (!role.discordRoleId) {
    return c.json({ error: 'This role has no mirrored Discord role yet — set one under “Save details” first.' }, 400);
  }

  const current = await database.select().from(s.roleChannels).where(eq(s.roleChannels.roleId, id));
  const currentIds = new Set(current.map((r) => r.channelId));
  const desiredIds = new Set(body.channelIds.filter(Boolean));

  const toAdd = [...desiredIds].filter((cid) => !currentIds.has(cid));
  const toRemove = [...currentIds].filter((cid) => !desiredIds.has(cid));

  const client = await rest(c.env);
  const names = new Map<string, string>();
  current.forEach((r) => r.channelName && names.set(r.channelId, r.channelName));
  if (client) {
    try {
      (await client.listAllChannels()).forEach((ch) => names.set(ch.id, ch.name));
    } catch {
      // Best-effort only — names are cosmetic; the sync below still runs on bare ids.
    }
  }

  const actor = c.get('viewer')!;
  const sync = await applyRoleChannelOverwrites(
    client,
    role.discordRoleId,
    { add: toAdd, remove: toRemove },
    `mustr: channel visibility set by ${actor.username}`,
  );

  if (toRemove.length || toAdd.length) {
    await database.batch([
      ...(toRemove.length
        ? [
            database
              .delete(s.roleChannels)
              .where(and(eq(s.roleChannels.roleId, id), inArray(s.roleChannels.channelId, toRemove))),
          ]
        : []),
      ...(toAdd.length
        ? [
            database
              .insert(s.roleChannels)
              .values(toAdd.map((channelId) => ({ roleId: id, channelId, channelName: names.get(channelId) ?? null }))),
          ]
        : []),
    ] as never);
  }

  await database.insert(s.auditLog).values({
    actorId: actor.id,
    action: 'role.channels_sync',
    targetType: 'role',
    targetId: String(id),
    meta: { added: toAdd, removed: toRemove, failed: sync.failed.map((f) => f.channelId) },
  });

  const rows = await database.select().from(s.roleChannels).where(eq(s.roleChannels.roleId, id));
  return c.json({
    channels: rows.map((r) => ({ id: r.channelId, name: r.channelName })),
    warnings: describeChannelFailures(sync.failed, names),
  });
});

roles.post('/', requirePermission('roles.manage'), async (c) => {
  const body = await c.req.json<{
    name: string;
    description?: string;
    color?: string;
    discordRoleId?: string;
  }>();

  if (!body.name?.trim()) return c.json({ error: 'Name is required' }, 400);

  const database = db(c.env);
  const highest = await database
    .select({ max: sql<number | null>`max(${s.roles.sortOrder})` })
    .from(s.roles);

  try {
    const inserted = await database
      .insert(s.roles)
      .values({
        name: body.name.trim(),
        description: body.description?.trim() || null,
        color: body.color?.trim() || null,
        discordRoleId: body.discordRoleId?.trim() || null,
        sortOrder: (highest[0]?.max ?? -1) + 1,
      })
      .returning();

    const created = inserted[0];
    if (!created) return c.json({ error: 'Failed to create role' }, 500);

    await database.insert(s.auditLog).values({
      actorId: c.get('viewer')!.id,
      action: 'role.create',
      targetType: 'role',
      targetId: String(created.id),
      meta: { name: created.name },
    });

    return c.json({ role: { ...created, permissions: [] } }, 201);
  } catch (err) {
    // roles.name is unique; surface the collision instead of a 500.
    if (String(err).includes('UNIQUE')) {
      return c.json({ error: `A role named “${body.name.trim()}” already exists.` }, 409);
    }
    throw err;
  }
});

roles.patch('/:id', requirePermission('roles.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{
    name?: string;
    description?: string | null;
    color?: string | null;
    discordRoleId?: string | null;
  }>();

  const database = db(c.env);
  const role = await database.query.roles.findFirst({ where: eq(s.roles.id, id) });
  if (!role) return c.json({ error: 'No such role' }, 404);

  // Renaming any role is safe: nothing in the code looks a role up by name
  // (permissions and memberships key off the role id), so names are cosmetic.
  // The isSystem flag only guards against deletion, below.

  const patch: Partial<typeof s.roles.$inferInsert> = { updatedAt: Math.floor(Date.now() / 1000) };
  if (body.name != null) patch.name = body.name.trim();
  if (body.description !== undefined) patch.description = body.description?.trim() || null;
  if (body.color !== undefined) patch.color = body.color?.trim() || null;
  if (body.discordRoleId !== undefined) patch.discordRoleId = body.discordRoleId?.trim() || null;

  const updated = (await database.update(s.roles).set(patch).where(eq(s.roles.id, id)).returning())[0]!;

  // Website is the source of truth for name and colour. Push both to Discord
  // when the role is (or has just become) mapped and any of name/colour/mapping
  // changed, so "set it here → set there" holds. A newly-set mapping also
  // adopts the current website name and colour (the "associate → sync"
  // behaviour). Name and colour go in one PATCH, so a change to either keeps
  // the whole Discord role in step.
  const nameChanged = patch.name != null && patch.name !== role.name;
  const colorChanged = body.color !== undefined && updated.color !== role.color;
  const mappingChanged =
    body.discordRoleId !== undefined && updated.discordRoleId !== role.discordRoleId;
  let discordSync: { synced: boolean; warning?: string } | undefined;

  if (updated.discordRoleId && (nameChanged || colorChanged || mappingChanged)) {
    const client = await rest(c.env);
    if (!client) {
      discordSync = {
        synced: false,
        warning: 'Saved. Discord bot is not configured, so the Discord role was not updated.',
      };
    } else {
      try {
        await client.updateRole(
          updated.discordRoleId,
          { name: updated.name, color: hexToInt(updated.color) },
          `mustr: synced by ${c.get('viewer')!.username}`,
        );
        discordSync = { synced: true };
      } catch (err) {
        discordSync =
          err instanceof DiscordError && err.status === 403
            ? {
                synced: false,
                warning:
                  'Saved here, but Discord refused: the bot needs its role dragged above this one in Server Settings → Roles.',
              }
            : { synced: false, warning: `Saved here, but the Discord update failed: ${(err as Error).message}` };
      }
    }

    await database.insert(s.auditLog).values({
      actorId: c.get('viewer')!.id,
      action: 'role.discord_sync',
      targetType: 'role',
      targetId: String(id),
      meta: {
        discordRoleId: updated.discordRoleId,
        name: updated.name,
        color: updated.color,
        synced: discordSync.synced,
      },
    });
  }

  // The role's Discord mirror just changed — any channel-visibility mapping
  // was pointed at the OLD Discord role, which would otherwise keep its
  // grant forever (Discord doesn't know mustr moved on). Best-effort strip
  // the old role's overwrites and, if a new mirror was set, re-apply the
  // same channel set to it so the mapping follows the role instead of
  // silently orphaning access on the old one.
  if (mappingChanged) {
    const mappedChannels = await database.select().from(s.roleChannels).where(eq(s.roleChannels.roleId, id));
    if (mappedChannels.length) {
      const client = await rest(c.env);
      const channelIds = mappedChannels.map((r) => r.channelId);
      if (role.discordRoleId) {
        await applyRoleChannelOverwrites(client, role.discordRoleId, { add: [], remove: channelIds }, 'mustr: Discord role mapping changed');
      }
      if (updated.discordRoleId) {
        await applyRoleChannelOverwrites(client, updated.discordRoleId, { add: channelIds, remove: [] }, 'mustr: Discord role mapping changed');
      } else {
        // No replacement mirror — the mapping has nothing left to point at.
        await database.delete(s.roleChannels).where(eq(s.roleChannels.roleId, id));
      }
    }
  }

  return c.json({ role: updated, discordSync });
});

/** Replace a role's permission set wholesale. */
roles.put('/:id/permissions', requirePermission('roles.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const { permissions } = await c.req.json<{ permissions: string[] }>();

  if (!Array.isArray(permissions)) {
    return c.json({ error: 'Expected a permissions array' }, 400);
  }
  const invalid = permissions.filter((p) => !isPermission(p));
  if (invalid.length) {
    return c.json({ error: `Unknown permission(s): ${invalid.join(', ')}` }, 400);
  }

  const database = db(c.env);
  const role = await database.query.roles.findFirst({ where: eq(s.roles.id, id) });
  if (!role) return c.json({ error: 'No such role' }, 404);

  const unique = [...new Set(permissions)] as Permission[];
  // A role's permission ceiling is whatever the editor already holds — otherwise
  // roles.manage alone is a path to minting an all-powerful role for yourself.
  if (!permissionsWithinGrant(c.get('viewer')!, unique)) {
    return c.json({ error: 'You cannot grant permissions you do not have yourself.' }, 403);
  }
  await database.batch([
    database.delete(s.rolePermissions).where(eq(s.rolePermissions.roleId, id)),
    ...(unique.length
      ? [database.insert(s.rolePermissions).values(unique.map((permission) => ({ roleId: id, permission })))]
      : []),
  ] as never);

  await database.insert(s.auditLog).values({
    actorId: c.get('viewer')!.id,
    action: 'role.permissions',
    targetType: 'role',
    targetId: String(id),
    meta: { permissions: unique },
  });

  return c.json({ ok: true, permissions: unique });
});

/**
 * Delete a role. When members hold it, the caller passes a `reason` and, if they
 * want the members to keep an equivalent capability, a `reassignTo` role id —
 * holders are granted that role (as an explicit/manual grant) before this one
 * cascades away. Omitting `reassignTo` (or null) just removes the role from
 * everyone, the old behaviour. The move is set-based so it scales, and holders
 * are pushed to the front of the reconcile sweep so Discord follows.
 */
roles.delete('/:id', requirePermission('roles.manage'), async (c) => {
  const id = Number(c.req.param('id'));
  const database = db(c.env);
  const actorId = c.get('viewer')!.id;

  const role = await database.query.roles.findFirst({ where: eq(s.roles.id, id) });
  if (!role) return c.json({ error: 'No such role' }, 404);
  if (role.isSystem) {
    return c.json({ error: `“${role.name}” is a system role and cannot be deleted.` }, 403);
  }

  const body = await c.req
    .json<{ reassignTo?: number | null; reason?: string }>()
    .catch(() => ({}) as { reassignTo?: number | null; reason?: string });

  const holders = await database
    .select({ n: sql<number>`count(*)` })
    .from(s.userRoles)
    .where(eq(s.userRoles.roleId, id));
  const memberCount = Number(holders[0]?.n ?? 0);

  let target: typeof s.roles.$inferSelect | null = null;
  if (memberCount > 0) {
    if (!body.reason?.trim()) {
      return c.json({ error: 'A reason is required to delete a role that has members.' }, 400);
    }
    if (body.reassignTo != null) {
      if (Number(body.reassignTo) === id) {
        return c.json({ error: 'Cannot reassign members to the role being deleted.' }, 400);
      }
      target =
        (await database.query.roles.findFirst({ where: eq(s.roles.id, Number(body.reassignTo)) })) ??
        null;
      if (!target) return c.json({ error: 'The role to move members to does not exist.' }, 400);
    }

    // Front-of-queue holders so the reconcile sweep updates Discord soon.
    await database.run(
      sql`update users set last_reconciled_at = 0 where id in (select user_id from user_roles where role_id = ${id})`,
    );

    // Move holders onto the replacement (explicit grant) before the old role —
    // and its memberships — cascade away on delete.
    if (target) {
      await database.run(
        sql`insert into user_roles (user_id, role_id, source, granted_by)
            select user_id, ${target.id}, 'manual', ${actorId} from user_roles where role_id = ${id}
            on conflict(user_id, role_id) do nothing`,
      );
    }
  }

  // Channel-visibility overwrites live on Discord's side, keyed to the (now
  // vanishing) Discord role — role_channels cascading away here wouldn't
  // touch them, so strip them first or the grant outlives the role.
  if (role.discordRoleId) {
    const mappedChannels = await database.select().from(s.roleChannels).where(eq(s.roleChannels.roleId, id));
    if (mappedChannels.length) {
      const client = await rest(c.env);
      await applyRoleChannelOverwrites(
        client,
        role.discordRoleId,
        { add: [], remove: mappedChannels.map((r) => r.channelId) },
        'mustr: role deleted',
      );
    }
  }

  // user_roles, role_permissions, and role_channels cascade on delete (see
  // schema). The Discord *role membership* side is left to the reconcile
  // sweep — it removes the old mapped role and adds the replacement's, from
  // the memberships we just wrote.
  await database.delete(s.roles).where(eq(s.roles.id, id));

  await database.insert(s.auditLog).values({
    actorId,
    action: 'role.delete',
    targetType: 'role',
    targetId: String(id),
    reason: body.reason?.trim() || null,
    meta: { name: role.name, memberCount, reassignedTo: target?.id ?? null },
  });

  return c.json({ ok: true, memberCount, reassignedTo: target?.id ?? null });
});

export default roles;
