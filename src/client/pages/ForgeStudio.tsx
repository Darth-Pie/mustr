/**
 * Sigil Forge studio — the in-app creator. Compose a monogram, pick a built-in
 * mark, or upload your own; choose one of eleven animation styles; tune speed,
 * density, glow, particle size, and colour (with an optional two-tone); preview
 * it live; and either save it as the site's boot-splash identity or copy a
 * zero-storage share link that carries the whole sigil in the URL.
 */

import { useMemo, useState } from 'react';
import { MorphIcon } from 'morphicons/react';
import { Play, Dices, Download, Copy, Check, LoaderCircle } from 'lucide';
import { useSigil } from '../lib/sigil';
import SigilStage from '../components/SigilStage';
import { api } from '../lib/api';
import { rasterizeSigilToPng } from '../lib/sigilRaster';
import { exportSigilGif } from '../lib/sigilExport';
import {
  BUILTIN_MARKS,
  DEFAULT_RECIPE,
  SIGIL_EMBLEMS,
  SIGIL_FRAMES,
  SIGIL_POSITIONS,
  SIGIL_STYLES,
  SIGIL_SWATCHES,
  SIGIL_HOLD_MIN,
  SIGIL_HOLD_MAX,
  encodeRecipe,
  isShareable,
  sanitizeRecipe,
  type SigilEmblem,
  type SigilFrame,
  type SigilPos,
  type SigilRecipe,
  type SigilStyle,
} from '../../shared/sigil';

const STYLE_LABELS: Record<SigilStyle, string> = {
  assemble: 'Assemble', draw: 'Draw-on', constellation: 'Constellation', morph: 'Morph',
  glitch: 'Glitch', wipe: 'Wipe', shimmer: 'Shimmer', dissolve: 'Dissolve',
  swirl: 'Swirl', typewriter: 'Typewriter', unfold: 'Unfold',
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const rand = <T,>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)]!;

export default function ForgeStudio() {
  const { sigil, save } = useSigil();
  const [recipe, setRecipe] = useState<SigilRecipe>(sigil.recipe);
  const [enabled, setEnabled] = useState(sigil.enabled);
  const [holdSeconds, setHoldSeconds] = useState(sigil.holdSeconds);
  const [playKey, setPlayKey] = useState(0);
  const [loop, setLoop] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportPct, setExportPct] = useState(0);

  const edit = (patch: Partial<SigilRecipe>) => {
    setRecipe((r) => sanitizeRecipe({ ...r, ...patch }));
    setPlayKey((k) => k + 1);
    setMsg(null);
  };
  const replay = () => setPlayKey((k) => k + 1);

  const shareUrl = useMemo(
    () => (isShareable(recipe) ? `${window.location.origin}/forge#${encodeRecipe(recipe)}` : ''),
    [recipe],
  );

  const surprise = () => {
    const source = rand(['builtin', 'compose'] as const);
    setRecipe(
      sanitizeRecipe({
        ...DEFAULT_RECIPE,
        source,
        builtin: rand(BUILTIN_MARKS).id,
        initials: recipe.initials || 'MU',
        frame: rand(SIGIL_FRAMES),
        emblem: rand(SIGIL_EMBLEMS),
        style: rand(SIGIL_STYLES),
        accent: rand(SIGIL_SWATCHES),
        twoTone: Math.random() < 0.4,
        accent2: rand(SIGIL_SWATCHES),
        density: 80 + Math.floor(Math.random() * 140),
        glow: 0.6 + Math.random() * 1.4,
      }),
    );
    setPlayKey((k) => k + 1);
    setMsg(null);
  };

  async function onUpload(file: File) {
    setUploading(true);
    setMsg(null);
    try {
      const res = await api.upload<{ url: string }>('/media/branding', file);
      edit({ source: 'image', imageUrl: res.url });
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  async function onSave() {
    setSaving(true);
    setMsg(null);
    try {
      // Render a static PNG of the mark and host it once, so it can be reused as
      // static art (Discord embeds, OG images). Image sigils reuse their upload.
      // Non-fatal: if it fails, we still save the recipe (art falls back to the logo).
      let pngUrl = '';
      let artError = '';
      try {
        if (recipe.source === 'image') {
          pngUrl = recipe.imageUrl;
        } else {
          const file = await rasterizeSigilToPng(recipe);
          const res = await api.upload<{ url: string }>('/media/branding', file);
          pngUrl = res.url;
        }
      } catch (e) {
        // Non-fatal — the recipe still saves — but never silent: without this
        // PNG every static-art surface (Discord embed crest, OG image) quietly
        // shows nothing, which is indistinguishable from "the feature is broken".
        pngUrl = '';
        artError = e instanceof Error ? e.message : String(e);
        console.error('Sigil static art failed to render/upload:', e);
      }
      await save({ enabled, recipe, pngUrl, holdSeconds });
      const base = enabled
        ? 'Saved. Your sigil now plays once when a visitor loads the site.'
        : 'Saved. Turn on “Play on site load” to show it as your boot splash — it is also what enables the Discord embed crest.';
      setMsg(
        artError
          ? `${base} But its static image could not be generated (${artError}), so Discord embeds and link previews will not show the crest.`
          : base,
      );
    } catch {
      setMsg('Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function downloadGif() {
    setExporting(true);
    setExportPct(0);
    setMsg(null);
    try {
      const blob = await exportSigilGif(recipe, { onProgress: setExportPct });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sigil.gif';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setMsg('Downloaded your animated sigil (GIF).');
    } catch (e) {
      // Report what actually went wrong. The old blanket message ("try a
      // built-in or composed mark") sent debugging in the wrong direction when
      // the real fault was a browser canvas/geometry difference.
      console.error('GIF export failed:', e);
      setMsg(`Could not render the GIF: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  }

  async function copyShare() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — the field is selectable */
    }
  }

  return (
    <section className="panel forge-studio">
      <header className="panel-head">
        <div>
          <h2>Sigil Forge</h2>
          <p className="muted">
            Turn your org’s mark into a living, animated sigil. Compose one, pick a shape, or upload
            your own — then set it as your boot splash or share a link that carries the whole thing.
          </p>
        </div>
        <button type="button" className="primary" onClick={onSave} disabled={saving || uploading}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </header>

      {msg && <div className="notice">{msg}</div>}

      <div className="forge-grid">
        {/* Preview */}
        <div className="forge-preview-col">
          <div className="forge-stage">
            <SigilStage recipe={recipe} playKey={playKey} loop={loop} />
          </div>
          <div className="forge-preview-actions">
            <button type="button" className="primary btn-icon" onClick={replay}>
              <MorphIcon icon={Play} size={14} aria-hidden /> Forge it
            </button>
            <button type="button" className="ghost btn-icon" onClick={surprise}>
              <MorphIcon icon={Dices} size={14} aria-hidden /> Surprise me
            </button>
            <label className="toggle-inline"><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop</label>
          </div>

          <label className="toggle-row forge-enable">
            <span>Play on site load</span>
            <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setMsg(null); }} />
          </label>

          {enabled && (
            <label className="range-row">
              <span>Hold on screen <b>{holdSeconds.toFixed(1)}s</b></span>
              <input
                type="range"
                min={SIGIL_HOLD_MIN}
                max={SIGIL_HOLD_MAX}
                step={0.1}
                value={holdSeconds}
                onChange={(e) => { setHoldSeconds(Number(e.target.value)); setMsg(null); }}
              />
              <span className="muted small">
                How long the finished mark rests before the splash fades out. The Speed slider
                controls how fast it animates; this is the pause afterwards.
              </span>
            </label>
          )}

          <div className="forge-share">
            <span className="field-label">Share link <span className="muted small">— no account needed, nothing stored</span></span>
            {shareUrl ? (
              <div className="forge-share-row">
                <input readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="ghost btn-icon" onClick={copyShare}>
                  <MorphIcon icon={copied ? Check : Copy} size={14} spring="snappy" aria-hidden />
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            ) : (
              <p className="muted small">Uploaded images can’t ride in a link (they’re too big for a URL). Compose a mark or pick a built-in one to get a shareable link.</p>
            )}
          </div>

          <div className="forge-export">
            <button type="button" className="ghost btn-icon" disabled={exporting} onClick={() => void downloadGif()}>
              {/* Morphs to a spinner-ish loader while encoding, back to the
                  download arrow when idle. */}
              <MorphIcon
                className={exporting ? 'is-working' : undefined}
                icon={exporting ? LoaderCircle : Download}
                size={14}
                aria-hidden
              />
              {exporting ? `Rendering… ${Math.round(exportPct * 100)}%` : 'Download animated GIF'}
            </button>
            <span className="muted small">A looping GIF you can post anywhere — watermarked with mustr.</span>
          </div>
        </div>

        {/* Controls */}
        <div className="forge-controls">
          <div className="field">
            <span className="field-label">Artwork</span>
            <div className="seg">
              {(['builtin', 'compose', 'image'] as const).map((sMode) => (
                <button
                  key={sMode}
                  type="button"
                  className={`seg-btn${recipe.source === sMode ? ' on' : ''}`}
                  onClick={() => edit({ source: sMode })}
                >
                  {sMode === 'builtin' ? 'Built-in' : sMode === 'compose' ? 'Compose' : 'Upload'}
                </button>
              ))}
            </div>
          </div>

          {recipe.source === 'builtin' && (
            <div className="field">
              <span className="field-label">Mark</span>
              <div className="chip-row">
                {BUILTIN_MARKS.map((m) => (
                  <button key={m.id} type="button" className={`chip${recipe.builtin === m.id ? ' on' : ''}`} onClick={() => edit({ builtin: m.id })}>
                    {m.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {recipe.source === 'compose' && (
            <>
              <label className="field">
                <span className="field-label">Initials or short name</span>
                <input value={recipe.initials} maxLength={16} placeholder="e.g. MU" onChange={(e) => edit({ initials: e.target.value })} />
              </label>
              <div className="field">
                <span className="field-label">Frame</span>
                <div className="chip-row">
                  {SIGIL_FRAMES.map((f: SigilFrame) => (
                    <button key={f} type="button" className={`chip${recipe.frame === f ? ' on' : ''}`} onClick={() => edit({ frame: f })}>{cap(f)}</button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span className="field-label">Emblem</span>
                <div className="chip-row">
                  {SIGIL_EMBLEMS.map((em: SigilEmblem) => (
                    <button key={em} type="button" className={`chip${recipe.emblem === em ? ' on' : ''}`} onClick={() => edit({ emblem: em })}>{cap(em)}</button>
                  ))}
                </div>
              </div>
              {recipe.emblem !== 'none' && (
                <div className="field">
                  <span className="field-label">Emblem position</span>
                  <div className="chip-row">
                    {SIGIL_POSITIONS.map((p: SigilPos) => (
                      <button key={p} type="button" className={`chip${recipe.pos === p ? ' on' : ''}`} onClick={() => edit({ pos: p })}>{cap(p)}</button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {recipe.source === 'image' && (
            <div className="field">
              <span className="field-label">Your logo</span>
              <div className="avatar-controls">
                <label className="upload-btn">
                  {uploading ? 'Uploading…' : recipe.imageUrl ? 'Change image' : 'Upload PNG / JPG'}
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden disabled={uploading}
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onUpload(f); }} />
                </label>
              </div>
              <p className="muted small">A transparent PNG animates best. Uploaded marks work as your boot splash, but can’t be shared by link.</p>
            </div>
          )}

          <div className="field">
            <span className="field-label">Animation</span>
            <div className="chip-row">
              {SIGIL_STYLES.map((st) => (
                <button key={st} type="button" className={`chip${recipe.style === st ? ' on' : ''}`} onClick={() => edit({ style: st })}>{STYLE_LABELS[st]}</button>
              ))}
            </div>
          </div>

          <label className="range-row">
            <span>Speed <b>{recipe.speed.toFixed(1)}×</b></span>
            <input type="range" min={0.5} max={2} step={0.1} value={recipe.speed} onChange={(e) => edit({ speed: Number(e.target.value) })} />
          </label>
          <label className="range-row">
            <span>Particle density <b>{recipe.density}</b></span>
            <input type="range" min={40} max={260} step={10} value={recipe.density} onChange={(e) => edit({ density: Number(e.target.value) })} />
          </label>
          <label className="range-row">
            <span>Glow <b>{recipe.glow.toFixed(1)}</b></span>
            <input type="range" min={0} max={2.5} step={0.1} value={recipe.glow} onChange={(e) => edit({ glow: Number(e.target.value) })} />
          </label>
          <label className="range-row">
            <span>Particle size <b>{recipe.psize.toFixed(1)}×</b></span>
            <input type="range" min={0.5} max={2.5} step={0.1} value={recipe.psize} onChange={(e) => edit({ psize: Number(e.target.value) })} />
          </label>

          <div className="field">
            <span className="field-label">Colour</span>
            <div className="forge-swatches">
              {SIGIL_SWATCHES.map((c) => (
                <button key={c} type="button" className={`forge-sw${recipe.accent.toLowerCase() === c.toLowerCase() ? ' on' : ''}`} style={{ background: c }} aria-label={`accent ${c}`} onClick={() => edit({ accent: c })} />
              ))}
              <input type="color" className="forge-color" value={recipe.accent} onChange={(e) => edit({ accent: e.target.value })} aria-label="custom colour" />
            </div>
            <label className="toggle-inline forge-twotone">
              <input type="checkbox" checked={recipe.twoTone} onChange={(e) => edit({ twoTone: e.target.checked })} /> Two-tone
              <input type="color" className="forge-color" value={recipe.accent2} disabled={!recipe.twoTone} onChange={(e) => edit({ accent2: e.target.value })} aria-label="second colour" />
            </label>
          </div>

          {(recipe.source === 'builtin') && (
            <div className="field">
              <span className="field-label">Particles</span>
              <div className="chip-row">
                <button type="button" className={`chip${recipe.points === 'outline' ? ' on' : ''}`} onClick={() => edit({ points: 'outline' })}>Outline</button>
                <button type="button" className={`chip${recipe.points === 'filled' ? ' on' : ''}`} onClick={() => edit({ points: 'filled' })}>Filled</button>
              </div>
              <p className="muted small">Outline traces the mark’s edges; Filled fills its body with particles.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
