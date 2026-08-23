/**
 * Games catalog administration — add, rename, toggle active, set an icon, or
 * delete the titles the clan plays. War records can be tied to a game.
 */

import { useEffect, useState, type ChangeEvent } from 'react';
import { MorphIcon } from 'morphicons/react';
import { Gamepad2, X } from 'lucide';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import Switch from '../components/Switch';

interface Game {
  id: number;
  name: string;
  slug: string;
  iconUrl: string | null;
  active: boolean;
  sortOrder: number;
  recordCount: number;
}

export default function Games() {
  const [games, setGames] = useState<Game[]>([]);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    const { games } = await api.get<{ games: Game[] }>('/games');
    setGames(games);
  }

  const { run, busy, error, notice, warning } = useAction(load);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const addGame = () =>
    run(async () => {
      if (!newName.trim()) return;
      await api.post('/games', { name: newName.trim() });
      setNewName('');
      return `Added “${newName.trim()}”.`;
    });

  const rename = (id: number, name: string) => run(() => api.patch(`/games/${id}`, { name }));
  const setActive = (id: number, active: boolean) => run(() => api.patch(`/games/${id}`, { active }));
  const setIcon = (id: number, iconUrl: string | null) => run(() => api.patch(`/games/${id}`, { iconUrl }));
  const remove = (id: number) => run(() => api.del(`/games/${id}`));

  if (loading) return <div className="loading">Loading games…</div>;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Games</h2>
        <p className="muted">
          {games.length} game{games.length === 1 ? '' : 's'}. Inactive games stay for history but
          drop off pickers.
        </p>
      </header>

      <Alerts error={error} warning={warning} notice={notice} />

      <div className="add-row">
        <input
          value={newName}
          placeholder="New game name"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addGame()}
          disabled={busy}
        />
        <button onClick={() => void addGame()} disabled={busy || !newName.trim()}>
          Add game
        </button>
      </div>

      {games.length === 0 ? (
        <p className="muted">No games yet. Add the titles your clan plays.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Icon</th>
              <th>Name</th>
              <th>Active</th>
              <th>War records</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {games.map((game) => (
              <tr key={game.id}>
                <td>
                  <GameIconCell game={game} busy={busy} onSet={(url) => setIcon(game.id, url)} />
                </td>
                <td>
                  <input
                    defaultValue={game.name}
                    onBlur={(e) => e.target.value !== game.name && void rename(game.id, e.target.value)}
                    disabled={busy}
                  />
                </td>
                <td>
                  <Switch
                    checked={game.active}
                    onChange={(v) => void setActive(game.id, v)}
                    disabled={busy}
                    label={`${game.name} active`}
                    stateText={game.active ? 'Active' : 'Inactive'}
                  />
                </td>
                <td>{game.recordCount}</td>
                <td>
                  <button
                    className="danger"
                    onClick={() => void remove(game.id)}
                    disabled={busy}
                    title="Delete this game (war records tied to it become clan-wide)"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** A game's icon, with upload/remove — mirrors the rank insignia cell. */
function GameIconCell({
  game,
  busy,
  onSet,
}: {
  game: Game;
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
      const { url } = await api.upload<{ url: string }>('/media/games', file);
      onSet(url);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="rank-image-cell">
      <span className="rank-thumb">
        {game.iconUrl ? (
          <img src={game.iconUrl} alt="" width={28} height={28} />
        ) : (
          <span className="rank-thumb-empty">
            <MorphIcon icon={Gamepad2} size={16} aria-hidden />
          </span>
        )}
      </span>
      <label className="upload-btn mini">
        {uploading ? '…' : game.iconUrl ? 'Change' : 'Upload'}
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={(e) => void pickFile(e)}
          disabled={busy || uploading}
          hidden
        />
      </label>
      {game.iconUrl && (
        <button className="mini" disabled={busy || uploading} onClick={() => onSet(null)} title="Remove icon">
          <MorphIcon icon={X} size={13} aria-hidden />
        </button>
      )}
    </div>
  );
}
