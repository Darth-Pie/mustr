/**
 * Server-side rendering of a page layout down to plain HTML.
 *
 * The SPA renders layouts with React; this is the other path — turning the same
 * stored JSON into standalone markup with no client. Two callers need it: the
 * public /legal route, and the export endpoint that lets the static marketing
 * site pull authored content at build time.
 *
 * Only the SELF-CONTAINED content modules render here. The data-bound ones
 * (news, roster, events, medals, warrecords, games, training) read live tables
 * and are meaningless outside a running app, so they are skipped rather than
 * half-rendered — a static page can't have a live roster on it.
 */

import { sanitizeTextHtml, sanitizePageHtmlServer } from './htmlSanitize';

/** Escape text destined for HTML. */
export function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The loosely-typed shape we read out of the stored layout JSON. */
interface StoredLayout {
  rows?: { columns?: { modules?: { type?: string; config?: Record<string, unknown> }[] }[] }[];
}

/**
 * Render a stored layout's modules to an HTML fragment (no document wrapper, no
 * styling) so a caller can drop it into whatever page shell it owns.
 */
export async function renderLayoutBody(layout: unknown): Promise<string> {
  const l = (layout ?? {}) as StoredLayout;
  let body = '';

  for (const row of l.rows ?? []) {
    for (const col of row.columns ?? []) {
      for (const m of col.modules ?? []) {
        const cfg = m.config ?? {};
        if (m.type === 'heading') {
          const lvl = Number(cfg.level) === 1 ? 1 : Number(cfg.level) === 3 ? 3 : 2;
          body += `<h${lvl}>${escapeHtml(String(cfg.text ?? ''))}</h${lvl}>`;
        } else if (m.type === 'text') {
          body += await sanitizeTextHtml(String(cfg.html ?? ''));
        } else if (m.type === 'html') {
          body += await sanitizePageHtmlServer(String(cfg.html ?? ''));
        }
      }
    }
  }

  return body;
}
