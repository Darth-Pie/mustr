/**
 * Server-side HTML sanitizer for the raw-string render path (the public /legal
 * route and the marketing-site export) — the one place in the app that emits
 * admin-authored HTML with no client-side DOMPurify pass to fall back on.
 *
 * Built on HTMLRewriter, a real streaming HTML parser native to the Workers
 * runtime — not a regex blocklist. A regex can't reliably tell where a tag or
 * attribute ends (unquoted attribute values, malformed/nested tags all defeat
 * one), which is exactly how the previous version of this file was bypassable.
 * A parser doesn't have that ambiguity, and the allow-list model here (strip
 * anything not explicitly permitted, rather than block known-bad patterns) fails
 * closed instead of open. Mirrors the same allow-lists the client's DOMPurify
 * pass uses — see shared/htmlAllowlist.ts.
 */

import {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP,
  PAGE_ALLOWED_TAGS,
  PAGE_ALLOWED_ATTR,
  PAGE_ALLOWED_URI_REGEXP,
} from '../../shared/htmlAllowlist';

// Tags whose entire subtree must never survive, not just the wrapper — unlike
// an unlisted-but-inert tag (which is safe to unwrap and keep the text of),
// unwrapping these would let their content (script source, style rules, a
// nested form) reach the output.
const ALWAYS_REMOVE = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base',
]);

const URL_ATTRS = new Set(['href', 'src']);

function sanitize(html: string, tags: readonly string[], attrs: readonly string[], uriRe: RegExp): Promise<string> {
  if (!html) return Promise.resolve('');
  const tagSet = new Set(tags);
  const attrSet = new Set(attrs);

  const rewriter = new HTMLRewriter()
    .on('*', {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (ALWAYS_REMOVE.has(tag)) {
          el.remove();
          return;
        }
        if (!tagSet.has(tag)) {
          el.removeAndKeepContent();
          return;
        }
        // `Element` is ambiently declared by both `DOM` lib (for client code
        // sharing this tsconfig) and workers-types, and DOM's shape wins the
        // merge — so `.attributes` types as a DOM `NamedNodeMap` even though at
        // runtime (a Worker) it's actually workers-types' `IterableIterator<
        // [string, string]>`. Cast past the incorrect merged type.
        const attrs = el.attributes as unknown as IterableIterator<[string, string]>;
        for (const [name] of [...attrs]) {
          const attr = name.toLowerCase();
          if (!attrSet.has(attr)) {
            el.removeAttribute(name);
            continue;
          }
          if (URL_ATTRS.has(attr) && !uriRe.test(el.getAttribute(name) ?? '')) {
            el.removeAttribute(name);
          }
        }
      },
    })
    .onDocument({
      comments(c) {
        c.remove();
      },
    });

  const res = rewriter.transform(new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
  return res.text();
}

/** Matches the client's sanitizeHtml — the narrower news-post allow-list. */
export function sanitizeTextHtml(html: string): Promise<string> {
  return sanitize(html, ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP);
}

/** Matches the client's sanitizePageHtml — the wider HTML-block allow-list. */
export function sanitizePageHtmlServer(html: string): Promise<string> {
  return sanitize(html, PAGE_ALLOWED_TAGS, PAGE_ALLOWED_ATTR, PAGE_ALLOWED_URI_REGEXP);
}
