/**
 * SigilStage — the Sigil Forge animation engine.
 *
 * Renders a {@link SigilRecipe} as a living, animated mark inside a square SVG
 * stage. The animation geometry is derived from the artwork itself (path
 * sampling for vector marks, pixel sampling for composed/uploaded rasters), so
 * every one of the eleven styles works on any mark — nothing is hardcoded to a
 * particular logo. This is the typed React port of the standalone prototype.
 *
 * Self-contained and StrictMode-safe: it builds/animates the SVG imperatively in
 * a useEffect and cancels every timer/frame on cleanup. All element ids are
 * per-instance (useId) so multiple stages on one page never collide.
 */

import { useEffect, useId, useRef } from 'react';
import {
  BUILTIN_MARKS,
  sanitizeRecipe,
  type SigilRecipe,
  type SigilStyle,
} from '../../shared/sigil';
import { composeMark as composeMarkShared } from '../lib/sigilCompose';

const NS = 'http://www.w3.org/2000/svg';

interface Props {
  recipe: SigilRecipe;
  /** Change this number to replay. */
  playKey?: number;
  /** Replay forever (studio preview / share page). */
  loop?: boolean;
  /** Render the finished mark instantly, with no animation — a crisp emblem for
   *  loaders, crests, and other brand-kit surfaces. */
  static?: boolean;
  onDone?: () => void;
  className?: string;
}

type Vb = [number, number, number, number];
interface Raster { w: number; h: number; data: Uint8ClampedArray | null; url: string; alphaOnly: boolean }
interface ResolvedMark { vb: Vb; paths: string[]; raster: Raster | null }

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
const lighten = (h: string, t: number) => lerpC(h, '#ffffff', t);
const darken = (h: string, t: number) => lerpC(h, '#000000', t);

/* Compose a monogram into a ResolvedMark, via the shared renderer. */
function composeMark(recipe: SigilRecipe): ResolvedMark {
  const c = composeMarkShared(recipe);
  return { vb: [0, 0, 100, 100], paths: [], raster: { w: c.w, h: c.h, data: c.data, url: c.url, alphaOnly: true } };
}

export default function SigilStage({ recipe: rawRecipe, playKey = 0, loop = false, static: staticMode = false, onDone, className }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const gradId = `sg-grad-${uid}`, haloId = `sg-halo-${uid}`, clipId = `sg-clip-${uid}`;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const svg = root.querySelector('svg')!;
    const measure = root.querySelector('.ss-measure') as SVGPathElement;
    const markG = root.querySelector('.ss-mark') as SVGGElement;
    const fxG = root.querySelector('.ss-fx') as SVGGElement;
    const halo = root.querySelector('.ss-halo') as SVGCircleElement;
    const gradEl = root.querySelector(`#${gradId}`) as SVGLinearGradientElement;

    const recipe = sanitizeRecipe(rawRecipe);
    const s = 1 / recipe.speed;
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

    let dead = false;
    let timers: number[] = [];
    let raf = 0;
    let loopTimer = 0;
    const T = (fn: () => void, ms: number) => { const id = window.setTimeout(fn, ms); timers.push(id); return id; };
    const clearAnim = () => { timers.forEach(clearTimeout); timers = []; if (raf) cancelAnimationFrame(raf); fxG.innerHTML = ''; };
    const cleanup = () => { dead = true; clearTimeout(loopTimer); clearAnim(); };

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---- gradient ---- */
    const gradStops = (): [string, string, string] =>
      recipe.twoTone
        ? [recipe.accent, lerpC(recipe.accent, recipe.accent2, 0.5), recipe.accent2]
        : [lighten(recipe.accent, 0.45), recipe.accent, darken(recipe.accent, 0.3)];
    const updateGrad = () => {
      const st = gradEl.querySelectorAll('stop'); const c = gradStops();
      if (st.length >= 3) { st[0]!.setAttribute('stop-color', c[0]); st[1]!.setAttribute('stop-color', c[1]); st[2]!.setAttribute('stop-color', c[2]); }
    };
    const pcolor = (x: number): string => {
      if (!recipe.twoTone) return recipe.accent;
      const t = Math.max(0, Math.min(1, (x - vb[0]) / (vb[2] || 1)));
      return lerpC(recipe.accent, recipe.accent2, t);
    };

    /* ---- resolve the mark ---- */
    let mark: ResolvedMark;
    if (recipe.source === 'compose') mark = composeMark(recipe);
    else {
      const m = BUILTIN_MARKS.find((x) => x.id === recipe.builtin) ?? BUILTIN_MARKS[0]!;
      mark = { vb: [0, 0, 100, 100], paths: m.paths, raster: null };
    }
    let vb: Vb = mark.vb;

    const renderMark = () => {
      svg.setAttribute('viewBox', vb.join(' '));
      markG.innerHTML = '';
      if (mark.raster) {
        const im = document.createElementNS(NS, 'image');
        im.setAttribute('href', mark.raster.url);
        im.setAttributeNS('http://www.w3.org/1999/xlink', 'href', mark.raster.url);
        im.setAttribute('x', String(vb[0])); im.setAttribute('y', String(vb[1]));
        im.setAttribute('width', String(vb[2])); im.setAttribute('height', String(vb[3]));
        im.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        (im as unknown as HTMLElement).dataset.closed = '0';
        markG.appendChild(im);
        return;
      }
      mark.paths.forEach((d) => {
        const closed = /z\s*$/i.test(d.trim());
        const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d);
        p.setAttribute('fill', closed ? `url(#${gradId})` : 'none');
        p.setAttribute('stroke', closed ? 'none' : recipe.accent);
        p.setAttribute('stroke-width', '3'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
        (p as unknown as HTMLElement).dataset.closed = closed ? '1' : '0';
        markG.appendChild(p);
      });

      // Tighten the viewBox onto the artwork itself. The built-in marks are
      // authored inside a 0..100 box but only occupy the middle ~60% of it, so
      // rendering that full box wastes roughly a third of the stage on empty
      // padding and the mark reads as small no matter how large the container
      // is. Fit to the real bounding box (plus a small margin) so the mark fills
      // whatever space it's given. Everything else is expressed relative to vb
      // — particle scatter, wipe, shimmer, the two-tone gradient — so they all
      // follow automatically. Guarded: getBBox needs layout and returns zeroes
      // if the element isn't rendered yet, in which case we keep the authored box.
      if (!mark.raster && mark.paths.length) {
        try {
          const b = markG.getBBox();
          if (b.width > 1 && b.height > 1) {
            const pad = Math.max(b.width, b.height) * 0.08;
            const side = Math.max(b.width, b.height) + pad * 2;
            // Square + centred, so preserveAspectRatio never letterboxes it.
            vb = [
              b.x + b.width / 2 - side / 2,
              b.y + b.height / 2 - side / 2,
              side,
              side,
            ];
            svg.setAttribute('viewBox', vb.join(' '));
          }
        } catch { /* no layout yet — authored box is a fine fallback */ }
      }
    };

    /* ---- sampling ---- */
    const vbRand = () => ({ x: vb[0] + Math.random() * vb[2], y: vb[1] + Math.random() * vb[3] });
    const samplePoints = (n: number): { x: number; y: number }[] => {
      const lens = mark.paths.map((d) => { measure.setAttribute('d', d); return measure.getTotalLength() || 0.001; });
      const total = lens.reduce((a, b) => a + b, 0) || 1;
      const pts: { x: number; y: number }[] = [];
      mark.paths.forEach((d, i) => {
        measure.setAttribute('d', d);
        const cnt = Math.max(4, Math.round((n * lens[i]!) / total));
        for (let k = 0; k < cnt; k++) { const pt = measure.getPointAtLength((lens[i]! * (k + 0.5)) / cnt); pts.push({ x: pt.x, y: pt.y }); }
      });
      return pts;
    };
    const sampleFilled = (n: number): { x: number; y: number }[] => {
      const closed = ([].slice.call(markG.children) as SVGPathElement[]).filter(
        (p) => (p as unknown as HTMLElement).dataset?.closed === '1' && typeof p.isPointInFill === 'function',
      );
      if (!closed.length) return samplePoints(n);
      const out: { x: number; y: number }[] = []; let tries = 0; const max = n * 60;
      while (out.length < n && tries < max) {
        tries++;
        const x = vb[0] + Math.random() * vb[2], y = vb[1] + Math.random() * vb[3];
        const pt = svg.createSVGPoint(); pt.x = x; pt.y = y;
        for (const c of closed) { if (c.isPointInFill(pt)) { out.push({ x, y }); break; } }
      }
      return out.length ? out : samplePoints(n);
    };
    const sampleRaster = (n: number): { x: number; y: number }[] => {
      const R = mark.raster!;
      const grid = () => { const g: { x: number; y: number }[] = []; for (let i = 0; i < n; i++) g.push(vbRand()); return g; };
      if (!R.data) return grid();
      const { w, h, data: d } = R; const out: { x: number; y: number }[] = []; let tries = 0; const max = n * 90;
      const M = (px: number, py: number) => ({ x: vb[0] + (px / w) * vb[2], y: vb[1] + (py / h) * vb[3] });
      while (out.length < n && tries < max) {
        tries++;
        const px = Math.floor(Math.random() * w), py = Math.floor(Math.random() * h), idx = (py * w + px) * 4;
        if ((d[idx + 3] ?? 0) < 60) continue;
        if (!R.alphaOnly) { const lum = (d[idx] ?? 0) * 0.299 + (d[idx + 1] ?? 0) * 0.587 + (d[idx + 2] ?? 0) * 0.114; if (lum > 238) continue; }
        out.push(M(px, py));
      }
      if (out.length < n * 0.3) {
        tries = 0; out.length = 0;
        while (out.length < n && tries < max) { tries++; const qx = Math.floor(Math.random() * w), qy = Math.floor(Math.random() * h); if ((d[(qy * w + qx) * 4 + 3] ?? 0) > 60) out.push(M(qx, qy)); }
      }
      return out.length ? out : grid();
    };
    const getPoints = (n: number) => (mark.raster ? sampleRaster(n) : recipe.points === 'filled' ? sampleFilled(n) : samplePoints(n));

    /* ---- fx helpers ---- */
    const mkParticle = (x: number, y: number, r: number, color?: string): SVGCircleElement => {
      const col = color || recipe.accent;
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', String(r * recipe.psize)); c.setAttribute('cx', String(x)); c.setAttribute('cy', String(y));
      c.setAttribute('fill', col); c.setAttribute('opacity', '0');
      c.style.filter = `drop-shadow(0 0 ${1.1 * recipe.glow}px ${col})`;
      fxG.appendChild(c); return c;
    };
    const ringPoints = (n: number, cx: number, cy: number, rad: number) => {
      const o: { x: number; y: number }[] = [];
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; o.push({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) }); }
      return o;
    };
    const haloIn = () => { halo.style.transition = `opacity ${1.0 * s}s ease`; halo.style.opacity = '1'; };
    const finish = () => { if (loop) scheduleLoop(); if (onDone && !dead) onDone(); };
    const scheduleLoop = () => { clearTimeout(loopTimer); if (loop && !dead) loopTimer = window.setTimeout(() => play(), Math.max(2800, 4400 / recipe.speed)); };

    /* ---- the animation ---- */
    function play() {
      if (dead) return;
      clearAnim(); renderMark(); updateGrad();
      const style: SigilStyle = recipe.style;
      const paths = [].slice.call(markG.children) as (SVGElement & { dataset: DOMStringMap })[];
      paths.forEach((p) => { p.style.transition = 'none'; p.style.opacity = '0'; });
      halo.style.transition = 'none'; halo.style.opacity = '0';
      markG.removeAttribute('clip-path');

      if (reduce) { paths.forEach((p) => (p.style.opacity = '1')); halo.style.opacity = '1'; finish(); return; }
      const isRaster = !!mark.raster;

      if (style === 'draw') {
        if (isRaster) { haloIn(); paths.forEach((p) => { p.style.transition = `opacity ${0.8 * s}s ease`; p.style.opacity = '1'; }); T(finish, 900 * s); return; }
        paths.forEach((p, i) => {
          const path = p as unknown as SVGPathElement; const len = path.getTotalLength();
          p.setAttribute('stroke', recipe.accent); p.setAttribute('fill', 'none');
          p.style.strokeDasharray = String(len); p.style.strokeDashoffset = String(len); p.style.opacity = '1';
          p.style.transition = `stroke-dashoffset ${0.9 * s}s ease ${i * 0.12 * s}s`;
          requestAnimationFrame(() => { p.style.strokeDashoffset = '0'; });
        });
        T(() => {
          haloIn();
          paths.forEach((p) => { if (p.dataset.closed === '1') { p.style.transition = `fill ${0.6 * s}s ease`; p.setAttribute('fill', `url(#${gradId})`); } });
          finish();
        }, (900 + paths.length * 120 + 300) * s);
        return;
      }

      if (style === 'glitch') {
        const cloneGroup = (color: string) => {
          const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'extra'); g.style.mixBlendMode = 'screen'; g.setAttribute('opacity', '0.9');
          paths.forEach((p) => { if (p.dataset.closed !== '1') return; const c = p.cloneNode(false) as SVGElement; c.setAttribute('fill', color); c.setAttribute('stroke', 'none'); c.style.opacity = '1'; g.appendChild(c); });
          fxG.appendChild(g); return g;
        };
        const gA = cloneGroup('#00e6ff'), gB = cloneGroup('#ff2d7a');
        paths.forEach((p) => (p.style.opacity = '0.4'));
        const t0 = performance.now(), durMs = 760 * s;
        const jitter = (ts: number) => {
          if (dead) return;
          const k = (ts - t0) / durMs;
          if (k >= 1) {
            gA.setAttribute('transform', ''); gB.setAttribute('transform', ''); haloIn();
            paths.forEach((p) => { p.style.transition = `opacity ${0.22 * s}s ease`; p.style.opacity = '1'; });
            T(() => { gA.style.transition = gB.style.transition = `opacity ${0.3 * s}s`; gA.setAttribute('opacity', '0'); gB.setAttribute('opacity', '0'); }, 60 * s);
            finish(); return;
          }
          const amp = (1 - k) * 3.4, jx = () => (Math.random() * 2 - 1) * amp;
          gA.setAttribute('transform', `translate(${-amp * 0.6 + jx() * 0.4},${jx() * 0.5})`);
          gB.setAttribute('transform', `translate(${amp * 0.6 + jx() * 0.4},${jx() * 0.5})`);
          paths.forEach((p) => (p.style.opacity = Math.random() < 0.5 ? '0.18' : '0.55'));
          raf = requestAnimationFrame(jitter);
        };
        raf = requestAnimationFrame(jitter);
        return;
      }

      if (style === 'wipe') {
        const defs = svg.querySelector('defs')!;
        let cp = svg.querySelector(`#${clipId}`) as SVGClipPathElement | null;
        if (!cp) { cp = document.createElementNS(NS, 'clipPath'); cp.setAttribute('id', clipId); cp.setAttribute('clipPathUnits', 'userSpaceOnUse'); const rr = document.createElementNS(NS, 'rect'); rr.setAttribute('class', 'ss-wiperect'); cp.appendChild(rr); defs.appendChild(cp); }
        const rect = cp.querySelector('.ss-wiperect') as SVGRectElement;
        rect.setAttribute('x', String(vb[0])); rect.setAttribute('y', String(vb[1])); rect.setAttribute('height', String(vb[3])); rect.setAttribute('width', '0');
        markG.setAttribute('clip-path', `url(#${clipId})`);
        paths.forEach((p) => (p.style.opacity = '1'));
        const edge = document.createElementNS(NS, 'rect'); edge.setAttribute('class', 'extra'); edge.setAttribute('y', String(vb[1])); edge.setAttribute('height', String(vb[3])); edge.setAttribute('width', '1.4'); edge.setAttribute('fill', '#fff'); edge.setAttribute('opacity', '0'); edge.style.filter = `drop-shadow(0 0 3px ${recipe.accent})`; fxG.appendChild(edge);
        haloIn();
        let w0 = 0;
        const wstep = (ts: number) => {
          if (dead) return; if (!w0) w0 = ts;
          const t = Math.min(1, (ts - w0) / (1000 * s)), e = 1 - Math.pow(1 - t, 2), w = vb[2] * e;
          rect.setAttribute('width', String(w)); edge.setAttribute('x', String(vb[0] + w - 0.7)); edge.setAttribute('opacity', t > 0.02 && t < 0.96 ? '0.9' : '0');
          if (t < 1) raf = requestAnimationFrame(wstep); else { markG.removeAttribute('clip-path'); finish(); }
        };
        T(() => { w0 = 0; raf = requestAnimationFrame(wstep); }, 120 * s);
        return;
      }

      if (style === 'shimmer') {
        if (isRaster) { haloIn(); paths.forEach((p) => { p.style.transition = `opacity ${0.8 * s}s ease`; p.style.opacity = '1'; }); T(finish, 900 * s); return; }
        const cx2 = vb[0] + vb[2] / 2, cy2 = vb[1] + vb[3] / 2, defs2 = svg.querySelector('defs')!;
        paths.forEach((p) => { p.style.transition = `opacity ${0.4 * s}s`; p.style.opacity = '0.28'; });
        haloIn();
        const scId = `${clipId}-sh`;
        let cp2 = svg.querySelector(`#${scId}`) as SVGClipPathElement | null;
        if (!cp2) { cp2 = document.createElementNS(NS, 'clipPath'); cp2.setAttribute('id', scId); cp2.setAttribute('clipPathUnits', 'userSpaceOnUse'); const r2 = document.createElementNS(NS, 'rect'); r2.setAttribute('class', 'ss-shimrect'); cp2.appendChild(r2); defs2.appendChild(cp2); }
        const srect = cp2.querySelector('.ss-shimrect') as SVGRectElement, bandW = vb[2] * 0.3;
        srect.setAttribute('y', String(vb[1] - vb[3])); srect.setAttribute('width', String(bandW)); srect.setAttribute('height', String(vb[3] * 3));
        srect.setAttribute('transform', `rotate(18 ${cx2} ${cy2})`);
        const g2 = document.createElementNS(NS, 'g'); g2.setAttribute('class', 'extra'); g2.setAttribute('clip-path', `url(#${scId})`);
        paths.forEach((p) => { if (p.dataset.closed !== '1') return; const c = p.cloneNode(false) as SVGElement; c.setAttribute('fill', '#fff'); c.setAttribute('stroke', 'none'); c.style.opacity = '0.95'; g2.appendChild(c); });
        fxG.appendChild(g2);
        let sp0 = 0; const span = vb[2] + bandW * 2;
        const sstep = (ts: number) => {
          if (dead) return; if (!sp0) sp0 = ts;
          const t = Math.min(1, (ts - sp0) / (1150 * s)); srect.setAttribute('x', String(vb[0] - bandW + t * span));
          if (t < 1) raf = requestAnimationFrame(sstep); else { g2.style.transition = `opacity ${0.3 * s}s`; g2.setAttribute('opacity', '0'); paths.forEach((p) => { p.style.transition = `opacity ${0.5 * s}s`; p.style.opacity = '1'; }); finish(); }
        };
        T(() => { sp0 = 0; raf = requestAnimationFrame(sstep); }, 150 * s);
        return;
      }

      if (style === 'morph') {
        const mcx = vb[0] + vb[2] / 2, mcy = vb[1] + vb[3] / 2, mrad = Math.min(vb[2], vb[3]) * 0.34;
        const tgt = getPoints(recipe.density), ring = ringPoints(tgt.length, mcx, mcy, mrad);
        const mp = tgt.map((p, i) => { const st = vbRand(); const rp = ring[i % ring.length]!; return { x: p.x, y: p.y, rx: rp.x, ry: rp.y, sx: st.x, sy: st.y, cx: 0, cy: 0, el: mkParticle(st.x, st.y, 0.85) }; });
        mp.forEach((n, i) => T(() => { n.el.style.transition = `opacity ${0.4 * s}s`; n.el.setAttribute('opacity', '0.85'); }, Math.min(500, i * 3) * s));
        let m0 = 0;
        const toRing = (ts: number) => {
          if (dead) return; if (!m0) m0 = ts; const t = Math.min(1, (ts - m0) / (820 * s)), e = easeOut(t);
          mp.forEach((n) => { n.el.setAttribute('cx', String(n.sx + (n.rx - n.sx) * e)); n.el.setAttribute('cy', String(n.sy + (n.ry - n.sy) * e)); });
          if (t < 1) raf = requestAnimationFrame(toRing); else spin();
        };
        const spin = () => {
          let s0 = 0;
          const rot = (ts: number) => {
            if (dead) return; if (!s0) s0 = ts; const t = Math.min(1, (ts - s0) / (520 * s)), ang = t * Math.PI * 0.6;
            mp.forEach((n) => { const dx = n.rx - mcx, dy = n.ry - mcy, c = Math.cos(ang), si = Math.sin(ang); n.el.setAttribute('cx', String(mcx + dx * c - dy * si)); n.el.setAttribute('cy', String(mcy + dx * si + dy * c)); });
            if (t < 1) raf = requestAnimationFrame(rot); else { mp.forEach((n) => { n.cx = +n.el.getAttribute('cx')!; n.cy = +n.el.getAttribute('cy')!; }); T(toMark, 80 * s); }
          };
          raf = requestAnimationFrame(rot);
        };
        const toMark = () => {
          let f0 = 0;
          const step = (ts: number) => {
            if (dead) return; if (!f0) f0 = ts; const t = Math.min(1, (ts - f0) / (950 * s)), e = easeOut(t);
            mp.forEach((n) => { n.el.setAttribute('cx', String(n.cx + (n.x - n.cx) * e)); n.el.setAttribute('cy', String(n.cy + (n.y - n.cy) * e)); });
            if (t < 1) raf = requestAnimationFrame(step); else { haloIn(); paths.forEach((p) => { p.style.transition = `opacity ${0.7 * s}s`; p.style.opacity = '1'; }); T(() => mp.forEach((n) => { n.el.style.transition = `opacity ${0.6 * s}s`; n.el.setAttribute('opacity', '0'); }), 220 * s); finish(); }
          };
          raf = requestAnimationFrame(step);
        };
        T(() => { m0 = 0; raf = requestAnimationFrame(toRing); }, 480 * s);
        return;
      }

      if (style === 'dissolve') {
        const pd = getPoints(recipe.density).map((p) => ({ el: mkParticle(p.x, p.y, 0.85, pcolor(p.x)) }));
        pd.forEach((n) => T(() => { n.el.style.transition = 'opacity .3s ease'; n.el.setAttribute('opacity', (0.25 + Math.random() * 0.6).toFixed(2)); }, Math.random() * 760 * s));
        T(() => { haloIn(); paths.forEach((p) => { p.style.transition = `opacity ${0.8 * s}s ease`; p.style.opacity = '1'; }); T(() => pd.forEach((n) => { n.el.style.transition = 'opacity .6s'; n.el.setAttribute('opacity', '0'); }), 240 * s); finish(); }, 1000 * s);
        return;
      }

      if (style === 'swirl') {
        const cxS = vb[0] + vb[2] / 2, cyS = vb[1] + vb[3] / 2;
        const ps = getPoints(recipe.density).map((p) => { const a0 = Math.atan2(p.y - cyS, p.x - cxS), r0 = Math.hypot(p.x - cxS, p.y - cyS) || 1, sa = a0 + Math.PI * 2, sr = r0 * 2.3; return { x: p.x, a0, r0, el: mkParticle(cxS + sr * Math.cos(sa), cyS + sr * Math.sin(sa), 0.85, pcolor(p.x)) }; });
        ps.forEach((n, i) => T(() => { n.el.style.transition = 'opacity .4s'; n.el.setAttribute('opacity', '0.85'); }, Math.min(500, i * 3) * s));
        let t0 = 0; const dur = 1250 * s;
        const sw = (ts: number) => {
          if (dead) return; if (!t0) t0 = ts; const t = Math.min(1, (ts - t0) / dur), e = easeOut(t);
          ps.forEach((n) => { const ang = n.a0 + Math.PI * 2 * (1 - e), rad = n.r0 * (1 + 1.3 * (1 - e)); n.el.setAttribute('cx', String(cxS + rad * Math.cos(ang))); n.el.setAttribute('cy', String(cyS + rad * Math.sin(ang))); });
          if (t < 1) raf = requestAnimationFrame(sw); else { haloIn(); paths.forEach((p) => { p.style.transition = `opacity ${0.7 * s}s`; p.style.opacity = '1'; }); T(() => ps.forEach((n) => { n.el.style.transition = 'opacity .6s'; n.el.setAttribute('opacity', '0'); }), 220 * s); finish(); }
        };
        T(() => { t0 = 0; raf = requestAnimationFrame(sw); }, 500 * s);
        return;
      }

      if (style === 'typewriter') {
        const pt2 = getPoints(recipe.density).map((p) => ({ x: p.x, el: mkParticle(p.x, p.y, 0.85, pcolor(p.x)) }));
        pt2.sort((a, b) => a.x - b.x);
        pt2.forEach((n, i) => T(() => { n.el.style.transition = 'opacity .18s'; n.el.setAttribute('opacity', '0.9'); }, (i / pt2.length) * 1150 * s));
        T(() => { haloIn(); paths.forEach((p) => { p.style.transition = `opacity ${0.7 * s}s`; p.style.opacity = '1'; }); T(() => pt2.forEach((n) => { n.el.style.transition = 'opacity .6s'; n.el.setAttribute('opacity', '0'); }), 220 * s); finish(); }, 1350 * s);
        return;
      }

      if (style === 'unfold') {
        haloIn();
        paths.forEach((p) => {
          p.style.transition = 'none'; p.style.transformBox = 'fill-box'; p.style.transformOrigin = 'center'; p.style.transform = 'scaleX(0.02) rotate(-6deg)'; p.style.opacity = '1';
          requestAnimationFrame(() => { p.style.transition = `transform ${0.9 * s}s cubic-bezier(.2,.9,.3,1.2)`; p.style.transform = 'scaleX(1) rotate(0deg)'; });
        });
        T(finish, 1000 * s);
        return;
      }

      // assemble + constellation
      const pts = getPoints(recipe.density).map((p) => { const st = vbRand(); return { x: p.x, y: p.y, sx: st.x, sy: st.y, el: mkParticle(st.x, st.y, style === 'constellation' ? 0.9 : 0.8, pcolor(p.x)) }; });
      pts.forEach((n, i) => T(() => { n.el.style.transition = `opacity ${0.4 * s}s`; n.el.setAttribute('opacity', style === 'constellation' ? '0.9' : '0.85'); }, Math.min(600, i * 4) * s));
      let t0 = 0; const dur = 1100 * s;
      const travel = (ts: number) => {
        if (dead) return; if (!t0) t0 = ts; const t = Math.min(1, (ts - t0) / dur), e = easeOut(t);
        pts.forEach((n) => { n.el.setAttribute('cx', String(n.sx + (n.x - n.sx) * e)); n.el.setAttribute('cy', String(n.sy + (n.y - n.sy) * e)); });
        if (t < 1) raf = requestAnimationFrame(travel); else settle();
      };
      const settle = () => {
        haloIn();
        if (style === 'constellation') {
          pts.forEach((n) => { n.el.setAttribute('r', String(1.15 * recipe.psize)); n.el.setAttribute('opacity', '1'); });
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i]!; let b0 = { d: 1e9, p: null as (typeof pts)[number] | null }, b1 = { d: 1e9, p: null as (typeof pts)[number] | null };
            for (let j = 0; j < pts.length; j++) {
              if (j === i) continue; const q = pts[j]!; const dx = q.x - a.x, dy = q.y - a.y, dd = dx * dx + dy * dy;
              if (dd < b0.d) { b1 = b0; b0 = { d: dd, p: q }; } else if (dd < b1.d) { b1 = { d: dd, p: q }; }
            }
            [b0.p, b1.p].forEach((q) => {
              if (!q) return; const l = document.createElementNS(NS, 'line');
              l.setAttribute('x1', String(a.x)); l.setAttribute('y1', String(a.y)); l.setAttribute('x2', String(q.x)); l.setAttribute('y2', String(q.y));
              l.setAttribute('stroke', recipe.accent); l.setAttribute('stroke-width', '0.45'); l.setAttribute('stroke-opacity', '0.5');
              fxG.insertBefore(l, fxG.firstChild);
            });
          }
          paths.forEach((p) => { p.style.transition = `opacity ${0.5 * s}s ease`; p.style.opacity = '0'; });
        } else {
          paths.forEach((p) => { p.style.transition = `opacity ${0.7 * s}s ease`; p.style.opacity = '1'; });
          T(() => pts.forEach((n) => { n.el.style.transition = `opacity ${0.6 * s}s`; n.el.setAttribute('opacity', '0'); }), 220 * s);
        }
        finish();
      };
      T(() => { t0 = 0; raf = requestAnimationFrame(travel); }, 620 * s);
    }

    // Static mode: render the finished mark instantly (emblem), no particles.
    const revealStatic = () => {
      renderMark(); updateGrad();
      halo.style.transition = 'none'; halo.style.opacity = '1';
      if (onDone && !dead) onDone();
    };
    const start = () => (staticMode ? revealStatic() : play());

    // For an uploaded image, load + sample first, then animate. Otherwise go now.
    if (recipe.source === 'image' && recipe.imageUrl) {
      const image = new Image(); image.crossOrigin = 'anonymous';
      image.onload = () => {
        if (dead) return;
        try {
          const MAX = 200, k = MAX / Math.max(image.width, image.height);
          const cw = Math.max(1, Math.round(image.width * k)), ch = Math.max(1, Math.round(image.height * k));
          const cnv = document.createElement('canvas'); cnv.width = cw; cnv.height = ch;
          const cx = cnv.getContext('2d')!; cx.drawImage(image, 0, 0, cw, ch);
          let data: Uint8ClampedArray | null = null;
          try { data = cx.getImageData(0, 0, cw, ch).data; } catch { data = null; }
          mark = { vb: [0, 0, cw, ch], paths: [], raster: { w: cw, h: ch, data, url: recipe.imageUrl, alphaOnly: false } };
          vb = mark.vb;
        } catch { /* keep default builtin fallback */ }
        start();
      };
      image.onerror = () => { if (!dead) { const m = BUILTIN_MARKS[0]!; mark = { vb: [0, 0, 100, 100], paths: m.paths, raster: null }; vb = mark.vb; start(); } };
      image.src = recipe.imageUrl;
    } else if (staticMode) {
      revealStatic();
    } else {
      renderMark();
      T(play, 60);
    }

    return cleanup;
  }, [rawRecipe, playKey, loop, staticMode, onDone, gradId, haloId, clipId]);

  return (
    <div className={`sigilstage${className ? ' ' + className : ''}`} ref={rootRef}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#e8d6ff" /><stop offset="0.5" stopColor="#a678e6" /><stop offset="1" stopColor="#6b46c8" />
          </linearGradient>
          <radialGradient id={haloId} cx="50%" cy="46%" r="55%">
            <stop offset="0" stopColor="rgba(150,110,240,0.4)" /><stop offset="60%" stopColor="rgba(120,80,210,0.12)" /><stop offset="100%" stopColor="rgba(0,0,0,0)" />
          </radialGradient>
        </defs>
        <circle className="ss-halo" cx="50" cy="46" r="52" fill={`url(#${haloId})`} opacity="0" />
        <path className="ss-measure" fill="none" stroke="none" />
        <g className="ss-mark" />
        <g className="ss-fx" />
      </svg>
    </div>
  );
}
