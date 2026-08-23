/**
 * Public Sigil Forge share page (/forge#<token>) — the viral surface.
 *
 * Reads a sigil recipe straight out of the URL hash and plays it, full-bleed,
 * with a CTA back to mustr. Zero storage: the token IS the sigil, decoded and
 * rendered entirely client-side — no database row, no image, nothing persisted.
 * Renders its own dark cinematic chrome (outside the app shell) and needs no
 * login, so a link works for anyone, anywhere.
 */

import { useMemo, useState } from 'react';
import { MorphIcon } from 'morphicons/react';
import { Play } from 'lucide';
import SigilStage from '../components/SigilStage';
import { decodeRecipe, DEFAULT_RECIPE } from '../../shared/sigil';

// The viral loop points at the product, wherever the sharing install lives.
const MUSTR_URL = 'https://mustr.gg';

export default function ForgeShare() {
  const recipe = useMemo(() => {
    const token = window.location.hash.replace(/^#/, '').trim();
    return (token && decodeRecipe(token)) || DEFAULT_RECIPE;
  }, []);
  const [playKey, setPlayKey] = useState(0);

  return (
    <div className="forge-share-page">
      <div className="fsp-inner">
        <p className="fsp-eyebrow">Forged with Sigil Forge</p>
        <div className="fsp-stage">
          <SigilStage recipe={recipe} playKey={playKey} loop />
        </div>
        <h1 className="fsp-title">A mark that moves.</h1>
        <p className="fsp-lede">
          Every org on mustr can forge a living, animated sigil like this — no design tools, and no
          account needed to try it.
        </p>
        <div className="fsp-actions">
          <a className="fsp-btn primary" href={MUSTR_URL} target="_blank" rel="noopener noreferrer">
            Make your own with mustr ↗
          </a>
          <button type="button" className="fsp-btn btn-icon" onClick={() => setPlayKey((k) => k + 1)}>
            <MorphIcon icon={Play} size={14} aria-hidden /> Replay
          </button>
        </div>
        <p className="fsp-foot">
          Made with{' '}
          <a href={MUSTR_URL} target="_blank" rel="noopener noreferrer">
            mustr
          </a>{' '}
          — the community platform for gaming orgs.
        </p>
      </div>
    </div>
  );
}
