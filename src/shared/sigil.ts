/**
 * The "sigil recipe" — a small, self-contained description of an animated mark:
 * where the artwork comes from (a built-in mark, a composed monogram, or an
 * uploaded image), how it animates, and how it's tuned. This is the single model
 * the Sigil Forge studio edits AND the payload a share link carries.
 *
 * The whole point of the recipe: it's tiny (a few hundred bytes), so a *generated*
 * sigil (built-in or composed) fits entirely inside a URL — the share page reads
 * it back and renders the animation client-side with ZERO server storage. The URL
 * is the database.
 *
 * Security: on the public share page this comes straight from the URL, i.e. from
 * an attacker. `sanitizeRecipe` is the trust boundary — every enum is checked,
 * every number clamped, initials stripped to a short safe string, and an
 * `image` source is NEVER honored from a link (an uploaded image can't ride in a
 * URL anyway, and we won't fetch an arbitrary attacker-supplied image URL).
 */

export type SigilSource = 'builtin' | 'compose' | 'image';
export type SigilStyle =
  | 'assemble'
  | 'draw'
  | 'constellation'
  | 'morph'
  | 'glitch'
  | 'wipe'
  | 'shimmer'
  | 'dissolve'
  | 'swirl'
  | 'typewriter'
  | 'unfold';
export type SigilFrame = 'none' | 'circle' | 'shield' | 'hex' | 'diamond' | 'rounded' | 'banner';
export type SigilEmblem = 'none' | 'star' | 'swords' | 'bolt' | 'ring' | 'crown' | 'flame' | 'rocket' | 'gem';
export type SigilPos = 'behind' | 'top' | 'bottom';
export type SigilPoints = 'outline' | 'filled';

export const SIGIL_STYLES: SigilStyle[] = [
  'assemble', 'draw', 'constellation', 'morph', 'glitch', 'wipe',
  'shimmer', 'dissolve', 'swirl', 'typewriter', 'unfold',
];
export const SIGIL_FRAMES: SigilFrame[] = ['none', 'circle', 'shield', 'hex', 'diamond', 'rounded', 'banner'];
export const SIGIL_EMBLEMS: SigilEmblem[] = ['none', 'star', 'swords', 'bolt', 'ring', 'crown', 'flame', 'rocket', 'gem'];
export const SIGIL_POSITIONS: SigilPos[] = ['behind', 'top', 'bottom'];

/** Built-in vector marks (viewBox 0 0 100 100). Ids are stable — used in share links. */
export const BUILTIN_MARKS: { id: string; name: string; paths: string[] }[] = [
  { id: 'sigilm', name: 'Sigil M', paths: ['M20,82 L20,18 L34,18 L50,44 L66,18 L80,18 L80,82 L67,82 L67,42 L52,64 L48,64 L33,42 L33,82 Z'] },
  { id: 'shield', name: 'Shield', paths: ['M50,13 L83,24 L83,52 C83,74 68,87 50,93 C32,87 17,74 17,52 L17,24 Z'] },
  { id: 'compass', name: 'Compass', paths: ['M50,6 L58,42 L94,50 L58,58 L50,94 L42,58 L6,50 L42,42 Z', 'M50,26 L61,50 L50,74 L39,50 Z'] },
  { id: 'rune', name: 'Rune', paths: ['M50,8 L88,30 L88,70 L50,92 L12,70 L12,30 Z', 'M50,30 L70,42 L70,58 L50,70 L30,58 L30,42 Z', 'M50,42 L50,58'] },
  { id: 'bolt', name: 'Bolt', paths: ['M56,8 L28,54 L46,54 L40,92 L74,40 L54,40 Z'] },
  { id: 'gem', name: 'Gem', paths: ['M50,10 L80,40 L50,92 L20,40 Z', 'M20,40 L80,40', 'M50,10 L50,40', 'M35,40 L50,92', 'M65,40 L50,92'] },
  // Two congruent triangles that share the centre (50,50) so they interlock into
  // a symmetric Star of David — up-triangle apex top / base at y=72, down-triangle
  // apex bottom / base at y=28. Each centroid lands exactly on 50,50.
  { id: 'hexstar', name: 'Hexstar', paths: ['M50,6 L88,72 L12,72 Z', 'M50,94 L88,28 L12,28 Z'] },
];

export const SIGIL_SWATCHES = ['#8b5cf6', '#38e1c0', '#ffb020', '#ff5d7d', '#5b8cff', '#c9a2ff'];

export interface SigilRecipe {
  source: SigilSource;
  /** Built-in mark id when source==='builtin'. */
  builtin: string;
  /** Compose fields (source==='compose'). */
  initials: string;
  frame: SigilFrame;
  emblem: SigilEmblem;
  pos: SigilPos;
  /** Uploaded image URL (source==='image'). Never encoded into a share link. */
  imageUrl: string;
  /** Animation. */
  style: SigilStyle;
  points: SigilPoints;
  speed: number;
  density: number;
  glow: number;
  psize: number;
  accent: string;
  accent2: string;
  twoTone: boolean;
}

export const DEFAULT_RECIPE: SigilRecipe = {
  source: 'builtin',
  builtin: 'sigilm',
  initials: 'MU',
  frame: 'shield',
  emblem: 'none',
  pos: 'behind',
  imageUrl: '',
  style: 'assemble',
  points: 'outline',
  speed: 1,
  density: 120,
  glow: 1,
  psize: 1,
  accent: '#8b5cf6',
  accent2: '#38e1c0',
  twoTone: false,
};

function pick<T extends string>(v: unknown, allowed: readonly T[], dflt: T): T {
  return allowed.includes(v as T) ? (v as T) : dflt;
}
function clamp(n: unknown, lo: number, hi: number, dflt: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
}
function cleanHex(v: unknown, dflt: string): string {
  return typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) ? v.trim() : dflt;
}
/** Same-origin ("/media/…") or absolute http(s) only — never javascript:/data:/protocol-relative. */
function cleanUrl(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t) return '';
  if (t.startsWith('/') && !t.startsWith('//')) return t.slice(0, 500);
  if (/^https?:\/\//i.test(t)) return t.slice(0, 500);
  return '';
}
/** Initials → letters/digits/spaces only, upper-cased, capped. Drawn to canvas, never HTML. */
function cleanInitials(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 16).toUpperCase();
}

/**
 * Validate/normalise a recipe from any source (saved blob, studio draft, or a
 * share URL). `fromLink` = true means it came from an untrusted URL: an `image`
 * source is downgraded to the default built-in (we never load a link-supplied
 * image URL).
 */
export function sanitizeRecipe(raw: unknown, opts: { fromLink?: boolean } = {}): SigilRecipe {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let source = pick<SigilSource>(r.source, ['builtin', 'compose', 'image'], DEFAULT_RECIPE.source);
  if (opts.fromLink && source === 'image') source = 'builtin';

  const builtin = BUILTIN_MARKS.some((m) => m.id === r.builtin) ? (r.builtin as string) : DEFAULT_RECIPE.builtin;

  return {
    source,
    builtin,
    initials: cleanInitials(r.initials) || (source === 'compose' ? DEFAULT_RECIPE.initials : ''),
    frame: pick(r.frame, SIGIL_FRAMES, DEFAULT_RECIPE.frame),
    emblem: pick(r.emblem, SIGIL_EMBLEMS, DEFAULT_RECIPE.emblem),
    pos: pick(r.pos, SIGIL_POSITIONS, DEFAULT_RECIPE.pos),
    imageUrl: opts.fromLink ? '' : cleanUrl(r.imageUrl),
    style: pick(r.style, SIGIL_STYLES, DEFAULT_RECIPE.style),
    points: pick(r.points, ['outline', 'filled'], DEFAULT_RECIPE.points),
    speed: clamp(r.speed, 0.5, 2, DEFAULT_RECIPE.speed),
    density: Math.round(clamp(r.density, 40, 260, DEFAULT_RECIPE.density)),
    glow: clamp(r.glow, 0, 2.5, DEFAULT_RECIPE.glow),
    psize: clamp(r.psize, 0.5, 2.5, DEFAULT_RECIPE.psize),
    accent: cleanHex(r.accent, DEFAULT_RECIPE.accent),
    accent2: cleanHex(r.accent2, DEFAULT_RECIPE.accent2),
    twoTone: r.twoTone === true,
  };
}

/** True if this recipe can be carried by a share link (image sources cannot). */
export function isShareable(recipe: SigilRecipe): boolean {
  return recipe.source !== 'image';
}

/* ------------------------------------------------------------------ *
 * Site sigil — a Forge recipe saved as the org's identity. Stored under the
 * public `sigil` settings key (public so the boot splash can play it before
 * anyone signs in). Additive: leaves the older image-only Brandmark config
 * untouched; when enabled here, the Forge sigil takes over the boot splash.
 * ------------------------------------------------------------------ */

export interface SiteSigil {
  /** Play this sigil as the boot splash on site load. */
  enabled: boolean;
  recipe: SigilRecipe;
  /** A hosted static PNG of the mark, rendered client-side at save time. Used as
   *  static art (Discord embeds, OG images) where a raster URL is required.
   *  Blank until first saved, or when rasterization failed. */
  pngUrl: string;
  /** A hosted ANIMATED GIF of the mark, rendered at save time without the
   *  "mustr" watermark. Used as the Discord embed crest, which animates. Kept
   *  separate from pngUrl rather than replacing it: link-preview/OG scrapers
   *  want a still, so those keep using the PNG. Blank until first saved, or if
   *  rendering failed. */
  gifUrl: string;
  /** How long the finished mark rests on screen before the splash fades out,
   *  in seconds. Distinct from `recipe.speed`, which governs how fast the
   *  animation itself plays — this is the pause after it resolves, and it's the
   *  knob that decides whether the intro feels rushed. Splash-only, so it stays
   *  out of SigilRecipe and never rides in a share link. */
  holdSeconds: number;
}

export const SIGIL_HOLD_MIN = 0.5;
export const SIGIL_HOLD_MAX = 8;
export const SIGIL_HOLD_DEFAULT = 1.9;

export const DEFAULT_SITE_SIGIL: SiteSigil = {
  enabled: false,
  recipe: DEFAULT_RECIPE,
  pngUrl: '',
  gifUrl: '',
  holdSeconds: SIGIL_HOLD_DEFAULT,
};

export function sanitizeSiteSigil(raw: unknown): SiteSigil {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const hold = Number(r.holdSeconds);
  return {
    enabled: r.enabled === true,
    recipe: sanitizeRecipe(r.recipe),
    pngUrl: cleanUrl(r.pngUrl),
    gifUrl: cleanUrl(r.gifUrl),
    // Absent on rows saved before this existed — fall back, don't zero it out.
    holdSeconds: Number.isFinite(hold)
      ? Math.min(SIGIL_HOLD_MAX, Math.max(SIGIL_HOLD_MIN, hold))
      : SIGIL_HOLD_DEFAULT,
  };
}

/* ------------------------------------------------------------------ *
 * URL codec — the recipe ⇄ a short base64url token. No storage anywhere;
 * the token IS the sigil. Compact-keyed to keep links short.
 * ------------------------------------------------------------------ */

// Short keys so the encoded JSON stays tiny. Bump `v` if the shape changes.
type Packed = Record<string, unknown> & { v: 1 };
function pack(r: SigilRecipe): Packed {
  const p: Packed = { v: 1, s: r.source, y: r.style };
  if (r.source === 'builtin') p.b = r.builtin;
  if (r.source === 'compose') { p.i = r.initials; p.f = r.frame; p.e = r.emblem; p.p = r.pos; }
  p.pt = r.points; p.sp = r.speed; p.d = r.density; p.g = r.glow; p.z = r.psize;
  p.c = r.accent; if (r.twoTone) { p.c2 = r.accent2; p.t = 1; }
  return p;
}
function unpack(p: Record<string, unknown>): unknown {
  return {
    source: p.s, builtin: p.b, initials: p.i, frame: p.f, emblem: p.e, pos: p.p,
    style: p.y, points: p.pt, speed: p.sp, density: p.d, glow: p.g, psize: p.z,
    accent: p.c, accent2: p.c2, twoTone: p.t === 1,
  };
}

/** base64 → base64url (URL/hash-safe, no padding). */
function b64url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s: string): string {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  return t + '='.repeat((4 - (t.length % 4)) % 4);
}
/** UTF-8-safe base64 — btoa/atob exist in both the browser and the Workers runtime. */
function toBase64(str: string): string {
  return btoa(unescape(encodeURIComponent(str)));
}
function fromBase64(b64: string): string {
  return decodeURIComponent(escape(atob(b64)));
}

/** Encode a recipe to a compact URL token. */
export function encodeRecipe(recipe: SigilRecipe): string {
  return b64url(toBase64(JSON.stringify(pack(recipe))));
}

/** Decode a URL token back to a sanitized recipe (fromLink — untrusted). Null if unparseable. */
export function decodeRecipe(token: string): SigilRecipe | null {
  try {
    const obj = JSON.parse(fromBase64(unb64url(token))) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return null;
    return sanitizeRecipe(unpack(obj), { fromLink: true });
  } catch {
    return null;
  }
}
