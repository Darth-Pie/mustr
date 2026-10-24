/**
 * Visibility of the built-in content pages (News, Roster, Events, Leveling).
 *
 * These are React pages with their own data endpoints, not layout pages, so they
 * can't carry the page_layouts `isPublic` flag. Instead each has an audience here,
 * mirroring the module/page vocabulary:
 *   'public'  → logged-out visitors may view it (the route, the nav link, and the
 *               data endpoint all open up).
 *   'members' → any signed-in member, subject to the page's existing permission
 *               (e.g. Events still needs events.view). This is the safe default.
 *
 * Stored in settings['page_access']; sanitised on every read/write so only an
 * explicit 'public' ever opts a page in — a malformed or stale blob falls back to
 * 'members' (never accidentally public).
 */

export type BuiltinContentPage = 'news' | 'roster' | 'events' | 'leveling';
export type PageAudience = 'public' | 'members';
export type PageAccessConfig = Record<BuiltinContentPage, PageAudience>;

export const BUILTIN_CONTENT_PAGES: readonly BuiltinContentPage[] = ['news', 'roster', 'events', 'leveling'];

export const DEFAULT_PAGE_ACCESS: PageAccessConfig = {
  news: 'members',
  roster: 'members',
  events: 'members',
  leveling: 'members',
};

/** Coerce arbitrary JSON into a valid config — only an explicit 'public' opts in. */
export function cleanPageAccess(raw: unknown): PageAccessConfig {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const pick = (k: BuiltinContentPage): PageAudience => (o[k] === 'public' ? 'public' : 'members');
  return { news: pick('news'), roster: pick('roster'), events: pick('events'), leveling: pick('leveling') };
}
