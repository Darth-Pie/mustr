/**
 * The gallery contract, shared by the server (which stores + enforces it) and
 * the client (which renders + edits it).
 *
 * A gallery is a list of ALBUMS; each album holds an ordered list of ITEMS that
 * are either an uploaded image or an embedded video (YouTube and friends —
 * never self-hosted video, which R2 egress and Worker limits make a bad idea).
 *
 * The interesting part is visibility. Every album carries one of three
 * audiences, deliberately the same vocabulary a page-layout module uses
 * (see LayoutModule.visibleToRole / .public in shared/layout.ts):
 *
 *   'public'  → anyone, including logged-out visitors.
 *   'members' → any signed-in, approved member.
 *   'role'    → only members holding `visibleToRole` (god bypasses).
 *
 * `canViewAlbum` below is the ONE authority on that rule. The server filters
 * every list and re-checks every fetch through it, and the client uses the same
 * function only to decide what to *draw* — a client that lied would still get an
 * empty response. Referencing the role by id means renaming a role never
 * silently reopens an album.
 */

import { resolveEmbed } from './embeds';
import type { Viewer } from './permissions';

export type AlbumAudience = 'public' | 'members' | 'role';

export const ALBUM_AUDIENCES: readonly AlbumAudience[] = ['public', 'members', 'role'];

export type GalleryItemKind = 'image' | 'video';

/**
 * An album as the API hands it out. `itemCount` and `coverUrl` are derived at
 * read time rather than stored, so deleting the cover image can't leave a
 * dangling reference.
 */
export interface GalleryAlbum {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  audience: AlbumAudience;
  /** Only meaningful when audience === 'role'. */
  visibleToRole: number | null;
  sortOrder: number;
  itemCount: number;
  coverUrl: string | null;
  updatedAt: number;
}

export interface GalleryItem {
  id: number;
  albumId: number;
  kind: GalleryItemKind;
  /**
   * Images: the full-size object, always one of our own `/media/gallery/…`
   * URLs. Videos: the original watch URL the author pasted, kept only so the
   * admin UI can show what was added — it is NEVER what gets framed.
   */
  url: string;
  /**
   * Videos only: the canonical, origin-locked embed src produced by
   * resolveEmbed. This is the only string allowed to reach an <iframe>.
   */
  src: string | null;
  provider: string | null;
  /** Images: a downscaled variant for the grid. Videos: null (poster is derived). */
  thumbUrl: string | null;
  /** Intrinsic pixel size — what lets the justified layout reserve space and avoid CLS. */
  width: number;
  height: number;
  caption: string | null;
  alt: string | null;
  sortOrder: number;
}

/* ------------------------------------------------------------------ *
 * Visibility
 * ------------------------------------------------------------------ */

/** The album fields the visibility rule actually needs. */
export type AlbumVisibility = Pick<GalleryAlbum, 'audience' | 'visibleToRole'>;

/**
 * Is this viewer allowed to see this album? The single authority — server-side
 * filtering and client-side rendering both call it, so they can never disagree.
 *
 * A *pending* applicant counts as a member only in demo/preview mode, matching
 * how requireAuth treats them everywhere else: authenticated, but authorized
 * like a visitor until approved.
 */
export function canViewAlbum(album: AlbumVisibility, viewer: Viewer | null): boolean {
  if (album.audience === 'public') return true;
  if (!viewer) return false;
  if (viewer.isGod) return true;
  // An unapproved applicant sees members-only content only in preview mode.
  if (viewer.pending && !viewer.preview) return false;
  if (album.audience === 'members') return true;
  // 'role' — must actually hold it. A role-gated album with no role set is
  // treated as closed rather than open; failing shut is the safe direction.
  if (album.visibleToRole == null) return false;
  return viewer.roles.some((r) => r.id === album.visibleToRole);
}

/** Human-readable audience, for admin lists and the album header. */
export function audienceLabel(album: AlbumVisibility, roleName?: string | null): string {
  if (album.audience === 'public') return 'Everyone';
  if (album.audience === 'members') return 'Members';
  return roleName ? `${roleName} only` : 'Role only';
}

/* ------------------------------------------------------------------ *
 * Sanitising — every write path runs through here.
 * ------------------------------------------------------------------ */

export const MAX_TITLE = 80;
export const MAX_DESCRIPTION = 400;
export const MAX_CAPTION = 200;
export const MAX_ALT = 200;
/** Per-album cap. Generous for a community gallery, bounded enough to keep one page fast. */
export const MAX_ITEMS_PER_ALBUM = 500;

/** Largest intrinsic dimension we record. Guards against absurd stored values. */
const MAX_DIMENSION = 20000;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** Coerce arbitrary input to a known audience; anything unrecognised fails shut to 'members'. */
export function cleanAudience(raw: unknown): AlbumAudience {
  return raw === 'public' || raw === 'role' ? raw : 'members';
}

/**
 * A positive integer role id, or null. Used for `visibleToRole` — note the
 * caller must still confirm the role EXISTS; this only validates the shape.
 */
export function cleanRoleId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Clamp an intrinsic dimension into a sane range, defaulting when unusable. */
export function cleanDimension(raw: unknown, fallback: number): number {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n > 0 && n <= MAX_DIMENSION ? n : fallback;
}

/**
 * True for a URL we're willing to store as gallery image media: one of our own
 * gallery-category objects. Scoped to `/media/gallery/` specifically (not any
 * `/media/*` path) so a gallery item can never be pointed at another category's
 * object — e.g. a member's avatar — which would let deleting/replacing the item
 * later destroy media that isn't the gallery's to own.
 */
export function isOwnMediaUrl(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('/media/gallery/') && v.length > '/media/gallery/'.length;
}

export interface AlbumInput {
  title: string;
  description: string | null;
  audience: AlbumAudience;
  visibleToRole: number | null;
}

/**
 * Clean an incoming album payload. Returns null when there's nothing usable
 * (an album with no title), so the route can answer 400 rather than store junk.
 * `visibleToRole` is dropped unless the audience actually uses it, which keeps
 * a stale role id from lingering and reactivating if the audience flips back.
 */
export function cleanAlbumInput(raw: unknown): AlbumInput | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const title = str(o.title, MAX_TITLE);
  if (!title) return null;
  const audience = cleanAudience(o.audience);
  return {
    title,
    description: str(o.description, MAX_DESCRIPTION) || null,
    audience,
    visibleToRole: audience === 'role' ? cleanRoleId(o.visibleToRole) : null,
  };
}

/** What a caller may set on an item. Sizes and media URLs are validated hard. */
export interface ItemInput {
  kind: GalleryItemKind;
  url: string;
  src: string | null;
  provider: string | null;
  thumbUrl: string | null;
  width: number;
  height: number;
  caption: string | null;
  alt: string | null;
}

/**
 * Clean an incoming item. Returns null if it could never be displayed, which is
 * the same test the renderer applies — so nothing unrenderable reaches storage.
 *
 * Videos re-resolve their embed src from the pasted URL on every write and never
 * trust a client-supplied `src`. That's the rule shared/embeds.ts exists to
 * enforce: only an origin-locked URL we rebuilt ourselves can reach an iframe.
 */
export function cleanItemInput(raw: unknown): ItemInput | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const caption = str(o.caption, MAX_CAPTION) || null;
  const alt = str(o.alt, MAX_ALT) || null;

  if (o.kind === 'video') {
    const url = str(o.url, 500);
    const resolved = resolveEmbed(url);
    if (!resolved) return null;
    return {
      kind: 'video',
      url,
      src: resolved.src,
      provider: resolved.provider,
      thumbUrl: null,
      // Embeds are 16:9; giving the layout a real ratio keeps videos from
      // collapsing to a sliver in a justified row.
      width: cleanDimension(o.width, 1280),
      height: cleanDimension(o.height, 720),
      caption,
      alt,
    };
  }

  const url = str(o.url, 300);
  if (!isOwnMediaUrl(url)) return null;
  const thumb = str(o.thumbUrl, 300);
  return {
    kind: 'image',
    url,
    src: null,
    provider: null,
    thumbUrl: isOwnMediaUrl(thumb) ? thumb : null,
    width: cleanDimension(o.width, 1600),
    height: cleanDimension(o.height, 1200),
    caption,
    alt,
  };
}

/* ------------------------------------------------------------------ *
 * Display helpers
 * ------------------------------------------------------------------ */

/**
 * The image the grid should show for an item: an image's thumbnail (falling
 * back to the full object), or a video's provider poster. Null when a video
 * provider has no derivable poster — the caller draws a placeholder instead.
 */
export function itemThumb(item: Pick<GalleryItem, 'kind' | 'url' | 'thumbUrl' | 'src'>): string | null {
  if (item.kind === 'image') return item.thumbUrl || item.url;
  return embedPoster(item.src);
}

/**
 * A still frame for an embedded video, derived from the canonical embed src
 * (never from author input). Only YouTube exposes a predictable poster URL;
 * the others return null and get a placeholder tile.
 */
export function embedPoster(src: string | null | undefined): string | null {
  if (!src) return null;
  const m = src.match(/youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{11})/);
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null;
}

/** Slug for a new album: lowercase, dash-joined, always non-empty. */
export function albumSlug(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}
