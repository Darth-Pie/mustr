/**
 * Rank administration — add, rename, reorder, delete, and choose which roles
 * each rank grants.
 *
 * This screen is the reason for the rewrite: the 2003 version rendered 21
 * hardcoded rows of `<input name="name_9">` because ranks were columns. It now
 * also drives roles — assigning a rank hands out its roles, which cascade to
 * Discord.
 */

import { useEffect, useState, type ChangeEvent } from 'react';
import { MorphIcon } from 'morphicons/react';
import { X } from 'lucide';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import { useSession } from '../lib/session';
import { useDragOrder } from '../lib/dragOrder';
import Switch from '../components/Switch';
import ReassignDialog from '../components/ReassignDialog';

interface Rank {
  id: number;
  name: string;
  abbreviation: string | null;
  imageUrl: string | null;
  sortOrder: number;
  reqDays: number;
  reqWins: number;
  isDefault: boolean;
  memberCount: number;
  roleIds: number[];
}

interface Role {
  id: number;
  name: string;
  color: string | null;
}

/** The rank just below `rank` on the ladder (fallback: just above, else none). */
function nextLowerRankId(ranks: Rank[], rank: Rank): number | null {
  const lower = ranks
    .filter((r) => r.id !== rank.id && r.sortOrder < rank.sortOrder)
    .sort((a, b) => b.sortOrder - a.sortOrder)[0];
  const higher = ranks
    .filter((r) => r.id !== rank.id && r.sortOrder > rank.sortOrder)
    .sort((a, b) => a.sortOrder - b.sortOrder)[0];
  return lower?.id ?? higher?.id ?? null;
}

export default function Ranks() {
  const { can } = useSession();
  const canManageRoles = can('roles.manage');

  const [ranks, setRanks] = useState<Rank[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [selectedRankId, setSelectedRankId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  // A rank pending deletion that still has members — the reassign dialog is open.
  const [pendingDelete, setPendingDelete] = useState<Rank | null>(null);

  async function load() {
    const { ranks } = await api.get<{ ranks: Rank[] }>('/ranks');
    setRanks([...ranks].sort((a, b) => b.sortOrder - a.sortOrder));
  }

  const { run, busy, error, notice, warning } = useAction(load);

  useEffect(() => {
    void load();
    if (canManageRoles) {
      api
        .get<{ roles: Role[] }>('/roles')
        .then(({ roles }) => setRoles(roles))
        .catch(() => setRoles([]));
    }
  }, [canManageRoles]);

  const addRank = () =>
    run(async () => {
      if (!newName.trim()) return;
      await api.post('/ranks', { name: newName.trim() });
      setNewName('');
    });

  const rename = (id: number, name: string) => run(() => api.patch(`/ranks/${id}`, { name }));
  const setDefault = (id: number) => run(() => api.patch(`/ranks/${id}`, { isDefault: true }));
  const setImage = (id: number, imageUrl: string | null) =>
    run(() => api.patch(`/ranks/${id}`, { imageUrl }));

  // Member-less ranks delete with a plain confirm; ones with members open the
  // reassign dialog so the admin says where those members go.
  const remove = (rank: Rank) => {
    if (rank.memberCount > 0) {
      setPendingDelete(rank);
      return;
    }
    if (!window.confirm(`Delete the rank “${rank.name}”?`)) return;
    void run(() => api.del(`/ranks/${rank.id}`));
  };

  const confirmReassignDelete = (target: number | null, reason: string) => {
    const rank = pendingDelete;
    if (!rank) return;
    void run(async () => {
      await api.del(`/ranks/${rank.id}`, { reassignTo: target, reason });
      setPendingDelete(null);
      const where = target != null ? `“${ranks.find((r) => r.id === target)?.name ?? 'another rank'}”` : 'no rank';
      return `Deleted “${rank.name}” and moved ${rank.memberCount} member${rank.memberCount === 1 ? '' : 's'} to ${where}.`;
    });
  };

  // Drag to reorder. Display is highest-first; the endpoint wants lowest-first,
  // so the saved order is the reversed display order. Optimistic, then load()
  // (via useAction) reconciles with what the server stored.
  const reorder = (nextKeys: string[]) => {
    const byId = new Map(ranks.map((r) => [String(r.id), r]));
    const next = nextKeys.map((k) => byId.get(k)).filter((r): r is Rank => !!r);
    setRanks(next);
    void run(() => api.put('/ranks/order', { order: next.map((r) => r.id).reverse() }));
  };
  const dnd = useDragOrder(
    ranks.map((r) => String(r.id)),
    reorder,
  );

  const saveRankRoles = (rankId: number, roleIds: number[]) =>
    run(async () => {
      const res = await api.put<{
        applied: { members: number; warnings: string[] };
      }>(`/ranks/${rankId}/roles`, { roleIds });
      const { members, warnings } = res.applied;
      const base =
        members > 0
          ? `Saved. Applied to ${members} member${members === 1 ? '' : 's'} at this rank.`
          : 'Saved.';
      return warnings.length ? { warning: `${base} ${warnings[0]}` } : base;
    });

  const selectedRank = ranks.find((r) => r.id === selectedRankId) ?? null;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Ranks</h2>
        <p className="muted">
          {ranks.length} rank{ranks.length === 1 ? '' : 's'}. Highest first.
        </p>
      </header>

      <Alerts error={error} warning={warning} notice={notice} />

      <div className="add-row">
        <input
          value={newName}
          placeholder="New rank name"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addRank()}
          disabled={busy}
        />
        <button onClick={() => void addRank()} disabled={busy || !newName.trim()}>
          Add rank
        </button>
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th>Order</th>
            <th>Image</th>
            <th>Name</th>
            <th>Members</th>
            <th>Default</th>
            {canManageRoles && <th>Roles</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {ranks.map((rank) => {
            const key = String(rank.id);
            const rowCls = `${dnd.isDragging(key) ? 'dragging ' : ''}${dnd.dropClass(key)}`.trim();
            return (
            <tr key={rank.id} className={rowCls || undefined} {...dnd.rowProps(key)}>
              <td className="reorder">
                <span
                  className="drag-grip"
                  title="Drag to reorder"
                  aria-label={`Drag to reorder ${rank.name}`}
                  {...(busy ? {} : dnd.handleProps(key))}
                >
                  ⠿
                </span>
              </td>
              <td>
                <RankImageCell
                  rank={rank}
                  busy={busy}
                  onSet={(url) => setImage(rank.id, url)}
                />
              </td>
              <td>
                <input
                  defaultValue={rank.name}
                  onBlur={(e) =>
                    e.target.value !== rank.name && void rename(rank.id, e.target.value)
                  }
                  disabled={busy}
                />
              </td>
              <td>{rank.memberCount}</td>
              <td>
                <input
                  type="radio"
                  name="default-rank"
                  checked={rank.isDefault}
                  onChange={() => void setDefault(rank.id)}
                  disabled={busy}
                  title="Rank given to new recruits on first sign-in"
                />
              </td>
              {canManageRoles && (
                <td>
                  <button
                    className={rank.id === selectedRankId ? 'active' : ''}
                    onClick={() => setSelectedRankId(rank.id === selectedRankId ? null : rank.id)}
                  >
                    Roles ({rank.roleIds.length})
                  </button>
                </td>
              )}
              <td>
                <button
                  className="danger"
                  onClick={() => remove(rank)}
                  disabled={busy}
                  title={
                    rank.memberCount > 0
                      ? 'Delete this rank and move its members elsewhere'
                      : 'Delete this rank'
                  }
                >
                  Delete
                </button>
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>

      {pendingDelete && (
        <ReassignDialog
          title={`Delete rank “${pendingDelete.name}”`}
          count={pendingDelete.memberCount}
          options={ranks.filter((r) => r.id !== pendingDelete.id).map((r) => ({ value: r.id, label: r.name }))}
          defaultValue={nextLowerRankId(ranks, pendingDelete)}
          noneLabel="No rank (unranked)"
          busy={busy}
          onConfirm={confirmReassignDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {canManageRoles && selectedRank && (
        <RankRolesEditor
          key={selectedRank.id}
          rank={selectedRank}
          roles={roles}
          busy={busy}
          onSave={(roleIds) => saveRankRoles(selectedRank.id, roleIds)}
          onClose={() => setSelectedRankId(null)}
        />
      )}
    </section>
  );
}

/**
 * A rank's insignia image, with upload/remove. Uploads land in R2 under ranks/
 * and the returned URL is saved to the rank; the previous object is cleaned up
 * server-side.
 */
function RankImageCell({
  rank,
  busy,
  onSet,
}: {
  rank: Rank;
  busy: boolean;
  onSet: (url: string | null) => void;
}) {
  const [uploading, setUploading] = useState(false);

  async function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const { url } = await api.upload<{ url: string }>('/media/ranks', file);
      onSet(url);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="rank-image-cell">
      <span className="rank-thumb">
        {rank.imageUrl ? (
          <img src={rank.imageUrl} alt="" width={28} height={28} />
        ) : (
          <span className="rank-thumb-empty">—</span>
        )}
      </span>
      <label className="upload-btn mini">
        {uploading ? '…' : rank.imageUrl ? 'Change' : 'Upload'}
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={(e) => void pickFile(e)}
          disabled={busy || uploading}
          hidden
        />
      </label>
      {rank.imageUrl && (
        <button className="mini" disabled={busy || uploading} onClick={() => onSet(null)} title="Remove image">
          <MorphIcon icon={X} size={13} aria-hidden />
        </button>
      )}
    </div>
  );
}

function RankRolesEditor({
  rank,
  roles,
  busy,
  onSave,
  onClose,
}: {
  rank: Rank;
  roles: Role[];
  busy: boolean;
  onSave: (roleIds: number[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set(rank.roleIds));

  const dirty =
    selected.size !== rank.roleIds.length || rank.roleIds.some((id) => !selected.has(id));

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="rank-roles-editor">
      <div className="rre-head">
        <h3>Roles granted by “{rank.name}”</h3>
        <button onClick={onClose} title="Close">
          <MorphIcon icon={X} size={14} aria-hidden />
        </button>
      </div>
      <p className="muted small">
        Members at this rank receive these roles automatically. Changing this updates everyone
        currently at the rank, and mapped Discord roles follow.
      </p>

      {roles.length === 0 ? (
        <p className="muted">No roles exist yet. Create some on the Roles page first.</p>
      ) : (
        <div className="rre-roles">
          {roles.map((role) => (
            <div key={role.id} className="rre-role">
              <Switch
                checked={selected.has(role.id)}
                onChange={() => toggle(role.id)}
                disabled={busy}
                label={role.name}
                hideState
              />
              <span className="dot" style={{ background: role.color ?? 'var(--color-muted)' }} />
              {role.name}
            </div>
          ))}
        </div>
      )}

      <button className="primary" disabled={busy || !dirty} onClick={() => onSave([...selected])}>
        Save rank roles
      </button>
    </div>
  );
}
