/**
 * Personal account settings. Today this is "API access": a member mints and
 * revokes personal access tokens for the mobile/native app (or scripts). The
 * raw token is shown exactly once, right after it's created — after that only
 * its label and short prefix are ever visible.
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import Switch from '../components/Switch';
import {
  loadA11yPrefs,
  saveA11yPrefs,
  FONT_MIN,
  FONT_MAX,
  FONT_STEP,
  FONT_DEFAULT,
  type A11yPrefs,
} from '../lib/a11y';
import { SKINS } from '../lib/skins';
import { loadSkinPref, saveSkinPref, reapplySkin } from '../lib/skinPref';

interface ApiToken {
  id: number;
  label: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

interface CreatedToken extends ApiToken {
  token: string;
}

function when(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Personal access tokens were groundwork for a mobile app that isn't built yet,
// and nothing consumes them today. Parked as a future feature: the backend
// (routes, revoke, docs) stays intact; flip this to re-expose the panel.
const SHOW_API_TOKENS = false;

export default function AccountSettings() {
  const { viewer } = useSession();
  // Personal accessibility prefs (per-device). Changes apply + persist instantly.
  const [a11y, setA11y] = useState<A11yPrefs>(() => loadA11yPrefs());
  const setFontScale = (n: number) => setA11y((p) => saveA11yPrefs({ ...p, fontScale: n }));
  const setHighContrast = (v: boolean) => setA11y((p) => saveA11yPrefs({ ...p, highContrast: v }));
  // Personal skin override (null = follow the org default). Applies instantly.
  const [skinPref, setSkinPref] = useState<string | null>(() => loadSkinPref());
  const chooseSkin = (skin: string | null) => {
    saveSkinPref(skin);
    setSkinPref(skin);
    reapplySkin();
  };
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The one-time full token value, shown until the member dismisses it.
  const [fresh, setFresh] = useState<CreatedToken | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () =>
    api
      .get<{ tokens: ApiToken[] }>('/auth/tokens')
      .then(({ tokens }) => setTokens(tokens))
      .catch(() => setTokens([]));

  useEffect(() => {
    if (SHOW_API_TOKENS) void load();
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<CreatedToken>('/auth/tokens', { label: label.trim() || 'Mobile app' });
      setFresh(created);
      setCopied(false);
      setLabel('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the token.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: number, name: string) {
    if (!window.confirm(`Revoke “${name}”? Any app or script using it will stop working immediately.`)) return;
    try {
      await api.del(`/auth/tokens/${id}`);
      if (fresh?.id === id) setFresh(null);
      await load();
    } catch {
      setError('Could not revoke the token.');
    }
  }

  async function copyFresh() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh.token);
      setCopied(true);
    } catch {
      /* Clipboard blocked — the value is selectable in the box regardless. */
    }
  }

  return (
    <section className="panel account-settings">
      <header className="panel-head">
        <div>
          <h2>Account</h2>
          <p className="muted">Signed in as {viewer ? viewer.username : ''}. Manage access for apps and scripts below.</p>
        </div>
      </header>

      <h3 className="account-subhead">Accessibility</h3>
      <p className="muted">Personal to you and saved on this device; they don’t change what anyone else sees.</p>
      <div className="a11y-settings">
        <div className="a11y-row">
          <label htmlFor="a11y-font" className="a11y-label">Text size</label>
          <span className="a11y-aa small" aria-hidden>A</span>
          <input
            id="a11y-font"
            type="range"
            className="a11y-slider"
            min={FONT_MIN}
            max={FONT_MAX}
            step={FONT_STEP}
            value={a11y.fontScale}
            onChange={(e) => setFontScale(Number(e.target.value))}
            aria-valuetext={`${a11y.fontScale} percent`}
          />
          <span className="a11y-aa" aria-hidden>A</span>
          <span className="a11y-value">{a11y.fontScale}%</span>
          {a11y.fontScale !== FONT_DEFAULT && (
            <button type="button" className="ghost mini" onClick={() => setFontScale(FONT_DEFAULT)}>
              Reset
            </button>
          )}
        </div>
        <div className="a11y-row">
          <div className="a11y-toggle-text">
            <span className="a11y-label">High contrast</span>
            <span className="muted small">Stronger colours and borders for easier reading.</span>
          </div>
          <Switch checked={a11y.highContrast} onChange={setHighContrast} label="High contrast mode" />
        </div>
      </div>

      <h3 className="account-subhead">Appearance</h3>
      <p className="muted">Pick a surface style just for you; it only changes how the site looks on this device.</p>
      <div className="skin-picker">
        <button
          type="button"
          className={`skin-option${skinPref === null ? ' active' : ''}`}
          aria-pressed={skinPref === null}
          onClick={() => chooseSkin(null)}
        >
          <span className="skin-swatch skin-swatch-classic" aria-hidden>
            <span className="skin-swatch-card" />
          </span>
          <span className="skin-option-text">
            <b>Site default</b>
            <span className="muted small">Follow the style your org chose.</span>
          </span>
        </button>
        {SKINS.map((sk) => (
          <button
            key={sk.key}
            type="button"
            className={`skin-option${skinPref === sk.key ? ' active' : ''}`}
            aria-pressed={skinPref === sk.key}
            onClick={() => chooseSkin(sk.key)}
          >
            <span className={`skin-swatch skin-swatch-${sk.key}`} aria-hidden>
              <span className="skin-swatch-card" />
            </span>
            <span className="skin-option-text">
              <b>{sk.label}</b>
              <span className="muted small">{sk.desc}</span>
            </span>
          </button>
        ))}
      </div>

      <h3 className="account-subhead">API access</h3>
      {!SHOW_API_TOKENS && (
        <p className="muted">Personal access tokens for a mobile app or scripts are planned for a future release.</p>
      )}

      {SHOW_API_TOKENS && (
      <>
      <p className="muted">
        A personal access token lets the mobile app (or a script) sign in as you. It carries exactly your
        permissions. Treat it like a password — anyone with it can act as you until you revoke it.
      </p>

      {error && <div className="notice error">{error}</div>}

      {fresh && (
        <div className="token-reveal">
          <strong>Copy your new token now. It won’t be shown again.</strong>
          <div className="token-reveal-row">
            <code className="token-value">{fresh.token}</code>
            <button type="button" className="primary" onClick={copyFresh}>
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
          <button type="button" className="ghost" onClick={() => setFresh(null)}>
            Done
          </button>
        </div>
      )}

      <div className="token-create">
        <input
          type="text"
          value={label}
          maxLength={60}
          placeholder="Name this token (e.g. “My iPhone”)"
          onChange={(e) => setLabel(e.target.value)}
          disabled={busy}
        />
        <button type="button" className="primary" onClick={() => void create()} disabled={busy}>
          {busy ? 'Creating…' : 'Create token'}
        </button>
      </div>

      {tokens === null ? (
        <p className="muted">Loading…</p>
      ) : tokens.length === 0 ? (
        <p className="muted">No tokens yet.</p>
      ) : (
        <table className="token-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Token</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td><code>{t.prefix}…</code></td>
                <td>{when(t.createdAt)}</td>
                <td>{when(t.lastUsedAt)}</td>
                <td>{when(t.expiresAt)}</td>
                <td>
                  <button type="button" className="mini danger" onClick={() => void revoke(t.id, t.label)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      </>
      )}
    </section>
  );
}
