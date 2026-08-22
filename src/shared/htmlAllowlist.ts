/**
 * The single source of truth for which HTML admin-authored rich text is allowed
 * to contain. Shared so the client's DOMPurify pass (src/client/lib/richtext.ts)
 * and the server's HTMLRewriter pass (src/server/pages/htmlSanitize.ts, used for
 * the public /legal route and the marketing-site export) can never drift apart —
 * they are the two independent places in the app that turn stored HTML back into
 * markup, and both need to agree on what "safe" means.
 */

export const ALLOWED_TAGS = [
  'p', 'br', 'hr',
  'h1', 'h2', 'h3',
  'strong', 'b', 'em', 'i', 's', 'u', 'code', 'pre',
  'blockquote',
  'ul', 'ol', 'li',
  'a',
];

export const ALLOWED_ATTR = ['href', 'target', 'rel'];

// Only http(s) and mailto links; blocks javascript: and data: URIs.
export const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:)/i;

/*
 * The wider allow-list for the "HTML block" module. A page author with
 * pages.manage may hand-write markup, so this permits layout/table/media tags a
 * news post never needs — but the security floor is identical: no <script>,
 * no on* handler, no <iframe>/<object>/<embed>/<form>/<style>, no inline
 * `style=` attribute. Videos are NOT done through raw <iframe> here — they go
 * through the separate, origin-allowlisted Video-embed module. URLs are limited
 * to http(s), mailto, and root-relative ("/media/…") paths, so no
 * javascript:/data: URI can ride in on href/src.
 */
export const PAGE_ALLOWED_TAGS = [
  ...ALLOWED_TAGS,
  'h4', 'h5', 'h6',
  'div', 'span', 'section', 'article', 'header', 'footer', 'figure', 'figcaption',
  'img',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'dl', 'dt', 'dd',
  'sub', 'sup', 'small', 'mark', 'ins', 'del', 'abbr', 'kbd', 'samp', 'var', 'time',
];

export const PAGE_ALLOWED_ATTR = [
  'href', 'target', 'rel',
  'src', 'alt', 'title', 'width', 'height', 'loading', 'decoding',
  'class', 'colspan', 'rowspan', 'span', 'datetime',
];

// http(s), mailto, and root-relative ("/…", but never protocol-relative "//").
export const PAGE_ALLOWED_URI_REGEXP = /^(?:https?:|mailto:|\/(?!\/))/i;
