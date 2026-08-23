/**
 * War-record administration — the catalog of awardable "items of pride".
 *
 * A war record is a name, an optional image/description, and an optional game
 * it belongs to. Handing one to a specific member happens on that member's
 * page, not here. Structurally a sibling of the medals catalog, so it reuses
 * the medal styling.
 */

import { useEffect, useState, type ChangeEvent } from 'react';
import { MorphIcon } from 'morphicons/react';
import { Trophy } from 'lucide';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';

interface WarRecord {
  id: number;
  name: string;
  description: string | null;
  imageUrl: string | null;
  gameId: number | null;
  gameName: string | null;
  sortOrder: number;
  awardCount: number;
}

interface GameOption {
  id: number;
  name: string;
}

export default function WarRecords() {
  const [records, setRecords] = useState<WarRecord[]>([]);
  const [games, setGames] = useState<GameOption[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    const { warRecords } = await api.get<{ warRecords: WarRecord[] }>('/warrecords');
    setRecords(warRecords);
  }

  const { run, busy, error, notice, warning } = useAction(load);

  useEffect(() => {
    Promise.all([
      load(),
      api.get<{ games: GameOption[] }>('/games').then(({ games }) => setGames(games)).catch(() => setGames([])),
    ]).finally(() => setLoading(false));
  }, []);

  const addRecord = () =>
    run(async () => {
      if (!newName.trim()) return;
      const { warRecord } = await api.post<{ warRecord: WarRecord }>('/warrecords', { name: newName.trim() });
      setNewName('');
      setSelectedId(warRecord.id);
      return `Created “${warRecord.name}”.`;
    });

  const selected = records.find((r) => r.id === selectedId) ?? null;

  if (loading) return <div className="loading">Loading war records…</div>;

  return (
    <section className="panel medals-page">
      <header className="panel-head">
        <h2>War Records</h2>
        <p className="muted">
          {records.length} record{records.length === 1 ? '' : 's'}. Award them to members from their
          profile.
        </p>
      </header>

      <Alerts error={error} warning={warning} notice={notice} />

      <div className="add-row">
        <input
          value={newName}
          placeholder="New war record name"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addRecord()}
          disabled={busy}
        />
        <button onClick={() => void addRecord()} disabled={busy || !newName.trim()}>
          Add war record
        </button>
      </div>

      <div className="roles-layout">
        <ul className="medal-list">
          {records.map((rec) => (
            <li key={rec.id}>
              <button
                className={rec.id === selectedId ? 'medal-chip active' : 'medal-chip'}
                onClick={() => setSelectedId(rec.id)}
              >
                <span className="medal-thumb">
                  {rec.imageUrl ? (
                    <img src={rec.imageUrl} alt="" width={28} height={28} />
                  ) : (
                    <span className="medal-thumb-empty">
                      <MorphIcon icon={Trophy} size={16} aria-hidden />
                    </span>
                  )}
                </span>
                <span className="medal-name">{rec.name}</span>
                {rec.gameName && <span className="tag">{rec.gameName}</span>}
                <span className="count">{rec.awardCount}</span>
              </button>
            </li>
          ))}
          {records.length === 0 && <li className="muted small">No war records yet.</li>}
        </ul>

        {selected ? (
          <RecordEditor
            key={selected.id}
            record={selected}
            games={games}
            busy={busy}
            onSave={(patch) =>
              run(async () => {
                await api.patch(`/warrecords/${selected.id}`, patch);
                return 'Saved.';
              })
            }
            onUpload={async (file) => {
              const { url } = await api.upload<{ url: string }>('/media/warrecords', file);
              return url;
            }}
            onDelete={() =>
              run(async () => {
                await api.del(`/warrecords/${selected.id}`);
                setSelectedId(null);
                return 'War record deleted.';
              })
            }
          />
        ) : (
          <div className="role-editor empty-editor">Select a war record to edit it.</div>
        )}
      </div>
    </section>
  );
}

function RecordEditor({
  record,
  games,
  busy,
  onSave,
  onUpload,
  onDelete,
}: {
  record: WarRecord;
  games: GameOption[];
  busy: boolean;
  onSave: (patch: { name: string; description: string; imageUrl: string | null; gameId: number | null }) => void;
  onUpload: (file: File) => Promise<string>;
  onDelete: () => void;
}) {
  const [name, setName] = useState(record.name);
  const [description, setDescription] = useState(record.description ?? '');
  const [imageUrl, setImageUrl] = useState(record.imageUrl);
  const [gameId, setGameId] = useState<number | null>(record.gameId);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const dirty =
    name !== record.name ||
    description !== (record.description ?? '') ||
    imageUrl !== record.imageUrl ||
    gameId !== record.gameId;

  async function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
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
              <MorphIcon icon={Trophy} size={32} aria-hidden />
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
          placeholder="What this war record is for"
          disabled={busy}
        />
      </label>

      <label>
        Game
        <select
          value={gameId ?? ''}
          onChange={(e) => setGameId(e.target.value ? Number(e.target.value) : null)}
          disabled={busy}
        >
          <option value="">— Clan-wide (no game) —</option>
          {games.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>

      <button
        className="primary"
        disabled={busy || uploading || !dirty || !name.trim()}
        onClick={() => onSave({ name: name.trim(), description, imageUrl, gameId })}
      >
        Save
      </button>

      <div className="editor-footer">
        <button className="danger" disabled={busy} onClick={onDelete} title="Delete this war record">
          Delete war record
        </button>
        {record.awardCount > 0 && (
          <span className="muted small">
            Held by {record.awardCount} member{record.awardCount === 1 ? '' : 's'} — deleting removes it
            from all of them
          </span>
        )}
      </div>
    </div>
  );
}
