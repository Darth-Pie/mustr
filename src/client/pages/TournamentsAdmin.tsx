/**
 * Tournaments admin: create a tournament and jump into any existing one to run
 * it (seeding, generation, and result reporting all live on the tournament's
 * own bracket page). Gated by tournaments.manage via the admin section tree.
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import Switch from '../components/Switch';
import {
  TOURNAMENT_FORMATS,
  FORMAT_LABELS,
  FORMAT_BLURBS,
  type TournamentFormat,
  type CompetitorType,
  type SeedMethod,
} from '../../shared/tournament';
import { STATUS_LABELS, type Tournament, type TournamentSummary } from '../lib/tournaments';

interface GameRow {
  id: number;
  name: string;
}

interface MedalRow {
  id: number;
  name: string;
}

export default function TournamentsAdmin() {
  const navigate = useNavigate();
  const { can } = useSession();
  const canAlliance = can('alliance.manage');
  const [list, setList] = useState<TournamentSummary[]>([]);
  const [games, setGames] = useState<GameRow[]>([]);
  const [medals, setMedals] = useState<MedalRow[]>([]);
  const [championMedalId, setChampionMedalId] = useState<string>('');
  const [savedMedal, setSavedMedal] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create form.
  const [name, setName] = useState('');
  const [format, setFormat] = useState<TournamentFormat>('single_elim');
  const [competitorType, setCompetitorType] = useState<CompetitorType>('individual');
  const [seedMethod, setSeedMethod] = useState<SeedMethod>('random');
  const [bestOf, setBestOf] = useState(1);
  const [thirdPlace, setThirdPlace] = useState(false);
  const [maxEntrants, setMaxEntrants] = useState('');
  const [gameId, setGameId] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [shareAlliance, setShareAlliance] = useState(false);
  const [description, setDescription] = useState('');

  const loadList = () =>
    api
      .get<{ tournaments: TournamentSummary[] }>('/tournaments')
      .then((d) => setList(d.tournaments))
      .catch(() => setList([]));

  useEffect(() => {
    void loadList();
    api.get<{ games: GameRow[] }>('/games').then((d) => setGames(d.games)).catch(() => setGames([]));
    api.get<{ medals: MedalRow[] }>('/medals').then((d) => setMedals(d.medals)).catch(() => setMedals([]));
    api
      .get<{ settings: { championMedalId: number | null } }>('/tournaments/settings/config')
      .then((d) => {
        const v = d.settings.championMedalId != null ? String(d.settings.championMedalId) : '';
        setChampionMedalId(v);
        setSavedMedal(v);
      })
      .catch(() => {});
  }, []);

  async function saveChampionMedal() {
    try {
      await api.put('/tournaments/settings/config', { championMedalId: championMedalId ? Number(championMedalId) : null });
      setSavedMedal(championMedalId);
    } catch {
      setError('Could not save the champion medal.');
    }
  }

  async function create() {
    if (!name.trim()) {
      setError('Give the tournament a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { tournament } = await api.post<{ tournament: Tournament }>('/tournaments', {
        name: name.trim(),
        format,
        competitorType,
        seedMethod,
        bestOf,
        thirdPlace,
        maxEntrants: maxEntrants ? Number(maxEntrants) : null,
        gameId: gameId ? Number(gameId) : null,
        isPublic,
        shareAlliance,
        description: description.trim(),
      });
      navigate(`/tournaments/${tournament.slug}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create the tournament.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-tool">
      <header className="admin-tool-head">
        <h3>Tournaments</h3>
        <p className="muted">Create a tournament, then open it to seed entrants, generate the bracket, and report results.</p>
      </header>

      {error && <div className="notice error">{error}</div>}

      <div className="tournament-create panel-sub">
        <h4>New tournament</h4>
        <div className="form-grid">
          <label className="field">
            <span>Name</span>
            <input type="text" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Summer Showdown" />
          </label>

          <label className="field">
            <span>Format</span>
            <select value={format} onChange={(e) => setFormat(e.target.value as TournamentFormat)}>
              {TOURNAMENT_FORMATS.map((f) => (
                <option key={f} value={f}>{FORMAT_LABELS[f]}</option>
              ))}
            </select>
            <span className="muted small">{FORMAT_BLURBS[format]}</span>
            {(format === 'round_robin' || format === 'swiss') && (
              <span className="muted small">Setup works now; automatic bracket generation for this format arrives in a later update.</span>
            )}
          </label>

          <label className="field">
            <span>Competitors</span>
            <select value={competitorType} onChange={(e) => setCompetitorType(e.target.value as CompetitorType)}>
              <option value="individual">Individual members</option>
              <option value="team">Teams</option>
            </select>
          </label>

          <label className="field">
            <span>Seeding</span>
            <select value={seedMethod} onChange={(e) => setSeedMethod(e.target.value as SeedMethod)}>
              <option value="random">Random</option>
              <option value="signup">Sign-up order</option>
              <option value="manual">Manual (by set seed)</option>
            </select>
          </label>

          <label className="field">
            <span>Match length</span>
            <select value={bestOf} onChange={(e) => setBestOf(Number(e.target.value))}>
              <option value={1}>Single game</option>
              <option value={3}>Best of 3</option>
              <option value={5}>Best of 5</option>
              <option value={7}>Best of 7</option>
            </select>
          </label>

          <label className="field">
            <span>Entrant cap (optional)</span>
            <input type="number" min={2} value={maxEntrants} onChange={(e) => setMaxEntrants(e.target.value)} placeholder="Unlimited" />
          </label>

          <label className="field">
            <span>Game (optional)</span>
            <select value={gameId} onChange={(e) => setGameId(e.target.value)}>
              <option value="">— None —</option>
              {games.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>

          <label className="field field-wide">
            <span>Description (optional)</span>
            <textarea value={description} maxLength={4000} rows={2} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>

        <div className="form-toggles">
          {format === 'single_elim' && (
            <div className="toggle-row">
              <span>Third-place match</span>
              <Switch checked={thirdPlace} onChange={setThirdPlace} label="Play a third-place match" />
            </div>
          )}
          <div className="toggle-row">
            <div>
              <span>Public bracket</span>
              <span className="muted small"> — visible to logged-out visitors</span>
            </div>
            <Switch checked={isPublic} onChange={setIsPublic} label="Public bracket" />
          </div>
          {canAlliance && (
            <div className="toggle-row">
              <div>
                <span>Share with alliance</span>
                <span className="muted small"> — allied orgs can field entrants and follow the results</span>
              </div>
              <Switch checked={shareAlliance} onChange={setShareAlliance} label="Share with alliance" />
            </div>
          )}
        </div>

        <button type="button" className="primary" disabled={busy} onClick={() => void create()}>
          {busy ? 'Creating…' : 'Create tournament'}
        </button>
      </div>

      <div className="panel-sub">
        <h4>Champion medal</h4>
        <p className="muted small">Automatically award this medal to the winner of every tournament (all members of a winning team get it). Optional.</p>
        <div className="champion-medal-row">
          <select value={championMedalId} onChange={(e) => setChampionMedalId(e.target.value)}>
            <option value="">— No medal —</option>
            {medals.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <button type="button" className="primary" disabled={championMedalId === savedMedal} onClick={() => void saveChampionMedal()}>
            {championMedalId === savedMedal ? 'Saved' : 'Save'}
          </button>
        </div>
      </div>

      <h4 className="account-subhead">All tournaments</h4>
      {list.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <table className="admin-table">
          <thead>
            <tr><th>Name</th><th>Format</th><th>Status</th><th>Entrants</th><th /></tr>
          </thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>{FORMAT_LABELS[t.format]}</td>
                <td><span className={`status-chip status-${t.status}`}>{STATUS_LABELS[t.status]}</span></td>
                <td>{t.entrantCount}</td>
                <td><Link to={`/tournaments/${t.slug}`} className="mini">Open →</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
