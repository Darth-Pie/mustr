/**
 * The tournaments index. Members see every tournament; logged-out visitors see
 * only the ones marked public (the API enforces that). Each card links to the
 * bracket. Organizers get a shortcut into the admin panel to create one.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MorphIcon } from 'morphicons/react';
import { Trophy } from 'lucide';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { FORMAT_LABELS } from '../../shared/tournament';
import { STATUS_LABELS, type TournamentSummary } from '../lib/tournaments';

export default function Tournaments() {
  const { can } = useSession();
  const [rows, setRows] = useState<TournamentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ tournaments: TournamentSummary[] }>('/tournaments')
      .then((d) => {
        setRows(d.tournaments);
        setError(null);
      })
      .catch((err) =>
        setError(err instanceof ApiError && err.status === 401 ? 'Sign in to see tournaments.' : 'Could not load tournaments.'),
      )
      .finally(() => setLoading(false));
  }, []);

  const active = rows.filter((t) => t.status !== 'complete');
  const past = rows.filter((t) => t.status === 'complete');

  return (
    <section className="panel">
      <header className="panel-head roster-head">
        <div>
          <h2>Tournaments</h2>
          <p className="muted">Brackets, standings, and champions.</p>
        </div>
        {can('tournaments.manage') && (
          <Link to="/admin/tournaments" className="button primary">New tournament</Link>
        )}
      </header>

      {loading ? (
        <div className="loading">Loading…</div>
      ) : error ? (
        <p className="muted">{error}</p>
      ) : rows.length === 0 ? (
        <p className="muted">No tournaments yet.</p>
      ) : (
        <>
          <div className="tournament-grid">
            {active.map((t) => (
              <TournamentCard key={t.id} t={t} />
            ))}
          </div>
          {past.length > 0 && (
            <>
              <h3 className="account-subhead">Past tournaments</h3>
              <div className="tournament-grid">
                {past.map((t) => (
                  <TournamentCard key={t.id} t={t} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function TournamentCard({ t }: { t: TournamentSummary }) {
  return (
    <Link to={`/tournaments/${t.slug}`} className="tournament-card">
      {t.imageUrl ? (
        <img className="tournament-card-img" src={t.imageUrl} alt="" loading="lazy" />
      ) : (
        <div className="tournament-card-img placeholder" aria-hidden>
          <MorphIcon icon={Trophy} size={40} aria-hidden />
        </div>
      )}
      <div className="tournament-card-body">
        <div className="tournament-card-title">{t.name}</div>
        <div className="tournament-card-meta">
          <span className={`status-chip status-${t.status}`}>{STATUS_LABELS[t.status]}</span>
          <span className="muted small">{FORMAT_LABELS[t.format]}</span>
        </div>
        <div className="muted small">
          {t.gameName ? `${t.gameName} · ` : ''}
          {t.entrantCount} {t.competitorType === 'team' ? 'teams' : 'entrants'}
        </div>
      </div>
    </Link>
  );
}
