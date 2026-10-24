/**
 * World of Warcraft module settings — the site's own Battle.net API client.
 *
 * Shown whether or not the module is on: the key has to be saved and tested
 * before the module can be switched on (the server refuses otherwise). The
 * secret is write-only; the server only says whether one is stored.
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import type { PublicWowConfig, WowRegion } from '../../shared/wow';

const REGIONS: { value: WowRegion; label: string }[] = [
  { value: 'us', label: 'US' },
  { value: 'eu', label: 'Europe' },
  { value: 'kr', label: 'Korea' },
  { value: 'tw', label: 'Taiwan' },
];

const when = (t: number) =>
  new Date(t * 1000).toLocaleString(undefined, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

export default function WowSettings({ moduleOn }: { moduleOn: boolean }) {
  const [cfg, setCfg] = useState<PublicWowConfig | null>(null);
  const [redirectUri, setRedirectUri] = useState('');
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [region, setRegion] = useState<WowRegion>('us');
  const [namespace, setNamespace] = useState('');
  const { run, busy, error, notice, warning } = useAction();

  const load = () =>
    api.get<{ wow: PublicWowConfig; redirectUri: string }>('/wow/admin/config').then(({ wow, redirectUri }) => {
      setCfg(wow);
      setRedirectUri(redirectUri);
      setClientId(wow.clientId);
      setRegion(wow.region);
      setNamespace(wow.namespace);
      setSecret('');
    });

  useEffect(() => {
    void load().catch(() => {});
  }, []);

  if (!cfg) return <p className="muted small">Loading…</p>;

  const dirty =
    clientId.trim() !== cfg.clientId || secret.trim() !== '' || region !== cfg.region || namespace.trim() !== cfg.namespace;

  const save = () =>
    run(async () => {
      await api.put('/wow/admin/config', { wow: { clientId, clientSecret: secret, region, namespace } });
      await load();
      return 'Saved. Test the connection to switch the module on.';
    });

  const test = () =>
    run(async () => {
      const r = await api.post<{ ok: boolean; error?: string }>('/wow/admin/test');
      await load();
      if (!r.ok) return { warning: r.error ?? 'Blizzard refused the connection.' };
      return 'Connected to Battle.net.';
    });

  const createMedals = () =>
    run(async () => {
      const { created } = await api.post<{ created: number }>('/wow/admin/medals');
      return created ? `Created ${created} WoW medals. Rename them or change their pictures under Medals.` : 'The WoW medals already exist.';
    });

  return (
    <div className="wow-settings">
      <Alerts error={error} warning={warning} notice={notice} />
      <p className="muted small">
        Register a free API client at develop.battle.net (Blizzard requires an authenticator on the account), then
        enter it here.
      </p>
      <label className="option-field">
        Client ID
        <input type="text" value={clientId} disabled={busy} maxLength={128} onChange={(e) => setClientId(e.target.value)} />
      </label>
      <label className="option-field">
        Client secret
        <input
          type="password"
          value={secret}
          disabled={busy}
          maxLength={256}
          autoComplete="new-password"
          placeholder={cfg.hasSecret ? 'Saved. Leave blank to keep it.' : ''}
          onChange={(e) => setSecret(e.target.value)}
        />
      </label>
      <label className="option-field">
        Region
        <select value={region} disabled={busy} onChange={(e) => setRegion(e.target.value as WowRegion)}>
          {REGIONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <label className="option-field">
        Blizzard data section
        <input
          type="text"
          value={namespace}
          disabled={busy}
          maxLength={64}
          placeholder="profile-classic1x (Classic Era, for testing)"
          onChange={(e) => setNamespace(e.target.value)}
        />
        <span className="muted small">
          Which game's characters to read. Filled in automatically once Blizzard publishes World of Warcraft: Forever's.
        </span>
      </label>
      <p className="muted small wow-redirect">
        Add this redirect URL to your Battle.net client: <code>{redirectUri}</code>
      </p>
      <div className="wow-settings-actions">
        <button type="button" className="primary small" disabled={busy || !dirty} onClick={() => void save()}>
          Save
        </button>
        <button type="button" className="small" disabled={busy || dirty} onClick={() => void test()}>
          Test connection
        </button>
        {moduleOn && (
          <button type="button" className="small" disabled={busy} onClick={() => void createMedals()}>
            Create WoW medals
          </button>
        )}
      </div>
      <p className="muted small">
        {cfg.verifiedAt ? `Connection verified ${when(cfg.verifiedAt)}.` : 'Not verified yet.'}
        {cfg.lastError && cfg.lastErrorAt ? ` Last error: ${cfg.lastError} (${when(cfg.lastErrorAt)}).` : ''}
      </p>
    </div>
  );
}
