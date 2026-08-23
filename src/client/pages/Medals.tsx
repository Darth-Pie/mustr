/**
 * Medal administration — the catalog of medal definitions.
 *
 * A medal is a name, an optional image, and an optional tenure rule: set
 * "auto-award after N months" and the server hands it out automatically once a
 * member has been in the guild that long (see server/medals/tenure.ts). Handing
 * a medal to a specific member happens on that member's page, not here.
 */

import { useEffect, useState } from 'react';
import { MorphIcon } from 'morphicons/react';
import { Medal as MedalIcon } from 'lucide';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import NumberField from '../components/NumberField';

interface Medal {
  id: number;
  name: string;
  description: string | null;
  imageUrl: string | null;
  gameId: number | null;
  autoGrantMonths: number | null;
  autoGrantAttendance: number | null;
  sortOrder: number;
  awardCount: number;
}

// Common tenure milestones, offered as quick picks. Any positive number works.
const TENURE_PRESETS: [label: string, months: number][] = [
  ['6 months', 6],
  ['1 year', 12],
  ['2 years', 24],
  ['3 years', 36],
  ['5 years', 60],
];

// Common attendance milestones for activity medals.
const ATTENDANCE_PRESETS: [label: string, events: number][] = [
  ['10 events', 10],
  ['25 events', 25],
  ['50 events', 50],
  ['100 events', 100],
];

export default function Medals() {
  const [medals, setMedals] = useState<Medal[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    const { medals } = await api.get<{ medals: Medal[] }>('/medals');
    setMedals(medals);
  }

  const { run, busy, error, notice, warning } = useAction(load);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const addMedal = () =>
    run(async () => {
      if (!newName.trim()) return;
      const { medal } = await api.post<{ medal: Medal }>('/medals', { name: newName.trim() });
      setNewName('');
      setSelectedId(medal.id);
      return `Created “${medal.name}”.`;
    });

  const selected = medals.find((m) => m.id === selectedId) ?? null;

  if (loading) return <div className="loading">Loading medals…</div>;

  return (
    <section className="panel medals-page">
      <header className="panel-head">
        <h2>Medals</h2>
        <p className="muted">
          {medals.length} medal{medals.length === 1 ? '' : 's'}. Give a member a medal from their
          profile; tenure medals are awarded automatically.
        </p>
      </header>

      <Alerts error={error} warning={warning} notice={notice} />

      <div className="add-row">
        <input
          value={newName}
          placeholder="New medal name"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addMedal()}
          disabled={busy}
        />
        <button onClick={() => void addMedal()} disabled={busy || !newName.trim()}>
          Add medal
        </button>
      </div>

      <div className="roles-layout">
        <ul className="medal-list">
          {medals.map((medal) => (
            <li key={medal.id}>
              <button
                className={medal.id === selectedId ? 'medal-chip active' : 'medal-chip'}
                onClick={() => setSelectedId(medal.id)}
              >
                <span className="medal-thumb">
                  {medal.imageUrl ? (
                    <img src={medal.imageUrl} alt="" width={28} height={28} />
                  ) : (
                    <span className="medal-thumb-empty">
                      <MorphIcon icon={MedalIcon} size={16} aria-hidden />
                    </span>
                  )}
                </span>
                <span className="medal-name">{medal.name}</span>
                {medal.autoGrantMonths != null && <span className="tag">tenure</span>}
                {medal.autoGrantAttendance != null && <span className="tag">activity</span>}
                <span className="count">{medal.awardCount}</span>
              </button>
            </li>
          ))}
        </ul>

        {selected ? (
          <MedalEditor
            key={selected.id}
            medal={selected}
            busy={busy}
            onSave={(patch) =>
              run(async () => {
                await api.patch(`/medals/${selected.id}`, patch);
                return 'Saved.';
              })
            }
            onUpload={async (file) => {
              const { url } = await api.upload<{ url: string }>('/media/medals', file);
              return url;
            }}
            onDelete={() =>
              run(async () => {
                await api.del(`/medals/${selected.id}`);
                setSelectedId(null);
                return 'Medal deleted.';
              })
            }
          />
        ) : (
          <div className="role-editor empty-editor">Select a medal to edit it.</div>
        )}
      </div>
    </section>
  );
}

function MedalEditor({
  medal,
  busy,
  onSave,
  onUpload,
  onDelete,
}: {
  medal: Medal;
  busy: boolean;
  onSave: (patch: Partial<Medal>) => void;
  onUpload: (file: File) => Promise<string>;
  onDelete: () => void;
}) {
  const [name, setName] = useState(medal.name);
  const [description, setDescription] = useState(medal.description ?? '');
  const [imageUrl, setImageUrl] = useState(medal.imageUrl);
  const [months, setMonths] = useState<string>(
    medal.autoGrantMonths != null ? String(medal.autoGrantMonths) : '',
  );
  const [events, setEvents] = useState<string>(
    medal.autoGrantAttendance != null ? String(medal.autoGrantAttendance) : '',
  );
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const parsedMonths = months.trim() === '' ? null : Number(months);
  const monthsValid =
    parsedMonths === null || (Number.isInteger(parsedMonths) && parsedMonths > 0);
  const parsedEvents = events.trim() === '' ? null : Number(events);
  const eventsValid =
    parsedEvents === null || (Number.isInteger(parsedEvents) && parsedEvents > 0);

  const dirty =
    name !== medal.name ||
    description !== (medal.description ?? '') ||
    imageUrl !== medal.imageUrl ||
    parsedMonths !== medal.autoGrantMonths ||
    parsedEvents !== medal.autoGrantAttendance;

  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const url = await onUpload(file);
      setImageUrl(url);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="role-editor medal-editor">
      <div className="medal-editor-head">
        <span className="medal-thumb large">
          {imageUrl ? (
            <img src={imageUrl} alt="" width={64} height={64} />
          ) : (
            <span className="medal-thumb-empty">
              <MorphIcon icon={MedalIcon} size={32} aria-hidden />
            </span>
          )}
        </span>
        <div className="medal-image-controls">
          <label className="upload-btn">
            {uploading ? 'Uploading…' : imageUrl ? 'Replace image' : 'Upload image'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={(e) => void pickFile(e)}
              disabled={busy || uploading}
              hidden
            />
          </label>
          {imageUrl && (
            <button className="mini" disabled={busy || uploading} onClick={() => setImageUrl(null)}>
              Remove image
            </button>
          )}
          <span className="muted small">PNG, JPEG, GIF, or WebP — up to 1 MB.</span>
          {uploadError && <span className="small warn">{uploadError}</span>}
        </div>
      </div>

      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
      </label>

      <label>
        Description
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this medal is for"
          disabled={busy}
        />
      </label>

      <fieldset className="tenure">
        <legend>Auto-award by time in guild</legend>
        <div className="tenure-row">
          <NumberField
            min={1}
            step={1}
            value={months}
            placeholder="e.g. 12"
            ariaLabel="Months in guild"
            onChange={setMonths}
            disabled={busy}
          />
          <span className="muted small">
            months in the guild. Leave blank to award this medal by hand only.
          </span>
        </div>
        <div className="tenure-presets">
          {TENURE_PRESETS.map(([label, m]) => (
            <button
              key={m}
              type="button"
              className={parsedMonths === m ? 'preset active' : 'preset'}
              disabled={busy}
              onClick={() => setMonths(String(m))}
            >
              {label}
            </button>
          ))}
          {parsedMonths !== null && (
            <button type="button" className="preset" disabled={busy} onClick={() => setMonths('')}>
              Clear
            </button>
          )}
        </div>
        {!monthsValid && <p className="small warn">Enter a positive whole number of months.</p>}
      </fieldset>

      <fieldset className="tenure">
        <legend>Auto-award by events attended</legend>
        <div className="tenure-row">
          <NumberField
            min={1}
            step={1}
            value={events}
            placeholder="e.g. 50"
            ariaLabel="Events attended"
            onChange={setEvents}
            disabled={busy}
          />
          <span className="muted small">
            events attended. Turns this into an activity medal — leave blank for none.
          </span>
        </div>
        <div className="tenure-presets">
          {ATTENDANCE_PRESETS.map(([label, n]) => (
            <button
              key={n}
              type="button"
              className={parsedEvents === n ? 'preset active' : 'preset'}
              disabled={busy}
              onClick={() => setEvents(String(n))}
            >
              {label}
            </button>
          ))}
          {parsedEvents !== null && (
            <button type="button" className="preset" disabled={busy} onClick={() => setEvents('')}>
              Clear
            </button>
          )}
        </div>
        {!eventsValid && <p className="small warn">Enter a positive whole number of events.</p>}
      </fieldset>

      <button
        className="primary"
        disabled={busy || uploading || !dirty || !monthsValid || !eventsValid || !name.trim()}
        onClick={() =>
          onSave({
            name: name.trim(),
            description,
            imageUrl,
            autoGrantMonths: parsedMonths,
            autoGrantAttendance: parsedEvents,
          })
        }
      >
        Save
      </button>

      <div className="editor-footer">
        <button className="danger" disabled={busy} onClick={onDelete} title="Delete this medal">
          Delete medal
        </button>
        {medal.awardCount > 0 && (
          <span className="muted small">
            Held by {medal.awardCount} member{medal.awardCount === 1 ? '' : 's'}
            {medal.autoGrantMonths != null && ' — deleting removes it from all of them'}
          </span>
        )}
      </div>
    </div>
  );
}
