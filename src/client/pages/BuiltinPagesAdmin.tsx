/**
 * Content → Pages → Built-in pages (second tab).
 *
 * The pages mustr generates itself (News, Roster, Events) aren't drag-and-drop
 * layouts, so they can't carry the layout `isPublic` flag. Their audience lives
 * in settings['page_access'] instead — Public (logged-out visitors may view) or
 * Members (signed in, subject to the page's own permission). This tab is the one
 * place to set all three; the home page and any custom pages set their own
 * visibility in the Pages tab, and the Gallery is governed per-album.
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import type { PageAccessConfig, BuiltinContentPage } from '../../shared/pageAccess';

const PAGES: { key: BuiltinContentPage; label: string; path: string; hint: string }[] = [
  { key: 'news', label: 'News', path: '/news', hint: 'The news feed and individual posts.' },
  { key: 'roster', label: 'Roster', path: '/roster', hint: 'The member roster and leadership chart.' },
  { key: 'events', label: 'Events', path: '/events', hint: 'The events page. Members still need the events.view permission.' },
  { key: 'leveling', label: 'Leveling', path: '/leveling', hint: 'The World of Warcraft level race. Needs the module on.' },
];

export default function BuiltinPagesAdmin() {
  const [access, setAccess] = useState<PageAccessConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const { run, busy, error, notice, warning } = useAction();

  useEffect(() => {
    api
      .get<{ pageAccess: PageAccessConfig }>('/settings/page-access')
      .then(({ pageAccess }) => setAccess(pageAccess))
      .catch(() => setAccess(null))
      .finally(() => setLoading(false));
  }, []);

  const setOne = (page: BuiltinContentPage, next: 'public' | 'members') =>
    run(async () => {
      if (!access) return '';
      const updated = { ...access, [page]: next };
      setAccess(updated); // optimistic
      await api.put('/settings/page-access', { pageAccess: updated });
      // The site nav + public-page gating key off this — tell the app to reload.
      window.dispatchEvent(new Event('ct-pages-changed'));
      return next === 'public' ? 'Now public — anyone can view it.' : 'Now members-only.';
    });

  if (loading) return <div className="loading">Loading…</div>;

  return (
    <section className="panel builtin-pages-admin">
      <header className="panel-head">
        <h2>Built-in pages</h2>
        <p className="muted">
          Choose who can see the pages mustr generates. <strong>Public</strong> lets logged-out
          visitors view the page; <strong>Members</strong> keeps it to signed-in members.
        </p>
      </header>

      <Alerts error={error} warning={warning} notice={notice} />

      {access ? (
        <ul className="pages-list">
          {PAGES.map((p) => (
            <li key={p.key} className="builtin-page-row">
              <span className="pages-list-name">
                {p.label} <span className="pages-list-meta muted small">{p.path}</span>
                <span className="muted small builtin-page-hint">{p.hint}</span>
              </span>
              <label className="inline-field">
                <select
                  value={access[p.key]}
                  disabled={busy}
                  onChange={(e) => void setOne(p.key, e.target.value as 'public' | 'members')}
                >
                  <option value="members">👥 Members — signed in</option>
                  <option value="public">🌐 Public — anyone</option>
                </select>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Could not load page visibility settings.</p>
      )}
    </section>
  );
}
