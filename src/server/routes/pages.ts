/**
 * Page layouts — the drag-and-drop module arrangement for the home page and any
 * number of admin-created custom content pages (served at /p/:slug).
 *
 * 'home' is the one built-in page: it always exists (falling back to the
 * DEFAULT_LAYOUTS default), is navigated to at /, is never listed in the custom
 * nav, and can't be deleted — only reset. Every other page is a row in
 * page_layouts an admin created.
 *
 * GET is public (pages render for everyone); mutations are gated on
 * `pages.manage`. Stored JSON is always structurally sanitized before it can
 * reach the renderer; rich-text html inside a module is sanitized client-side on
 * save and again on render, exactly like news bodies.
 */

import { Hono } from 'hono';
import { eq, asc } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { AppContext } from '../env';
import { db, requirePermission } from '../middleware/auth';
import { loadPageAccess } from '../pageAccess';
import { loadAttendanceConfig } from '../attendance';
import { renderLayoutBody } from '../pages/render';
import {
  defaultLayout,
  sanitizeLayout,
  isValidPageSlug,
  slugify,
  HOME_SLUG,
} from '../../shared/layout';

const pages = new Hono<AppContext>();

/** Admin list: the built-in home first, then every custom page. */
pages.get('/', requirePermission('pages.manage'), async (c) => {
  const rows = await db(c.env)
    .select({
      slug: s.pageLayouts.slug,
      title: s.pageLayouts.title,
      showInNav: s.pageLayouts.showInNav,
      navOrder: s.pageLayouts.navOrder,
      isPublic: s.pageLayouts.isPublic,
      updatedAt: s.pageLayouts.updatedAt,
    })
    .from(s.pageLayouts)
    .orderBy(asc(s.pageLayouts.navOrder), asc(s.pageLayouts.slug));

  const home = rows.find((r) => r.slug === HOME_SLUG);
  const custom = rows.filter((r) => r.slug !== HOME_SLUG);
  const list = [
    // Home defaults to public when it has no stored row (fresh install), matching
    // the seed in migration 0018 for installs that do.
    { slug: HOME_SLUG, title: home?.title ?? 'Home page', showInNav: false, navOrder: 0, isHome: true, isPublic: home ? !!home.isPublic : true },
    ...custom.map((r) => ({ ...r, showInNav: !!r.showInNav, isPublic: !!r.isPublic, isHome: false })),
  ];
  return c.json({ pages: list });
});

/**
 * Public: the custom pages that opt into the top nav, in order. `isPublic` rides
 * along so a logged-out visitor's nav can be filtered to only the pages they can
 * actually open (a signed-in member sees every in-nav page).
 */
pages.get('/nav', async (c) => {
  const rows = await db(c.env)
    .select({
      slug: s.pageLayouts.slug,
      title: s.pageLayouts.title,
      navOrder: s.pageLayouts.navOrder,
      isPublic: s.pageLayouts.isPublic,
    })
    .from(s.pageLayouts)
    .where(eq(s.pageLayouts.showInNav, true))
    .orderBy(asc(s.pageLayouts.navOrder), asc(s.pageLayouts.slug));
  return c.json({ pages: rows.filter((r) => r.slug !== HOME_SLUG).map((r) => ({ ...r, isPublic: !!r.isPublic })) });
});

/**
 * Public: the slugs of every page a logged-out visitor may open — the custom
 * pages flagged public, plus 'home' when the home page is public (which it is by
 * default when it has no stored row). The nav renderer uses this to decide which
 * menu links to show an anonymous viewer, so a link never points somewhere they'd
 * just be bounced to /login. Two-segment path so it can't collide with /:slug.
 */
pages.get('/public/list', async (c) => {
  const [rows, access, attendance] = await Promise.all([
    db(c.env).select({ slug: s.pageLayouts.slug, isPublic: s.pageLayouts.isPublic }).from(s.pageLayouts),
    loadPageAccess(c.env, db(c.env)),
    loadAttendanceConfig(c.env, db(c.env)),
  ]);
  const slugs = rows.filter((r) => r.isPublic).map((r) => r.slug);
  // A fresh install has no 'home' row yet; home defaults to public in that case.
  if (!rows.some((r) => r.slug === HOME_SLUG)) slugs.push(HOME_SLUG);
  // Built-in content pages (News/Roster/Events) opted into 'public' — their keys
  // double as nav/route targets, and 'news' etc. are reserved so never collide
  // with a custom page slug.
  for (const [key, audience] of Object.entries(access)) if (audience === 'public') slugs.push(key);
  // The attendance leaderboard opts in via its own flag.
  if (attendance.leaderboardPublic) slugs.push('leaderboard');
  return c.json({ slugs });
});

/**
 * The role list for the editor's "Visible to" audience picker. Gated on
 * pages.manage (a page editor may hold neither roles.manage nor roles.assign,
 * so /roles and /roles/assignable aren't reachable to them). Non-sensitive —
 * role names and colours already show on the public roster. Lives under a
 * two-segment path so it can never collide with a custom page's `/:slug`.
 */
pages.get('/meta/roles', requirePermission('pages.manage'), async (c) => {
  const list = await db(c.env)
    .select({ id: s.roles.id, name: s.roles.name, color: s.roles.color })
    .from(s.roles)
    .orderBy(asc(s.roles.sortOrder), asc(s.roles.name));
  return c.json({ roles: list });
});

/** Public: a page's layout. `exists` distinguishes a real page from a 404 target. */
pages.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const row = await db(c.env).query.pageLayouts.findFirst({ where: eq(s.pageLayouts.slug, slug) });
  const exists = !!row || slug === HOME_SLUG;
  const layout = row ? sanitizeLayout(row.layout) : defaultLayout(slug);
  // Home is public by default when it has no stored row; everything else is
  // private until an admin opts it in. The client uses this to decide whether a
  // logged-out visitor may view the page at all.
  const isPublic = row ? !!row.isPublic : slug === HOME_SLUG;
  return c.json({ slug, title: row?.title ?? (slug === HOME_SLUG ? 'Home' : slug), layout, exists, customized: !!row, isPublic });
});

/**
 * A page's content rendered to an HTML fragment, for a build step outside this
 * app to embed (the static mustr.gg site pulls its copy from here).
 *
 * Gated on `pages.manage` rather than public on purpose: a page being authored
 * for the marketing site is usually a draft, and publishing every layout at a
 * guessable URL just to export it would leak work in progress. Bearer API tokens
 * resolve to the same permission set as a session, so a build script can
 * authenticate without a browser.
 *
 * Returns a FRAGMENT, not a document — the consumer owns the shell, so the
 * marketing site keeps its own nav, footer and styling.
 */
pages.get('/:slug/export', requirePermission('pages.manage'), async (c) => {
  const slug = c.req.param('slug');
  const row = await db(c.env).query.pageLayouts.findFirst({ where: eq(s.pageLayouts.slug, slug) });
  if (!row) return c.json({ error: 'No such page.' }, 404);

  return c.json({
    slug,
    title: row.title ?? slug,
    html: await renderLayoutBody(row.layout),
    exportedAt: Math.floor(Date.now() / 1000),
  });
});

/** Create a custom page. */
pages.post('/', requirePermission('pages.manage'), async (c) => {
  const body = await c.req.json<{ title?: string; slug?: string }>();
  const title = (body.title ?? '').trim().slice(0, 80);
  if (!title) return c.json({ error: 'A title is required.' }, 400);

  const slug = (body.slug?.trim() || slugify(title)).toLowerCase();
  if (!isValidPageSlug(slug)) {
    return c.json({ error: 'That name can’t be used — pick another (letters, numbers, dashes; not a reserved word).' }, 400);
  }

  const existing = await db(c.env).query.pageLayouts.findFirst({ where: eq(s.pageLayouts.slug, slug) });
  if (existing) return c.json({ error: 'A page with that address already exists.' }, 409);

  const viewer = c.get('viewer')!;
  const now = Math.floor(Date.now() / 1000);
  await db(c.env)
    .insert(s.pageLayouts)
    .values({ slug, title, layout: { version: 1, rows: [] }, updatedBy: viewer.id, updatedAt: now });

  await db(c.env).insert(s.auditLog).values({
    actorId: viewer.id,
    action: 'page.create',
    targetType: 'page',
    targetId: slug,
    meta: { title },
  });

  return c.json({ ok: true, slug, title }, 201);
});

/** Save a page's layout. */
pages.put('/:slug', requirePermission('pages.manage'), async (c) => {
  const slug = c.req.param('slug');
  const isHome = slug === HOME_SLUG;
  const existing = await db(c.env).query.pageLayouts.findFirst({ where: eq(s.pageLayouts.slug, slug) });
  if (!isHome && !existing) return c.json({ error: 'No such page.' }, 404);

  const body = await c.req.json<{ layout?: unknown }>();
  const layout = sanitizeLayout(body.layout);
  const viewer = c.get('viewer')!;
  const now = Math.floor(Date.now() / 1000);
  const title = existing?.title ?? (isHome ? 'Home page' : slug);

  await db(c.env)
    .insert(s.pageLayouts)
    .values({ slug, title, layout, updatedBy: viewer.id, updatedAt: now })
    .onConflictDoUpdate({
      target: s.pageLayouts.slug,
      set: { layout, updatedBy: viewer.id, updatedAt: now },
    });

  await db(c.env).insert(s.auditLog).values({
    actorId: viewer.id,
    action: 'page.layout',
    targetType: 'page',
    targetId: slug,
    meta: { rows: layout.rows.length },
  });

  return c.json({ ok: true, slug, layout });
});

/**
 * Update a page's metadata (title, nav placement, public flag). Home's nav flag
 * is ignored (it's never a nav link), but its public flag is honoured — and since
 * home may have no stored row yet, we upsert one (seeded with the default layout)
 * so the flag can be toggled on a fresh install without first editing the layout.
 */
pages.patch('/:slug', requirePermission('pages.manage'), async (c) => {
  const slug = c.req.param('slug');
  const isHome = slug === HOME_SLUG;
  const existing = await db(c.env).query.pageLayouts.findFirst({ where: eq(s.pageLayouts.slug, slug) });
  if (!existing && !isHome) return c.json({ error: 'No such page.' }, 404);

  const body = await c.req.json<{ title?: string; showInNav?: boolean; navOrder?: number; isPublic?: boolean }>();
  const set: Record<string, unknown> = { updatedAt: Math.floor(Date.now() / 1000) };
  if (typeof body.title === 'string' && body.title.trim()) set.title = body.title.trim().slice(0, 80);
  if (!isHome && typeof body.showInNav === 'boolean') set.showInNav = body.showInNav;
  if (typeof body.navOrder === 'number' && Number.isFinite(body.navOrder)) set.navOrder = Math.round(body.navOrder);
  if (typeof body.isPublic === 'boolean') set.isPublic = body.isPublic;

  if (existing) {
    await db(c.env).update(s.pageLayouts).set(set).where(eq(s.pageLayouts.slug, slug));
  } else {
    // Home with no row yet: create it so the flag persists. Seed the default
    // layout (identical to what the page already renders) and default public on.
    await db(c.env).insert(s.pageLayouts).values({
      slug,
      title: (set.title as string | undefined) ?? 'Home page',
      layout: defaultLayout(slug),
      showInNav: false,
      navOrder: 0,
      isPublic: typeof body.isPublic === 'boolean' ? body.isPublic : true,
      updatedBy: c.get('viewer')!.id,
      updatedAt: Math.floor(Date.now() / 1000),
    });
  }
  return c.json({ ok: true, slug });
});

/**
 * Delete a custom page, or — for home — reset it to the built-in default by
 * removing its stored override.
 */
pages.delete('/:slug', requirePermission('pages.manage'), async (c) => {
  const slug = c.req.param('slug');
  const viewer = c.get('viewer')!;
  await db(c.env).delete(s.pageLayouts).where(eq(s.pageLayouts.slug, slug));
  await db(c.env).insert(s.auditLog).values({
    actorId: viewer.id,
    action: slug === HOME_SLUG ? 'page.reset' : 'page.delete',
    targetType: 'page',
    targetId: slug,
  });
  return c.json({ ok: true, slug, layout: defaultLayout(slug) });
});

export default pages;
