/**
 * Settings → Theme & Branding → Footer.
 *
 * A lean, per-install site footer: a short blurb (basic HTML allowed, sanitised
 * on render), a few links, and a copyright line. Shows on every page. The
 * default ships with the trademark / non-affiliation notice + a Legal link.
 */

import { useEffect, useState } from 'react';
import { MorphIcon } from 'morphicons/react';
import { X } from 'lucide';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import type { FooterConfig, FooterLink } from '../../shared/footer';

export default function FooterAdmin() {
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [links, setLinks] = useState<FooterLink[]>([]);
  const [copyright, setCopyright] = useState('');
  const { run, busy, error, notice, warning } = useAction();

  const apply = (f: FooterConfig) => {
    setText(f.text);
    setLinks(f.links);
    setCopyright(f.copyright);
  };

  useEffect(() => {
    api
      .get<{ footer: FooterConfig }>('/settings/footer')
      .then(({ footer }) => apply(footer))
      .finally(() => setLoading(false));
  }, []);

  const save = () =>
    run(async () => {
      const { footer } = await api.put<{ footer: FooterConfig }>('/settings/footer', {
        footer: { text, links, copyright },
      });
      apply(footer);
      return 'Saved. The footer is live on every page.';
    });

  const setLink = (i: number, patch: Partial<FooterLink>) =>
    setLinks((ls) => ls.map((l, li) => (li === i ? { ...l, ...patch } : l)));
  const addLink = () => setLinks((ls) => [...ls, { label: '', href: '' }]);
  const removeLink = (i: number) => setLinks((ls) => ls.filter((_, li) => li !== i));

  if (loading) return <div className="loading">Loading…</div>;

  return (
    <section className="panel footer-admin">
      <header className="panel-head">
        <h2>Footer</h2>
        <p className="muted">
          Shown at the bottom of every page. Basic formatting is allowed in the blurb; scripts and
          styles are stripped when it renders.
        </p>
      </header>

      <Alerts error={error} warning={warning} notice={notice} />

      <label>
        Blurb
        <textarea
          rows={3}
          value={text}
          disabled={busy}
          placeholder="A short line — e.g. a disclaimer or tagline. Basic HTML (links, bold) allowed."
          onChange={(e) => setText(e.target.value)}
        />
      </label>

      <fieldset>
        <legend>Links</legend>
        {links.length === 0 && <p className="muted small">No links yet.</p>}
        {links.map((l, i) => (
          <div className="footer-link-row" key={i}>
            <input
              type="text"
              value={l.label}
              placeholder="Label"
              maxLength={60}
              disabled={busy}
              onChange={(e) => setLink(i, { label: e.target.value })}
            />
            <input
              type="text"
              value={l.href}
              placeholder="/p/legal or https://…"
              disabled={busy}
              onChange={(e) => setLink(i, { href: e.target.value })}
            />
            <button type="button" className="mini danger" title="Remove link" disabled={busy} onClick={() => removeLink(i)}>
              <MorphIcon icon={X} size={13} aria-hidden />
            </button>
          </div>
        ))}
        <button type="button" className="mini" disabled={busy} onClick={addLink}>
          + Add link
        </button>
      </fieldset>

      <label>
        Copyright line
        <input
          type="text"
          value={copyright}
          maxLength={200}
          disabled={busy}
          placeholder="Leave blank to auto-show “© {year} {site name}”"
          onChange={(e) => setCopyright(e.target.value)}
        />
      </label>

      <div className="news-editor-actions">
        <button className="primary" disabled={busy} onClick={() => void save()}>
          Save
        </button>
      </div>
    </section>
  );
}
