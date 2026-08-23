/**
 * Renders the admin-arranged top menu (see shared/nav.ts).
 *
 * Gates decide what shows, all applied here so the stored tree can stay complete
 * and the same menu can serve everyone:
 *  - a built-in's own permission (Events/Admin), which a menu entry can never
 *    bypass;
 *  - the optional per-entry role the admin set;
 *  - and, for a LOGGED-OUT visitor, whether the destination is actually reachable
 *    without signing in. A menu entry only ever *shows a door the viewer may open*,
 *    so an anonymous visitor sees Home (when it's public) and any public page, but
 *    not News/Roster (login-only) or Events/Admin (permissioned) — no dead links
 *    that would just bounce them to /login.
 *
 * Which pages count as public is passed in as `publicSlugs` ('home' included when
 * the home page is public). Categories become click-to-open dropdowns on desktop
 * and expand inline in the mobile hamburger; empty categories hide themselves.
 */

import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useSession } from '../lib/session';
import { useModules } from '../lib/modules';
import { canAccessAdmin } from '../lib/adminSections';
import { BUILTIN_TARGETS, isServerServedPath, navItemHref, navItemLabel, type NavItem } from '../../shared/nav';

/** Close the mobile menu after a real navigation (not a category toggle). */
type NavProps = { items: NavItem[]; onNavigate: () => void; publicSlugs?: Set<string> };

function useVisibility(publicSlugs?: Set<string>) {
  const { viewer, can } = useSession();
  const modules = useModules();
  const anon = !viewer;

  const roleOk = (roleId?: number): boolean =>
    roleId == null || (!!viewer && (viewer.isGod || viewer.roles.some((r) => r.id === roleId)));

  const targetOk = (item: NavItem): boolean => {
    if (item.kind === 'builtin' && item.target) {
      const b = BUILTIN_TARGETS[item.target];
      if (!b) return false;
      // A destination belonging to an optional module disappears with it, so
      // turning the module off can't leave a link to a route that now 404s.
      if (b.module && !modules[b.module]) return false;
      // Some built-ins (e.g. Gallery) are reachable by anyone — always shown.
      if (b.public) return true;
      // A logged-out visitor sees other built-ins only when the destination is
      // public (publicSlugs carries the built-in keys — 'home', 'news', … — that opted in).
      if (anon) return !!publicSlugs?.has(item.target);
      if (b.admin) return canAccessAdmin(can);
      if (b.permission) return can(b.permission);
      return true;
    }
    if (item.kind === 'page' && item.target) {
      // Any signed-in member may open a page; a logged-out visitor only a public one.
      return anon ? !!publicSlugs?.has(item.target) : true;
    }
    // A plain URL link carries no auth requirement.
    return true;
  };

  const linkVisible = (item: NavItem): boolean => targetOk(item) && roleOk(item.visibleToRole);
  return { roleOk, linkVisible };
}

function Leaf({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  const href = navItemHref(item);
  if (!href) return null;
  const label = navItemLabel(item);
  const external = item.kind === 'url' && /^https?:\/\//i.test(href);
  // A path the Worker serves directly (e.g. /about, /product) isn't an SPA route,
  // so it needs a real navigation — a client <Link> would 404 in the router until
  // a manual refresh. This covers builtins flagged serverRoute AND free-form URL
  // links an admin points at one of those Worker-served pages.
  const serverRoute =
    !external &&
    ((item.kind === 'builtin' && !!item.target && !!BUILTIN_TARGETS[item.target]?.serverRoute) ||
      isServerServedPath(href));

  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" onClick={onNavigate}>
        {label}
      </a>
    );
  }
  if (serverRoute) {
    return (
      <a href={href} onClick={onNavigate}>
        {label}
      </a>
    );
  }
  return (
    <NavLink to={href} end={href === '/'} onClick={onNavigate} className={item.kind === 'builtin' && item.target === 'admin' ? 'nav-admin' : undefined}>
      {label}
    </NavLink>
  );
}

function Category({
  group,
  onNavigate,
  publicSlugs,
}: {
  group: NavItem;
  onNavigate: () => void;
  publicSlugs?: Set<string>;
}) {
  const { linkVisible } = useVisibility(publicSlugs);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const kids = (group.children ?? []).filter(linkVisible);
  if (kids.length === 0) return null;

  const navigateAndClose = () => {
    setOpen(false);
    onNavigate();
  };

  return (
    <div className={open ? 'nav-cat open' : 'nav-cat'} ref={ref}>
      <button
        type="button"
        className="nav-cat-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        // Don't let the click bubble to the mobile <nav>, which would close the
        // whole hamburger before the submenu can open.
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        {navItemLabel(group)}
        <span className="nav-cat-caret" aria-hidden>
          ▾
        </span>
      </button>
      <div className="nav-cat-menu" role="menu">
        {kids.map((k) => (
          <Leaf key={k.id} item={k} onNavigate={navigateAndClose} />
        ))}
      </div>
    </div>
  );
}

export default function SiteNav({ items, onNavigate, publicSlugs }: NavProps) {
  const { linkVisible, roleOk } = useVisibility(publicSlugs);

  return (
    <>
      {items.map((item) => {
        if (item.type === 'group') {
          if (!roleOk(item.visibleToRole)) return null;
          return <Category key={item.id} group={item} onNavigate={onNavigate} publicSlugs={publicSlugs} />;
        }
        if (!linkVisible(item)) return null;
        return <Leaf key={item.id} item={item} onNavigate={onNavigate} />;
      })}
    </>
  );
}
