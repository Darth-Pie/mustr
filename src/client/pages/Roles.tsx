/**
 * Role administration.
 *
 * Roles carry permissions and, when mapped to a Discord role, drive Discord
 * membership too. This is the browser side of the integration the original
 * the original never had — the 2003 version gated everything on a single rank
 * threshold with no concept of a capability grant.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import Switch from '../components/Switch';
import ColorPicker from '../components/ColorPicker';
import { PERMISSIONS, type Permission } from '../../shared/permissions';
import ReassignDialog from '../components/ReassignDialog';

interface Role {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  discordRoleId: string | null;
  isSystem: boolean;
  memberCount: number;
  permissions: Permission[];
}

interface DiscordRole {
  id: string;
  name: string;
  color: string | null;
  position: number;
}

/** Discord channel type codes worth distinguishing in the picker. */
const CATEGORY_TYPE = 4;

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  position: number;
  parentId: string | null;
}

// Group "roster.view", "roster.edit", … under a "roster" heading.
const PERMISSION_GROUPS = Object.entries(PERMISSIONS).reduce<Record<string, [Permission, string][]>>(
  (acc, [perm, label]) => {
    const area = perm.split('.')[0]!;
    (acc[area] ??= []).push([perm as Permission, label]);
    return acc;
  },
  {},
);

export default function Roles() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [discordRoles, setDiscordRoles] = useState<DiscordRole[]>([]);
  const [discordWarning, setDiscordWarning] = useState<string | null>(null);
  const [discordChannels, setDiscordChannels] = useState<DiscordChannel[]>([]);
  const [discordChannelsWarning, setDiscordChannelsWarning] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(true);
  // A role pending deletion that members still hold — the reassign dialog is open.
  const [pendingDelete, setPendingDelete] = useState<Role | null>(null);

  async function load() {
    const { roles } = await api.get<{ roles: Role[] }>('/roles');
    setRoles(roles);
  }

  const { run, busy, error, notice, warning } = useAction(load);

  useEffect(() => {
    Promise.all([
      load(),
      api
        .get<{ roles: DiscordRole[]; warning?: string }>('/roles/discord-roles')
        .then(({ roles, warning }) => {
          setDiscordRoles(roles);
          setDiscordWarning(warning ?? null);
        })
        .catch(() => setDiscordWarning('Could not reach Discord to load roles.')),
      api
        .get<{ channels: DiscordChannel[]; warning?: string }>('/roles/discord-channels')
        .then(({ channels, warning }) => {
          setDiscordChannels(channels);
          setDiscordChannelsWarning(warning ?? null);
        })
        .catch(() => setDiscordChannelsWarning('Could not reach Discord to load channels.')),
    ]).finally(() => setLoading(false));
  }, []);

  const addRole = () =>
    run(async () => {
      if (!newName.trim()) return;
      const { role } = await api.post<{ role: Role }>('/roles', { name: newName.trim() });
      setNewName('');
      setSelectedId(role.id);
    });

  const selected = roles.find((r) => r.id === selectedId) ?? null;

  if (loading) return <div className="loading">Loading roles…</div>;

  return (
    <section className="panel roles-page">
      <header className="panel-head">
        <h2>Roles</h2>
        <p className="muted">
          {roles.length} role{roles.length === 1 ? '' : 's'}. Roles grant permissions and can mirror
          a Discord role.
        </p>
      </header>

      <Alerts error={error} warning={warning} notice={notice} />

      <div className="add-row">
        <input
          value={newName}
          placeholder="New role name"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addRole()}
          disabled={busy}
        />
        <button onClick={() => void addRole()} disabled={busy || !newName.trim()}>
          Add role
        </button>
      </div>

      <div className="roles-layout">
        <ul className="role-list">
          {roles.map((role) => (
            <li key={role.id}>
              <button
                className={role.id === selectedId ? 'role-chip active' : 'role-chip'}
                onClick={() => setSelectedId(role.id)}
              >
                <span className="dot" style={{ background: role.color ?? 'var(--color-muted)' }} />
                <span className="role-name">{role.name}</span>
                {role.isSystem && <span className="tag">system</span>}
                <span className="count">{role.memberCount}</span>
              </button>
            </li>
          ))}
        </ul>

        {selected ? (
          <RoleEditor
            key={selected.id}
            role={selected}
            discordRoles={discordRoles}
            discordWarning={discordWarning}
            discordChannels={discordChannels}
            discordChannelsWarning={discordChannelsWarning}
            busy={busy}
            onSave={(patch) =>
              run(async () => {
                const res = await api.patch<{
                  discordSync?: { synced: boolean; warning?: string };
                }>(`/roles/${selected.id}`, patch);
                if (res.discordSync?.warning) return { warning: res.discordSync.warning };
                if (res.discordSync?.synced) return 'Saved — the Discord role’s name and color now match.';
                return 'Saved.';
              })
            }
            onSavePermissions={(permissions) =>
              run(() => api.put(`/roles/${selected.id}/permissions`, { permissions }))
            }
            onDelete={() => {
              // With members, open the reassign dialog; empty roles delete outright.
              if (selected.memberCount > 0) {
                setPendingDelete(selected);
                return;
              }
              if (!window.confirm(`Delete the role “${selected.name}”?`)) return;
              void run(async () => {
                await api.del(`/roles/${selected.id}`);
                setSelectedId(null);
              });
            }}
          />
        ) : (
          <div className="role-editor empty-editor">Select a role to edit it.</div>
        )}
      </div>

      {pendingDelete && (
        <ReassignDialog
          title={`Delete role “${pendingDelete.name}”`}
          count={pendingDelete.memberCount}
          options={roles.filter((r) => r.id !== pendingDelete.id).map((r) => ({ value: r.id, label: r.name }))}
          defaultValue={null}
          noneLabel="Remove from everyone (no replacement)"
          busy={busy}
          onConfirm={(target, reason) =>
            run(async () => {
              const name = pendingDelete.name;
              const memberCount = pendingDelete.memberCount;
              await api.del(`/roles/${pendingDelete.id}`, { reassignTo: target, reason });
              setSelectedId(null);
              setPendingDelete(null);
              const outcome =
                target != null
                  ? `moved ${memberCount} member${memberCount === 1 ? '' : 's'} to “${roles.find((r) => r.id === target)?.name ?? 'another role'}”`
                  : `removed it from ${memberCount} member${memberCount === 1 ? '' : 's'}`;
              return `Deleted “${name}” and ${outcome}.`;
            })
          }
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </section>
  );
}

function RoleEditor({
  role,
  discordRoles,
  discordWarning,
  discordChannels,
  discordChannelsWarning,
  busy,
  onSave,
  onSavePermissions,
  onDelete,
}: {
  role: Role;
  discordRoles: DiscordRole[];
  discordWarning: string | null;
  discordChannels: DiscordChannel[];
  discordChannelsWarning: string | null;
  busy: boolean;
  onSave: (patch: Partial<Role>) => void;
  onSavePermissions: (permissions: Permission[]) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? '');
  const [color, setColor] = useState(role.color ?? '#7f8c8d');
  const [discordRoleId, setDiscordRoleId] = useState(role.discordRoleId ?? '');
  const [perms, setPerms] = useState<Set<Permission>>(new Set(role.permissions));

  const permsDirty = useMemo(() => {
    const original = new Set(role.permissions);
    return original.size !== perms.size || [...perms].some((p) => !original.has(p));
  }, [perms, role.permissions]);

  const detailsDirty =
    name !== role.name ||
    description !== (role.description ?? '') ||
    color !== (role.color ?? '#7f8c8d') ||
    discordRoleId !== (role.discordRoleId ?? '');

  const toggle = (p: Permission) =>
    setPerms((prev) => {
      const next = new Set(prev);
      next.has(p) ? next.delete(p) : next.add(p);
      return next;
    });

  // A mapped Discord role that no longer exists in the guild would otherwise
  // vanish silently from the dropdown; keep it visible so it can be cleared.
  const mappedButMissing =
    role.discordRoleId && !discordRoles.some((d) => d.id === role.discordRoleId);

  const [channelIds, setChannelIds] = useState<Set<string>>(new Set());
  const [channelsLoading, setChannelsLoading] = useState(true);
  const channelAction = useAction();

  useEffect(() => {
    let cancelled = false;
    setChannelsLoading(true);
    api
      .get<{ channels: { id: string; name: string | null }[] }>(`/roles/${role.id}/channels`)
      .then(({ channels }) => {
        if (!cancelled) setChannelIds(new Set(channels.map((c) => c.id)));
      })
      .finally(() => {
        if (!cancelled) setChannelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // role.id only — this component remounts per selected role (key={selected.id}).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role.id]);

  const toggleChannel = (id: string) =>
    setChannelIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const saveChannels = () =>
    channelAction.run(async () => {
      const { channels, warnings } = await api.put<{
        channels: { id: string; name: string | null }[];
        warnings: string[];
      }>(`/roles/${role.id}/channels`, { channelIds: [...channelIds] });
      setChannelIds(new Set(channels.map((c) => c.id)));
      if (warnings.length) return { warning: warnings.join(' ') };
      return 'Saved.';
    });

  // Group by category (Discord type 4); channels with no parent, or whose
  // parent wasn't returned, fall into "Uncategorized".
  const channelGroups = useMemo(() => {
    const categories = discordChannels.filter((c) => c.type === CATEGORY_TYPE);
    const catById = new Map(categories.map((c) => [c.id, c]));
    const groups = new Map<string, { title: string; categoryId: string | null; channels: DiscordChannel[] }>();
    groups.set('none', { title: 'Uncategorized', categoryId: null, channels: [] });
    for (const cat of categories.sort((a, b) => a.position - b.position)) {
      groups.set(cat.id, { title: cat.name, categoryId: cat.id, channels: [] });
    }
    for (const ch of discordChannels) {
      if (ch.type === CATEGORY_TYPE) continue;
      const key = ch.parentId && catById.has(ch.parentId) ? ch.parentId : 'none';
      groups.get(key)!.channels.push(ch);
    }
    for (const g of groups.values()) g.channels.sort((a, b) => a.position - b.position);
    return [...groups.values()].filter((g) => g.channels.length > 0 || g.categoryId);
  }, [discordChannels]);

  return (
    <div className="role-editor">
      <div className="field-row">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        </label>
        <div className="color-field">
          Color
          <ColorPicker value={color} onChange={setColor} disabled={busy} aria-label="Role color" />
        </div>
      </div>

      <label>
        Description
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this role is for"
          disabled={busy}
        />
      </label>

      <label>
        Mirrored Discord role
        <select
          value={discordRoleId}
          onChange={(e) => setDiscordRoleId(e.target.value)}
          disabled={busy}
        >
          <option value="">— none —</option>
          {mappedButMissing && (
            <option value={role.discordRoleId!}>
              (unknown role {role.discordRoleId})
            </option>
          )}
          {discordRoles.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      {discordWarning && <p className="muted small warn">{discordWarning}</p>}
      {discordRoleId && !discordWarning && (
        <p className="muted small">
          On save, the Discord role is renamed to “{name}” and recolored to match. Granting this
          role to a member also adds the Discord role; removing it takes the Discord role away.
        </p>
      )}

      <button
        className="primary"
        disabled={busy || !detailsDirty}
        onClick={() => onSave({ name, description, color, discordRoleId: discordRoleId || null })}
      >
        Save details
      </button>

      <fieldset className="perms">
        <legend>Discord channel visibility</legend>
        {!role.discordRoleId ? (
          <p className="muted small">Map a Discord role above and save details first — visibility is granted to that role.</p>
        ) : (
          <>
            <p className="muted small">
              Checking a channel grants the mirrored Discord role <b>View Channel</b> there — mustr only ever
              adds or removes that one grant, never touching @everyone or anyone else’s access. To actually
              hide a channel from everyone else, deny @everyone → View Channel on it in Discord first; mustr
              won’t do that automatically.
            </p>
            {discordChannelsWarning && <p className="muted small warn">{discordChannelsWarning}</p>}
            <Alerts error={channelAction.error} warning={channelAction.warning} notice={channelAction.notice} />
            {channelsLoading ? (
              <p className="muted small">Loading…</p>
            ) : (
              channelGroups.map((g) => (
                <div key={g.categoryId ?? 'none'} className="perm-group">
                  <h4>{g.title}</h4>
                  {g.categoryId && (
                    <div className="perm">
                      <Switch
                        checked={channelIds.has(g.categoryId)}
                        onChange={() => toggleChannel(g.categoryId!)}
                        disabled={busy || channelAction.busy}
                        label={`Whole “${g.title}” category`}
                        hideState
                      />
                      <span>
                        <i>Whole category</i>
                      </span>
                    </div>
                  )}
                  {g.channels.map((ch) => (
                    <div key={ch.id} className="perm">
                      <Switch
                        checked={channelIds.has(ch.id)}
                        onChange={() => toggleChannel(ch.id)}
                        disabled={busy || channelAction.busy}
                        label={ch.name}
                        hideState
                      />
                      <span>{ch.name}</span>
                    </div>
                  ))}
                </div>
              ))
            )}
            <button className="primary" disabled={busy || channelAction.busy || channelsLoading} onClick={() => void saveChannels()}>
              Save channel visibility
            </button>
          </>
        )}
      </fieldset>

      <fieldset className="perms">
        <legend>Permissions</legend>
        {Object.entries(PERMISSION_GROUPS).map(([area, entries]) => (
          <div key={area} className="perm-group">
            <h4>{area}</h4>
            {entries.map(([perm, label]) => (
              <div key={perm} className="perm">
                <Switch
                  checked={perms.has(perm)}
                  onChange={() => toggle(perm)}
                  disabled={busy}
                  label={label}
                  hideState
                />
                <span>
                  {label}
                  <code>{perm}</code>
                </span>
              </div>
            ))}
          </div>
        ))}
        <button
          className="primary"
          disabled={busy || !permsDirty}
          onClick={() => onSavePermissions([...perms])}
        >
          Save permissions
        </button>
      </fieldset>

      <div className="editor-footer">
        <button
          className="danger"
          disabled={busy || role.isSystem}
          onClick={onDelete}
          title={role.isSystem ? 'System roles cannot be deleted' : 'Delete this role'}
        >
          Delete role
        </button>
        {role.memberCount > 0 && (
          <span className="muted small">
            {role.memberCount} member{role.memberCount === 1 ? '' : 's'} hold this role
          </span>
        )}
      </div>
    </div>
  );
}
