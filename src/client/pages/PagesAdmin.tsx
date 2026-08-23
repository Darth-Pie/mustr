/**
 * The page layout editor — the WYSIWYG / drag-and-drop side of templating.
 *
 * An admin arranges a standard page (the home page today) as rows of columns,
 * dropping modules — News, Roster, Events, a heading, a rich-text note — into
 * each column and setting how wide each column is on desktop. Everything is the
 * portable JSON from shared/layout.ts, saved to /api/pages/:slug and rendered by
 * the very same PageRenderer members see, so the preview is truthful. Columns
 * stack on mobile automatically; there is no separate mobile layout to maintain.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { MorphIcon } from 'morphicons/react';
import { X, ChevronUp, ChevronDown } from 'lucide';
import { api } from '../lib/api';
import { useDragOrder, type DragOrder } from '../lib/dragOrder';
import Switch from '../components/Switch';
import PageRenderer from '../components/PageRenderer';
import RichTextEditor from '../components/RichTextEditor';
import NumberField from '../components/NumberField';
import {
  HOME_SLUG,
  MODULE_SPECS,
  moduleSpec,
  defaultLayout,
  slugify,
  GRID_UNITS,
  type PageLayout,
  type LayoutRow,
  type LayoutColumn,
  type LayoutModule,
  type ModuleType,
} from '../../shared/layout';
import { resolveEmbed } from '../../shared/embeds';

interface PageMeta {
  slug: string;
  title: string | null;
  showInNav: boolean;
  navOrder: number;
  isHome: boolean;
  /** Whether logged-out visitors may view this page (module visibility still applies). */
  isPublic: boolean;
}

/** A role option for the "Visible to" audience picker. */
interface RoleOpt {
  id: number;
  name: string;
  color: string | null;
}

function newId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

type Drag = { rowId: string; colId: string; moduleId: string };

export default function PagesAdmin() {
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [roles, setRoles] = useState<RoleOpt[]>([]);
  // `null` = the page list (landing view); a slug = editing that page.
  const [slug, setSlug] = useState<string | null>(null);
  const [layout, setLayout] = useState<PageLayout | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const dragRef = useRef<Drag | null>(null);

  const loadPages = () =>
    api
      .get<{ pages: PageMeta[] }>('/pages')
      .then(({ pages }) => setPages(pages))
      .catch(() =>
        setPages([{ slug: HOME_SLUG, title: 'Home page', showInNav: false, navOrder: 0, isHome: true, isPublic: true }]),
      );

  // After a create/rename/delete/nav-toggle, refresh our own list and tell the
  // rest of the app (the top nav loads page names once) that they changed.
  const refreshPages = async () => {
    await loadPages();
    window.dispatchEvent(new Event('ct-pages-changed'));
  };

  useEffect(() => {
    void loadPages();
    api
      .get<{ roles: RoleOpt[] }>('/pages/meta/roles')
      .then(({ roles }) => setRoles(roles))
      .catch(() => setRoles([]));
  }, []);

  useEffect(() => {
    if (!slug) {
      setLayout(null);
      return;
    }
    setLoading(true);
    setDirty(false);
    setPreview(false);
    api
      .get<{ layout: PageLayout }>(`/pages/${slug}`)
      .then(({ layout }) => setLayout(layout))
      .catch(() => setLayout(defaultLayout(slug)))
      .finally(() => setLoading(false));
  }, [slug]);

  const current = slug ? pages.find((p) => p.slug === slug) : undefined;

  /* --- page management --- */
  async function createPage() {
    const title = window.prompt('Name the new page (e.g. "About Us"):')?.trim();
    if (!title) return;
    const suggested = slugify(title);
    const chosen = window.prompt('Page address (/p/…):', suggested)?.trim().toLowerCase();
    if (!chosen) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await api.post<{ slug: string }>('/pages', { title, slug: chosen });
      await refreshPages();
      setSlug(res.slug);
      setMessage('Page created. Add some modules and Save.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not create the page.');
    } finally {
      setSaving(false);
    }
  }

  async function renamePage() {
    if (!current) return;
    const title = window.prompt('Rename this page:', current.title ?? '')?.trim();
    if (!title) return;
    await api.patch(`/pages/${slug}`, { title }).catch(() => {});
    await refreshPages();
  }

  async function deletePage() {
    if (!current || current.isHome) return;
    if (!window.confirm(`Delete the page “${current.title ?? slug}”? This can’t be undone.`)) return;
    setSaving(true);
    try {
      await api.del(`/pages/${slug}`);
      await refreshPages();
      setSlug(null);
      setMessage('Page deleted.');
    } catch {
      setMessage('Could not delete the page.');
    } finally {
      setSaving(false);
    }
  }

  /** Immutable edit: clone, mutate the rows, mark dirty. */
  function edit(mutator: (rows: LayoutRow[]) => void) {
    setLayout((prev) => {
      if (!prev) return prev;
      const rows = structuredClone(prev.rows);
      mutator(rows);
      return { ...prev, rows };
    });
    setDirty(true);
    setMessage(null);
  }

  const findCol = (rows: LayoutRow[], rowId: string, colId: string): LayoutColumn | undefined =>
    rows.find((r) => r.id === rowId)?.columns.find((c) => c.id === colId);

  /* --- row ops --- */
  const addRow = () =>
    edit((rows) =>
      rows.push({ id: newId('r'), columns: [{ id: newId('c'), span: GRID_UNITS, modules: [] }] }),
    );
  const removeRow = (rowId: string) => edit((rows) => {
    const i = rows.findIndex((r) => r.id === rowId);
    if (i >= 0) rows.splice(i, 1);
  });
  // Drag to reorder rows. Modules already drag between columns; rows are a flat
  // list, so the shared useDragOrder hook drives them.
  const reorderRows = (nextKeys: string[]) =>
    edit((rows) => {
      const byId = new Map(rows.map((r) => [r.id, r]));
      const next = nextKeys.map((k) => byId.get(k)).filter((r): r is LayoutRow => !!r);
      rows.splice(0, rows.length, ...next);
    });
  const rowDnd = useDragOrder(layout?.rows.map((r) => r.id) ?? [], reorderRows);

  /* --- column ops --- */
  const addColumn = (rowId: string) =>
    edit((rows) => {
      const row = rows.find((r) => r.id === rowId);
      if (row && row.columns.length < 6)
        row.columns.push({ id: newId('c'), span: GRID_UNITS, modules: [] });
    });
  const removeColumn = (rowId: string, colId: string) =>
    edit((rows) => {
      const row = rows.find((r) => r.id === rowId);
      if (!row) return;
      row.columns = row.columns.filter((c) => c.id !== colId);
      if (row.columns.length === 0) rows.splice(rows.indexOf(row), 1);
    });
  const setSpan = (rowId: string, colId: string, span: number) =>
    edit((rows) => {
      const col = findCol(rows, rowId, colId);
      if (col) col.span = span;
    });

  /* --- module ops --- */
  const addModule = (rowId: string, colId: string, type: ModuleType) =>
    edit((rows) => {
      const col = findCol(rows, rowId, colId);
      const spec = moduleSpec(type);
      if (col && spec)
        col.modules.push({ id: newId('m'), type, config: { ...spec.defaultConfig } });
    });
  const removeModule = (rowId: string, colId: string, moduleId: string) =>
    edit((rows) => {
      const col = findCol(rows, rowId, colId);
      if (col) col.modules = col.modules.filter((m) => m.id !== moduleId);
    });
  const patchConfig = (rowId: string, colId: string, moduleId: string, patch: Record<string, unknown>) =>
    edit((rows) => {
      const mod = findCol(rows, rowId, colId)?.modules.find((m) => m.id === moduleId);
      if (mod) mod.config = { ...mod.config, ...patch };
    });
  // The audience picker sends one of: 'public', 'members', or a role id (string).
  // At most one audience field is ever stored (they're mutually exclusive).
  const setVisibility = (rowId: string, colId: string, moduleId: string, value: string) =>
    edit((rows) => {
      const mod = findCol(rows, rowId, colId)?.modules.find((m) => m.id === moduleId);
      if (!mod) return;
      delete mod.visibleToRole;
      delete mod.public;
      if (value === 'public') mod.public = true;
      else if (value && value !== 'members') mod.visibleToRole = Number(value);
      // 'members' (the default) leaves both unset.
    });

  async function togglePagePublic(next: boolean) {
    if (!slug) return;
    setSaving(true);
    setMessage(null);
    try {
      await api.patch(`/pages/${slug}`, { isPublic: next });
      await refreshPages(); // updates current.isPublic + the site's public nav
      setMessage(
        next
          ? 'This page is now public. Set the modules you want visible to “Public”; the rest stay members-only.'
          : 'This page now requires signing in.',
      );
    } catch {
      setMessage('Could not change visibility. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  /** Drop the dragged module into `toCol`, before `beforeId` (or at the end). */
  const dropModule = (toRowId: string, toColId: string, beforeId: string | null) => {
    const from = dragRef.current;
    dragRef.current = null;
    if (!from) return;
    if (from.rowId === toRowId && from.colId === toColId && from.moduleId === beforeId) return;
    edit((rows) => {
      const src = findCol(rows, from.rowId, from.colId);
      const dst = findCol(rows, toRowId, toColId);
      if (!src || !dst) return;
      const idx = src.modules.findIndex((m) => m.id === from.moduleId);
      if (idx < 0) return;
      const [moved] = src.modules.splice(idx, 1);
      if (!moved) return;
      const before = beforeId ? dst.modules.findIndex((m) => m.id === beforeId) : -1;
      if (before < 0) dst.modules.push(moved);
      else dst.modules.splice(before, 0, moved);
    });
  };

  async function save() {
    if (!layout) return;
    setSaving(true);
    setMessage(null);
    try {
      await api.put(`/pages/${slug}`, { layout });
      setDirty(false);
      setMessage('Saved. The page is live.');
    } catch {
      setMessage('Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function resetDefault() {
    if (!window.confirm('Reset this page to the built-in default layout? Your customizations will be removed.')) return;
    setSaving(true);
    try {
      const { layout: def } = await api.del<{ layout: PageLayout }>(`/pages/${slug}`);
      setLayout(def);
      setDirty(false);
      setMessage('Reset to the default layout.');
    } catch {
      setMessage('Could not reset. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const pageTitle = useMemo(() => current?.title ?? slug ?? '', [current, slug]);

  // Landing view: pick a page to edit (or create one) instead of jumping
  // straight into the home page.
  if (!slug) {
    return (
      <section className="panel pages-admin">
        <header className="panel-head pages-admin-head">
          <div>
            <h2>Pages</h2>
            <p className="muted">Choose a page to edit, or build a new one. Columns stack on mobile.</p>
          </div>
          <div className="pages-admin-actions">
            <button type="button" className="primary" onClick={createPage} disabled={saving}>
              + New page
            </button>
          </div>
        </header>

        {message && <div className="notice">{message}</div>}

        <ul className="pages-list">
          {pages.map((p) => (
            <li key={p.slug}>
              <button type="button" className="pages-list-item" onClick={() => setSlug(p.slug)}>
                <span className="pages-list-name">{p.isHome ? 'Home page' : p.title ?? p.slug}</span>
                <span className="pages-list-meta muted small">
                  {p.isHome ? '/' : `/p/${p.slug}`}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <p className="muted small builtin-pages-pointer">
          Visibility of the built-in News, Roster and Events pages lives under the{' '}
          <strong>Built-in pages</strong> tab.
        </p>
      </section>
    );
  }

  if (loading || !layout) return <div className="loading">Loading…</div>;

  return (
    <section className="panel pages-admin">
      <header className="panel-head pages-admin-head">
        <div>
          <h2>Pages</h2>
          <p className="muted">Arrange modules on the home page, or build custom pages. Columns stack on mobile.</p>
        </div>
        <div className="pages-admin-actions">
          <button type="button" className="ghost" onClick={() => setSlug(null)} title="Back to all pages">
            ← All pages
          </button>
          <select value={slug} onChange={(e) => setSlug(e.target.value)} title="Page to edit">
            {pages.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.isHome ? 'Home page' : p.title ?? p.slug}
              </option>
            ))}
          </select>
          <button type="button" className="ghost" onClick={createPage} disabled={saving}>
            + New page
          </button>
          <button type="button" className="ghost" onClick={() => setPreview((p) => !p)}>
            {preview ? 'Edit' : 'Preview'}
          </button>
          <button type="button" className="primary" onClick={save} disabled={saving || !dirty}>
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
      </header>

      {/* Per-page controls: public visibility (all pages), plus nav placement +
          rename/delete for custom pages, reset for home. */}
      <div className="pages-admin-meta">
        <div className="inline-field check pages-public-toggle" title="When on, logged-out visitors can view this page. Module-level visibility still applies.">
          <Switch
            checked={!!current?.isPublic}
            onChange={(v) => togglePagePublic(v)}
            disabled={saving}
            label="Public — viewable without signing in"
            hideState
          />
          <span>
            Public <span className="muted small">— viewable without signing in</span>
          </span>
        </div>
        {current?.isHome ? (
          <button type="button" className="ghost" onClick={resetDefault} disabled={saving}>
            Reset home to default
          </button>
        ) : (
          <>
            <span className="muted small">
              Add this page to the menu under <strong>Content → Navigation</strong>.
            </span>
            <button type="button" className="ghost" onClick={renamePage} disabled={saving}>
              Rename
            </button>
            <button type="button" className="ghost danger" onClick={deletePage} disabled={saving}>
              Delete page
            </button>
            <a className="btn-link" href={`/p/${slug}`} target="_blank" rel="noopener noreferrer">
              View ↗
            </a>
          </>
        )}
      </div>

      {message && <div className="notice">{message}</div>}

      {preview ? (
        <div className="pages-preview">
          <div className="muted small pages-preview-label">Preview — {pageTitle}</div>
          <PageRenderer layout={layout} showHidden roles={roles} />
        </div>
      ) : (
        <div className="layout-editor">
          {layout.rows.map((row, ri) => (
            <RowEditor
              key={row.id}
              row={row}
              index={ri}
              rowDnd={rowDnd}
              onRemoveRow={removeRow}
              onAddColumn={addColumn}
              onRemoveColumn={removeColumn}
              onSetSpan={setSpan}
              onAddModule={addModule}
              onRemoveModule={removeModule}
              onPatchConfig={patchConfig}
              onSetVisibility={setVisibility}
              roles={roles}
              onDragStartModule={(d) => (dragRef.current = d)}
              onDropModule={dropModule}
            />
          ))}
          <button type="button" className="add-row" onClick={addRow}>
            + Add row
          </button>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Row → columns → modules
 * ------------------------------------------------------------------ */

function RowEditor(props: {
  row: LayoutRow;
  index: number;
  rowDnd: DragOrder;
  onRemoveRow: (rowId: string) => void;
  onAddColumn: (rowId: string) => void;
  onRemoveColumn: (rowId: string, colId: string) => void;
  onSetSpan: (rowId: string, colId: string, span: number) => void;
  onAddModule: (rowId: string, colId: string, type: ModuleType) => void;
  onRemoveModule: (rowId: string, colId: string, moduleId: string) => void;
  onPatchConfig: (rowId: string, colId: string, moduleId: string, patch: Record<string, unknown>) => void;
  onSetVisibility: (rowId: string, colId: string, moduleId: string, value: string) => void;
  roles: RoleOpt[];
  onDragStartModule: (d: Drag) => void;
  onDropModule: (rowId: string, colId: string, beforeId: string | null) => void;
}) {
  const { row, index, rowDnd } = props;
  const cls = `row-editor ${rowDnd.isDragging(row.id) ? 'dragging ' : ''}${rowDnd.dropClass(row.id)}`.trim();
  return (
    <div className={cls} {...rowDnd.rowProps(row.id)}>
      <div className="row-editor-bar">
        <span className="row-editor-drag drag-grip" title="Drag to reorder this row" {...rowDnd.handleProps(row.id)}>
          ⠿
        </span>
        <span className="row-editor-label">Row {index + 1}</span>
        <div className="row-editor-tools">
          <button type="button" className="mini" title="Add column" onClick={() => props.onAddColumn(row.id)}>+ Col</button>
          <button type="button" className="mini danger" title="Delete row" onClick={() => props.onRemoveRow(row.id)}><MorphIcon icon={X} size={13} aria-hidden /></button>
        </div>
      </div>
      <div className="row-editor-cols">
        {row.columns.map((col) => (
          <ColumnEditor key={col.id} rowId={row.id} col={col} {...props} />
        ))}
      </div>
    </div>
  );
}

function ColumnEditor(props: {
  rowId: string;
  col: LayoutColumn;
  onRemoveColumn: (rowId: string, colId: string) => void;
  onSetSpan: (rowId: string, colId: string, span: number) => void;
  onAddModule: (rowId: string, colId: string, type: ModuleType) => void;
  onRemoveModule: (rowId: string, colId: string, moduleId: string) => void;
  onPatchConfig: (rowId: string, colId: string, moduleId: string, patch: Record<string, unknown>) => void;
  onSetVisibility: (rowId: string, colId: string, moduleId: string, value: string) => void;
  roles: RoleOpt[];
  onDragStartModule: (d: Drag) => void;
  onDropModule: (rowId: string, colId: string, beforeId: string | null) => void;
}) {
  const { rowId, col } = props;
  const [over, setOver] = useState(false);
  return (
    <div
      className="col-editor"
      style={{ flexGrow: col.span, flexBasis: `${(col.span / GRID_UNITS) * 100}%` }}
    >
      <div className="col-editor-bar">
        <label className="col-span-label">
          Width
          <select value={col.span} onChange={(e) => props.onSetSpan(rowId, col.id, Number(e.target.value))}>
            {Array.from({ length: GRID_UNITS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}/{GRID_UNITS}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="mini danger" title="Delete column" onClick={() => props.onRemoveColumn(rowId, col.id)}><MorphIcon icon={X} size={13} aria-hidden /></button>
      </div>

      <div
        className={over ? 'col-dropzone over' : 'col-dropzone'}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          props.onDropModule(rowId, col.id, null);
        }}
      >
        {col.modules.length === 0 && <div className="col-empty">Drop or add a module</div>}
        {col.modules.map((m) => (
          <ModuleEditor key={m.id} {...props} rowId={rowId} colId={col.id} module={m} />
        ))}
      </div>

      <select
        className="add-module"
        value=""
        onChange={(e) => {
          if (e.target.value) props.onAddModule(rowId, col.id, e.target.value as ModuleType);
          e.target.value = '';
        }}
      >
        <option value="">+ Add module…</option>
        {MODULE_SPECS.map((spec) => (
          <option key={spec.type} value={spec.type}>
            {spec.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ModuleEditor(props: {
  rowId: string;
  colId: string;
  module: LayoutModule;
  onRemoveModule: (rowId: string, colId: string, moduleId: string) => void;
  onPatchConfig: (rowId: string, colId: string, moduleId: string, patch: Record<string, unknown>) => void;
  onSetVisibility: (rowId: string, colId: string, moduleId: string, value: string) => void;
  roles: RoleOpt[];
  onDragStartModule: (d: Drag) => void;
  onDropModule: (rowId: string, colId: string, beforeId: string | null) => void;
}) {
  const { rowId, colId, module: m } = props;
  const spec = moduleSpec(m.type);
  const cfg = m.config;
  // Only make the card draggable while the ⋮⋮ handle is held. If the whole card
  // were always `draggable`, a click-drag inside any text field or the rich-text
  // editor would start an element drag instead of selecting text — the reported
  // "can't select text after trying to move one" bug.
  const [grabbing, setGrabbing] = useState(false);

  return (
    <div
      className="module-editor"
      draggable={grabbing}
      onDragStart={(e) => {
        props.onDragStartModule({ rowId, colId, moduleId: m.id });
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => setGrabbing(false)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setGrabbing(false);
        props.onDropModule(rowId, colId, m.id);
      }}
    >
      <div className="module-editor-bar">
        <span
          className="module-editor-drag drag-grip"
          title="Drag to move"
          // Arm dragging only for a gesture that begins on the handle; disarm if
          // it was just a click (mouseup with no drag) so text stays selectable.
          onMouseDown={() => setGrabbing(true)}
          onMouseUp={() => setGrabbing(false)}
        >
          ⠿
        </span>
        <span className="module-editor-type">{spec?.label ?? m.type}</span>
        <div className="module-editor-tools">
          <button type="button" className="mini danger" title="Remove" onClick={() => props.onRemoveModule(rowId, colId, m.id)}><MorphIcon icon={X} size={13} aria-hidden /></button>
        </div>
      </div>

      <div className="module-editor-config">
        <label className="inline-field module-audience">
          Visible to
          <select
            value={m.visibleToRole != null ? String(m.visibleToRole) : m.public ? 'public' : 'members'}
            onChange={(e) => props.onSetVisibility(rowId, colId, m.id, e.target.value)}
          >
            <option value="public">🌐 Public — anyone</option>
            <option value="members">👥 Members — signed in</option>
            {props.roles.length > 0 && (
              <optgroup label="Specific role">
                {props.roles.map((r) => (
                  <option key={r.id} value={String(r.id)}>
                    🔒 {r.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>

        {m.type === 'heading' && (
          <>
            <input
              type="text"
              value={typeof cfg.text === 'string' ? cfg.text : ''}
              placeholder="Heading text"
              onChange={(e) => props.onPatchConfig(rowId, colId, m.id, { text: e.target.value })}
            />
            <label className="inline-field">
              Size
              <select
                value={typeof cfg.level === 'number' ? cfg.level : 2}
                onChange={(e) => props.onPatchConfig(rowId, colId, m.id, { level: Number(e.target.value) })}
              >
                <option value={1}>Large</option>
                <option value={2}>Medium</option>
                <option value={3}>Small</option>
              </select>
            </label>
          </>
        )}

        {m.type === 'text' && (
          <RichTextEditor
            key={m.id}
            value={typeof cfg.html === 'string' ? cfg.html : ''}
            onChange={(html) => props.onPatchConfig(rowId, colId, m.id, { html })}
          />
        )}

        {m.type === 'html' && (
          <>
            <textarea
              className="html-config"
              rows={8}
              spellCheck={false}
              value={typeof cfg.html === 'string' ? cfg.html : ''}
              placeholder={'<h3>Title</h3>\n<p>Your HTML…</p>'}
              onChange={(e) => props.onPatchConfig(rowId, colId, m.id, { html: e.target.value })}
            />
            <p className="muted small">
              Headings, lists, tables, images, links and formatting are allowed. Scripts,
              inline styles, event handlers and iframes are removed when the page renders —
              use a <strong>Video embed</strong> module for videos.
            </p>
          </>
        )}

        {m.type === 'hero' && (
          <HeroConfig config={cfg} onPatch={(patch) => props.onPatchConfig(rowId, colId, m.id, patch)} />
        )}

        {m.type === 'embed' && (
          <EmbedConfig config={cfg} onPatch={(patch) => props.onPatchConfig(rowId, colId, m.id, patch)} />
        )}

        {(m.type === 'news' ||
          m.type === 'roster' ||
          m.type === 'events' ||
          m.type === 'medals' ||
          m.type === 'warrecords' ||
          m.type === 'games' ||
          m.type === 'leaderboard') && (
          <>
            <input
              type="text"
              value={typeof cfg.title === 'string' ? cfg.title : ''}
              placeholder="Section title"
              onChange={(e) => props.onPatchConfig(rowId, colId, m.id, { title: e.target.value })}
            />
            <label className="inline-field">
              Show up to
              <NumberField
                min={1}
                max={50}
                value={typeof cfg.limit === 'number' ? cfg.limit : 5}
                ariaLabel="Items to show"
                onChange={(v) => props.onPatchConfig(rowId, colId, m.id, { limit: Number(v) })}
              />
            </label>
          </>
        )}

        {m.type === 'leaderboard' && (
          <label className="inline-field">
            Ranking
            <select
              value={cfg.window === 'all' ? 'all' : 'recent'}
              onChange={(e) => props.onPatchConfig(rowId, colId, m.id, { window: e.target.value })}
            >
              <option value="recent">Recent activity</option>
              <option value="all">All-time</option>
            </select>
          </label>
        )}

        {m.type === 'training' && (
          <>
            <input
              type="text"
              value={typeof cfg.title === 'string' ? cfg.title : ''}
              placeholder="Section title"
              onChange={(e) => props.onPatchConfig(rowId, colId, m.id, { title: e.target.value })}
            />
            <p className="muted small">Courses are managed under Content → Training.</p>
          </>
        )}

        {m.type === 'image' && (
          <ImageConfig
            config={cfg}
            onPatch={(patch) => props.onPatchConfig(rowId, colId, m.id, patch)}
          />
        )}

        {m.type === 'gallery' && (
          <GalleryConfig
            config={cfg}
            onPatch={(patch) => props.onPatchConfig(rowId, colId, m.id, patch)}
          />
        )}

        {m.type === 'button' && (
          <>
            <input
              type="text"
              value={typeof cfg.label === 'string' ? cfg.label : ''}
              placeholder="Button label"
              onChange={(e) => props.onPatchConfig(rowId, colId, m.id, { label: e.target.value })}
            />
            <input
              type="text"
              value={typeof cfg.href === 'string' ? cfg.href : ''}
              placeholder="Link URL (/roster or https://…)"
              onChange={(e) => props.onPatchConfig(rowId, colId, m.id, { href: e.target.value })}
            />
            <label className="inline-field">
              Style
              <select
                value={cfg.style === 'default' ? 'default' : 'primary'}
                onChange={(e) => props.onPatchConfig(rowId, colId, m.id, { style: e.target.value })}
              >
                <option value="primary">Primary</option>
                <option value="default">Subtle</option>
              </select>
            </label>
          </>
        )}

        {m.type === 'divider' && <p className="muted small">A horizontal divider — no options.</p>}
      </div>
    </div>
  );
}

/**
 * Video-embed config: paste any provider URL. We resolve it to a canonical,
 * origin-locked src on the spot (so the preview works immediately and the stored
 * value is already safe); the server re-derives it on save regardless.
 */
function EmbedConfig({
  config,
  onPatch,
}: {
  config: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const url = typeof config.url === 'string' ? config.url : '';
  const resolved = resolveEmbed(url);
  return (
    <div className="module-embed-config">
      <input
        type="text"
        value={url}
        placeholder="Paste a YouTube, Twitch, Vimeo or Streamable link"
        onChange={(e) => {
          const next = e.target.value;
          const r = resolveEmbed(next);
          onPatch({ url: next, src: r?.src ?? '', provider: r?.provider ?? '' });
        }}
      />
      <input
        type="text"
        value={typeof config.title === 'string' ? config.title : ''}
        placeholder="Caption / accessible title (optional)"
        onChange={(e) => onPatch({ title: e.target.value })}
      />
      <label className="inline-field">
        Shape
        <select
          value={config.ratio === '4:3' ? '4:3' : '16:9'}
          onChange={(e) => onPatch({ ratio: e.target.value })}
        >
          <option value="16:9">Widescreen 16:9</option>
          <option value="4:3">Classic 4:3</option>
        </select>
      </label>
      {url &&
        (resolved ? (
          <p className="muted small">✓ {resolved.provider} embed detected.</p>
        ) : (
          <p className="muted small module-image-err">
            Not a supported link — use YouTube, Twitch, Vimeo or Streamable.
          </p>
        ))}
    </div>
  );
}

/** Image module config: an uploader (to the 'pages' media category) plus alt/link/caption. */
function ImageConfig({
  config,
  onPatch,
}: {
  config: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const url = typeof config.url === 'string' ? config.url : '';

  return (
    <div className="module-image-config">
      {url && <img className="module-image-preview" src={url} alt="" />}
      <div className="avatar-controls">
        <label className="upload-btn mini">
          {uploading ? 'Uploading…' : url ? 'Change image' : 'Upload image'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            disabled={uploading}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setErr(null);
              setUploading(true);
              try {
                const res = await api.upload<{ url: string }>('/media/pages', file);
                onPatch({ url: res.url });
              } catch (e2) {
                setErr(e2 instanceof Error ? e2.message : 'Upload failed.');
              } finally {
                setUploading(false);
              }
            }}
          />
        </label>
        {url && (
          <button type="button" className="mini" disabled={uploading} onClick={() => onPatch({ url: '' })}>
            Remove
          </button>
        )}
      </div>
      {err && <p className="muted small module-image-err">{err}</p>}
      <input
        type="text"
        value={typeof config.alt === 'string' ? config.alt : ''}
        placeholder="Alt text (accessibility)"
        onChange={(e) => onPatch({ alt: e.target.value })}
      />
      <input
        type="text"
        value={typeof config.href === 'string' ? config.href : ''}
        placeholder="Link URL (optional)"
        onChange={(e) => onPatch({ href: e.target.value })}
      />
      <input
        type="text"
        value={typeof config.caption === 'string' ? config.caption : ''}
        placeholder="Caption (optional)"
        onChange={(e) => onPatch({ caption: e.target.value })}
      />
    </div>
  );
}

interface GalleryItemEdit {
  kind: 'image' | 'video';
  url: string;
  src?: string;
  provider?: string;
  alt?: string;
  caption?: string;
}

/**
 * Gallery config: build an ordered list of images (uploaded to the 'pages' media
 * category) and videos (a pasted link resolved to a safe embed). Reorder, caption,
 * and remove each; pick how many columns the grid uses.
 */
function GalleryConfig({
  config,
  onPatch,
}: {
  config: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const items: GalleryItemEdit[] = Array.isArray(config.items) ? (config.items as GalleryItemEdit[]) : [];
  const columns = typeof config.columns === 'number' ? config.columns : 3;
  const [uploading, setUploading] = useState(false);
  const [videoUrl, setVideoUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const setItems = (next: GalleryItemEdit[]) => onPatch({ items: next });

  const addVideo = () => {
    const r = resolveEmbed(videoUrl);
    if (!r) {
      setErr('Not a supported video link — use YouTube, Twitch, Vimeo or Streamable.');
      return;
    }
    setItems([...items, { kind: 'video', url: videoUrl.trim(), src: r.src, provider: r.provider, caption: '' }]);
    setVideoUrl('');
    setErr(null);
  };

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const copy = [...items];
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    setItems(copy);
  };

  return (
    <div className="gallery-config">
      <div className="gallery-config-controls">
        <input
          type="text"
          value={typeof config.title === 'string' ? config.title : ''}
          placeholder="Gallery title (optional)"
          onChange={(e) => onPatch({ title: e.target.value })}
        />
        <label className="inline-field">
          Columns
          <select value={columns} onChange={(e) => onPatch({ columns: Number(e.target.value) })}>
            {[2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="gallery-config-add">
        <label className="upload-btn mini">
          {uploading ? 'Uploading…' : '+ Add image'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            disabled={uploading}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setErr(null);
              setUploading(true);
              try {
                const res = await api.upload<{ url: string }>('/media/pages', file);
                setItems([...items, { kind: 'image', url: res.url, alt: '', caption: '' }]);
              } catch (e2) {
                setErr(e2 instanceof Error ? e2.message : 'Upload failed.');
              } finally {
                setUploading(false);
              }
            }}
          />
        </label>
        <span className="gallery-config-or muted small">or</span>
        <input
          type="text"
          value={videoUrl}
          placeholder="Paste a YouTube / Twitch / Vimeo link"
          onChange={(e) => setVideoUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addVideo();
            }
          }}
        />
        <button type="button" className="mini" onClick={addVideo} disabled={!videoUrl.trim()}>
          + Add video
        </button>
      </div>
      {err && <p className="muted small module-image-err">{err}</p>}

      {items.length === 0 ? (
        <p className="muted small">No items yet — add an image or a video above.</p>
      ) : (
        <ul className="gallery-config-list">
          {items.map((it, i) => (
            <li key={i} className="gallery-config-item">
              <span className="gallery-config-thumb">
                {it.kind === 'image' ? (
                  <img src={it.url} alt="" />
                ) : (
                  <span className="gallery-config-video" title={it.url}>
                    ▶ {it.provider ?? 'video'}
                  </span>
                )}
              </span>
              <input
                type="text"
                className="gallery-config-caption"
                value={it.caption ?? ''}
                placeholder="Caption (optional)"
                onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, caption: e.target.value } : x)))}
              />
              <div className="module-editor-tools">
                <button type="button" className="mini" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <MorphIcon icon={ChevronUp} size={13} aria-hidden />
                </button>
                <button
                  type="button"
                  className="mini"
                  title="Move down"
                  disabled={i === items.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <MorphIcon icon={ChevronDown} size={13} aria-hidden />
                </button>
                <button
                  type="button"
                  className="mini danger"
                  title="Remove"
                  onClick={() => setItems(items.filter((_, j) => j !== i))}
                >
                  <MorphIcon icon={X} size={13} aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface HeroCardEdit {
  icon: string;
  title: string;
  tag: string;
  body: string;
}

/** Hero banner config: headline + CTAs + editable feature chips and value cards. */
function HeroConfig({
  config,
  onPatch,
}: {
  config: Record<string, unknown>;
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const s = (k: string): string => (typeof config[k] === 'string' ? (config[k] as string) : '');
  const chips: string[] = Array.isArray(config.chips)
    ? (config.chips as unknown[]).map((c) => (typeof c === 'string' ? c : ''))
    : [];
  const cards: HeroCardEdit[] = Array.isArray(config.cards)
    ? (config.cards as unknown[]).map((c) => {
        const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
        return {
          icon: typeof o.icon === 'string' ? o.icon : '',
          title: typeof o.title === 'string' ? o.title : '',
          tag: typeof o.tag === 'string' ? o.tag : '',
          body: typeof o.body === 'string' ? o.body : '',
        };
      })
    : [];

  const patchCard = (i: number, patch: Partial<HeroCardEdit>) =>
    onPatch({ cards: cards.map((c, ci) => (ci === i ? { ...c, ...patch } : c)) });
  const addCard = () => onPatch({ cards: [...cards, { icon: '', title: '', tag: '', body: '' }] });
  const removeCard = (i: number) => onPatch({ cards: cards.filter((_, ci) => ci !== i) });

  return (
    <div className="hero-config">
      <input
        type="text"
        value={s('eyebrow')}
        placeholder="Eyebrow — small label above the headline"
        onChange={(e) => onPatch({ eyebrow: e.target.value })}
      />
      <input
        type="text"
        value={s('headline')}
        placeholder="Headline"
        onChange={(e) => onPatch({ headline: e.target.value })}
      />
      <textarea
        rows={3}
        value={s('subhead')}
        placeholder="Sub-headline paragraph"
        onChange={(e) => onPatch({ subhead: e.target.value })}
      />
      <div className="hero-config-row">
        <input
          type="text"
          value={s('primaryLabel')}
          placeholder="Primary button label"
          onChange={(e) => onPatch({ primaryLabel: e.target.value })}
        />
        <input
          type="text"
          value={s('primaryHref')}
          placeholder="Primary link (/api/auth/login, /roster, https://…)"
          onChange={(e) => onPatch({ primaryHref: e.target.value })}
        />
      </div>
      <div className="hero-config-row">
        <input
          type="text"
          value={s('secondaryLabel')}
          placeholder="Secondary button label"
          onChange={(e) => onPatch({ secondaryLabel: e.target.value })}
        />
        <input
          type="text"
          value={s('secondaryHref')}
          placeholder="Secondary link (https://discord.com/oauth2/…)"
          onChange={(e) => onPatch({ secondaryHref: e.target.value })}
        />
      </div>
      <label className="hero-config-label">Feature chips — one per line</label>
      <textarea
        rows={4}
        value={chips.join('\n')}
        placeholder={'⚡ Real-Time Discord Role Sync\n🎖️ Custom Medals & Service Records'}
        onChange={(e) => onPatch({ chips: e.target.value.split('\n') })}
      />
      <label className="hero-config-label">Value cards</label>
      {cards.map((c, i) => (
        <div className="hero-config-card" key={i}>
          <div className="hero-config-row">
            <input
              className="hero-config-icon"
              type="text"
              value={c.icon}
              placeholder="Icon"
              onChange={(e) => patchCard(i, { icon: e.target.value })}
            />
            <input
              type="text"
              value={c.title}
              placeholder="Card title"
              onChange={(e) => patchCard(i, { title: e.target.value })}
            />
            <button type="button" className="mini danger" title="Remove card" onClick={() => removeCard(i)}>
              <MorphIcon icon={X} size={13} aria-hidden />
            </button>
          </div>
          <input
            type="text"
            value={c.tag}
            placeholder="Tagline"
            onChange={(e) => patchCard(i, { tag: e.target.value })}
          />
          <textarea
            rows={2}
            value={c.body}
            placeholder="Card description"
            onChange={(e) => patchCard(i, { body: e.target.value })}
          />
        </div>
      ))}
      <button type="button" className="mini" onClick={addCard}>
        + Add card
      </button>
    </div>
  );
}
