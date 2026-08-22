/**
 * Sanitization for news post HTML.
 *
 * Posts are authored in a WYSIWYG editor (TipTap) that emits HTML, and that
 * HTML is stored in news.body. Stored markup is NEVER trusted: it's sanitized
 * here both before it's saved and again every time it's rendered, so a payload
 * that somehow reached the database (e.g. a hand-crafted API call) still can't
 * execute when displayed.
 *
 * The allow-list matches what the editor can actually produce — nothing more.
 */

import DOMPurify from 'dompurify';
import { ALLOWED_TAGS, ALLOWED_ATTR, PAGE_ALLOWED_TAGS, PAGE_ALLOWED_ATTR } from '../../shared/htmlAllowlist';

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Only http(s) and mailto links; blocks javascript: and data: URIs.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  });
}

/*
 * The wider allow-list for the "HTML block" module. A page author with
 * pages.manage may hand-write markup, so this permits layout/table/media tags a
 * news post never needs — but the security floor is identical to news: DOMPurify
 * still strips <script>, every on* handler, <iframe>/<object>/<embed>, <form>,
 * <style>, and (via FORBID_ATTR) inline `style=` attributes. Videos are NOT done
 * through raw <iframe> here — they go through the separate, origin-allowlisted
 * Video-embed module. URLs are limited to http(s), mailto, and root-relative
 * ("/media/…") paths, so no javascript:/data: URI can ride in on href/src.
 */
export function sanitizePageHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: PAGE_ALLOWED_TAGS,
    ALLOWED_ATTR: PAGE_ALLOWED_ATTR,
    // http(s), mailto, and root-relative ("/…", but never protocol-relative "//").
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/(?!\/))/i,
    // Inline CSS can exfiltrate (background:url()) and enables clickjacking overlays.
    FORBID_ATTR: ['style'],
    FORBID_TAGS: ['style'],
  });
}

// One-time hardening applied to every sanitize pass: force safe rel on any link
// that opens a new tab (reverse-tabnabbing), and make author images lazy/low-risk.
// Runs in the browser only (DOMPurify needs a DOM); harmless for news markup.
let hooksInstalled = false;
if (!hooksInstalled && typeof DOMPurify.addHook === 'function') {
  hooksInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as unknown as Element;
    if (el.tagName === 'A' && el.getAttribute('target') === '_blank') {
      el.setAttribute('rel', 'noopener noreferrer');
    }
    if (el.tagName === 'IMG') {
      el.setAttribute('loading', 'lazy');
      el.setAttribute('decoding', 'async');
      el.setAttribute('referrerpolicy', 'no-referrer');
    }
  });
}

/**
 * A plain-text snippet for feed cards when a post has no explicit excerpt.
 * Strips all markup and collapses whitespace, then truncates on a word boundary.
 */
export function excerptFromHtml(html: string, max = 180): string {
  const text = DOMPurify.sanitize(html, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  return text.slice(0, text.lastIndexOf(' ', max)).trimEnd() + '…';
}
