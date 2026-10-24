/**
 * The page-layout contract shared by the server (which stores + sanitizes it)
 * and the client (which renders + edits it).
 *
 * A page is a stack of ROWS. Each row is a set of COLUMNS laid out on a 12-unit
 * responsive grid — a column's `span` is how many of the 12 units it occupies on
 * desktop; on a narrow screen every column collapses to full width and the whole
 * page becomes a single readable stack. Each column holds an ordered list of
 * MODULES — self-contained blocks (a news feed, the roster, a rich-text note)
 * that fetch their own data at render time. Because the layout is just data,
 * the exact same JSON drives the web app now and can drive a native app later.
 */

import { resolveEmbed } from './embeds';

export type ModuleType =
  | 'heading'
  | 'text'
  | 'html'
  | 'hero'
  | 'image'
  | 'gallery'
  | 'button'
  | 'embed'
  | 'divider'
  | 'news'
  | 'roster'
  | 'events'
  | 'medals'
  | 'warrecords'
  | 'games'
  | 'training'
  | 'leaderboard'
  | 'tournaments';

export interface LayoutModule {
  /** Stable id for React keys and drag-and-drop; not meaningful to the server. */
  id: string;
  type: ModuleType;
  /** Per-module options (title, item limit, rich-text html, …). */
  config: Record<string, unknown>;
  /**
   * Optional audience gate: when set to a role id, the module renders only for
   * viewers who hold that role (e.g. a leadership-only callout). God bypasses it.
   * Referenced by id so renaming the role never breaks a page.
   *
   * The three audiences (mutually exclusive):
   *   visibleToRole set → that role only.
   *   public === true   → everyone, including logged-out visitors (only meaningful
   *                       on a page whose isPublic flag is on).
   *   neither           → any signed-in member. This is the safe default and the
   *                       historical meaning of a role-less module, so existing
   *                       "Everyone" modules never leak when a page is made public.
   */
  visibleToRole?: number;
  /** See visibleToRole — marks a role-less module as visible to anonymous visitors. */
  public?: boolean;
}

export interface LayoutColumn {
  id: string;
  /** 1–12 grid units on desktop. Columns in a row need not sum to 12. */
  span: number;
  modules: LayoutModule[];
}

export interface LayoutRow {
  id: string;
  columns: LayoutColumn[];
}

export interface PageLayout {
  version: 1;
  rows: LayoutRow[];
}

/** The grid width. Kept here so client CSS and server clamping agree. */
export const GRID_UNITS = 12;

/* ------------------------------------------------------------------ *
 * Module catalog — the palette shown in the editor and the whitelist the
 * server validates against. Adding a module type means adding it here AND
 * giving it a renderer in the client module registry.
 * ------------------------------------------------------------------ */

export interface ModuleSpec {
  type: ModuleType;
  label: string;
  description: string;
  /** Config seeded when this module is dropped onto a page. */
  defaultConfig: Record<string, unknown>;
}

export const MODULE_SPECS: readonly ModuleSpec[] = [
  {
    type: 'heading',
    label: 'Heading',
    description: 'A section title.',
    defaultConfig: { text: 'Heading', level: 2 },
  },
  {
    type: 'text',
    label: 'Rich text',
    description: 'A free-form block of formatted text.',
    defaultConfig: { html: '<p>Write something…</p>' },
  },
  {
    type: 'html',
    label: 'HTML block',
    description: 'Hand-written HTML — tags are sanitized when the page renders.',
    defaultConfig: { html: '' },
  },
  {
    type: 'hero',
    label: 'Hero banner',
    description: 'A bold landing headline with call-to-action buttons, feature chips, and a value grid.',
    defaultConfig: {
      eyebrow: 'Muster your community',
      headline: 'Gather Your Fleet. Build Your Legacy.',
      subhead:
        'Stop managing your gaming organization with static spreadsheets and disconnected bots. mustr unifies your community with custom rank structures, real-time Discord role synchronization, automated event signups, service medal tracking, and custom web portals — all in one place.',
      primaryLabel: '🚀 Claim Your Org Space',
      primaryHref: '/api/auth/login',
      secondaryLabel: '🤖 Add Discord Bot',
      secondaryHref: '',
      chips: [
        '⚡ Real-Time Discord Role Sync',
        '🏆 Tournaments & Brackets',
        '📊 Attendance & Leaderboards',
        '📅 Native Discord Event RSVPs',
        '🎨 Fully Customizable Web Hubs',
      ],
      cards: [
        {
          icon: '🔄',
          title: 'Bi-Directional Discord Sync',
          tag: 'Never hand-assign a Discord role again.',
          body: 'Promote a member on your web portal, and their Discord roles, nicknames, and channel permissions update instantly in real time.',
        },
        {
          icon: '🎖️',
          title: 'Custom Ranks & Service Medals',
          tag: 'Reward loyalty and recognize achievements.',
          body: 'Build bespoke rank chains, award military-style service medals, and preserve every member’s historical record and service history.',
        },
        {
          icon: '📅',
          title: 'Seamless Event Operations',
          tag: 'Schedule once, deploy everywhere.',
          body: 'Create raids, fleet ops, or meetings on the web. Members RSVP directly from Discord or your web hub with zero friction.',
        },
        {
          icon: '🎨',
          title: 'Bespoke Community Web Hubs',
          tag: 'A real online home for your organization.',
          body: 'Design custom pages, embed videos, tailor your theme, and showcase a public recruitment portal that stands out.',
        },
      ],
    },
  },
  {
    type: 'embed',
    label: 'Video embed',
    description: 'Embed a YouTube, Twitch, Vimeo, or Streamable video.',
    defaultConfig: { url: '', title: '', ratio: '16:9' },
  },
  {
    type: 'image',
    label: 'Image / banner',
    description: 'A standalone image, optionally linked.',
    defaultConfig: { url: '', alt: '', href: '', caption: '' },
  },
  {
    type: 'gallery',
    label: 'Gallery',
    description: 'A grid of images and YouTube videos that open in a lightbox.',
    defaultConfig: { title: '', columns: 3, items: [] },
  },
  {
    type: 'button',
    label: 'Button / link',
    description: 'A call-to-action link.',
    defaultConfig: { label: 'Learn more', href: '/', style: 'primary' },
  },
  {
    type: 'divider',
    label: 'Divider',
    description: 'A horizontal rule to separate content.',
    defaultConfig: {},
  },
  {
    type: 'news',
    label: 'News feed',
    description: 'The latest news posts.',
    defaultConfig: { title: 'Latest News', limit: 5 },
  },
  {
    type: 'roster',
    label: 'Roster',
    description: 'A summary of the member roster.',
    defaultConfig: { title: 'Roster', limit: 12 },
  },
  {
    type: 'events',
    label: 'Events',
    description: 'Upcoming clan events.',
    defaultConfig: { title: 'Upcoming Events', limit: 5 },
  },
  {
    type: 'medals',
    label: 'Medals',
    description: 'The medals the clan awards.',
    defaultConfig: { title: 'Medals', limit: 12 },
  },
  {
    type: 'warrecords',
    label: 'War records',
    description: 'The clan’s war-record honours.',
    defaultConfig: { title: 'War Records', limit: 12 },
  },
  {
    type: 'games',
    label: 'Games',
    description: 'The games the clan plays.',
    defaultConfig: { title: 'Games We Play', limit: 12 },
  },
  {
    type: 'training',
    label: 'Training',
    description: 'The training courses members can take, with completion tracking.',
    defaultConfig: { title: 'Training' },
  },
  {
    type: 'leaderboard',
    label: 'Leaderboard',
    description: 'Most active members by events attended (recent or all-time).',
    defaultConfig: { title: 'Most Active', limit: 10, window: 'recent' },
  },
  {
    type: 'tournaments',
    label: 'Tournaments',
    description: 'Active and upcoming tournaments, linking to their brackets.',
    defaultConfig: { title: 'Tournaments', limit: 5 },
  },
];

export const MODULE_TYPES = MODULE_SPECS.map((m) => m.type);

export function moduleSpec(type: ModuleType): ModuleSpec | undefined {
  return MODULE_SPECS.find((m) => m.type === type);
}

/* ------------------------------------------------------------------ *
 * Defaults — what a page looks like before anyone customizes it. The home
 * page matches the example brief: news on the right, roster + events stacked
 * on the left.
 * ------------------------------------------------------------------ */

export const DEFAULT_LAYOUTS: Record<string, PageLayout> = {
  home: {
    version: 1,
    rows: [
      {
        id: 'r-home',
        columns: [
          {
            id: 'c-left',
            span: 5,
            modules: [
              { id: 'm-roster', type: 'roster', config: { title: 'Roster', limit: 12 } },
              { id: 'm-events', type: 'events', config: { title: 'Upcoming Events', limit: 5 } },
            ],
          },
          {
            id: 'c-right',
            span: 7,
            modules: [{ id: 'm-news', type: 'news', config: { title: 'Latest News', limit: 6 } }],
          },
        ],
      },
    ],
  },
};

/** The always-present built-in page, navigated to at `/`. */
export const HOME_SLUG = 'home';

/**
 * Slugs a custom page may not claim: the built-in home plus every top-level app
 * route, so a custom page can never shadow /roster, /admin, the API, etc.
 */
export const RESERVED_PAGE_SLUGS = [
  'home',
  'news',
  'roster',
  'events',
  'leveling',
  'members',
  'admin',
  'login',
  'api',
  'media',
  'p',
];

/** A valid custom-page slug: url-safe, reasonable length, not reserved. */
export function isValidPageSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,40}$/.test(slug) && !RESERVED_PAGE_SLUGS.includes(slug);
}

/** Turn free-text (a page title) into a candidate slug. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function defaultLayout(slug: string): PageLayout {
  return DEFAULT_LAYOUTS[slug] ?? { version: 1, rows: [] };
}

/* ------------------------------------------------------------------ *
 * Sanitizer — the server never trusts a stored/submitted layout. This coerces
 * arbitrary JSON into a valid PageLayout, dropping anything unknown, clamping
 * spans, and enforcing sane bounds so a hostile or corrupt payload can't blow
 * up the renderer. Rich-text html is left as-is here and sanitized separately
 * (it needs a DOM sanitizer); everything else is structural.
 * ------------------------------------------------------------------ */

const MAX_ROWS = 20;
const MAX_COLS = 6;
const MAX_MODULES = 20;

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function clampSpan(v: unknown): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return GRID_UNITS;
  return Math.min(GRID_UNITS, Math.max(1, n));
}

let idCounter = 0;
function fallbackId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

function cleanId(v: unknown, prefix: string): string {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : fallbackId(prefix);
}

/**
 * Accept only same-origin paths ("/…") and absolute http(s) URLs. Everything
 * else — javascript:, data:, mailto:, protocol-relative — becomes empty, so a
 * stored url/href can never smuggle a script into an <img src> or <a href>.
 */
function cleanUrl(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t) return '';
  if (t.startsWith('/') && !t.startsWith('//')) return t.slice(0, 500);
  if (/^https?:\/\//i.test(t)) return t.slice(0, 500);
  return '';
}

/**
 * Sanitize a module's config to a small, known set of primitive keys so nothing
 * unexpected is persisted. `sanitizeText` (a DOM-aware html cleaner) is injected
 * because it isn't available in the worker without a dependency; when omitted,
 * html is stored verbatim (callers that can't sanitize should reject text edits
 * or run their own pass).
 */
function cleanConfig(
  type: ModuleType,
  raw: unknown,
  sanitizeText?: (html: string) => string,
): Record<string, unknown> {
  const src = asObject(raw);
  const out: Record<string, unknown> = {};

  if (typeof src.title === 'string') out.title = src.title.slice(0, 120);
  if (src.limit != null) {
    const n = Math.round(Number(src.limit));
    if (Number.isFinite(n)) out.limit = Math.min(50, Math.max(1, n));
  }

  if (type === 'heading') {
    out.text = (typeof src.text === 'string' ? src.text : 'Heading').slice(0, 200);
    const lvl = Math.round(Number(src.level));
    out.level = [1, 2, 3].includes(lvl) ? lvl : 2;
  }

  if (type === 'text') {
    const html = typeof src.html === 'string' ? src.html.slice(0, 20000) : '';
    out.html = sanitizeText ? sanitizeText(html) : html;
  }

  if (type === 'html') {
    // Stored verbatim (bounded); the html block is sanitized at render time with
    // its own wider allowlist (sanitizePageHtml) — the DOM cleaner isn't available
    // here in the worker, and the renderer is the authoritative, always-run pass.
    out.html = typeof src.html === 'string' ? src.html.slice(0, 20000) : '';
  }

  if (type === 'hero') {
    const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
    out.eyebrow = s(src.eyebrow, 120);
    out.headline = s(src.headline, 200);
    out.subhead = s(src.subhead, 600);
    out.primaryLabel = s(src.primaryLabel, 80);
    out.primaryHref = cleanUrl(src.primaryHref);
    out.secondaryLabel = s(src.secondaryLabel, 80);
    out.secondaryHref = cleanUrl(src.secondaryHref);
    out.chips = (Array.isArray(src.chips) ? src.chips : [])
      .slice(0, 8)
      .map((c) => s(c, 80))
      .filter(Boolean);
    out.cards = (Array.isArray(src.cards) ? src.cards : [])
      .slice(0, 8)
      .map((c) => {
        const card = asObject(c);
        return {
          icon: s(card.icon, 8),
          title: s(card.title, 80),
          tag: s(card.tag, 140),
          body: s(card.body, 400),
        };
      })
      .filter((c) => c.title || c.body);
  }

  if (type === 'embed') {
    // Never trust a stored/submitted iframe. Keep the pasted url for the editor,
    // but (re)derive the canonical, origin-locked embed src from it every time —
    // resolveEmbed only ever emits an allowlisted origin + a strict id, so `src`
    // is safe to drop straight into an <iframe> at render.
    const url = typeof src.url === 'string' ? src.url.slice(0, 500) : '';
    const resolved = resolveEmbed(url);
    out.url = url;
    out.provider = resolved?.provider ?? '';
    out.src = resolved?.src ?? '';
    out.ratio = src.ratio === '4:3' ? '4:3' : '16:9';
  }

  if (type === 'image') {
    out.url = cleanUrl(src.url);
    out.href = cleanUrl(src.href);
    out.alt = (typeof src.alt === 'string' ? src.alt : '').slice(0, 200);
    out.caption = (typeof src.caption === 'string' ? src.caption : '').slice(0, 200);
  }

  if (type === 'gallery') {
    const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
    const cols = Math.round(Number(src.columns));
    out.columns = [2, 3, 4, 5].includes(cols) ? cols : 3;
    out.items = (Array.isArray(src.items) ? src.items : [])
      .slice(0, 60)
      .map((raw) => {
        const it = asObject(raw);
        if (it.kind === 'video') {
          // Same rule as the embed module: never echo the pasted URL into an
          // iframe — re-derive a canonical, origin-locked src from it every save.
          const url = typeof it.url === 'string' ? it.url.slice(0, 500) : '';
          const resolved = resolveEmbed(url);
          if (!resolved) return null;
          return { kind: 'video', url, src: resolved.src, provider: resolved.provider, caption: s(it.caption, 200) };
        }
        const url = cleanUrl(it.url);
        if (!url) return null;
        return { kind: 'image', url, alt: s(it.alt, 200), caption: s(it.caption, 200) };
      })
      .filter((it) => it !== null);
  }

  if (type === 'button') {
    out.label = (typeof src.label === 'string' ? src.label : 'Learn more').slice(0, 80);
    out.href = cleanUrl(src.href);
    out.style = src.style === 'default' ? 'default' : 'primary';
  }

  if (type === 'leaderboard') {
    out.window = src.window === 'all' ? 'all' : 'recent';
  }

  return out;
}

export function sanitizeLayout(raw: unknown, sanitizeText?: (html: string) => string): PageLayout {
  const root = asObject(raw);
  const rowsIn = Array.isArray(root.rows) ? root.rows : [];
  const rows: LayoutRow[] = [];

  for (const rowRaw of rowsIn.slice(0, MAX_ROWS)) {
    const row = asObject(rowRaw);
    const colsIn = Array.isArray(row.columns) ? row.columns : [];
    const columns: LayoutColumn[] = [];

    for (const colRaw of colsIn.slice(0, MAX_COLS)) {
      const col = asObject(colRaw);
      const modsIn = Array.isArray(col.modules) ? col.modules : [];
      const modules: LayoutModule[] = [];

      for (const modRaw of modsIn.slice(0, MAX_MODULES)) {
        const mod = asObject(modRaw);
        const type = mod.type as ModuleType;
        if (!MODULE_TYPES.includes(type)) continue;
        const cleaned: LayoutModule = {
          id: cleanId(mod.id, 'm'),
          type,
          config: cleanConfig(type, mod.config, sanitizeText),
        };
        // Audience is at most one of: a role gate, or public. A positive integer
        // role id wins; anything else is dropped (a stale/invalid gate fails to
        // "members", not hidden and not public). `public` only stands alone —
        // never alongside a role — so a role-gated module can't also be public.
        const roleId = Number(mod.visibleToRole);
        if (Number.isInteger(roleId) && roleId > 0) {
          cleaned.visibleToRole = roleId;
        } else if (mod.public === true) {
          cleaned.public = true;
        }
        modules.push(cleaned);
      }

      columns.push({ id: cleanId(col.id, 'c'), span: clampSpan(col.span), modules });
    }

    if (columns.length) rows.push({ id: cleanId(row.id, 'r'), columns });
  }

  return { version: 1, rows };
}
