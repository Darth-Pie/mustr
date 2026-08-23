/**
 * Save-time rasterizer — turn a sigil recipe into a static PNG File, entirely in
 * the browser, so it can be uploaded once and reused as static art (Discord
 * embeds, OG images). This is the zero-Worker-overhead path: the client already
 * has everything needed to draw the finished mark, so no server canvas, no WASM,
 * no headless browser.
 *
 * Built-in and composed marks are drawn to a self-contained SVG (the composed
 * monogram is embedded as its own data-URL image) and rasterized via canvas —
 * both stay same-origin/clean, so the canvas never taints. Uploaded-image sigils
 * skip this entirely: their PNG is simply the already-hosted upload.
 */

import { BUILTIN_MARKS, type SigilRecipe } from '../../shared/sigil';
import { composeMark } from './sigilCompose';

/* Minimal colour helpers (mirrors SigilStage's gradient). */
function hx2rgb(h: string): [number, number, number] {
  let s = (h || '').replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s || '0', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgb2hx(a: number[]): string {
  return '#' + a.map((v) => ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2)).join('');
}
function lerpC(a: string, b: string, t: number): string {
  const A = hx2rgb(a), B = hx2rgb(b);
  return rgb2hx([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}
function gradStops(r: SigilRecipe): [string, string, string] {
  return r.twoTone
    ? [r.accent, lerpC(r.accent, r.accent2, 0.5), r.accent2]
    : [lerpC(r.accent, '#ffffff', 0.45), r.accent, lerpC(r.accent, '#000000', 0.3)];
}

/** A self-contained SVG string of the finished mark, on a dark stage by default
 *  (pass `background: false` for a transparent mark-only image). */
export function buildSigilSvg(recipe: SigilRecipe, size: number, opts: { background?: boolean } = {}): string {
  const background = opts.background !== false;
  const [s0, s1, s2] = gradStops(recipe);
  const glow = lerpC(recipe.accent, '#000000', 0.55);

  let markSvg: string;
  if (recipe.source === 'compose') {
    const url = composeMark(recipe).url;
    markSvg = `<image href="${url}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet"/>`;
  } else if (recipe.source === 'image' && recipe.imageUrl) {
    // Not normally used (image sigils reuse their upload), but supported: the
    // caller must pass a same-origin/data URL to keep the canvas clean.
    markSvg = `<image href="${recipe.imageUrl}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet"/>`;
  } else {
    const m = BUILTIN_MARKS.find((x) => x.id === recipe.builtin) ?? BUILTIN_MARKS[0]!;
    markSvg = m.paths
      .map((d) => {
        const closed = /z\s*$/i.test(d.trim());
        return `<path d="${d}" fill="${closed ? 'url(#g)' : 'none'}" stroke="${closed ? 'none' : recipe.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
      })
      .join('');
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">` +
    `<defs>` +
    `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${s0}"/><stop offset="0.5" stop-color="${s1}"/><stop offset="1" stop-color="${s2}"/></linearGradient>` +
    `<radialGradient id="bg" cx="50%" cy="44%" r="60%"><stop offset="0" stop-color="${glow}"/><stop offset="100%" stop-color="#0c0918"/></radialGradient>` +
    `</defs>` +
    (background ? `<rect width="100" height="100" fill="url(#bg)"/>` : '') +
    `<g transform="translate(14,14) scale(0.72)">${markSvg}</g>` +
    `</svg>`
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

/**
 * The mark SVG as a data: URL rather than a blob: URL. Both are same-origin in
 * principle, but a blob: URL carries no headers for a browser to reason about
 * and some (Firefox especially) treat an SVG drawn from one as tainting the
 * canvas — which makes the very next toBlob/getImageData throw. A data: URL is
 * unambiguously inline, so the canvas always stays clean.
 * encodeURIComponent (not btoa) so non-ASCII in a composed monogram survives.
 */
export function sigilSvgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Rasterize a recipe to a square PNG File (built-in / composed marks). */
export async function rasterizeSigilToPng(recipe: SigilRecipe, size = 640): Promise<File> {
  const svg = buildSigilSvg(recipe, size);
  const img = await loadImage(sigilSvgDataUrl(svg));
  const cnv = document.createElement('canvas'); cnv.width = size; cnv.height = size;
  const ctx = cnv.getContext('2d')!;
  ctx.drawImage(img, 0, 0, size, size);
  const blob = await new Promise<Blob | null>((res) => cnv.toBlob(res, 'image/png'));
  if (!blob) throw new Error('rasterize produced no image');
  return new File([blob], 'sigil.png', { type: 'image/png' });
}
