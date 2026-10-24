/**
 * The Battle.net client for the World of Warcraft module.
 *
 * Two kinds of token:
 *   - a member's own sign-in token (authorization-code flow, `wow.profile`), used
 *     once at link time to list their characters and then dropped — never stored;
 *   - the site's app token (client-credentials flow), which reads any public
 *     character and is cached in settings via a TokenStore until near expiry.
 *
 * No database access here: callers pass a TokenStore, and every fetch takes an
 * optional fetch function so tests can stand in for Blizzard. Our traffic says
 * who it is (honest User-Agent), the same posture as the Star Citizen fetch.
 */

import type { AccountCharacter, CharacterStatus, CharacterSummary, Gear, WowConfig } from '../../shared/wow';
import { parseAccountCharacters, parseEquipment, parseStatus, parseSummary, parseUserInfo } from './parse';

export const BNET_OAUTH = 'https://oauth.battle.net';
export const BNET_USER_AGENT = 'Mozilla/5.0 (compatible; mustr.gg-wow/1.0; +https://mustr.gg)';

/** Refresh the app token when it has less than this many seconds left. */
const TOKEN_MARGIN = 300;

export class BnetError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BnetError';
  }

  /** Worth trying again later: rate-limited or Blizzard-side trouble. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export type BnetCreds = Pick<WowConfig, 'clientId' | 'clientSecret' | 'region' | 'namespace'>;

export interface TokenStore {
  get(): Promise<{ token: string; expiresAt: number } | null>;
  set(v: { token: string; expiresAt: number }): Promise<void>;
}

export type FetchFn = typeof fetch;

/** Blizzard wants the realm slug and the character name lowercased. */
export function characterPath(realmSlug: string, name: string): string {
  return `/profile/wow/character/${encodeURIComponent(realmSlug)}/${encodeURIComponent(name.toLowerCase())}`;
}

export function authorizeUrl(c: BnetCreds, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid wow.profile',
    state,
  });
  return `${BNET_OAUTH}/authorize?${params}`;
}

const basicAuth = (c: BnetCreds) => `Basic ${btoa(`${c.clientId}:${c.clientSecret}`)}`;

async function tokenRequest(c: BnetCreds, body: Record<string, string>, f: FetchFn) {
  const res = await f(`${BNET_OAUTH}/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(c),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': BNET_USER_AGENT,
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new BnetError(res.status, `Battle.net token request returned ${res.status}`);
  const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
  if (typeof json.access_token !== 'string') throw new BnetError(502, 'Battle.net token response had no token');
  return { token: json.access_token, expiresIn: typeof json.expires_in === 'number' ? json.expires_in : 0 };
}

/** Finish a member's sign-in. Returns their token for immediate, one-time use. */
export async function exchangeCode(c: BnetCreds, code: string, redirectUri: string, f: FetchFn = fetch): Promise<string> {
  const { token } = await tokenRequest(c, { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, f);
  return token;
}

async function getJson(url: string, token: string, f: FetchFn): Promise<unknown | null> {
  const res = await f(url, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': BNET_USER_AGENT, Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new BnetError(res.status, `Blizzard returned ${res.status}`);
  return res.json();
}

function apiUrl(c: BnetCreds, path: string): string {
  const params = new URLSearchParams({ namespace: `${c.namespace}-${c.region}`, locale: 'en_US' });
  return `https://${c.region}.api.blizzard.com${path}?${params}`;
}

export async function fetchUserInfo(userToken: string, f: FetchFn = fetch): Promise<{ bnetId: string; battletag: string }> {
  const json = await getJson(`${BNET_OAUTH}/userinfo`, userToken, f);
  if (json === null) throw new BnetError(404, 'Battle.net returned no account details');
  return parseUserInfo(json);
}

export async function fetchAccountCharacters(c: BnetCreds, userToken: string, f: FetchFn = fetch): Promise<AccountCharacter[]> {
  const json = await getJson(apiUrl(c, '/profile/user/wow'), userToken, f);
  return json === null ? [] : parseAccountCharacters(json);
}

/** The site's app token, from the store while it has more than five minutes left. */
export async function appToken(c: BnetCreds, store: TokenStore, now: number, f: FetchFn = fetch): Promise<string> {
  const cached = await store.get();
  if (cached && cached.expiresAt - now > TOKEN_MARGIN) return cached.token;
  const { token, expiresIn } = await tokenRequest(c, { grant_type: 'client_credentials' }, f);
  await store.set({ token, expiresAt: now + expiresIn });
  return token;
}

export async function fetchSummary(
  c: BnetCreds,
  token: string,
  realmSlug: string,
  name: string,
  f: FetchFn = fetch,
): Promise<CharacterSummary | null> {
  const json = await getJson(apiUrl(c, characterPath(realmSlug, name)), token, f);
  return json === null ? null : parseSummary(json);
}

export async function fetchEquipment(
  c: BnetCreds,
  token: string,
  realmSlug: string,
  name: string,
  f: FetchFn = fetch,
): Promise<Gear | null> {
  const json = await getJson(apiUrl(c, `${characterPath(realmSlug, name)}/equipment`), token, f);
  return json === null ? null : parseEquipment(json);
}

export async function fetchStatus(
  c: BnetCreds,
  token: string,
  realmSlug: string,
  name: string,
  f: FetchFn = fetch,
): Promise<CharacterStatus | null> {
  const json = await getJson(apiUrl(c, `${characterPath(realmSlug, name)}/status`), token, f);
  return json === null ? null : parseStatus(json);
}
