/**
 * Settings → Modules — turn optional per-install features on or off.
 *
 * Two tiers, deliberately separated. The top is a card per module: name, one
 * sentence, and a switch — the whole "what does this install run" answer
 * readable at a glance, without settings for modules you don't use in the way.
 * Below that, each module's option sets are accordions, all collapsed by
 * default, so the page stays short as more modules land.
 *
 * A module's settings only render while it's on. There's no point showing an
 * org SID field for a module whose routes are all 404ing.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import Switch from '../components/Switch';
import WowSettings from '../components/WowSettings';
import {
  clearModulesCache,
  clearScConfigCache,
  clearGalleryConfigCache,
  type ModuleFlags,
  type ScConfig,
  type GalleryConfig,
} from '../lib/modules';

interface ModuleDef {
  key: keyof ModuleFlags;
  label: string;
  description: string;
}

const MODULES: ModuleDef[] = [
  {
    key: 'starcitizen',
    label: 'Star Citizen',
    description:
      'Members import their RSI hangar, verify their account, and plan ship upgrades — all from their own profile.',
  },
  {
    key: 'gallery',
    label: 'Gallery',
    description:
      'A Gallery page of photo and video albums, each shown to everyone, to members, or to one role.',
  },
  {
    key: 'wow',
    label: 'World of Warcraft',
    description:
      'Members link Battle.net and the guild gets a leveling race: character timelines, charts, records, Discord milestones and medals.',
  },
];

const NO_MODULES: ModuleFlags = { starcitizen: false, gallery: false, wow: false };

/**
 * One collapsible option set. `<details>` gives us the open/close behaviour,
 * keyboard support and find-in-page for free, but its open state is owned by
 * the DOM — so it's mirrored into React state here. Without that, any re-render
 * (every `busy` flip during a save) would snap the panel back to `initialOpen`
 * and close a section the reader had just opened.
 */
function OptionSet({
  title,
  hint,
  initialOpen = false,
  children,
}: {
  title: string;
  hint?: string;
  initialOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <details className="option-set" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="option-set-title">{title}</span>
        {hint && <span className="muted small option-set-hint">{hint}</span>}
        <span className="option-set-caret" aria-hidden>
          ▾
        </span>
      </summary>
      <div className="option-set-body">{children}</div>
    </details>
  );
}

export default function ModulesAdmin() {
  const [flags, setFlags] = useState<ModuleFlags | null>(null);
  const [sc, setSc] = useState<ScConfig | null>(null);
  const [orgSidDraft, setOrgSidDraft] = useState('');
  const [gal, setGal] = useState<GalleryConfig | null>(null);
  const [heroTitleDraft, setHeroTitleDraft] = useState('');
  const [heroTaglineDraft, setHeroTaglineDraft] = useState('');
  const { run, busy, error, notice, warning } = useAction();

  useEffect(() => {
    api
      .get<{ modules: ModuleFlags }>('/settings/modules')
      .then(({ modules }) => setFlags(modules))
      .catch(() => setFlags(NO_MODULES));
    api
      .get<{ sc: ScConfig }>('/settings/sc')
      .then(({ sc }) => {
        setSc(sc);
        setOrgSidDraft(sc.orgSid);
      })
      .catch(() => {});
    api
      .get<{ gallery: GalleryConfig }>('/settings/gallery')
      .then(({ gallery }) => {
        setGal(gallery);
        setHeroTitleDraft(gallery.heroTitle);
        setHeroTaglineDraft(gallery.heroTagline);
      })
      .catch(() => {});
  }, []);

  // Every save sends the FULL SC config (the server replaces the blob), so
  // toggling a kill switch preserves the org SID and vice-versa.
  const saveSc = (next: ScConfig, okMsg = 'Saved.') =>
    run(async () => {
      const { sc: saved } = await api.put<{ sc: ScConfig }>('/settings/sc', { sc: next });
      setSc(saved);
      setOrgSidDraft(saved.orgSid);
      clearScConfigCache(); // profiles pick up a kill switch without a reload
      return okMsg;
    });

  // Same full-blob rule as the SC config: every save replaces the stored object,
  // so editing the copy can't drop the hero switch and vice-versa.
  const saveGallery = (next: GalleryConfig, okMsg = 'Saved.') =>
    run(async () => {
      const { gallery: saved } = await api.put<{ gallery: GalleryConfig }>('/settings/gallery', {
        gallery: next,
      });
      setGal(saved);
      setHeroTitleDraft(saved.heroTitle);
      setHeroTaglineDraft(saved.heroTagline);
      clearGalleryConfigCache();
      return okMsg;
    });

  const toggle = (key: keyof ModuleFlags, value: boolean) =>
    run(async () => {
      const next = { ...(flags ?? NO_MODULES), [key]: value };
      const { modules } = await api.put<{ modules: ModuleFlags }>('/settings/modules', { modules: next });
      setFlags(modules);
      clearModulesCache(); // so profiles pick up the change without a reload
      return value ? 'Module enabled.' : 'Module disabled.';
    });

  if (!flags) return <div className="loading">Loading…</div>;

  const scOpen = flags.starcitizen && sc;
  const galOpen = flags.gallery && gal;
  const heroCopyDirty =
    !!gal && (heroTitleDraft.trim() !== gal.heroTitle || heroTaglineDraft.trim() !== gal.heroTagline);

  return (
    <section className="panel modules-admin">
      <header className="panel-head">
        <h2>Modules</h2>
        <p className="muted">Optional features for this site. Turn on only what your group needs.</p>
      </header>

      <Alerts error={error} warning={warning} notice={notice} />

      <ul className="module-cards">
        {MODULES.map((m) => (
          <li key={m.key} className={flags[m.key] ? 'module-card is-on' : 'module-card'}>
            <div className="module-card-top">
              <span className="module-card-name">{m.label}</span>
              <Switch
                checked={!!flags[m.key]}
                disabled={busy}
                label={`${m.label} module`}
                onChange={(v) => void toggle(m.key, v)}
              />
            </div>
            <p className="muted small">{m.description}</p>
          </li>
        ))}
      </ul>

      {!scOpen && !galOpen ? (
        <p className="muted small module-settings-empty">
          Turn a module on to configure it — its settings appear here.
        </p>
      ) : (
        <div className="module-settings">
          {scOpen && sc && (
            <OptionSet title="Star Citizen" hint="Org identity & feature kill switches">
              <label className="option-field">
                Org SID
                <div className="module-config-row">
                  <input
                    type="text"
                    value={orgSidDraft}
                    placeholder="e.g. F919"
                    maxLength={20}
                    disabled={busy}
                    onChange={(e) => setOrgSidDraft(e.target.value)}
                  />
                  <button
                    type="button"
                    className="primary small"
                    disabled={busy || orgSidDraft.trim() === sc.orgSid}
                    onClick={() => void saveSc({ ...sc, orgSid: orgSidDraft.trim() })}
                  >
                    Save
                  </button>
                </div>
                <span className="muted small">
                  Your org’s RSI Spectrum Identification (the tag in your org URL{' '}
                  <code>/orgs/&lt;SID&gt;</code>). Used to confirm a member’s verified RSI account
                  actually lists your org.
                </span>
              </label>

              <div className="option-subhead">
                <span className="option-subhead-title">Feature kill switches</span>
                <span className="muted small">
                  Each feature can be switched off on its own (e.g. if RSI / Cloud Imperium requests
                  it). Turning the whole module off above disables all of them.
                </span>
              </div>
              <div className="module-row">
                <div className="module-info">
                  <span className="module-name">Hangar import &amp; display</span>
                  <span className="muted small">
                    Members export their own hangar (client-side bookmarklet) and it shows on
                    profiles. No server-side access to RSI.
                  </span>
                </div>
                <Switch
                  checked={sc.hangarEnabled}
                  disabled={busy}
                  label="Hangar import and display"
                  onChange={(v) => void saveSc({ ...sc, hangarEnabled: v })}
                />
              </div>
              <div className="module-row">
                <div className="module-info">
                  <span className="module-name">RSI account verification</span>
                  <span className="muted small">
                    Reads a member’s public RSI profile to confirm account ownership + org
                    membership. This is the only feature that fetches RSI server-side.
                  </span>
                </div>
                <Switch
                  checked={sc.verifyEnabled}
                  disabled={busy}
                  label="RSI account verification"
                  onChange={(v) => void saveSc({ ...sc, verifyEnabled: v })}
                />
              </div>
            </OptionSet>
          )}

          {galOpen && gal && (
            <OptionSet title="Gallery — page & hero" hint="Albums live under Content → Gallery">
              <p className="muted small">
                Each album decides its own audience, so a public album and a leadership-only one can
                sit side by side.
              </p>

              <div className="module-row">
                <div className="module-info">
                  <span className="module-name">Scrolling hero</span>
                  <span className="muted small">
                    A drifting collage at the top of the gallery page, sampled from your{' '}
                    <strong>public</strong> albums only. With no public albums there’s nothing safe
                    to sample, so the hero simply doesn’t render.
                  </span>
                </div>
                <Switch
                  checked={gal.heroEnabled}
                  disabled={busy}
                  label="Scrolling hero"
                  onChange={(v) => void saveGallery({ ...gal, heroEnabled: v })}
                />
              </div>

              {gal.heroEnabled && (
                <>
                  <label className="option-field">
                    Hero heading
                    <input
                      type="text"
                      value={heroTitleDraft}
                      placeholder="Gallery"
                      maxLength={80}
                      disabled={busy}
                      onChange={(e) => setHeroTitleDraft(e.target.value)}
                    />
                  </label>
                  <label className="option-field">
                    Hero tagline
                    <div className="module-config-row">
                      <input
                        type="text"
                        value={heroTaglineDraft}
                        placeholder="Moments from the org."
                        maxLength={200}
                        disabled={busy}
                        onChange={(e) => setHeroTaglineDraft(e.target.value)}
                      />
                      <button
                        type="button"
                        className="primary small"
                        disabled={busy || !heroCopyDirty}
                        onClick={() =>
                          void saveGallery({
                            ...gal,
                            heroTitle: heroTitleDraft.trim(),
                            heroTagline: heroTaglineDraft.trim(),
                          })
                        }
                      >
                        Save
                      </button>
                    </div>
                    <span className="muted small">Leave either blank to use the built-in wording.</span>
                  </label>
                </>
              )}
            </OptionSet>
          )}
        </div>
      )}

      {/* Always shown: the Battle.net key must be saved and tested before the
          World of Warcraft module can be switched on. */}
      <div className="module-settings">
        <OptionSet
          title="World of Warcraft"
          hint={flags.wow ? 'Battle.net API client' : 'Set up and test the Battle.net key, then switch the module on'}
        >
          <WowSettings moduleOn={flags.wow} />
        </OptionSet>
      </div>
    </section>
  );
}
