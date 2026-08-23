/**
 * Navigation builder — arrange the top menu by dragging.
 *
 * The menu is an ordered list of entries; each is a link (to a built-in page, a
 * custom page, or a URL) or a submenu (a dropdown holding links). Editing is
 * drag-and-drop, mirroring the Admin Menu builder:
 *  - drag any row by its grip;
 *  - drop on a top-level row to reorder at the top level (this also pulls a link
 *    back out of a submenu);
 *  - drop into a submenu's body to file a link under it;
 *  - drop on a link inside a submenu to place it precisely.
 * Submenus can't nest, so a submenu only ever reorders at the top level.
 *
 * Only the grip is draggable, so the label inputs stay editable. Every entry can
 * be gated to a role. Saved to /api/nav; the top bar re-reads it live via the
 * `ct-nav-changed` event.
 */

import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { MorphIcon } from 'morphicons/react';
import { X } from 'lucide';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import {
  BUILTIN_TARGETS,
  newNavId,
  navItemLabel,
  type NavItem,
  type NavConfig,
} from '../../shared/nav';

interface PageOpt {
  slug: string;
  title: string | null;
}
interface RoleOpt {
  id: number;
  name: string;
  color: string | null;
}

type DragState = { id: string; isSubmenu: boolean } | null;
/** Where the pointer currently is, for the drop indicator. */
type OverState =
  | { kind: 'top'; id: string; after: boolean }
  | { kind: 'child'; id: string; after: boolean }
  | { kind: 'into'; groupId: string }
  | null;

/** Recursively remove the entry with `id` from the tree, returning it. */
function removeItem(items: NavItem[], id: string): NavItem | null {
  const i = items.findIndex((x) => x.id === id);
  if (i >= 0) return items.splice(i, 1)[0] ?? null;
  for (const it of items) {
    if (it.type === 'group' && it.children) {
      const found = removeItem(it.children, id);
      if (found) return found;
    }
  }
  return null;
}

export default function NavAdmin() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<NavItem[]>([]);
  const [saved, setSaved] = useState<string>('[]');
  const [pages, setPages] = useState<PageOpt[]>([]);
  const [roles, setRoles] = useState<RoleOpt[]>([]);
  const [drag, setDrag] = useState<DragState>(null);
  const [over, setOver] = useState<OverState>(null);

  const { run, busy, error, notice, warning } = useAction();

  useEffect(() => {
    api
      .get<{ nav: NavConfig; pages: PageOpt[]; roles: RoleOpt[] }>('/nav/meta')
      .then((d) => {
        setItems(d.nav.items);
        setSaved(JSON.stringify(d.nav.items));
        setPages(d.pages);
        setRoles(d.roles);
      })
      .finally(() => setLoading(false));
  }, []);

  const dirty = useMemo(() => JSON.stringify(items) !== saved, [items, saved]);

  /** Clone, mutate, set — every edit goes through here. */
  const update = (fn: (draft: NavItem[]) => void) =>
    setItems((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });

  /* --- label / role / delete (index-based; the tree re-renders after a drag) --- */
  const setTop = (idx: number, patch: Partial<NavItem>) =>
    update((it) => {
      it[idx] = { ...it[idx]!, ...patch };
    });
  const delTop = (idx: number) => update((it) => it.splice(idx, 1));
  const setChild = (gIdx: number, cIdx: number, patch: Partial<NavItem>) =>
    update((it) => {
      const kids = it[gIdx]!.children!;
      kids[cIdx] = { ...kids[cIdx]!, ...patch };
    });
  const delChild = (gIdx: number, cIdx: number) => update((it) => it[gIdx]!.children!.splice(cIdx, 1));

  /* --- adding --- */
  const addLink = (kind: NavItem['kind'], target: string, label = '') =>
    update((it) => it.push({ id: newNavId(), type: 'link', label, kind, target }));
  const addGroup = () =>
    update((it) => it.push({ id: newNavId(), type: 'group', label: 'New submenu', children: [] }));

  /* --- drag-and-drop --- */
  const clearDrag = () => {
    setDrag(null);
    setOver(null);
  };
  const afterY = (e: DragEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };
  const startDrag = (id: string, isSubmenu: boolean) => (e: DragEvent) => {
    setDrag({ id, isSubmenu });
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', id);
    } catch {
      /* some browsers require a payload; ignore if refused */
    }
  };

  const doDrop = (target: NonNullable<OverState>) => {
    const d = drag;
    clearDrag();
    if (!d) return;
    // A submenu can only live at the top level — never inside another submenu.
    if (d.isSubmenu && target.kind !== 'top') return;
    if ((target.kind === 'top' || target.kind === 'child') && target.id === d.id) return;

    update((tree) => {
      const moved = removeItem(tree, d.id);
      if (!moved) return;
      if (target.kind === 'top') {
        const idx = tree.findIndex((x) => x.id === target.id);
        if (idx < 0) tree.push(moved);
        else tree.splice(target.after ? idx + 1 : idx, 0, moved);
      } else if (target.kind === 'child') {
        const grp = tree.find((x) => x.type === 'group' && x.children?.some((c) => c.id === target.id));
        if (!grp?.children) {
          tree.push(moved);
          return;
        }
        const idx = grp.children.findIndex((c) => c.id === target.id);
        grp.children.splice(target.after ? idx + 1 : idx, 0, moved);
      } else {
        const grp = tree.find((x) => x.type === 'group' && x.id === target.groupId);
        if (!grp) tree.push(moved);
        else (grp.children ??= []).push(moved);
      }
    });
  };

  // Drop-target handlers. Each stops propagation so an inner target (a child, a
  // submenu body) wins over the outer top-level row it sits within.
  const topProps = (id: string) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      setOver({ kind: 'top', id, after: afterY(e) });
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      doDrop({ kind: 'top', id, after: afterY(e) });
    },
  });
  const childProps = (id: string) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!drag || drag.isSubmenu) return;
      e.preventDefault();
      e.stopPropagation();
      setOver({ kind: 'child', id, after: afterY(e) });
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!drag || drag.isSubmenu) return;
      e.preventDefault();
      e.stopPropagation();
      doDrop({ kind: 'child', id, after: afterY(e) });
    },
  });
  const intoProps = (groupId: string) => ({
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!drag || drag.isSubmenu) return;
      e.preventDefault();
      e.stopPropagation();
      setOver({ kind: 'into', groupId });
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      if (!drag || drag.isSubmenu) return;
      e.preventDefault();
      e.stopPropagation();
      doDrop({ kind: 'into', groupId });
    },
  });

  const gripProps = (id: string, isSubmenu: boolean) => ({
    className: 'drag-grip',
    draggable: !busy,
    onDragStart: startDrag(id, isSubmenu),
    onDragEnd: clearDrag,
    title: 'Drag to reorder',
    'aria-hidden': true,
  });

  const rowCls = (base: string, id: string, kinds: NonNullable<OverState>['kind'][]) => {
    let cls = base;
    if (drag?.id === id) cls += ' dragging';
    if (over && kinds.includes(over.kind) && 'id' in over && over.id === id) {
      cls += over.after ? ' drop-after' : ' drop-before';
    }
    return cls;
  };

  const save = () =>
    run(async () => {
      const { nav } = await api.put<{ nav: NavConfig }>('/nav', {
        nav: { version: 1, items },
      });
      setItems(nav.items);
      setSaved(JSON.stringify(nav.items));
      window.dispatchEvent(new Event('ct-nav-changed'));
      return 'Menu saved. The top bar now reflects it.';
    });

  const roleSelect = (value: number | undefined, onChange: (v: number | undefined) => void) => (
    <select
      className="nav-role"
      value={value != null ? String(value) : ''}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
      title="Who can see this entry"
    >
      <option value="">Everyone</option>
      {roles.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </select>
  );

  if (loading) return <div className="loading">Loading…</div>;

  return (
    <section className="panel nav-admin">
      <header className="panel-head nav-admin-head">
        <div>
          <h2>Navigation</h2>
          <p className="muted">
            Drag the grips to arrange the top menu: reorder entries, drag a link into a submenu to
            file it there, or drag it back out. Submenus become dropdowns. Choose who sees each.
          </p>
        </div>
        <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? 'Saving…' : dirty ? 'Save menu' : 'Saved'}
        </button>
      </header>

      <Alerts error={error} warning={warning} notice={notice} />

      <ol className="nav-tree">
        {items.map((item, idx) =>
          item.type === 'group' ? (
            <li key={item.id} className="nav-tree-group">
              <div className={rowCls('nav-row nav-row-group', item.id, ['top'])} {...topProps(item.id)}>
                <span {...gripProps(item.id, true)}>⠿</span>
                <span className="nav-row-kind" title="Submenu (dropdown)">
                  ▾ Submenu
                </span>
                <input
                  className="nav-row-label"
                  value={item.label}
                  placeholder="Submenu name"
                  onChange={(e) => setTop(idx, { label: e.target.value })}
                />
                {roleSelect(item.visibleToRole, (v) => setTop(idx, { visibleToRole: v }))}
                <div className="nav-row-tools">
                  <button className="mini danger" title="Delete submenu (its links are removed with it)" onClick={() => delTop(idx)}><MorphIcon icon={X} size={13} aria-hidden /></button>
                </div>
              </div>

              <ol
                className={over?.kind === 'into' && over.groupId === item.id ? 'nav-tree-children drop-into' : 'nav-tree-children'}
                {...intoProps(item.id)}
              >
                {(item.children ?? []).length === 0 && (
                  <li className="nav-child-empty muted small">Empty — drag a link here to file it under this submenu.</li>
                )}
                {(item.children ?? []).map((child, cIdx) => (
                  <li key={child.id} className={rowCls('nav-row nav-row-child', child.id, ['child'])} {...childProps(child.id)}>
                    <span {...gripProps(child.id, false)}>⠿</span>
                    <span className="nav-row-kind">{describeKind(child)}</span>
                    <input
                      className="nav-row-label"
                      value={child.label}
                      placeholder={navItemLabel(child)}
                      onChange={(e) => setChild(idx, cIdx, { label: e.target.value })}
                    />
                    {roleSelect(child.visibleToRole, (v) => setChild(idx, cIdx, { visibleToRole: v }))}
                    <div className="nav-row-tools">
                      <button className="mini danger" title="Remove" onClick={() => delChild(idx, cIdx)}><MorphIcon icon={X} size={13} aria-hidden /></button>
                    </div>
                  </li>
                ))}
              </ol>
            </li>
          ) : (
            <li key={item.id} className={rowCls('nav-row nav-row-link', item.id, ['top'])} {...topProps(item.id)}>
              <span {...gripProps(item.id, false)}>⠿</span>
              <span className="nav-row-kind">{describeKind(item)}</span>
              <input
                className="nav-row-label"
                value={item.label}
                placeholder={navItemLabel(item)}
                onChange={(e) => setTop(idx, { label: e.target.value })}
              />
              {roleSelect(item.visibleToRole, (v) => setTop(idx, { visibleToRole: v }))}
              <div className="nav-row-tools">
                <button className="mini danger" title="Remove" onClick={() => delTop(idx)}><MorphIcon icon={X} size={13} aria-hidden /></button>
              </div>
            </li>
          ),
        )}
        {items.length === 0 && <li className="muted small">The menu is empty. Add entries below.</li>}
      </ol>

      <AddToolbar pages={pages} onAddLink={addLink} onAddGroup={addGroup} />

      <p className="muted small">
        Built-in destinations still respect their own access rules — e.g. an <strong>Events</strong>{' '}
        or <strong>Admin</strong> entry only appears for members who can already reach them, whatever
        role you set here.
      </p>
    </section>
  );
}

function describeKind(item: NavItem): string {
  if (item.kind === 'builtin') return `Built-in · ${BUILTIN_TARGETS[item.target ?? '']?.label ?? item.target}`;
  if (item.kind === 'page') return `Page · /p/${item.target}`;
  if (item.kind === 'url') return `Link · ${item.target}`;
  return 'Link';
}

/** The "add an entry" strip: a built-in, a page, a custom URL, or a submenu. */
function AddToolbar({
  pages,
  onAddLink,
  onAddGroup,
}: {
  pages: PageOpt[];
  onAddLink: (kind: NavItem['kind'], target: string, label?: string) => void;
  onAddGroup: () => void;
}) {
  const [urlLabel, setUrlLabel] = useState('');
  const [url, setUrl] = useState('');
  const [urlErr, setUrlErr] = useState<string | null>(null);

  const addUrl = () => {
    const u = url.trim();
    const ok = (u.startsWith('/') && !u.startsWith('//')) || /^https?:\/\//i.test(u);
    if (!ok) {
      setUrlErr('Enter a path like /roster or a full https:// link.');
      return;
    }
    onAddLink('url', u, urlLabel.trim());
    setUrl('');
    setUrlLabel('');
    setUrlErr(null);
  };

  return (
    <div className="nav-add">
      <div className="nav-add-row">
        <label>
          Built-in page
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) onAddLink('builtin', e.target.value);
              e.target.value = '';
            }}
          >
            <option value="">Add…</option>
            {Object.values(BUILTIN_TARGETS).map((b) => (
              <option key={b.key} value={b.key}>
                {b.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          Custom page
          <select
            value=""
            disabled={pages.length === 0}
            onChange={(e) => {
              if (e.target.value) {
                const p = pages.find((x) => x.slug === e.target.value);
                onAddLink('page', e.target.value, (p?.title ?? '').slice(0, 40));
              }
              e.target.value = '';
            }}
          >
            <option value="">{pages.length ? 'Add…' : 'No pages yet'}</option>
            {pages.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.title ?? p.slug}
              </option>
            ))}
          </select>
        </label>

        <button type="button" className="ghost" onClick={onAddGroup}>
          + Submenu
        </button>
      </div>

      <div className="nav-add-row nav-add-url">
        <label>
          Custom link
          <input value={urlLabel} placeholder="Label" onChange={(e) => setUrlLabel(e.target.value)} />
        </label>
        <input
          className="nav-add-url-input"
          value={url}
          placeholder="/roster or https://discord.gg/…"
          onChange={(e) => setUrl(e.target.value)}
        />
        <button type="button" className="ghost" onClick={addUrl}>
          + Link
        </button>
        {urlErr && <span className="muted small module-image-err">{urlErr}</span>}
      </div>
    </div>
  );
}
