/**
 * A single member: identity, rank, self-editable bio, roles, and medals.
 *
 * Admin controls (promote/demote, status, role grants) are each gated on the
 * matching permission via the session's can(). That means holders of the
 * top-level Command role see them, and God is a fallback — not a special case.
 */

import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { MorphIcon } from 'morphicons/react';
import { X, Medal as MedalIcon, Trophy, ChevronUp, ChevronDown } from 'lucide';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import { useSession } from '../lib/session';
import { memberName } from '../../shared/names';
import { memberAvatar } from '../../shared/avatar';
import { useRecordRecent } from '../lib/recent';
import { useModules, useScConfig } from '../lib/modules';
import HangarView from '../components/HangarView';
import HangarImport from '../components/HangarImport';
import ScVerify from '../components/ScVerify';
import WowCharacters from '../components/WowCharacters';
import MemberTraining from '../components/MemberTraining';
import MemberActivity from '../components/MemberActivity';
import SigilEmblem from '../components/SigilEmblem';

interface Role {
  id: number;
  name: string;
  color: string | null;
  source?: 'manual' | 'rank';
}
interface Medal {
  awardId: number;
  id: number;
  name: string;
  imageUrl: string | null;
  citation: string | null;
  // NULL = awarded automatically by the tenure sweep, not by a person.
  awardedBy: number | null;
  awardedAt: number;
}
/** A medal definition, for the award picker. */
interface MedalDef {
  id: number;
  name: string;
  imageUrl: string | null;
  autoGrantMonths: number | null;
}
interface WarRecord {
  awardId: number;
  id: number;
  name: string;
  imageUrl: string | null;
  gameName: string | null;
  citation: string | null;
  awardedBy: number | null;
  awardedAt: number;
}
/** A war-record definition, for the award picker. */
interface WarRecordDef {
  id: number;
  name: string;
  imageUrl: string | null;
  gameName: string | null;
}
interface Member {
  id: number;
  discordId: string;
  username: string;
  globalName: string | null;
  displayName: string | null;
  avatar: string | null;
  profileImageUrl: string | null;
  status: string;
  joinedAt: number;
  rank: { id: number; name: string; sortOrder: number; imageUrl: string | null } | null;
  roles: Role[];
  medals: Medal[];
  warRecords: WarRecord[];
  bio: string | null;
}
interface Rank {
  id: number;
  name: string;
  sortOrder: number;
}

const STATUSES = ['active', 'inactive', 'loa', 'retired', 'banned'] as const;

export default function MemberDetail() {
  const { id } = useParams();
  const memberId = Number(id);
  const navigate = useNavigate();
  const { viewer, can } = useSession();
  const modules = useModules();
  const sc = useScConfig();
  // Bumped after a self-import so the hangar view below re-fetches.
  const [hangarKey, setHangarKey] = useState(0);

  const [member, setMember] = useState<Member | null>(null);
  const [ranks, setRanks] = useState<Rank[]>([]);
  const [assignable, setAssignable] = useState<Role[]>([]);
  const [medalCatalog, setMedalCatalog] = useState<MedalDef[]>([]);
  const [warRecordCatalog, setWarRecordCatalog] = useState<WarRecordDef[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { member } = await api.get<{ member: Member }>(`/members/${memberId}`);
    setMember(member);
  }, [memberId]);

  const { run, busy, error, notice, warning, setError } = useAction(load);

  // Negative actions (demote, remove/ban, revoke an award or role) require a
  // written reason. Rather than a prompt per button, they funnel through one
  // inline reason box: promptReason stashes the label + the call to make once a
  // reason is entered, and the box renders near the top of the panel.
  const [pending, setPending] = useState<{ label: string; onConfirm: (reason: string) => void } | null>(
    null,
  );
  const [reasonText, setReasonText] = useState('');
  const promptReason = (label: string, onConfirm: (reason: string) => void) => {
    setReasonText('');
    setPending({ label, onConfirm });
  };
  const confirmReason = () => {
    const reason = reasonText.trim();
    if (reason.length < 3 || !pending) return;
    pending.onConfirm(reason);
    setPending(null);
    setReasonText('');
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([
      load(),
      api.get<{ ranks: Rank[] }>('/ranks').then(({ ranks }) => setRanks(ranks)),
      can('roles.assign')
        ? api.get<{ roles: Role[] }>('/roles/assignable').then(({ roles }) => setAssignable(roles))
        : Promise.resolve(),
      can('medals.award')
        ? api.get<{ medals: MedalDef[] }>('/medals').then(({ medals }) => setMedalCatalog(medals))
        : Promise.resolve(),
      can('warrecords.award')
        ? api
            .get<{ warRecords: WarRecordDef[] }>('/warrecords')
            .then(({ warRecords }) => setWarRecordCatalog(warRecords))
        : Promise.resolve(),
    ])
      .catch(() => setError('Failed to load member.'))
      .finally(() => setLoading(false));
  }, [load, can, setError]);

  useRecordRecent(member ? { group: 'people', label: memberName(member), to: `/members/${member.id}` } : null);

  if (loading) return <div className="loading">Loading member…</div>;
  if (!member) return <div className="empty">Member not found.</div>;

  const isSelf = viewer?.id === member.id;
  const canEditProfile = isSelf || can('roster.edit');
  const displayName = memberName(member);
  // The underlying Discord identity, shown when a display name overrides it.
  const discordHandle = member.globalName ?? member.username;
  const showsDiscordHandle = displayName !== discordHandle;

  // Adjacent ranks for one-step promote/demote, and whether the viewer outranks
  // the target (God ignores the ladder).
  const ordered = [...ranks].sort((a, b) => a.sortOrder - b.sortOrder);
  const curOrder = member.rank?.sortOrder ?? -1;
  const nextUp = ordered.find((r) => r.sortOrder > curOrder) ?? null;
  const nextDown = [...ordered].reverse().find((r) => r.sortOrder < curOrder) ?? null;
  const viewerOrder = viewer?.rank?.sortOrder ?? -1;
  const outranksTarget = viewer?.isGod || (curOrder >= 0 && viewerOrder > curOrder) || curOrder < 0;
  const canPromoteTo = (r: Rank | null) => !!r && (viewer?.isGod || viewerOrder > r.sortOrder);

  const setRank = (rankId: number | null, label: string, reason?: string) =>
    run(async () => {
      const res = await api.put<{ rankRoleSync?: { added: string[]; removed: string[]; warnings: string[] } }>(
        `/members/${member.id}/rank`,
        { rankId, reason },
      );
      const s = res.rankRoleSync;
      const changes = [
        s?.added.length ? `roles added: ${s.added.join(', ')}` : '',
        s?.removed.length ? `removed: ${s.removed.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; ');
      const summary = `${label}.${changes ? ` (${changes})` : ''}`;
      return s?.warnings.length ? { warning: `${summary} ${s.warnings[0]}` } : summary;
    });

  const setStatus = (status: string, reason?: string) =>
    run(async () => {
      await api.patch(`/members/${member.id}/status`, { status, reason });
      return `Status set to ${status}.`;
    });

  const resyncDiscord = () =>
    run(async () => {
      const res = await api.post<{ ok: boolean; added?: number; removed?: number; warning?: string }>(
        `/members/${member.id}/resync`,
      );
      if (res.warning) return { warning: res.warning };
      const n = (res.added ?? 0) + (res.removed ?? 0);
      return n === 0
        ? 'Discord already matches the website.'
        : `Discord synced — ${res.added} added, ${res.removed} removed.`;
    });

  const grantRole = (roleId: number) =>
    run(async () => {
      const res = await api.post<{ warning?: string }>(`/members/${member.id}/roles`, { roleId });
      return res.warning ? { warning: res.warning } : 'Role granted.';
    });

  const revokeRole = (roleId: number, reason: string) =>
    run(async () => {
      const res = await api.del<{ warning?: string }>(`/members/${member.id}/roles/${roleId}`, { reason });
      return res.warning ? { warning: res.warning } : 'Role removed.';
    });

  const awardMedal = (medalId: number, citation: string) =>
    run(async () => {
      await api.post(`/members/${member.id}/medals`, {
        medalId,
        citation: citation.trim() || undefined,
      });
      return 'Medal awarded.';
    });

  const revokeMedal = (awardId: number, reason: string) =>
    run(async () => {
      await api.del(`/members/${member.id}/medals/${awardId}`, { reason });
      return 'Medal revoked.';
    });

  const awardWarRecord = (warRecordId: number, citation: string) =>
    run(async () => {
      await api.post(`/members/${member.id}/warrecords`, {
        warRecordId,
        citation: citation.trim() || undefined,
      });
      return 'War record awarded.';
    });

  const revokeWarRecord = (awardId: number, reason: string) =>
    run(async () => {
      await api.del(`/members/${member.id}/warrecords/${awardId}`, { reason });
      return 'War record revoked.';
    });

  const setProfileImage = (profileImageUrl: string | null) =>
    run(async () => {
      await api.patch(`/members/${member.id}/profile`, { profileImageUrl });
      return profileImageUrl
        ? 'Profile image updated.'
        : 'Profile image removed — using the Discord avatar.';
    });

  const heldRoleIds = new Set(member.roles.map((r) => r.id));
  const grantable = assignable.filter((r) => !heldRoleIds.has(r.id));

  const heldMedalIds = new Set(member.medals.map((m) => m.id));
  const awardable = medalCatalog.filter((m) => !heldMedalIds.has(m.id));

  const heldWarRecordIds = new Set(member.warRecords.map((w) => w.id));
  const awardableWarRecords = warRecordCatalog.filter((w) => !heldWarRecordIds.has(w.id));

  // Manual roles are the only ones managed here; rank-derived roles are set on
  // the rank in the admin panel, so they aren't listed or revocable on a member.
  const manualRoles = member.roles.filter((r) => r.source !== 'rank');
  const showAdminBar =
    can('roster.promote') ||
    can('roster.edit') ||
    can('roster.remove') ||
    can('roles.assign') ||
    can('discord.sync');

  return (
    <section className="panel member-detail">
      {viewer?.pending && isSelf ? (
        <div className="pending-banner">
          <strong>⏳ Application in review.</strong> You’re not a member yet — fill out your profile below so an
          officer knows who you are. You’ll get full access once you’re approved.
        </div>
      ) : (
        <button className="back" onClick={() => navigate('/roster')}>
          ← Roster
        </button>
      )}

      <Alerts error={error} warning={warning} notice={notice} />

      {pending && (
        <div className="reason-prompt">
          <span className="reason-label">{pending.label} — reason required:</span>
          <input
            autoFocus
            value={reasonText}
            maxLength={500}
            placeholder="Why is this happening?"
            disabled={busy}
            onChange={(e) => setReasonText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmReason();
              if (e.key === 'Escape') setPending(null);
            }}
          />
          <button
            className="danger mini"
            disabled={busy || reasonText.trim().length < 3}
            onClick={confirmReason}
          >
            Confirm
          </button>
          <button className="mini" disabled={busy} onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      )}

      <header className="member-head">
        <SigilEmblem className="member-crest" />
        <AvatarBlock
          member={member}
          canEdit={canEditProfile}
          hasOverride={!!member.profileImageUrl}
          busy={busy}
          onSet={setProfileImage}
        />
        <div>
          <h2>{displayName}</h2>
          {showsDiscordHandle && <div className="muted small">Discord: {discordHandle}</div>}
          <div className="member-sub muted">
            <span className="rank-chip">{member.rank ? member.rank.name : 'Unranked'}</span>
            <span className={`status-chip status-${member.status}`}>{member.status}</span>
            <span>joined {new Date(member.joinedAt * 1000).toLocaleDateString()}</span>
          </div>
        </div>
      </header>

      {showAdminBar && (
        <div className="member-admin-bar">
          {can('roster.promote') && (
            <div className="mab-group">
              <span className="rank-thumb">
                {member.rank?.imageUrl ? (
                  <img src={member.rank.imageUrl} alt="" width={28} height={28} />
                ) : (
                  <span className="rank-thumb-empty">—</span>
                )}
              </span>
              <span className="mab-rank-name">{member.rank ? member.rank.name : 'Unranked'}</span>
              {outranksTarget ? (
                <span className="mab-buttons">
                  <button
                    disabled={busy || !canPromoteTo(nextUp)}
                    title={nextUp ? `Promote to ${nextUp.name}` : 'Already at the top rank'}
                    onClick={() => nextUp && void setRank(nextUp.id, `Promoted to ${nextUp.name}`)}
                  >
                    <MorphIcon icon={ChevronUp} size={13} aria-hidden /> Promote
                  </button>
                  <button
                    disabled={busy || !nextDown}
                    title={nextDown ? `Demote to ${nextDown.name}` : 'Already at the lowest rank'}
                    onClick={() =>
                      nextDown &&
                      promptReason(`Demote to ${nextDown.name}`, (reason) =>
                        setRank(nextDown.id, `Demoted to ${nextDown.name}`, reason),
                      )
                    }
                  >
                    <MorphIcon icon={ChevronDown} size={13} aria-hidden /> Demote
                  </button>
                </span>
              ) : (
                <span className="muted small">Outranks you</span>
              )}
            </div>
          )}

          {(can('roster.edit') || can('roster.remove')) && (
            <div className="mab-group">
              <span className="mab-label">Status</span>
              <select
                value={member.status}
                disabled={busy || !outranksTarget}
                onChange={(e) => {
                  const next = e.target.value;
                  // Ban/retire are negative — demand a reason. Softer states
                  // (active/inactive/loa) apply straight away.
                  if (next === 'banned' || next === 'retired') {
                    promptReason(
                      next === 'banned' ? 'Ban this member' : 'Retire this member',
                      (reason) => setStatus(next, reason),
                    );
                  } else {
                    void setStatus(next);
                  }
                }}
              >
                {STATUSES.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
              {can('roster.remove') && member.status !== 'retired' && (
                <button
                  className="danger mini"
                  disabled={busy || !outranksTarget}
                  onClick={() =>
                    promptReason('Retire (remove) this member', (reason) =>
                      setStatus('retired', reason),
                    )
                  }
                  title="Retire this member (keeps their history)"
                >
                  Remove
                </button>
              )}
            </div>
          )}

          {can('roles.assign') && (
            <div className="mab-group mab-roles">
              <span className="mab-label">Roles</span>
              {manualRoles.map((role) => (
                <span key={role.id} className="role-pill">
                  <span className="dot" style={{ background: role.color ?? 'var(--color-muted)' }} />
                  {role.name}
                  <button
                    className="mini danger"
                    disabled={busy}
                    title="Remove this role"
                    onClick={() =>
                      promptReason(`Remove role “${role.name}”`, (reason) =>
                        revokeRole(role.id, reason),
                      )
                    }
                  >
                    <MorphIcon icon={X} size={11} aria-hidden />
                  </button>
                </span>
              ))}
              {grantable.length > 0 && (
                <select
                  disabled={busy}
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) {
                      void grantRole(Number(e.target.value));
                      e.target.value = '';
                    }
                  }}
                >
                  <option value="">Grant a role…</option>
                  {grantable.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {can('discord.sync') && (
            <div className="mab-group">
              <button
                disabled={busy}
                onClick={() => void resyncDiscord()}
                title="Force this member’s Discord roles to match the website now"
              >
                Re-sync Discord
              </button>
            </div>
          )}
        </div>
      )}

      <div className="member-main">
          <section className="block">
            <h3>Profile</h3>
            {canEditProfile ? (
              <ProfileEditor
                displayName={member.displayName ?? ''}
                bio={member.bio ?? ''}
                busy={busy}
                isSelf={isSelf}
                onSave={({ displayName, bio }) =>
                  run(async () => {
                    const res = await api.patch<{
                      discordSync?: { synced: boolean; warning?: string };
                    }>(`/members/${member.id}/profile`, { displayName, bio });
                    if (res.discordSync?.warning) return { warning: res.discordSync.warning };
                    if (res.discordSync?.synced)
                      return 'Saved — the Discord nickname was updated to match.';
                    return 'Profile saved.';
                  })
                }
              />
            ) : member.bio ? (
              <p className="bio">{member.bio}</p>
            ) : (
              <p className="muted">No bio yet.</p>
            )}
          </section>

          <section className="block">
            <h3>Medals</h3>
            {member.medals.length === 0 ? (
              <div className="crest-empty">
                <SigilEmblem className="crest-empty-mark" />
                <span className="muted">No medals yet.</span>
              </div>
            ) : (
              <ul className="member-medals">
                {member.medals.map((m) => (
                  <li key={m.awardId} title={m.citation ?? ''}>
                    {m.imageUrl ? (
                      <img src={m.imageUrl} alt="" width={28} height={28} />
                    ) : (
                      <span className="medal-thumb-empty small">
                        <MorphIcon icon={MedalIcon} size={16} aria-hidden />
                      </span>
                    )}
                    <span className="medal-label">
                      {m.name}
                      {m.citation && <span className="medal-citation">{m.citation}</span>}
                    </span>
                    {m.awardedBy === null && <span className="tag">auto</span>}
                    {can('medals.award') && (
                      <button
                        className="mini danger"
                        disabled={busy}
                        title="Revoke this medal"
                        onClick={() =>
                          promptReason(`Revoke medal “${m.name}”`, (reason) =>
                            revokeMedal(m.awardId, reason),
                          )
                        }
                      >
                        <MorphIcon icon={X} size={11} aria-hidden />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {can('medals.award') &&
              (awardable.length > 0 ? (
                <AwardMedalRow medals={awardable} busy={busy} onAward={awardMedal} />
              ) : (
                medalCatalog.length > 0 && (
                  <p className="muted small">This member holds every medal in the catalog.</p>
                )
              ))}
          </section>

          <section className="block">
            <h3>War Records</h3>
            {member.warRecords.length === 0 ? (
              <div className="crest-empty">
                <SigilEmblem className="crest-empty-mark" />
                <span className="muted">No war records yet.</span>
              </div>
            ) : (
              <ul className="member-medals">
                {member.warRecords.map((w) => (
                  <li key={w.awardId} title={w.citation ?? ''}>
                    {w.imageUrl ? (
                      <img src={w.imageUrl} alt="" width={28} height={28} />
                    ) : (
                      <span className="medal-thumb-empty small">
                        <MorphIcon icon={Trophy} size={16} aria-hidden />
                      </span>
                    )}
                    <span className="medal-label">
                      {w.name}
                      {w.gameName && <span className="tag">{w.gameName}</span>}
                      {w.citation && <span className="medal-citation">{w.citation}</span>}
                    </span>
                    {can('warrecords.award') && (
                      <button
                        className="mini danger"
                        disabled={busy}
                        title="Revoke this war record"
                        onClick={() =>
                          promptReason(`Revoke war record “${w.name}”`, (reason) =>
                            revokeWarRecord(w.awardId, reason),
                          )
                        }
                      >
                        <MorphIcon icon={X} size={11} aria-hidden />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {can('warrecords.award') &&
              (awardableWarRecords.length > 0 ? (
                <AwardWarRecordRow records={awardableWarRecords} busy={busy} onAward={awardWarRecord} />
              ) : (
                warRecordCatalog.length > 0 && (
                  <p className="muted small">This member holds every war record in the catalog.</p>
                )
              ))}
          </section>

          {/* Renders itself only when the viewer may see this member's activity
              (self, a permitted role, or god) and the feature is on. */}
          <MemberActivity userId={member.id} />

          {(isSelf || can('training.view')) && (
            <div className="block">
              <MemberTraining userId={member.id} isSelf={isSelf} />
            </div>
          )}

          {/* Renders itself only when there is something to show: the member's own
              link controls, or someone else's followed characters. */}
          {modules.wow && <WowCharacters userId={member.id} isSelf={isSelf} />}

          {modules.starcitizen && (sc.hangarEnabled || sc.verifyEnabled) && (isSelf || can('hangar.view')) && (
            <section className="block hangar-section">
              <h3>Star Citizen</h3>
              {sc.verifyEnabled && <ScVerify userId={member.id} isSelf={isSelf} />}
              {sc.hangarEnabled && isSelf && (
                <HangarImport userId={member.id} onImported={() => setHangarKey((k) => k + 1)} />
              )}
              {sc.hangarEnabled && <HangarView userId={member.id} refreshKey={hangarKey} />}
              <p className="sc-disclaimer muted small">
                Star Citizen®, Squadron 42®, Roberts Space Industries®, and Cloud Imperium® are
                trademarks of Cloud Imperium Rights LLC. mustr is an unofficial community tool and is
                not affiliated with, endorsed, sponsored, or approved by Cloud Imperium Games or
                Roberts Space Industries.
              </p>
            </section>
          )}
      </div>
    </section>
  );
}

/**
 * The member's avatar, with self-service upload when the viewer may edit this
 * profile. Uploads land in R2 under avatars/ and the returned URL is saved as
 * the profile-image override; "Use Discord" clears it back to the Discord
 * avatar. Defaults to the Discord avatar until an override is set.
 */
function AvatarBlock({
  member,
  canEdit,
  hasOverride,
  busy,
  onSet,
}: {
  member: { discordId: string; avatar: string | null; profileImageUrl: string | null };
  canEdit: boolean;
  hasOverride: boolean;
  busy: boolean;
  onSet: (url: string | null) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const { url } = await api.upload<{ url: string }>('/media/avatars', file);
      onSet(url);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="member-avatar">
      <img className="avatar lg" src={memberAvatar(member, 128)} alt="" width={72} height={72} />
      {canEdit && (
        <div className="avatar-controls">
          <label className="upload-btn mini">
            {uploading ? 'Uploading…' : hasOverride ? 'Change' : 'Upload'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={(e) => void pickFile(e)}
              disabled={busy || uploading}
              hidden
            />
          </label>
          {hasOverride && (
            <button
              className="mini"
              disabled={busy || uploading}
              onClick={() => onSet(null)}
              title="Revert to the Discord avatar"
            >
              Use Discord
            </button>
          )}
          {uploadError && <span className="small warn">{uploadError}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Pick a medal and (optionally) write a citation, then award it. Kept as its
 * own component so the select + citation input have local state that resets
 * after each award.
 */
function AwardMedalRow({
  medals,
  busy,
  onAward,
}: {
  medals: MedalDef[];
  busy: boolean;
  onAward: (medalId: number, citation: string) => void;
}) {
  const [medalId, setMedalId] = useState<number | ''>('');
  const [citation, setCitation] = useState('');

  return (
    <div className="award-row">
      <select
        value={medalId}
        disabled={busy}
        onChange={(e) => setMedalId(e.target.value ? Number(e.target.value) : '')}
      >
        <option value="">Award a medal…</option>
        {medals.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.autoGrantMonths != null ? ' (tenure)' : ''}
          </option>
        ))}
      </select>
      <input
        value={citation}
        placeholder="Citation (optional)"
        maxLength={300}
        disabled={busy || medalId === ''}
        onChange={(e) => setCitation(e.target.value)}
      />
      <button
        disabled={busy || medalId === ''}
        onClick={() => {
          if (medalId !== '') {
            onAward(medalId, citation);
            setMedalId('');
            setCitation('');
          }
        }}
      >
        Award
      </button>
    </div>
  );
}

/** Pick a war record and (optionally) a citation, then award it. */
function AwardWarRecordRow({
  records,
  busy,
  onAward,
}: {
  records: WarRecordDef[];
  busy: boolean;
  onAward: (warRecordId: number, citation: string) => void;
}) {
  const [recordId, setRecordId] = useState<number | ''>('');
  const [citation, setCitation] = useState('');

  return (
    <div className="award-row">
      <select
        value={recordId}
        disabled={busy}
        onChange={(e) => setRecordId(e.target.value ? Number(e.target.value) : '')}
      >
        <option value="">Award a war record…</option>
        {records.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
            {r.gameName ? ` (${r.gameName})` : ''}
          </option>
        ))}
      </select>
      <input
        value={citation}
        placeholder="Citation (optional)"
        maxLength={300}
        disabled={busy || recordId === ''}
        onChange={(e) => setCitation(e.target.value)}
      />
      <button
        disabled={busy || recordId === ''}
        onClick={() => {
          if (recordId !== '') {
            onAward(recordId, citation);
            setRecordId('');
            setCitation('');
          }
        }}
      >
        Award
      </button>
    </div>
  );
}

function ProfileEditor({
  displayName,
  bio,
  busy,
  isSelf,
  onSave,
}: {
  displayName: string;
  bio: string;
  busy: boolean;
  isSelf: boolean;
  onSave: (v: { displayName: string; bio: string }) => void;
}) {
  const [name, setName] = useState(displayName);
  const [text, setText] = useState(bio);
  const dirty = name !== displayName || text !== bio;
  const nameValid = name.trim().length >= 2;

  return (
    <div className="bio-editor">
      <label className="field">
        Display name <span className="req">*</span>
        <input
          value={name}
          maxLength={32}
          placeholder={isSelf ? 'Your in-game name' : 'Set a display name'}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          aria-invalid={!nameValid}
        />
      </label>
      <p className="muted small">
        Required. Shown across the site instead of the Discord name, and applied as the member’s
        Discord nickname.
      </p>

      <label className="field">
        Bio
        <textarea
          value={text}
          maxLength={2000}
          rows={4}
          placeholder={isSelf ? 'Tell the clan about yourself…' : 'Edit this member’s bio…'}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />
      </label>

      <div className="bio-actions">
        <button
          className="primary"
          disabled={busy || !dirty || !nameValid}
          title={!nameValid ? 'A display name is required' : undefined}
          onClick={() => onSave({ displayName: name, bio: text })}
        >
          Save profile
        </button>
        {dirty && (
          <button
            disabled={busy}
            onClick={() => {
              setName(displayName);
              setText(bio);
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
