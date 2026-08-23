/**
 * Events — upcoming clan happenings. Everyone with events.view sees the list
 * and can sign themselves up (optionally picking a role like Tank/Healer/DPS).
 * events.manage adds create/edit/cancel; events.attendees reveals the full
 * "who's coming" roster. Each event mirrors to a Discord scheduled event and a
 * sign-up message whose buttons write the same rows — so the two stay in sync.
 */

import { useEffect, useState, type ChangeEvent } from 'react';
import { MorphIcon } from 'morphicons/react';
import { X, MapPin, Gamepad2, Repeat2, Users } from 'lucide';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import { useSession } from '../lib/session';
import Switch from '../components/Switch';
import { selfCheckinOpen, type AttendanceMode } from '../../shared/attendance';

interface RoleState {
  id: number;
  name: string;
  emoji: string | null;
  capacity: number | null;
  count: number;
}
interface EventItem {
  id: number;
  title: string;
  description: string | null;
  imageUrl: string | null;
  startsAt: number;
  endsAt: number;
  location: string;
  gameId: number | null;
  gameName: string | null;
  createdBy: number | null;
  recurrence: Recurrence;
  shareAlliance: boolean;
  roles: RoleState[];
  signupCount: number;
  mySignup: { roleId: number | null } | null;
  attended: boolean;
}
interface GameOption {
  id: number;
  name: string;
}

type Recurrence = 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly';
const RECURRENCE_OPTIONS: { value: Recurrence; label: string }[] = [
  { value: 'none', label: 'Doesn’t repeat' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every 2 weeks' },
  { value: 'monthly', label: 'Monthly' },
];
const RECURRENCE_BADGE: Record<Recurrence, string> = {
  none: '',
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
};

const pad = (n: number) => String(n).padStart(2, '0');

// Time is picked as an hour (12-hour labels) plus a 15-minute slot, rather than
// a raw datetime field, so the choices are unambiguous.
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({
  value: h,
  label: `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`,
}));
const MINUTE_OPTIONS = [0, 15, 30, 45];
const roundTo15 = (m: number) => MINUTE_OPTIONS.reduce((a, b) => (Math.abs(b - m) < Math.abs(a - m) ? b : a), 0);

// A curated set of icons for the Discord sign-up buttons. Optional — "—" leaves
// the button text-only.
const ROLE_EMOJIS = ['⚔️', '🛡️', '✨', '🩹', '🏹', '🎯', '🔫', '🧙', '🚀', '🚁', '🐎', '👑', '🎙️', '🛠️', '💥'];
// Capacity choices for a role (1–30, or no limit).
const CAP_OPTIONS = Array.from({ length: 30 }, (_, i) => i + 1);

function whenLabel(startsAt: number, endsAt: number): string {
  const start = new Date(startsAt * 1000);
  const end = new Date(endsAt * 1000);
  const sameDay = start.toDateString() === end.toDateString();
  const date = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? `${date} · ${t(start)} – ${t(end)}` : `${start.toLocaleString()} → ${end.toLocaleString()}`;
}

export default function Events() {
  const { can } = useSession();
  const canManage = can('events.manage');
  const canSeeAttendees = can('events.attendees');
  const [events, setEvents] = useState<EventItem[]>([]);
  const [games, setGames] = useState<GameOption[]>([]);
  const [att, setAtt] = useState<{ mode: AttendanceMode; checkinWindowHours: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  async function load() {
    const { events } = await api.get<{ events: EventItem[] }>('/events');
    setEvents(events);
  }

  const { run, busy, error, notice, warning } = useAction(load);

  useEffect(() => {
    Promise.all([
      load(),
      canManage
        ? api.get<{ games: GameOption[] }>('/games').then(({ games }) => setGames(games)).catch(() => setGames([]))
        : Promise.resolve(),
      api
        .get<{ mode: AttendanceMode; checkinWindowHours: number }>('/attendance/settings')
        .then((a) => setAtt({ mode: a.mode, checkinWindowHours: a.checkinWindowHours }))
        .catch(() => setAtt(null)),
    ]).finally(() => setLoading(false));
  }, [canManage]);

  const create = (payload: EventPayload) =>
    run(async () => {
      await api.post('/events', payload);
      setCreating(false);
      return 'Event created. Posting to Discord.';
    });

  const saveEdit = (id: number, payload: EventPayload) =>
    run(async () => {
      await api.patch(`/events/${id}`, payload);
      setEditingId(null);
      return 'Event updated.';
    });

  const remove = (id: number) =>
    run(async () => {
      await api.del(`/events/${id}`);
      setConfirmDelete(null);
      return 'Event cancelled and removed from Discord.';
    });

  const signup = (eventId: number, roleId: number | null) =>
    run(async () => {
      await api.post(`/events/${eventId}/signup`, { roleId });
      return roleId === null ? 'You’re attending.' : 'Signed up.';
    });

  const withdraw = (eventId: number) =>
    run(async () => {
      await api.del(`/events/${eventId}/signup`);
      return 'Withdrawn from the event.';
    });

  const checkin = (eventId: number) =>
    run(async () => {
      await api.post(`/attendance/event/${eventId}/checkin`);
      return 'Checked in. Thanks for coming!';
    });

  const uncheckin = (eventId: number) =>
    run(async () => {
      await api.del(`/attendance/event/${eventId}/checkin`);
      return 'Check-in removed.';
    });

  if (loading) return <div className="loading">Loading events…</div>;

  return (
    <section className="panel">
      <header className="panel-head news-head">
        <div>
          <h2>Events</h2>
          <p className="muted">
            {events.length === 0 ? 'Nothing scheduled.' : `${events.length} upcoming`}
          </p>
        </div>
        {canManage && !creating && (
          <button onClick={() => { setCreating(true); setEditingId(null); }}>+ New event</button>
        )}
      </header>

      <Alerts error={error} warning={warning} notice={notice} />

      {creating && (
        <EventForm games={games} busy={busy} onSave={create} onCancel={() => setCreating(false)} />
      )}

      {events.length === 0 && !creating ? (
        <p className="muted">No upcoming events.</p>
      ) : (
        <ul className="event-list">
          {events.map((ev) =>
            editingId === ev.id ? (
              <li key={ev.id}>
                <EventForm
                  initial={ev}
                  games={games}
                  busy={busy}
                  onSave={(p) => saveEdit(ev.id, p)}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            ) : (
              <li key={ev.id} className="event-card">
                {ev.imageUrl && <img className="event-banner" src={ev.imageUrl} alt="" />}
                <div className="event-when">{whenLabel(ev.startsAt, ev.endsAt)}</div>
                <h3>{ev.title}</h3>
                <div className="muted small event-meta">
                  <MorphIcon icon={MapPin} size={13} aria-hidden /> {ev.location}
                  {ev.gameName && (
                    <>
                      {' '}
                      · <MorphIcon icon={Gamepad2} size={13} aria-hidden /> {ev.gameName}
                    </>
                  )}
                  {ev.recurrence !== 'none' && (
                    <>
                      {' '}
                      · <MorphIcon icon={Repeat2} size={13} aria-hidden /> {RECURRENCE_BADGE[ev.recurrence]}
                    </>
                  )}
                  {ev.signupCount > 0 && (
                    <>
                      {' '}
                      · <MorphIcon icon={Users} size={13} aria-hidden /> {ev.signupCount} signed up
                    </>
                  )}
                </div>
                {ev.description && <p className="event-desc">{ev.description}</p>}

                <SignupControls
                  event={ev}
                  busy={busy}
                  onSignup={(roleId) => void signup(ev.id, roleId)}
                  onWithdraw={() => void withdraw(ev.id)}
                />

                {att && (
                  <CheckInControl
                    event={ev}
                    mode={att.mode}
                    windowHours={att.checkinWindowHours}
                    busy={busy}
                    onCheckin={() => void checkin(ev.id)}
                    onUncheckin={() => void uncheckin(ev.id)}
                  />
                )}

                {canSeeAttendees && <AttendeeRoster eventId={ev.id} count={ev.signupCount} />}

                {canManage && (
                  <div className="event-actions">
                    <button className="mini" disabled={busy} onClick={() => { setEditingId(ev.id); setCreating(false); }}>
                      Edit
                    </button>
                    {confirmDelete === ev.id ? (
                      <span className="confirm-row">
                        <span className="small">Cancel this event?</span>
                        <button className="mini danger" disabled={busy} onClick={() => void remove(ev.id)}>
                          Confirm
                        </button>
                        <button className="mini" disabled={busy} onClick={() => setConfirmDelete(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button className="mini danger" disabled={busy} onClick={() => setConfirmDelete(ev.id)}>
                        Cancel event
                      </button>
                    )}
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

/** The member's own RSVP: role buttons (highlighting their pick) + attend/withdraw. */
function SignupControls({
  event,
  busy,
  onSignup,
  onWithdraw,
}: {
  event: EventItem;
  busy: boolean;
  onSignup: (roleId: number | null) => void;
  onWithdraw: () => void;
}) {
  const my = event.mySignup;
  const myRole = my?.roleId ?? null;
  const attending = my != null;

  return (
    <div className="signup-controls">
      <span className="signup-label">{attending ? "You're in:" : 'Sign up:'}</span>
      {event.roles.map((r) => {
        const selected = attending && myRole === r.id;
        const full = r.capacity != null && r.count >= r.capacity && !selected;
        return (
          <button
            key={r.id}
            className={selected ? 'chip active' : 'chip'}
            disabled={busy || full}
            title={full ? `${r.name} is full` : `Sign up as ${r.name}`}
            onClick={() => onSignup(r.id)}
          >
            {r.emoji ? `${r.emoji} ` : ''}
            {r.name}
            <span className="signup-count">
              {r.count}
              {r.capacity != null ? `/${r.capacity}` : ''}
            </span>
          </button>
        );
      })}
      <button
        className={attending && myRole === null ? 'chip active' : 'chip'}
        disabled={busy}
        onClick={() => onSignup(null)}
        title="Attend without a specific role"
      >
        Attending
      </button>
      {attending && (
        <button className="chip withdraw" disabled={busy} onClick={onWithdraw} title="Withdraw">
          Withdraw
        </button>
      )}
    </div>
  );
}

/**
 * Attendance check-in for the member themselves. Distinct from RSVP: it records
 * that you were actually there. Available while the check-in window is open (from
 * the event's start until a few hours after it ends) and only when the site's
 * attendance mode lets members check themselves in. Once attended, it shows so —
 * and offers an undo while the window is still open.
 */
function CheckInControl({
  event,
  mode,
  windowHours,
  busy,
  onCheckin,
  onUncheckin,
}: {
  event: EventItem;
  mode: AttendanceMode;
  windowHours: number;
  busy: boolean;
  onCheckin: () => void;
  onUncheckin: () => void;
}) {
  const now = Math.floor(Date.now() / 1000);
  const selfAllowed = mode === 'self' || mode === 'both';
  const open = selfCheckinOpen(event, now, windowHours);

  if (event.attended) {
    return (
      <div className="checkin-control">
        <span className="checkin-done">✓ You attended</span>
        {selfAllowed && open && (
          <button className="mini" disabled={busy} onClick={onUncheckin} title="Remove your check-in">
            Undo
          </button>
        )}
      </div>
    );
  }
  if (!selfAllowed || !open) return null;
  return (
    <div className="checkin-control">
      <button className="primary small" disabled={busy} onClick={onCheckin}>
        ✋ I’m here — check in
      </button>
      <span className="muted small">Confirms you attended (counts toward your participation).</span>
    </div>
  );
}

interface SignupEntry {
  userId: number;
  name: string;
  avatarUrl: string;
  roleId: number | null;
  roleName: string | null;
}

/** Collapsible "who's coming" roster, grouped by role. Fetched on first expand. */
function AttendeeRoster({ eventId, count }: { eventId: number; count: number }) {
  const [open, setOpen] = useState(false);
  const [signups, setSignups] = useState<SignupEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && signups === null) {
      setLoading(true);
      try {
        const { signups } = await api.get<{ signups: SignupEntry[] }>(`/events/${eventId}/signups`);
        setSignups(signups);
      } catch {
        setSignups([]);
      } finally {
        setLoading(false);
      }
    }
  }

  // Group by role name for display; no-role attendees fall under "Attending".
  const groups = new Map<string, SignupEntry[]>();
  for (const su of signups ?? []) {
    const key = su.roleName ?? 'Attending';
    const list = groups.get(key) ?? [];
    list.push(su);
    groups.set(key, list);
  }

  return (
    <div className="attendees">
      <button className="mini link-btn" onClick={() => void toggle()}>
        {open ? '▾' : '▸'} Who’s coming{count > 0 ? ` (${count})` : ''}
      </button>
      {open &&
        (loading ? (
          <p className="muted small">Loading…</p>
        ) : (signups?.length ?? 0) === 0 ? (
          <p className="muted small">No one has signed up yet.</p>
        ) : (
          <div className="attendee-groups">
            {[...groups.entries()].map(([role, members]) => (
              <div key={role} className="attendee-group">
                <div className="attendee-role">
                  {role} <span className="muted">({members.length})</span>
                </div>
                <ul className="attendee-members">
                  {members.map((m) => (
                    <li key={m.userId}>
                      <img className="avatar sm" src={m.avatarUrl} alt="" width={24} height={24} />
                      {m.name}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

interface RolePayload {
  id?: number;
  name: string;
  emoji: string | null;
  capacity: number | null;
}
interface EventPayload {
  title: string;
  description: string;
  imageUrl: string | null;
  startsAt: number;
  endsAt: number;
  location: string;
  gameId: number | null;
  recurrence: Recurrence;
  shareAlliance: boolean;
  roles: RolePayload[];
}

interface RoleDraft {
  id?: number;
  name: string;
  emoji: string;
  capacity: string;
}

/**
 * Date + time picker: a native date field plus an hour dropdown (12-hour
 * labels) and a 15-minute slot dropdown. Emits the combined moment as unix
 * seconds, or null until a date is chosen.
 */
function DateTimeField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
}) {
  const init = value != null ? new Date(value * 1000) : null;
  const [date, setDate] = useState(
    init ? `${init.getFullYear()}-${pad(init.getMonth() + 1)}-${pad(init.getDate())}` : '',
  );
  const [hour, setHour] = useState(init ? init.getHours() : 19);
  const [minute, setMinute] = useState(init ? roundTo15(init.getMinutes()) : 0);

  useEffect(() => {
    if (!date) {
      onChange(null);
      return;
    }
    const dt = new Date(`${date}T00:00:00`);
    dt.setHours(hour, minute, 0, 0);
    onChange(Math.floor(dt.getTime() / 1000));
    // onChange identity isn't a dependency — only the picked values matter.
  }, [date, hour, minute]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="datetime-field">
      <span className="field-label">{label}</span>
      <div className="datetime-inputs">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={disabled} />
        <select value={hour} onChange={(e) => setHour(Number(e.target.value))} disabled={disabled} aria-label={`${label} hour`}>
          {HOUR_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select value={minute} onChange={(e) => setMinute(Number(e.target.value))} disabled={disabled} aria-label={`${label} minute`}>
          {MINUTE_OPTIONS.map((m) => (
            <option key={m} value={m}>
              :{pad(m)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function EventForm({
  initial,
  games,
  busy,
  onSave,
  onCancel,
}: {
  initial?: EventItem;
  games: GameOption[];
  busy: boolean;
  onSave: (payload: EventPayload) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [imageUrl, setImageUrl] = useState<string | null>(initial?.imageUrl ?? null);
  const [startsAt, setStartsAt] = useState<number | null>(initial?.startsAt ?? null);
  const [endsAt, setEndsAt] = useState<number | null>(initial?.endsAt ?? null);
  const [location, setLocation] = useState(initial?.location ?? '');
  const [gameId, setGameId] = useState<number | null>(initial?.gameId ?? null);
  const [recurrence, setRecurrence] = useState<Recurrence>(initial?.recurrence ?? 'none');
  const { can } = useSession();
  const [shareAlliance, setShareAlliance] = useState<boolean>(initial?.shareAlliance ?? false);
  const [roles, setRoles] = useState<RoleDraft[]>(
    initial?.roles.map((r) => ({
      id: r.id,
      name: r.name,
      emoji: r.emoji ?? '',
      capacity: r.capacity != null ? String(r.capacity) : '',
    })) ?? [],
  );

  const timesValid = startsAt != null && endsAt != null && endsAt > startsAt;
  const valid = title.trim() && location.trim() && timesValid;

  const addRole = () => setRoles((rs) => [...rs, { name: '', emoji: '', capacity: '' }]);
  const updateRole = (i: number, patch: Partial<RoleDraft>) =>
    setRoles((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRole = (i: number) => setRoles((rs) => rs.filter((_, idx) => idx !== i));

  const submit = () =>
    onSave({
      title: title.trim(),
      description: description.trim(),
      imageUrl,
      startsAt: startsAt!,
      endsAt: endsAt!,
      location: location.trim(),
      gameId,
      recurrence,
      shareAlliance,
      roles: roles
        .filter((r) => r.name.trim())
        .map((r) => ({
          id: r.id,
          name: r.name.trim(),
          emoji: r.emoji.trim() || null,
          capacity: r.capacity.trim() ? Math.max(1, Number(r.capacity)) : null,
        })),
    });

  return (
    <div className="role-editor event-form">
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} placeholder="Clan war vs. …" />
      </label>

      <EventImageField imageUrl={imageUrl} busy={busy} onSet={setImageUrl} />

      <div className="field-row">
        <DateTimeField label="Starts" value={startsAt} onChange={setStartsAt} disabled={busy} />
        <DateTimeField label="Ends" value={endsAt} onChange={setEndsAt} disabled={busy} />
      </div>
      {!timesValid && (startsAt != null || endsAt != null) && (
        <p className="small warn">The end must be after the start.</p>
      )}

      <label>
        Location
        <input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          disabled={busy}
          placeholder="In-game lobby, Discord voice, …"
        />
      </label>

      <div className="field-row">
        <label>
          Game <span className="muted small">(optional)</span>
          <select value={gameId ?? ''} onChange={(e) => setGameId(e.target.value ? Number(e.target.value) : null)} disabled={busy}>
            <option value="">— None —</option>
            {games.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Repeats
          <select value={recurrence} onChange={(e) => setRecurrence(e.target.value as Recurrence)} disabled={busy}>
            {RECURRENCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {can('alliance.manage') && (
        <label className="toggle-row">
          <span>Share with alliance <span className="muted small">(posts to allied orgs’ Discords)</span></span>
          <Switch checked={shareAlliance} onChange={setShareAlliance} label="Share with alliance" />
        </label>
      )}

      <label>
        Description <span className="muted small">(optional)</span>
        <textarea value={description} rows={3} onChange={(e) => setDescription(e.target.value)} disabled={busy} />
      </label>

      <div className="event-roles-editor">
        <div className="field-label">
          Sign-up roles <span className="muted small">(optional — e.g. Tank, Healer, DPS)</span>
        </div>
        {roles.length > 0 && (
          <div className="role-row role-row-head">
            <span className="role-col-icon muted small">Icon</span>
            <span className="role-col-name muted small">Role name</span>
            <span className="role-col-cap muted small">Max players</span>
            <span className="role-col-rm" />
          </div>
        )}
        {roles.map((r, i) => (
          <div key={i} className="role-row">
            <select
              className="role-col-icon"
              value={r.emoji}
              onChange={(e) => updateRole(i, { emoji: e.target.value })}
              disabled={busy}
              aria-label="Role icon"
            >
              <option value="">—</option>
              {ROLE_EMOJIS.map((em) => (
                <option key={em} value={em}>
                  {em}
                </option>
              ))}
            </select>
            <input
              className="role-col-name"
              value={r.name}
              maxLength={40}
              placeholder="e.g. Tank"
              onChange={(e) => updateRole(i, { name: e.target.value })}
              disabled={busy}
            />
            <select
              className="role-col-cap"
              value={r.capacity}
              onChange={(e) => updateRole(i, { capacity: e.target.value })}
              disabled={busy}
              aria-label="Max players"
            >
              <option value="">No limit</option>
              {CAP_OPTIONS.map((n) => (
                <option key={n} value={String(n)}>
                  {n}
                </option>
              ))}
            </select>
            <button
              className="mini danger role-col-rm"
              onClick={() => removeRole(i)}
              disabled={busy}
              title="Remove role"
            >
              <MorphIcon icon={X} size={13} aria-hidden />
            </button>
          </div>
        ))}
        <button className="mini" onClick={addRole} disabled={busy || roles.length >= 20}>
          + Add role
        </button>
      </div>

      <div className="news-editor-actions">
        <button className="primary" disabled={busy || !valid} onClick={submit}>
          {initial ? 'Save changes' : 'Create event'}
        </button>
        <button disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Banner-image upload for an event, mirroring the medal/game icon uploaders. */
function EventImageField({
  imageUrl,
  busy,
  onSet,
}: {
  imageUrl: string | null;
  busy: boolean;
  onSet: (url: string | null) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const { url } = await api.upload<{ url: string }>('/media/events', file);
      onSet(url);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="event-image-field">
      <div className="field-label">
        Banner image <span className="muted small">(optional)</span>
      </div>
      {imageUrl && <img className="event-banner preview" src={imageUrl} alt="" />}
      <div className="avatar-controls">
        <label className="upload-btn mini">
          {uploading ? 'Uploading…' : imageUrl ? 'Change' : 'Upload'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={(e) => void pickFile(e)}
            disabled={busy || uploading}
            hidden
          />
        </label>
        {imageUrl && (
          <button className="mini" disabled={busy || uploading} onClick={() => onSet(null)} title="Remove image">
            Remove
          </button>
        )}
        {uploadError && <span className="small warn">{uploadError}</span>}
      </div>
    </div>
  );
}
