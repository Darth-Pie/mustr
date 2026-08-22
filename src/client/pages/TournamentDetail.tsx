/**
 * One tournament: its bracket, entrants, and (for organizers) the controls to
 * run it. Public tournaments render for logged-out visitors; private ones show
 * a sign-in prompt. A member may self-register into an individual tournament
 * while registration is open. Organizers (tournaments.manage) add/remove
 * entrants, generate or reset the bracket, and report results inline on the
 * bracket itself.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { memberAvatar } from '../../shared/avatar';
import { memberName } from '../../shared/names';
import { FORMAT_LABELS } from '../../shared/tournament';
import BracketView from '../components/BracketView';
import { STATUS_LABELS, type Entrant, type Match, type Tournament, type StandingRow } from '../lib/tournaments';

interface DetailResponse {
  tournament: Tournament;
  entrants: Entrant[];
  matches: Match[];
  canManage: boolean;
  standings: StandingRow[] | null;
}

interface MemberRow {
  id: number;
  username: string;
  globalName: string | null;
  displayName: string | null;
}

export default function TournamentDetail() {
  const { key } = useParams();
  const { viewer } = useSession();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!key) return;
    setLoading(true);
    api
      .get<DetailResponse>(`/tournaments/${key}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) =>
        setError(
          err instanceof ApiError && err.status === 401
            ? 'Sign in to view this tournament.'
            : err instanceof ApiError && err.status === 404
              ? 'That tournament doesn’t exist.'
              : 'Could not load the tournament.',
        ),
      )
      .finally(() => setLoading(false));
  }, [key]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <div className="loading">Loading…</div>;
  if (error) return <section className="panel"><p className="muted">{error}</p></section>;
  if (!data) return null;

  const { tournament: t, entrants, matches, canManage, standings } = data;
  const isGroup = t.format === 'round_robin' || t.format === 'swiss';
  const openForEntrants = t.status === 'draft' || t.status === 'registration' || t.status === 'seeding';
  const iAmEntered = !!viewer && entrants.some((e) => e.userId === viewer.id);
  const canSelfRegister =
    !!viewer && t.competitorType === 'individual' && t.status === 'registration' && !iAmEntered;
  const iAmOnATeam = !!viewer && entrants.some((e) => e.team.some((m) => m.userId === viewer.id));
  const canSelfCreateTeam =
    !!viewer && t.competitorType === 'team' && t.status === 'registration' && !iAmOnATeam;
  const iAmCaptainOf = (e: Entrant) => !!viewer && e.team.some((m) => m.userId === viewer.id && m.isCaptain);

  // Champion: for group formats, the top of the final standings; otherwise the
  // winner of the deciding match — the grand final (double-elim) or the
  // winners-bracket final (single-elim).
  const decider =
    matches.find((m) => m.bracket === 'grand_final') ??
    matches
      .filter((m) => m.bracket === 'winners' && m.slot === 0)
      .sort((a, b) => b.round - a.round)[0];
  const championId =
    t.status !== 'complete' ? null : isGroup ? (standings?.[0]?.entrantId ?? null) : (decider?.winnerId ?? null);
  const champion = championId != null ? entrants.find((e) => e.id === championId) : undefined;

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setNotice(null);
    setError(null);
    try {
      await fn();
      if (ok) setNotice(ok);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    }
  }

  const report = async (matchId: number, winnerId: number, score1: number, score2: number) => {
    await api.post(`/tournaments/${t.id}/matches/${matchId}/report`, { winnerId, score1, score2 });
    load();
  };

  return (
    <section className="panel tournament-detail">
      <header className="panel-head">
        <div>
          <div className="tournament-crumbs">
            <Link to="/tournaments" className="muted small">← All tournaments</Link>
          </div>
          <h2>{t.name}</h2>
          <p className="muted tournament-meta">
            <span className={`status-chip status-${t.status}`}>{STATUS_LABELS[t.status]}</span>
            <span>{FORMAT_LABELS[t.format]}</span>
            <span>·</span>
            <span>{t.competitorType === 'team' ? 'Teams' : 'Individuals'}</span>
            {t.bestOf > 1 && (<><span>·</span><span>Best of {t.bestOf}</span></>)}
            <span>·</span>
            <span>{entrants.length} entered{t.maxEntrants ? ` / ${t.maxEntrants}` : ''}</span>
          </p>
        </div>
        {canSelfRegister && (
          <button type="button" className="primary" onClick={() => void act(() => api.post(`/tournaments/${t.id}/register`), 'You’re entered!')}>
            Enter tournament
          </button>
        )}
        {viewer && iAmEntered && openForEntrants && t.competitorType === 'individual' && (
          <button type="button" className="ghost" onClick={() => void act(() => api.del(`/tournaments/${t.id}/register`), 'You’ve withdrawn.')}>
            Withdraw
          </button>
        )}
      </header>

      {canSelfCreateTeam && <TeamSelfCreate tournamentId={t.id} onAct={act} />}

      {t.imageUrl && <img className="tournament-banner" src={t.imageUrl} alt="" />}
      {t.description && <p className="tournament-desc">{t.description}</p>}

      {champion && (
        <div className="tournament-champion">
          <span className="champ-crown" aria-hidden>🏆</span>
          <div>
            <div className="champ-label">Champion</div>
            <div className="champ-name">{champion.name}</div>
          </div>
        </div>
      )}

      {notice && <div className="notice success">{notice}</div>}
      {error && <div className="notice error">{error}</div>}

      {canManage && <OrganizerPanel tournament={t} entrants={entrants} onAct={act} />}

      {standings && standings.length > 0 && (
        <>
          <h3 className="account-subhead">Standings</h3>
          <StandingsTable standings={standings} entrants={entrants} swiss={t.format === 'swiss'} />
        </>
      )}

      {(() => {
        const groupMatches = matches.filter((m) => m.bracket === 'group');
        const maxRound = groupMatches.length ? Math.max(...groupMatches.map((m) => m.round)) : 0;
        const roundDone = maxRound > 0 && groupMatches.filter((m) => m.round === maxRound).every((m) => m.status === 'complete' || m.status === 'bye');
        const canNext = canManage && t.format === 'swiss' && t.status === 'in_progress' && roundDone && maxRound < t.swissRounds;
        return canNext ? (
          <div className="organizer-actions">
            <button type="button" className="primary" onClick={() => void act(() => api.post(`/tournaments/${t.id}/next-round`), 'Next round paired.')}>
              Generate round {maxRound + 1} of {t.swissRounds}
            </button>
          </div>
        ) : null;
      })()}

      {matches.length > 0 && (
        <>
          <h3 className="account-subhead">{isGroup ? 'Rounds' : 'Bracket'}</h3>
          <BracketView matches={matches} entrants={entrants} canManage={canManage} bestOf={t.bestOf} onReport={report} />
        </>
      )}

      <h3 className="account-subhead">Entrants</h3>
      {entrants.length === 0 ? (
        <p className="muted">No entrants yet.</p>
      ) : (
        <ul className="entrant-list">
          {entrants.map((e) => (
            <EntrantRow
              key={e.id}
              entrant={e}
              tournamentId={t.id}
              isTeam={t.competitorType === 'team'}
              openForEntrants={openForEntrants}
              canManage={canManage}
              canEditTeam={canManage || iAmCaptainOf(e)}
              onAct={act}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Organizer controls — visible only to tournaments.manage.
 * ------------------------------------------------------------------ */

function OrganizerPanel({
  tournament: t,
  entrants,
  onAct,
}: {
  tournament: Tournament;
  entrants: Entrant[];
  onAct: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
}) {
  const openForEntrants = t.status === 'draft' || t.status === 'registration' || t.status === 'seeding';
  const generated = t.status === 'in_progress' || t.status === 'complete';

  return (
    <div className="organizer-panel">
      <div className="organizer-head">
        <strong>Organizer controls</strong>
        <span className="muted small">Seeding: {t.seedMethod === 'random' ? 'Random' : t.seedMethod === 'manual' ? 'Manual' : 'Sign-up order'}</span>
      </div>

      {openForEntrants && (
        <>
          <EntrantAdder tournament={t} entrants={entrants} onAct={onAct} />
          <div className="organizer-actions">
            <button
              type="button"
              className="primary"
              disabled={entrants.length < 2}
              onClick={() => void onAct(() => api.post(`/tournaments/${t.id}/generate`), 'Bracket generated.')}
            >
              Generate bracket ({entrants.length})
            </button>
            {entrants.length < 2 && <span className="muted small">Add at least two entrants.</span>}
          </div>
        </>
      )}

      {generated && (
        <div className="organizer-actions">
          <button
            type="button"
            className="ghost danger"
            onClick={() => {
              if (window.confirm('Reset the bracket? All match results are cleared and entrants can be edited again.')) {
                void onAct(() => api.post(`/tournaments/${t.id}/reset`), 'Bracket reset.');
              }
            }}
          >
            Reset bracket
          </button>
        </div>
      )}
    </div>
  );
}

function EntrantAdder({
  tournament: t,
  entrants,
  onAct,
}: {
  tournament: Tournament;
  entrants: Entrant[];
  onAct: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
}) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [filter, setFilter] = useState('');
  const [teamName, setTeamName] = useState('');
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    if (t.competitorType !== 'individual') return;
    api
      .get<{ members: MemberRow[] }>('/members?limit=100&sort=name&dir=asc')
      .then((d) => setMembers(d.members))
      .catch(() => setLoadErr('You need roster access to pick members. Enter teams by name instead, or ask a god to add entrants.'));
  }, [t.competitorType]);

  if (t.competitorType === 'team') {
    return (
      <div className="entrant-adder">
        <input
          type="text"
          placeholder="Team name"
          value={teamName}
          maxLength={80}
          onChange={(e) => setTeamName(e.target.value)}
        />
        <button
          type="button"
          className="primary"
          disabled={!teamName.trim()}
          onClick={() =>
            void onAct(async () => {
              await api.post(`/tournaments/${t.id}/entrants`, { name: teamName.trim() });
              setTeamName('');
            })
          }
        >
          Add team
        </button>
        <span className="muted small">Create the team, then open it below to add players.</span>
      </div>
    );
  }

  const entered = new Set(entrants.map((e) => e.userId).filter(Boolean));
  const matches = members
    .filter((m) => !entered.has(m.id))
    .filter((m) => {
      const name = memberName({ displayName: m.displayName, globalName: m.globalName, username: m.username });
      return !filter.trim() || name.toLowerCase().includes(filter.trim().toLowerCase());
    })
    .slice(0, 8);

  if (loadErr) return <p className="muted small">{loadErr}</p>;

  return (
    <div className="entrant-adder">
      <input
        type="text"
        placeholder="Add a member…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {filter.trim() && (
        <div className="entrant-suggest">
          {matches.length === 0 ? (
            <span className="muted small">No matching members.</span>
          ) : (
            matches.map((m) => {
              const name = memberName({ displayName: m.displayName, globalName: m.globalName, username: m.username });
              return (
                <button
                  key={m.id}
                  type="button"
                  className="ghost mini"
                  onClick={() =>
                    void onAct(async () => {
                      await api.post(`/tournaments/${t.id}/entrants`, { userId: m.id });
                      setFilter('');
                    })
                  }
                >
                  + {name}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Entrant rows — an individual, or a team with an (optionally editable)
 * roster. Team roster editing is allowed for an organizer or the team's own
 * captain, and only while the tournament is still open for entrants.
 * ------------------------------------------------------------------ */

function EntrantRow({
  entrant: e,
  tournamentId,
  isTeam,
  openForEntrants,
  canManage,
  canEditTeam,
  onAct,
}: {
  entrant: Entrant;
  tournamentId: number;
  isTeam: boolean;
  openForEntrants: boolean;
  canManage: boolean;
  canEditTeam: boolean;
  onAct: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  if (!isTeam) {
    return (
      <li className="entrant-row">
        {e.seed != null && <span className="entrant-seed">{e.seed}</span>}
        <img className="avatar" src={memberAvatar({ ...e, discordId: e.discordId ?? '' }, 48)} alt="" width={28} height={28} loading="lazy" />
        <span className="entrant-name">{e.name}</span>
        {e.originName && <span className="entrant-origin">via {e.originName}</span>}
        {canManage && openForEntrants && (
          <button type="button" className="mini danger entrant-remove" onClick={() => void onAct(() => api.del(`/tournaments/${tournamentId}/entrants/${e.id}`))}>
            Remove
          </button>
        )}
      </li>
    );
  }

  return (
    <li className="entrant-row team">
      <div className="entrant-row-main">
        {e.seed != null && <span className="entrant-seed">{e.seed}</span>}
        <button type="button" className="entrant-team-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="entrant-team-icon" aria-hidden>👥</span>
          <span className="entrant-name">{e.name}</span>
          {e.originName ? (
            <span className="entrant-origin">via {e.originName}</span>
          ) : (
            <span className="muted small">{e.team.length} player{e.team.length === 1 ? '' : 's'}</span>
          )}
        </button>
        {canManage && openForEntrants && (
          <button type="button" className="mini danger entrant-remove" onClick={() => void onAct(() => api.del(`/tournaments/${tournamentId}/entrants/${e.id}`))}>
            Remove
          </button>
        )}
      </div>
      {open && (
        canEditTeam && openForEntrants ? (
          <TeamRosterEditor entrant={e} tournamentId={tournamentId} onAct={onAct} />
        ) : (
          <div className="team-roster-view">
            {e.team.length === 0 ? (
              <span className="muted small">No players yet.</span>
            ) : (
              e.team.map((m) => (
                <span key={m.userId} className="team-member-chip">
                  {m.isCaptain && <span title="Captain" aria-label="Captain">★</span>} {m.name}
                </span>
              ))
            )}
          </div>
        )
      )}
    </li>
  );
}

function TeamRosterEditor({
  entrant: e,
  tournamentId,
  onAct,
}: {
  entrant: Entrant;
  tournamentId: number;
  onAct: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
}) {
  const [name, setName] = useState(e.name);
  const base = `/tournaments/${tournamentId}/entrants/${e.id}`;
  const memberIds = e.team.map((m) => m.userId);

  return (
    <div className="team-roster-editor">
      <div className="team-rename">
        <input type="text" value={name} maxLength={80} onChange={(ev) => setName(ev.target.value)} aria-label="Team name" />
        <button type="button" className="ghost mini" disabled={!name.trim() || name === e.name} onClick={() => void onAct(() => api.put(base, { name: name.trim() }))}>
          Rename
        </button>
      </div>

      <div className="team-members">
        {e.team.length === 0 ? (
          <span className="muted small">No players yet — add some below.</span>
        ) : (
          e.team.map((m) => (
            <div key={m.userId} className="team-member">
              <span className="team-member-name">{m.isCaptain && <span title="Captain">★</span>} {m.name}</span>
              {!m.isCaptain && (
                <button type="button" className="ghost mini" onClick={() => void onAct(() => api.post(`${base}/captain`, { userId: m.userId }))}>
                  Make captain
                </button>
              )}
              <button type="button" className="mini danger" onClick={() => void onAct(() => api.del(`${base}/members/${m.userId}`))}>
                Remove
              </button>
            </div>
          ))
        )}
      </div>

      <MemberSearchPicker
        excludeIds={memberIds}
        onPick={(userId) => void onAct(() => api.post(`${base}/members`, { userId }))}
        placeholder="Add a player…"
      />
    </div>
  );
}

function TeamSelfCreate({
  tournamentId,
  onAct,
}: {
  tournamentId: number;
  onAct: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  return (
    <div className="team-self-create">
      <strong>Enter a team</strong>
      <p className="muted small">Create your team and you’ll be its captain — then add your players.</p>
      <div className="entrant-adder">
        <input type="text" placeholder="Your team name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <button
          type="button"
          className="primary"
          disabled={!name.trim()}
          onClick={() => void onAct(() => api.post(`/tournaments/${tournamentId}/register`, { name: name.trim() }), 'Team created — you’re the captain.')}
        >
          Create team
        </button>
      </div>
    </div>
  );
}

interface SearchMember {
  id: number;
  name: string;
  avatar: string | null;
  profileImageUrl: string | null;
  discordId: string | null;
}

function MemberSearchPicker({
  excludeIds,
  onPick,
  placeholder,
}: {
  excludeIds: number[];
  onPick: (userId: number) => void;
  placeholder: string;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchMember[]>([]);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    let active = true;
    api
      .get<{ members: SearchMember[] }>(`/tournaments/members/search?q=${encodeURIComponent(q.trim())}`)
      .then((d) => {
        if (active) setResults(d.members.filter((m) => !excludeIds.includes(m.id)));
      })
      .catch(() => active && setResults([]));
    return () => {
      active = false;
    };
  }, [q, excludeIds]);

  return (
    <div className="entrant-adder member-search">
      <input type="text" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      {q.trim() && (
        <div className="entrant-suggest">
          {results.length === 0 ? (
            <span className="muted small">No matching members.</span>
          ) : (
            results.map((m) => (
              <button key={m.id} type="button" className="ghost mini" onClick={() => { onPick(m.id); setQ(''); }}>
                + {m.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Standings table for round-robin / Swiss. Ranked rows with wins, losses,
 * match points, and (for Swiss) the Buchholz tiebreak.
 * ------------------------------------------------------------------ */

function StandingsTable({
  standings,
  entrants,
  swiss,
}: {
  standings: StandingRow[];
  entrants: Entrant[];
  swiss: boolean;
}) {
  const nameOf = new Map(entrants.map((e) => [e.id, e.name]));
  return (
    <div className="standings-scroll">
      <table className="standings-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Competitor</th>
            <th title="Played">P</th>
            <th title="Wins">W</th>
            <th title="Losses">L</th>
            <th title="Match points">Pts</th>
            {swiss && <th title="Buchholz — opponents’ total points (tiebreak)">Buch</th>}
          </tr>
        </thead>
        <tbody>
          {standings.map((row) => (
            <tr key={row.entrantId} className={row.rank === 1 ? 'standings-leader' : undefined}>
              <td className="standings-rank">{row.rank}</td>
              <td>{nameOf.get(row.entrantId) ?? 'Unknown'}</td>
              <td>{row.played}</td>
              <td>{row.wins}</td>
              <td>{row.losses}</td>
              <td className="standings-points">{row.points}</td>
              {swiss && <td>{row.buchholz}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
