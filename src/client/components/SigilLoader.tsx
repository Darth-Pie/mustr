/**
 * SigilLoader — a loading indicator branded with the org's sigil (a gently
 * pulsing emblem over the label). Falls back to the plain text loader when no
 * site sigil is enabled or it hasn't loaded yet, so it's a safe drop-in
 * replacement for `<div className="loading">Loading…</div>` anywhere.
 */

import { useSigil } from '../lib/sigil';
import SigilEmblem from './SigilEmblem';

export default function SigilLoader({ label = 'Loading…' }: { label?: string }) {
  const { sigil, loaded } = useSigil();
  // Config still in flight (boot). Hold the space but stay invisible: on a site
  // with a boot splash the sigil config and the session arrive a beat apart, so
  // painting "Loading…" here flashes text for ~200ms and is then covered by the
  // splash — which reads as a janky triple-flash (text → sigil → page) rather
  // than one deliberate intro. After boot `loaded` is true, so every later
  // loading state still shows its label normally.
  if (!loaded) return <div className="loading loading-quiet">{label}</div>;
  if (!sigil.enabled) return <div className="loading">{label}</div>;
  return (
    <div className="sigil-loader" role="status" aria-live="polite">
      <div className="sigil-loader-mark">
        <SigilEmblem />
      </div>
      <span className="loading-label">{label}</span>
    </div>
  );
}
