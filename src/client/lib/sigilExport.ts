/**
 * Animated GIF export — turn a sigil recipe into a downloadable, looping GIF,
 * entirely in the browser. Zero server overhead, and a universal format that
 * plays anywhere (Discord, X, everywhere).
 *
 * Unlike the live SVG engine (which animates via rAF + CSS transitions, and so
 * can't be frame-captured reliably), this is a DETERMINISTIC canvas renderer: an
 * explicit renderFrame(t) that computes every particle's position at normalised
 * time t and draws it. That makes capture exact and reproducible — we step t from
 * 0→1, draw each frame, and hand the pixels to gifenc (a pure-JS encoder, no web
 * worker). A small "mustr" watermark is baked in for the share loop.
 *
 * Marks are sampled once up front: built-in marks via SVG path geometry
 * (getPointAtLength / isPointInFill), composed/uploaded marks via their pixels.
 * Everything stays same-origin so the capture canvas never taints.
 */

import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { BUILTIN_MARKS, type SigilRecipe, type SigilStyle } from '../../shared/sigil';
import { composeMark } from './sigilCompose';
import { buildSigilSvg } from './sigilRaster';

const NS = 'http://www.w3.org/2000/svg';
const INSET = 14, SCALE = 0.72; // matches buildSigilSvg's mark group

interface Pt { x: number; y: number; sx: number; sy: number }

/* ---- colour helpers ---- */
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

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // No crossOrigin: every image this loads is same-origin (recipe.imageUrl)
    // or a same-origin blob: URL (the rendered mark SVG) — blob: URLs carry no
    // HTTP headers to satisfy a CORS check, so requesting "anonymous" mode on
    // one taints the canvas in some browsers instead of the request just
    // succeeding, which is what broke GIF export for built-in/composed marks.
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

/* ---- sampling: mark → target points in 0..100 space ---- */
function sampleVector(recipe: SigilRecipe, n: number): { x: number; y: number }[] {
  const m = BUILTIN_MARKS.find((x) => x.id === recipe.builtin) ?? BUILTIN_MARKS[0]!;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;left:-9999px');
  document.body.appendChild(svg);
  try {
    if (recipe.points === 'filled') {
      const closed = m.paths
        .filter((d) => /z\s*$/i.test(d.trim()))
        .map((d) => { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.appendChild(p); return p; });
      if (closed.length) {
        const out: { x: number; y: number }[] = []; let tries = 0; const max = n * 60;
        while (out.length < n && tries < max) {
          tries++;
          const x = Math.random() * 100, y = Math.random() * 100;
          const pt = svg.createSVGPoint(); pt.x = x; pt.y = y;
          for (const c of closed) { if (c.isPointInFill(pt)) { out.push({ x, y }); break; } }
        }
        if (out.length) return out;
      }
    }
    const measure = document.createElementNS(NS, 'path'); svg.appendChild(measure);
    const lens = m.paths.map((d) => { measure.setAttribute('d', d); return measure.getTotalLength() || 0.001; });
    const total = lens.reduce((a, b) => a + b, 0) || 1;
    const pts: { x: number; y: number }[] = [];
    m.paths.forEach((d, i) => {
      measure.setAttribute('d', d);
      const cnt = Math.max(4, Math.round((n * lens[i]!) / total));
      for (let k = 0; k < cnt; k++) { const q = measure.getPointAtLength((lens[i]! * (k + 0.5)) / cnt); pts.push({ x: q.x, y: q.y }); }
    });
    return pts;
  } finally {
    document.body.removeChild(svg);
  }
}

async function sampleRaster(recipe: SigilRecipe, n: number): Promise<{ x: number; y: number }[]> {
  const rnd = () => { const g: { x: number; y: number }[] = []; for (let i = 0; i < n; i++) g.push({ x: Math.random() * 100, y: Math.random() * 100 }); return g; };
  let data: Uint8ClampedArray | null = null, w = 0, h = 0, alphaOnly = true;
  if (recipe.source === 'compose') {
    const c = composeMark(recipe); data = c.data; w = c.w; h = c.h; alphaOnly = true;
  } else {
    const img = await loadImage(recipe.imageUrl);
    const MAX = 220, k = MAX / Math.max(img.width, img.height);
    w = Math.max(1, Math.round(img.width * k)); h = Math.max(1, Math.round(img.height * k));
    const cnv = document.createElement('canvas'); cnv.width = w; cnv.height = h;
    const cx = cnv.getContext('2d')!; cx.drawImage(img, 0, 0, w, h);
    try { data = cx.getImageData(0, 0, w, h).data; } catch { data = null; }
    alphaOnly = false;
  }
  if (!data) return rnd();
  const out: { x: number; y: number }[] = []; let tries = 0; const max = n * 90;
  while (out.length < n && tries < max) {
    tries++;
    const px = Math.floor(Math.random() * w), py = Math.floor(Math.random() * h), idx = (py * w + px) * 4;
    if ((data[idx + 3] ?? 0) < 60) continue;
    if (!alphaOnly) { const lum = (data[idx] ?? 0) * 0.299 + (data[idx + 1] ?? 0) * 0.587 + (data[idx + 2] ?? 0) * 0.114; if (lum > 238) continue; }
    out.push({ x: (px / w) * 100, y: (py / h) * 100 });
  }
  return out.length ? out : rnd();
}

interface Scene {
  size: number;
  style: SigilStyle;
  recipe: SigilRecipe;
  points: Pt[];
  markImg: HTMLImageElement;
  imageMode: boolean; // draw markImg inset (uploaded logo) vs full (SVG already inset)
  neighbours: [number, number][]; // constellation lines (index pairs)
}

async function buildScene(recipe: SigilRecipe, size: number): Promise<Scene> {
  const n = recipe.density;
  const raw = recipe.source === 'builtin' ? sampleVector(recipe, n) : await sampleRaster(recipe, n);
  // Inset the targets into the same box the reveal image occupies.
  const points: Pt[] = raw.map((p) => ({
    x: INSET + p.x * SCALE,
    y: INSET + p.y * SCALE,
    sx: Math.random() * 100,
    sy: Math.random() * 100,
  }));

  const imageMode = recipe.source === 'image';
  const markImg = imageMode
    ? await loadImage(recipe.imageUrl)
    : await loadImage(URL.createObjectURL(new Blob([buildSigilSvg(recipe, size, { background: false })], { type: 'image/svg+xml' })));

  // Nearest-neighbour pairs for constellation (computed once, on the settled shape).
  const neighbours: [number, number][] = [];
  if (recipe.style === 'constellation') {
    for (let i = 0; i < points.length; i++) {
      let bd = 1e9, bj = -1;
      const a = points[i]!;
      for (let j = 0; j < points.length; j++) {
        if (j === i) continue; const b = points[j]!; const dx = b.x - a.x, dy = b.y - a.y, dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; bj = j; }
      }
      if (bj >= 0) neighbours.push([i, bj]);
    }
  }
  return { size, style: recipe.style, recipe, points, markImg, imageMode, neighbours };
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Particle position + opacity at normalised time t, per style. */
function particleAt(p: Pt, i: number, count: number, style: SigilStyle, t: number): { x: number; y: number; op: number } {
  const GATHER = 0.66;
  // per-style travel progress
  let travel: number;
  if (style === 'dissolve') {
    travel = 1; // materialise at target
  } else if (style === 'typewriter') {
    const norm = p.x / 100; // left→right stagger by target x
    travel = clamp01((t / GATHER - norm * 0.6) / (1 - norm * 0.6 || 1));
  } else {
    const stagger = Math.min(0.25, (i / Math.max(1, count)) * 0.25);
    travel = clamp01((t / GATHER - stagger) / (1 - stagger));
  }
  const e = easeOut(travel);

  let x: number, y: number;
  if (style === 'swirl') {
    const cx = INSET + 50 * SCALE, cy = INSET + 50 * SCALE;
    const a0 = Math.atan2(p.y - cy, p.x - cx), r0 = Math.hypot(p.x - cx, p.y - cy) || 1;
    const ang = a0 + Math.PI * 2 * (1 - e), rad = r0 * (1 + 1.3 * (1 - e));
    x = cx + rad * Math.cos(ang); y = cy + rad * Math.sin(ang);
  } else if (style === 'dissolve') {
    x = p.x; y = p.y;
  } else {
    x = p.sx + (p.x - p.sx) * e; y = p.sy + (p.y - p.sy) * e;
  }

  // opacity: fade in early, then fade out after the gather (constellation keeps them)
  let op: number;
  if (style === 'dissolve') {
    op = t < GATHER ? 0.3 + 0.6 * Math.abs(Math.sin((i + t * 30) * 1.7)) : 1;
  } else {
    op = clamp01(t / 0.12);
  }
  const fade = style === 'constellation' ? 0 : clamp01((t - GATHER) / 0.16);
  op *= 1 - fade;
  return { x, y, op };
}

function drawWatermark(ctx: CanvasRenderingContext2D, S: number) {
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#c9a2ff';
  ctx.font = `600 ${Math.round(S * 0.045)}px system-ui,-apple-system,Segoe UI,Roboto,sans-serif`;
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText('mustr', S - S * 0.04, S - S * 0.035);
  ctx.restore();
}

function drawFrame(ctx: CanvasRenderingContext2D, sc: Scene, t: number) {
  const S = sc.size, k = S / 100, r = sc.recipe;
  // background
  const bg = ctx.createRadialGradient(S * 0.5, S * 0.44, 0, S * 0.5, S * 0.44, S * 0.62);
  bg.addColorStop(0, lerpC(r.accent, '#000000', 0.5));
  bg.addColorStop(1, '#0c0918');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, S, S);

  const GATHER = 0.66;
  const markAlpha = sc.style === 'constellation' ? 0 : clamp01((t - (GATHER - 0.04)) / 0.22);

  // particles
  const baseR = (sc.style === 'constellation' ? 1.05 : 0.85) * r.psize * k;
  for (let i = 0; i < sc.points.length; i++) {
    const p = sc.points[i]!;
    const { x, y, op } = particleAt(p, i, sc.points.length, sc.style, t);
    if (op <= 0.02) continue;
    const col = r.twoTone ? lerpC(r.accent, r.accent2, clamp01((p.x - INSET) / (100 * SCALE || 1))) : r.accent;
    ctx.globalAlpha = op;
    ctx.fillStyle = col;
    ctx.shadowColor = col; ctx.shadowBlur = 1.1 * r.glow * k;
    ctx.beginPath(); ctx.arc(x * k, y * k, baseR, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;

  // constellation wireframe after the gather
  if (sc.style === 'constellation') {
    const lineA = clamp01((t - GATHER) / 0.2);
    if (lineA > 0) {
      ctx.strokeStyle = r.accent; ctx.globalAlpha = 0.5 * lineA; ctx.lineWidth = 0.45 * k;
      ctx.beginPath();
      for (const [i, j] of sc.neighbours) {
        const a = sc.points[i]!, b = sc.points[j]!;
        ctx.moveTo(a.x * k, a.y * k); ctx.lineTo(b.x * k, b.y * k);
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
  } else if (markAlpha > 0) {
    // reveal the finished mark
    ctx.globalAlpha = markAlpha;
    if (sc.imageMode) {
      const box = 72 * k, off = INSET * k;
      ctx.drawImage(sc.markImg, off, off, box, box);
    } else {
      ctx.drawImage(sc.markImg, 0, 0, S, S);
    }
    ctx.globalAlpha = 1;
  }

  drawWatermark(ctx, S);
}

export interface GifOptions {
  size?: number;
  frames?: number;
  fps?: number;
  onProgress?: (fraction: number) => void;
}

/** Render + encode the sigil to an animated GIF Blob. */
export async function exportSigilGif(recipe: SigilRecipe, opts: GifOptions = {}): Promise<Blob> {
  const size = opts.size ?? 360;
  const frames = opts.frames ?? 44;
  const fps = opts.fps ?? 20;
  const delay = Math.round(1000 / fps);

  const sc = await buildScene(recipe, size);
  const cnv = document.createElement('canvas'); cnv.width = size; cnv.height = size;
  const ctx = cnv.getContext('2d', { willReadFrequently: true })!;

  // One global palette from the fully-revealed final frame → stable colours, no
  // per-frame flicker, faster encode.
  drawFrame(ctx, sc, 1);
  const palette = quantize(ctx.getImageData(0, 0, size, size).data, 256);

  const gif = GIFEncoder();
  for (let i = 0; i < frames; i++) {
    const t = i / (frames - 1);
    drawFrame(ctx, sc, t);
    const data = ctx.getImageData(0, 0, size, size).data;
    const index = applyPalette(data, palette);
    gif.writeFrame(index, size, size, { palette: i === 0 ? palette : undefined, delay });
    opts.onProgress?.((i + 1) / frames);
    // Yield so the UI can paint progress and the tab stays responsive.
    if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  gif.finish();
  // Copy into a fresh ArrayBuffer-backed array so it's a valid BlobPart.
  return new Blob([new Uint8Array(gif.bytes())], { type: 'image/gif' });
}
