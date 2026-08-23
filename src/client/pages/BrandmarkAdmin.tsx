/**
 * Brandmark admin — turn the org's mark into an animated boot splash. Upload a
 * dedicated image (or fall back to the header logo), pick a style, tune it, and
 * preview live. Saving persists via settings.manage; the splash then plays once
 * per session on the next visit.
 */

import { useEffect, useState } from 'react';
import { MorphIcon } from 'morphicons/react';
import { Play } from 'lucide';
import { api } from '../lib/api';
import { useBrandmark } from '../lib/brandmark';
import { useBranding } from '../lib/branding';
import { BRANDMARK_ARCHETYPES, brandmarkToRecipe, type BrandmarkArchetype, type BrandmarkConfig } from '../../shared/brandmark';
import SigilStage from '../components/SigilStage';

const ARCH_LABELS: Record<BrandmarkArchetype, string> = {
  assemble: 'Assemble',
  constellation: 'Constellation',
  dissolve: 'Dissolve',
  wipe: 'Wipe',
};

export default function BrandmarkAdmin() {
  const { brandmark, save } = useBrandmark();
  const { branding } = useBranding();
  const [draft, setDraft] = useState<BrandmarkConfig>(brandmark);
  const [playKey, setPlayKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Seed the draft when the persisted config loads/changes.
  useEffect(() => {
    setDraft(brandmark);
    setPlayKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandmark.enabled, brandmark.imageUrl, brandmark.archetype, brandmark.accent]);

  const edit = (patch: Partial<BrandmarkConfig>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setMsg(null);
    setPlayKey((k) => k + 1);
  };

  const src = draft.imageUrl || branding.logoUrl || '';
  const themeAccent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();

  async function onSave() {
    setSaving(true);
    setMsg(null);
    try {
      await save(draft);
      setMsg('Saved. Your brandmark plays once when a visitor next loads the site.');
    } catch {
      setMsg('Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Brandmark</h2>
          <p className="muted">
            An animated intro of your mark that plays once, over a scrim, when the site loads.
            Uses a dedicated image — or your header logo if you don’t set one.
          </p>
        </div>
        <button type="button" className="primary" onClick={onSave} disabled={saving || uploading}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </header>

      {msg && <div className="notice">{msg}</div>}

      <div className="brandmark-admin">
        <div className="brandmark-preview-col">
          <div className="brandmark-stage">
            {src ? (
              <SigilStage recipe={brandmarkToRecipe(draft, src, themeAccent)} playKey={playKey} />
            ) : (
              <p className="muted small">Upload a mark, or set a header logo under Branding, to preview.</p>
            )}
          </div>
          <button type="button" className="ghost btn-icon" onClick={() => setPlayKey((k) => k + 1)} disabled={!src}>
            <MorphIcon icon={Play} size={14} aria-hidden /> Replay preview
          </button>
        </div>

        <div className="brandmark-controls">
          <label className="toggle-row">
            <span>Play on site load</span>
            <input type="checkbox" checked={draft.enabled} onChange={(e) => edit({ enabled: e.target.checked })} />
          </label>

          <div className="field">
            <span className="field-label">Mark image</span>
            <div className="avatar-controls">
              <label className="upload-btn">
                {uploading ? 'Uploading…' : draft.imageUrl ? 'Change image' : 'Upload image'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  hidden
                  disabled={uploading}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    setErr(null);
                    setUploading(true);
                    try {
                      const res = await api.upload<{ url: string }>('/media/branding', file);
                      edit({ imageUrl: res.url });
                    } catch (e2) {
                      setErr(e2 instanceof Error ? e2.message : 'Upload failed.');
                    } finally {
                      setUploading(false);
                    }
                  }}
                />
              </label>
              {draft.imageUrl && (
                <button type="button" className="ghost" onClick={() => edit({ imageUrl: '' })}>
                  Use header logo
                </button>
              )}
            </div>
            {!draft.imageUrl && (
              <p className="muted small">
                {branding.logoUrl
                  ? 'Using your header logo. A transparent PNG animates best.'
                  : 'No image or header logo set yet — upload one here, or set a logo under Branding.'}
              </p>
            )}
            {err && <p className="muted small">{err}</p>}
          </div>

          <div className="field">
            <span className="field-label">Style</span>
            <div className="chip-row">
              {BRANDMARK_ARCHETYPES.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={`chip${draft.archetype === a ? ' on' : ''}`}
                  onClick={() => edit({ archetype: a })}
                >
                  {ARCH_LABELS[a]}
                </button>
              ))}
            </div>
          </div>

          <label className="range-row">
            <span>Speed <b>{draft.speed.toFixed(1)}×</b></span>
            <input type="range" min={0.5} max={2} step={0.1} value={draft.speed} onChange={(e) => edit({ speed: Number(e.target.value) })} />
          </label>
          <label className="range-row">
            <span>Particles <b>{draft.density}</b></span>
            <input type="range" min={60} max={240} step={10} value={draft.density} onChange={(e) => edit({ density: Number(e.target.value) })} />
          </label>

          <div className="field">
            <span className="field-label">Particle colour</span>
            <div className="avatar-controls">
              <input type="color" value={draft.accent || '#8b5cf6'} onChange={(e) => edit({ accent: e.target.value })} />
              {draft.accent && (
                <button type="button" className="ghost" onClick={() => edit({ accent: '' })}>
                  Use theme accent
                </button>
              )}
            </div>
            <p className="muted small">Blank uses your theme’s accent colour. The logo keeps its own colours.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
