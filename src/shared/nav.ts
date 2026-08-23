/**
 * The site navigation model — the composable top menu.
 *
 * The menu used to be hardcoded (Home/News/Roster/Events + custom pages + Admin).
 * Here it is a small ordered tree an admin arranges: each entry is a **link** (to
 * a built-in destination, a custom page, or any URL) or a **category** (a
 * dropdown holding links). One level of nesting — categories hold links, not
 * other categories — which is all a top bar needs and keeps the editor sane.
 *
 * Two independent gates decide whether a viewer sees an entry:
 *  - a built-in destination carries a permission (Events needs `events.view`,
 *    Admin needs any admin tool). This is NON-bypassable — a nav entry can never
 *    grant access it shouldn't, it only *shows* a door the viewer may open.
 *  - an optional `visibleToRole` the admin sets, mirroring page-module visibility.
 * Both are enforced where the nav renders; the stored tree holds every entry.
 *
 * Stored in settings['nav']; sanitised on every read and write (this module is
 * the one authority on the shape) so a hand-edited or stale blob can never reach
 * the renderer malformed. When unset, `defaultNavConfig` reproduces the classic
 * menu, so an install that never touches the builder keeps its old nav.
 */

import type { Permission } from './permissions';

export interface BuiltinTarget {
  key: string;
  path: string;
  label: string;
  /** Required permission to see the entry, if any. */
  permission?: Permission;
  /** True → gated on "can reach any admin tool" rather than a single permission. */
  admin?: boolean;
  /**
   * True → this path is served by the Worker directly (e.g. /legal), not an SPA
   * route, so its nav link must be a full-page navigation, not a client <Link>.
   * No built-in needs this today — the same handling also covers free-form URL
   * links an admin points at a Worker-served path (see isServerServedPath).
   */
  serverRoute?: boolean;
  /** True → reachable by anyone, including logged-out visitors (e.g. the Gallery). */
  public?: boolean;
  /**
   * Names an optional module this destination belongs to. The entry is hidden
   * unless that module is enabled, so a menu built while the gallery was on
   * doesn't leave a dead link behind when it's switched off.
   */
  module?: 'starcitizen' | 'gallery';
}

/** The fixed destinations the app always ships. `key` is what a link stores. */
export const BUILTIN_TARGETS: Record<string, BuiltinTarget> = {
  home: { key: 'home', path: '/', label: 'Home' },
  news: { key: 'news', path: '/news', label: 'News' },
  roster: { key: 'roster', path: '/roster', label: 'Roster' },
  events: { key: 'events', path: '/events', label: 'Events', permission: 'events.view' },
  // Any signed-in member; reachable by logged-out visitors only when the admin
  // flips the leaderboard public (surfaced via /pages/public/list). No static
  // `public` flag, so anonymous visibility follows that runtime flag.
  leaderboard: { key: 'leaderboard', path: '/leaderboard', label: 'Leaderboard' },
  // Any signed-in member; anonymous visitors see a tournament only when it's
  // been marked public (the list/detail APIs enforce that per-tournament), so
  // like the leaderboard there's no static `public` flag.
  tournaments: { key: 'tournaments', path: '/tournaments', label: 'Tournaments' },
  // Public because the gallery holds public albums; the page itself decides
  // what a given viewer actually gets. The link is additionally hidden when the
  // gallery module is off — see SiteNav, which gates on the module flag.
  gallery: { key: 'gallery', path: '/gallery', label: 'Gallery', public: true, module: 'gallery' },
  admin: { key: 'admin', path: '/admin', label: 'Admin', admin: true },
};

export const BUILTIN_KEYS = Object.keys(BUILTIN_TARGETS);

export type NavKind = 'builtin' | 'page' | 'url';

export interface NavItem {
  id: string;
  type: 'link' | 'group';
  /** Display text. Falls back to the target's own label when blank. */
  label: string;
  /** Link only: what kind of destination `target` names. */
  kind?: NavKind;
  /** Link only: a builtin key, a page slug, or a URL. */
  target?: string;
  /** Optional role gate — the entry hides for viewers who lack this role (god bypasses). */
  visibleToRole?: number;
  /** Category (group) only: its child links, in order. */
  children?: NavItem[];
}

export interface NavConfig {
  version: 1;
  items: NavItem[];
}

const MAX_TOP = 40;
const MAX_CHILDREN = 30;
const ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

let idSeq = 0;
/** A stable-ish id for a fresh item. Collisions are resolved during sanitise. */
export function newNavId(prefix = 'n'): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}${idSeq}`;
}

/**
 * Paths the Worker serves as full HTML itself (marketing pages + raw endpoints),
 * which are NOT React Router routes. A link to one must be a real navigation — a
 * client <Link>/<NavLink> lands on the SPA's 404 and only "recovers" on a manual
 * refresh (which finally issues the real HTTP request the Worker answers).
 */
const SERVER_SERVED_EXACT = new Set(['/about', '/product', '/legal', '/setup', '/bot']);
export function isServerServedPath(href: string): boolean {
  const path = (href.split(/[?#]/)[0] || '').replace(/\/+$/, '');
  if (!path) return false; // '/' and '' are the SPA home
  return SERVER_SERVED_EXACT.has(path) || path.startsWith('/api/') || path.startsWith('/media/');
}

/** The href a link resolves to, or null for a category (which has no destination). */
export function navItemHref(item: NavItem): string | null {
  if (item.type !== 'link' || !item.kind || !item.target) return null;
  if (item.kind === 'builtin') return BUILTIN_TARGETS[item.target]?.path ?? null;
  if (item.kind === 'page') return `/p/${item.target}`;
  return item.target; // url — already validated to be same-origin or http(s)
}

/** The effective label for an entry, falling back to its target's name. */
export function navItemLabel(item: NavItem): string {
  if (item.label.trim()) return item.label.trim();
  if (item.kind === 'builtin' && item.target) return BUILTIN_TARGETS[item.target]?.label ?? 'Link';
  if (item.kind === 'page' && item.target) return item.target;
  return item.type === 'group' ? 'Category' : 'Link';
}

/** True for a URL we allow: same-origin ("/…", not "//…") or absolute http(s). */
function safeUrl(v: string): boolean {
  if (v.startsWith('/') && !v.startsWith('//')) return true;
  return /^https?:\/\//i.test(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Structurally sanitise an untrusted nav blob into a valid config. Invalid
 * entries are dropped rather than throwing, so a partially-bad blob still yields
 * a usable menu. `validSlugs`, when given, prunes page links whose page no
 * longer exists (e.g. the page was deleted after being added to the menu).
 */
export function sanitizeNav(raw: unknown, opts: { validSlugs?: Set<string> } = {}): NavConfig {
  const seen = new Set<string>();
  const rawItems = Array.isArray((raw as { items?: unknown })?.items)
    ? ((raw as { items: unknown[] }).items)
    : [];

  const takeId = (v: unknown): string => {
    let id = str(v);
    if (!ID_RE.test(id) || seen.has(id)) id = newNavId();
    seen.add(id);
    return id;
  };

  const sanitizeLink = (rawItem: unknown): NavItem | null => {
    const o = (rawItem ?? {}) as Record<string, unknown>;
    const kind = o.kind === 'builtin' || o.kind === 'page' || o.kind === 'url' ? o.kind : null;
    const target = str(o.target).trim();
    if (!kind || !target) return null;

    if (kind === 'builtin' && !BUILTIN_KEYS.includes(target)) return null;
    if (kind === 'page') {
      if (!SLUG_RE.test(target)) return null;
      if (opts.validSlugs && !opts.validSlugs.has(target)) return null;
    }
    if (kind === 'url' && !safeUrl(target)) return null;

    const item: NavItem = {
      id: takeId(o.id),
      type: 'link',
      label: str(o.label).trim().slice(0, 40),
      kind,
      target: target.slice(0, 300),
    };
    const role = Number(o.visibleToRole);
    if (Number.isInteger(role) && role > 0) item.visibleToRole = role;
    return item;
  };

  const items: NavItem[] = [];
  for (const rawItem of rawItems.slice(0, MAX_TOP)) {
    const o = (rawItem ?? {}) as Record<string, unknown>;
    if (o.type === 'group') {
      const kids: NavItem[] = [];
      const rawKids = Array.isArray(o.children) ? o.children.slice(0, MAX_CHILDREN) : [];
      for (const k of rawKids) {
        const link = sanitizeLink(k);
        if (link) kids.push(link);
      }
      const group: NavItem = {
        id: takeId(o.id),
        type: 'group',
        label: str(o.label).trim().slice(0, 40) || 'Category',
        children: kids,
      };
      const role = Number(o.visibleToRole);
      if (Number.isInteger(role) && role > 0) group.visibleToRole = role;
      items.push(group);
    } else {
      const link = sanitizeLink(rawItem);
      if (link) items.push(link);
    }
  }

  return { version: 1, items };
}

/**
 * The classic menu, reproduced from the built-ins plus the custom pages that
 * opted into the nav — the fallback when settings['nav'] is unset, so upgrading
 * to the builder preserves whatever an install already had.
 */
export function defaultNavConfig(navPages: { slug: string; title: string | null }[]): NavConfig {
  const items: NavItem[] = [
    { id: newNavId(), type: 'link', label: '', kind: 'builtin', target: 'home' },
    { id: newNavId(), type: 'link', label: '', kind: 'builtin', target: 'news' },
    { id: newNavId(), type: 'link', label: '', kind: 'builtin', target: 'roster' },
    { id: newNavId(), type: 'link', label: '', kind: 'builtin', target: 'events' },
    { id: newNavId(), type: 'link', label: '', kind: 'builtin', target: 'tournaments' },
    // Present in the default menu but hidden until the gallery module is turned
    // on (SiteNav gates it on the flag), so enabling the module surfaces the
    // link without an admin having to go and build one.
    { id: newNavId(), type: 'link', label: '', kind: 'builtin', target: 'gallery' },
    ...navPages.map((p) => ({
      id: newNavId(),
      type: 'link' as const,
      label: (p.title ?? p.slug).slice(0, 40),
      kind: 'page' as const,
      target: p.slug,
    })),
    { id: newNavId(), type: 'link', label: '', kind: 'builtin', target: 'admin' },
  ];
  return { version: 1, items };
}
