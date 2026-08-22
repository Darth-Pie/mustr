/**
 * Cross-org "alliance" federation — the wire contract between two INDEPENDENT
 * mustr instances.
 *
 * Allied orgs each keep their own instance, database, and Discord bot. They
 * federate by POSTing sanitized broadcasts to each other's
 * `/api/alliance/inbound`, authenticated by a scoped alliance token. Each
 * instance then posts the broadcast to ITS OWN Discord via ITS OWN bot. Bots
 * never talk to each other, and bot tokens are NEVER shared — only these narrow
 * alliance tokens are.
 *
 * This module is the trust boundary for inbound data: a broadcast arrives from
 * another org's instance and must be treated as fully untrusted. `sanitizeBroadcast`
 * caps every length and neutralizes anything that could ping a server or inject
 * Discord markup, so a malicious or compromised ally can't @everyone your members.
 */

/** Namespaced prefix so a leaked alliance token is easy to spot (cf. `clt_`). */
export const ALLIANCE_TOKEN_PREFIX = 'allc_';

/** Prefix for a one-step pairing INVITE token (distinct from a live link token). */
export const ALLIANCE_INVITE_PREFIX = 'allinv_';

/**
 * A "connect string" bundles an inviting org's base URL + invite token into one
 * copy-pasteable code, so pairing is a single paste instead of typing a URL and
 * a token separately. base64url of {u, t}; opaque to the user.
 */
export function encodeConnectString(url: string, token: string): string {
  const json = JSON.stringify({ u: url, t: token });
  return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a connect string to { url, token }, or null if it isn't valid. */
export function decodeConnectString(code: string): { url: string; token: string } | null {
  try {
    const b64 = code.trim().replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(atob(b64)) as { u?: unknown; t?: unknown };
    const url = cleanBaseUrl(parsed.u);
    const token = typeof parsed.t === 'string' ? parsed.t.trim() : '';
    if (!url || !token.startsWith(ALLIANCE_INVITE_PREFIX)) return null;
    return { url, token };
  } catch {
    return null;
  }
}

export type AllianceKind = 'test' | 'event' | 'announcement';
export const ALLIANCE_KINDS: AllianceKind[] = ['test', 'event', 'announcement'];

export interface AllianceBroadcast {
  /** Contract version, so receivers can reject incompatible senders later. */
  v: 1;
  /** Origin-unique id — for dedup / loop-prevention. */
  id: string;
  kind: AllianceKind;
  /** Human name of the originating org, shown to receivers as "via {origin}". */
  origin: string;
  title: string;
  /** Plain text only — never HTML. */
  body: string;
  /** Optional absolute http(s) link back to the source. */
  url?: string;
}

function clampStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/**
 * Defuse anything that could ping a server or inject a Discord mention. This is
 * belt-and-braces with `allowed_mentions: { parse: [] }` at post time: even if a
 * future caller forgets that, the text itself carries no live mention.
 */
export function neutralizeMentions(text: string): string {
  return text
    // @everyone / @here → zero-width break so they render but never notify.
    .replace(/@(everyone|here)/gi, '@​$1')
    // Raw <@id>, <@!id>, <@&roleId>, <#channelId> mention tokens → inert label.
    .replace(/<(@[!&]?|#)\d+>/g, '[mention]')
    .trim();
}

/**
 * Coerce an untrusted inbound payload into a safe AllianceBroadcast, or return
 * null if it isn't a usable broadcast. Lengths are capped, text is stripped of
 * live mentions, and any link must be http(s).
 */
export function sanitizeBroadcast(raw: unknown): AllianceBroadcast | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) return null;

  const kind = ALLIANCE_KINDS.includes(o.kind as AllianceKind) ? (o.kind as AllianceKind) : 'announcement';
  const title = neutralizeMentions(clampStr(o.title, 200));
  const body = neutralizeMentions(clampStr(o.body, 1500));
  if (!title && !body) return null;

  const id = clampStr(o.id, 100) || crypto.randomUUID();
  const origin = neutralizeMentions(clampStr(o.origin, 80)) || 'an allied org';
  const urlRaw = clampStr(o.url, 500).trim();
  const url = /^https?:\/\//i.test(urlRaw) ? urlRaw : undefined;

  return { v: 1, id, kind, origin, title, body, ...(url ? { url } : {}) };
}

/** Normalise an ally's base URL to a bare https origin (no trailing slash/path). */
export function cleanBaseUrl(v: unknown): string {
  const t = clampStr(v, 200).trim();
  if (!/^https?:\/\//i.test(t)) return '';
  try {
    return new URL(t).origin;
  } catch {
    return '';
  }
}
