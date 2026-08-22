/**
 * Alliance admin — link this org to allied orgs' independent mustr instances so
 * broadcasts (events, announcements) fan out across everyone's Discord servers,
 * each posted by that org's OWN bot.
 *
 * Pairing is a two-way token exchange: adding an ally mints a token you send THEM
 * (so they can call you), and you paste the token THEY gave you (so you can call
 * them). No bot tokens are ever shared. See src/shared/alliance.ts.
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import Switch from '../components/Switch';
import { STATUS_LABELS } from '../lib/tournaments';
import { FORMAT_LABELS, type TournamentFormat, type CompetitorType, type TournamentStatus } from '../../shared/tournament';

interface LinkView {
  id: number;
  name: string;
  baseUrl: string;
  channelId: string | null;
  enabled: boolean;
  hasOutbound: boolean;
  inboundPrefix: string | null;
  lastInboundAt: number | null;
}
interface Channel {
  id: string;
  name: string;
}
interface InviteView {
  id: number;
  prefix: string;
  label: string | null;
  expiresAt: number;
  consumedAt: number | null;
  expired: boolean;
}

function when(ts: number | null): string {
  return ts ? new Date(ts * 1000).toLocaleString() : 'never';
}

function inviteState(i: InviteView): string {
  if (i.consumedAt) return 'used';
  if (i.expired) return 'expired';
  return `expires ${new Date(i.expiresAt * 1000).toLocaleDateString()}`;
}

export default function AllianceAdmin() {
  const { run, busy, error, notice } = useAction();
  const [links, setLinks] = useState<LinkView[] | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [theirToken, setTheirToken] = useState('');
  // A freshly minted token to hand an ally — shown once, then dismissed.
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  // One-step pairing: invites we've generated + the join box.
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [inviteLabel, setInviteLabel] = useState('');
  const [joinCode, setJoinCode] = useState('');
  // A freshly generated connect code to hand an ally — shown once.
  const [connectCode, setConnectCode] = useState<string | null>(null);

  const load = () =>
    api.get<{ links: LinkView[] }>('/alliance/links').then((r) => setLinks(r.links)).catch(() => setLinks([]));
  const loadInvites = () =>
    api.get<{ invites: InviteView[] }>('/alliance/invites').then((r) => setInvites(r.invites)).catch(() => setInvites([]));

  useEffect(() => {
    void load();
    void loadInvites();
    api.get<{ channels: Channel[] }>('/settings/discord-channels').then((r) => setChannels(r.channels ?? [])).catch(() => {});
  }, []);

  const addAlly = () =>
    run(async () => {
      const r = await api.post<{ link: LinkView; inboundToken: string }>('/alliance/links', {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        outboundToken: theirToken.trim() || undefined,
      });
      setFresh({ name: r.link.name, token: r.inboundToken });
      setName('');
      setBaseUrl('');
      setTheirToken('');
      await load();
      return `Linked “${r.link.name}”. Copy the token below and send it to them.`;
    });

  const patch = (id: number, body: Record<string, unknown>) =>
    run(async () => {
      await api.patch(`/alliance/links/${id}`, body);
      await load();
      return '';
    });

  const remove = (l: LinkView) =>
    run(async () => {
      if (!window.confirm(`Remove the link to “${l.name}”? Broadcasts to and from them stop immediately.`)) return '';
      await api.del(`/alliance/links/${l.id}`);
      await load();
      return 'Link removed.';
    });

  const rotate = (l: LinkView) =>
    run(async () => {
      const r = await api.post<{ inboundToken: string }>(`/alliance/links/${l.id}/rotate`);
      setFresh({ name: l.name, token: r.inboundToken });
      return 'New token minted. Send it to them; the old one no longer works.';
    });

  const genInvite = () =>
    run(async () => {
      const r = await api.post<{ connectString: string }>('/alliance/invites', { label: inviteLabel.trim() || undefined });
      setConnectCode(r.connectString);
      setInviteLabel('');
      await loadInvites();
      return 'Invite created. Copy the connect code below and send it to your ally.';
    });

  const revokeInvite = (id: number) =>
    run(async () => {
      await api.del(`/alliance/invites/${id}`);
      await loadInvites();
      return 'Invite revoked.';
    });

  const joinByCode = () =>
    run(async () => {
      const r = await api.post<{ link: LinkView | null }>('/alliance/join', { code: joinCode.trim() });
      setJoinCode('');
      await load();
      return r.link ? `Connected to “${r.link.name}”. Pick a channel for their broadcasts below.` : 'Connected.';
    });

  const sendTest = () =>
    run(async () => {
      await api.post('/alliance/test');
      return 'Test broadcast sent to every enabled ally. Check their Discord channels.';
    });

  const enabledCount = (links ?? []).filter((l) => l.enabled).length;

  return (
    <section className="panel account-settings">
      <header className="panel-head">
        <div>
          <h2>Alliance</h2>
          <p className="muted">
            Link allied orgs so events and announcements fan out across everyone’s Discord — each posted by
            that org’s own bot. You stay independent; no bot tokens are ever shared.
          </p>
        </div>
        <button type="button" className="primary" disabled={busy || enabledCount === 0} onClick={() => void sendTest()} title={enabledCount === 0 ? 'Add and enable an ally first' : 'Send a test broadcast to every enabled ally'}>
          Send test broadcast
        </button>
      </header>

      <Alerts error={error} notice={notice} />

      {fresh && (
        <div className="token-reveal">
          <strong>Send this token to {fresh.name}. It’s shown only once.</strong>
          <p className="muted small">They paste it into their own Alliance panel (as the token to call <em>you</em>).</p>
          <div className="token-reveal-row">
            <code className="token-value">{fresh.token}</code>
            <button type="button" className="primary" onClick={() => void navigator.clipboard?.writeText(fresh.token)}>
              Copy
            </button>
          </div>
          <button type="button" className="ghost" onClick={() => setFresh(null)}>
            Done
          </button>
        </div>
      )}

      {connectCode && (
        <div className="token-reveal">
          <strong>Send this connect code to your ally. It’s shown only once.</strong>
          <p className="muted small">
            They paste it into their own Alliance panel under “Join an alliance”. Both sites link automatically — no tokens
            to swap back and forth. The code is single-use and expires in 7 days.
          </p>
          <div className="token-reveal-row">
            <code className="token-value">{connectCode}</code>
            <button type="button" className="primary" onClick={() => void navigator.clipboard?.writeText(connectCode)}>
              Copy
            </button>
          </div>
          <button type="button" className="ghost" onClick={() => setConnectCode(null)}>
            Done
          </button>
        </div>
      )}

      <h3 className="account-subhead">Invite an ally</h3>
      <p className="muted">
        Generate a connect code and send it to the other org. When they paste it into their Alliance panel, both sites
        pair up automatically.
      </p>
      <div className="alliance-add">
        <input type="text" placeholder="Label (optional, e.g. Red Talon)" value={inviteLabel} maxLength={80} disabled={busy} onChange={(e) => setInviteLabel(e.target.value)} />
        <button type="button" className="primary" disabled={busy} onClick={() => void genInvite()}>
          Generate invite
        </button>
      </div>
      {invites.length > 0 && (
        <ul className="alliance-invites">
          {invites.map((i) => (
            <li key={i.id}>
              <code>{i.prefix}…</code>
              {i.label && <span> · {i.label}</span>}
              <span className="muted small"> · {inviteState(i)}</span>
              {!i.consumedAt && (
                <button type="button" className="mini danger" disabled={busy} onClick={() => void revokeInvite(i.id)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="account-subhead">Join an alliance</h3>
      <p className="muted">Paste a connect code an ally sent you.</p>
      <div className="alliance-add">
        <input type="text" placeholder="Paste connect code" value={joinCode} maxLength={800} disabled={busy} onChange={(e) => setJoinCode(e.target.value)} />
        <button type="button" className="primary" disabled={busy || !joinCode.trim()} onClick={() => void joinByCode()}>
          Connect
        </button>
      </div>

      <details className="alliance-advanced">
        <summary className="muted small">Add manually (advanced)</summary>
        <p className="muted">
          Enter their org name and the base URL of their mustr site (e.g. <code>https://allies.example</code>).
          You’ll get a token to send them; paste the token they give you into “their token”. Use this only if the
          connect-code flow above isn’t an option.
        </p>
        <div className="alliance-add">
          <input type="text" placeholder="Org name (e.g. Red Talon)" value={name} maxLength={80} disabled={busy} onChange={(e) => setName(e.target.value)} />
          <input type="url" placeholder="https://their-mustr-site" value={baseUrl} maxLength={200} disabled={busy} onChange={(e) => setBaseUrl(e.target.value)} />
          <input type="text" placeholder="Their token (optional, paste later)" value={theirToken} maxLength={200} disabled={busy} onChange={(e) => setTheirToken(e.target.value)} />
          <button type="button" className="primary" disabled={busy || !name.trim() || !baseUrl.trim()} onClick={() => void addAlly()}>
            Add ally
          </button>
        </div>
      </details>

      <h3 className="account-subhead">Linked orgs</h3>
      {links === null ? (
        <p className="muted">Loading…</p>
      ) : links.length === 0 ? (
        <p className="muted">No allies linked yet.</p>
      ) : (
        <ul className="alliance-list">
          {links.map((l) => (
            <li key={l.id} className="alliance-row">
              <div className="alliance-row-head">
                <div>
                  <b>{l.name}</b>
                  <span className="muted small"> · {l.baseUrl}</span>
                </div>
                <Switch checked={l.enabled} onChange={(v) => void patch(l.id, { enabled: v })} label={`Enable ${l.name}`} />
              </div>
              <div className="alliance-row-controls">
                <label className="inline-field">
                  <span className="muted small">Post their broadcasts to</span>
                  <select value={l.channelId ?? ''} disabled={busy} onChange={(e) => void patch(l.id, { channelId: e.target.value || null })}>
                    <option value="">— pick a channel —</option>
                    {channels.map((c) => (
                      <option key={c.id} value={c.id}>#{c.name}</option>
                    ))}
                  </select>
                </label>
                <span className={`alliance-flag${l.hasOutbound ? ' ok' : ''}`}>{l.hasOutbound ? '↔ two-way' : '→ inbound only (add their token)'}</span>
                <span className="muted small">last received: {when(l.lastInboundAt)}</span>
                <div className="alliance-row-actions">
                  <button type="button" className="ghost mini" disabled={busy} onClick={() => void rotate(l)} title="Mint a new token for them (invalidates the old)">
                    New token
                  </button>
                  <button type="button" className="mini danger" disabled={busy} onClick={() => void remove(l)}>
                    Remove
                  </button>
                </div>
              </div>
              {!l.channelId && (
                <p className="muted small">Pick a channel so their broadcasts have somewhere to land.</p>
              )}
              {l.hasOutbound === false && (
                <details className="alliance-settoken">
                  <summary className="muted small">Paste their token</summary>
                  <SetToken id={l.id} onSet={(t) => patch(l.id, { outboundToken: t })} busy={busy} />
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      <SharedTournaments />
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Shared tournaments — the SUBSCRIBER view: tournaments allied orgs are hosting
 * that we can field entrants into and follow the results of.
 * ------------------------------------------------------------------ */

interface MirrorEntry {
  id: number;
  name: string;
  status: 'submitted' | 'accepted' | 'rejected' | 'withdrawn';
}
interface Mirror {
  id: number;
  host: string;
  name: string;
  format: TournamentFormat;
  competitorType: CompetitorType;
  status: TournamentStatus;
  url: string | null;
  registrationOpen: boolean;
  standings: { name: string; wins: number; losses: number; rank: number }[] | null;
  champion: string | null;
  closed: boolean;
  entries: MirrorEntry[];
}

function SharedTournaments() {
  const { run, busy, error, notice } = useAction();
  const [mirrors, setMirrors] = useState<Mirror[] | null>(null);

  const load = () =>
    api
      .get<{ tournaments: Mirror[] }>('/alliance/tournament/mirrors')
      .then((r) => setMirrors(r.tournaments))
      .catch(() => setMirrors([]));

  useEffect(() => {
    void load();
  }, []);

  const submit = (m: Mirror, name: string) =>
    run(async () => {
      await api.post(`/alliance/tournament/mirrors/${m.id}/entries`, { name });
      await load();
      return `Entered “${name}” in ${m.name}.`;
    });

  const withdraw = (m: Mirror, entry: MirrorEntry) =>
    run(async () => {
      await api.del(`/alliance/tournament/mirrors/${m.id}/entries/${entry.id}`);
      await load();
      return `Withdrew “${entry.name}”.`;
    });

  const active = (mirrors ?? []).filter((m) => !m.closed);

  return (
    <>
      <h3 className="account-subhead">Shared tournaments</h3>
      <p className="muted">
        Tournaments allied orgs are hosting. Field your own entrants and follow the standings — the host runs the bracket.
      </p>
      <Alerts error={error} notice={notice} />

      {mirrors === null ? (
        <p className="muted">Loading…</p>
      ) : active.length === 0 ? (
        <p className="muted">No allied tournaments right now. When an ally shares one, it shows up here.</p>
      ) : (
        <ul className="alliance-tourneys">
          {active.map((m) => (
            <MirrorCard key={m.id} m={m} busy={busy} onSubmit={submit} onWithdraw={withdraw} />
          ))}
        </ul>
      )}
    </>
  );
}

function MirrorCard({
  m,
  busy,
  onSubmit,
  onWithdraw,
}: {
  m: Mirror;
  busy: boolean;
  onSubmit: (m: Mirror, name: string) => void;
  onWithdraw: (m: Mirror, e: MirrorEntry) => void;
}) {
  const [name, setName] = useState('');
  const live = m.entries.filter((e) => e.status !== 'withdrawn');

  return (
    <li className="alliance-tourney">
      <div className="alliance-tourney-head">
        <div>
          <b>{m.name}</b>
          <span className="muted small"> · hosted by {m.host}</span>
        </div>
        <span className={`status-chip status-${m.status}`}>{STATUS_LABELS[m.status]}</span>
      </div>
      <div className="muted small">
        {FORMAT_LABELS[m.format]} · {m.competitorType === 'team' ? 'Teams' : 'Individuals'}
        {m.url && (
          <>
            {' · '}
            <a className="ext-link" href={m.url} target="_blank" rel="noopener noreferrer">View bracket</a>
          </>
        )}
      </div>

      {m.registrationOpen ? (
        <div className="alliance-tourney-enter">
          <input
            type="text"
            placeholder={m.competitorType === 'team' ? 'Team name' : 'Player name'}
            value={name}
            maxLength={80}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="button"
            className="primary mini"
            disabled={busy || !name.trim()}
            onClick={() => {
              onSubmit(m, name.trim());
              setName('');
            }}
          >
            Enter
          </button>
        </div>
      ) : (
        <p className="muted small">Registration is closed.</p>
      )}

      {live.length > 0 && (
        <ul className="alliance-tourney-entries">
          {live.map((e) => (
            <li key={e.id}>
              <span>{e.name}</span>
              <span className="muted small"> · {e.status}</span>
              {m.registrationOpen && (
                <button type="button" className="mini danger" disabled={busy} onClick={() => onWithdraw(m, e)}>
                  Withdraw
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {m.champion && <p className="alliance-tourney-champ">🏆 Champion: <b>{m.champion}</b></p>}

      {m.standings && m.standings.length > 0 && (
        <table className="alliance-standings">
          <thead>
            <tr><th>#</th><th>Entrant</th><th>W</th><th>L</th></tr>
          </thead>
          <tbody>
            {m.standings.slice(0, 8).map((row, i) => (
              <tr key={i}>
                <td>{row.rank}</td>
                <td>{row.name}</td>
                <td>{row.wins}</td>
                <td>{row.losses}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </li>
  );
}

/** Small inline form to set/replace the token an ally issued us. */
function SetToken({ id, onSet, busy }: { id: number; onSet: (t: string) => void; busy: boolean }) {
  const [v, setV] = useState('');
  return (
    <div className="alliance-settoken-row">
      <input type="text" placeholder="Token they sent you" value={v} maxLength={200} disabled={busy} onChange={(e) => setV(e.target.value)} data-link={id} />
      <button type="button" className="primary mini" disabled={busy || !v.trim()} onClick={() => onSet(v.trim())}>
        Save
      </button>
    </div>
  );
}
