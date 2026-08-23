/**
 * Boot splash — plays the org's animated mark once per browser session over a
 * full-screen scrim, then fades away. Off unless an admin enables it. Click
 * anywhere to skip.
 *
 * Two sources, in priority order: a full Sigil Forge recipe (the newer studio),
 * and, failing that, the older image-only Brandmark (a dedicated image or the
 * header logo). Whichever is enabled wins; the Forge sigil takes precedence.
 */

import { useEffect, useState } from 'react';
import { useBrandmark } from '../lib/brandmark';
import { useSigil } from '../lib/sigil';
import { useBranding } from '../lib/branding';
import { brandmarkToRecipe } from '../../shared/brandmark';
import { SIGIL_HOLD_DEFAULT } from '../../shared/sigil';
import SigilStage from './SigilStage';

const SESSION_KEY = 'mustr:brandmark:shown';

export default function BrandmarkSplash() {
  const { brandmark, loaded: bmLoaded } = useBrandmark();
  const { sigil, loaded: sigilLoaded } = useSigil();
  const { branding } = useBranding();
  const [phase, setPhase] = useState<'idle' | 'playing' | 'closing' | 'done'>('idle');

  const loaded = bmLoaded && sigilLoaded;
  const useSigilRecipe = sigil.enabled; // the Forge sigil wins when enabled
  const bmSrc = brandmark.imageUrl || branding.logoUrl || '';
  const active = useSigilRecipe || (brandmark.enabled && !!bmSrc);

  useEffect(() => {
    if (phase !== 'idle' || !loaded) return;
    if (!active) { setPhase('done'); return; }
    try { if (sessionStorage.getItem(SESSION_KEY)) { setPhase('done'); return; } } catch { /* ignore */ }
    setPhase('playing');
  }, [loaded, active, phase]);

  if (phase === 'idle' || phase === 'done') return null;

  const close = () => {
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* ignore */ }
    setPhase('closing');
    // Must outlast the brandmark-out animation, or the node unmounts mid-fade
    // and the splash appears to snap away.
    window.setTimeout(() => setPhase('done'), 1150);
  };

  // Preserve the old "blank accent = live theme accent" behaviour for the legacy
  // image Brandmark path.
  const themeAccent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
  const recipe = useSigilRecipe ? sigil.recipe : brandmarkToRecipe(brandmark, bmSrc, themeAccent);
  const holdMs = (useSigilRecipe ? sigil.holdSeconds : SIGIL_HOLD_DEFAULT) * 1000;

  return (
    <div
      className={`brandmark-splash${phase === 'closing' ? ' closing' : ''}`}
      role="presentation"
      onClick={close}
    >
      {/* Let the finished mark sit before dismissing — the animation resolving
          and the screen clearing on top of each other is what makes the intro
          feel rushed. Admin-tunable via Sigil Forge; the legacy image Brandmark
          path has no setting of its own, so it takes the default. */}
      <SigilStage
        recipe={recipe}
        className="splash-mark"
        onDone={() => window.setTimeout(close, holdMs)}
      />
    </div>
  );
}
