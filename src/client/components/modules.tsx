/**
 * The module registry — one renderer per module type from shared/layout.ts.
 * Each module is self-contained: it fetches its own data and renders a compact
 * card suitable for sitting in a layout column. A module that can't load (no
 * permission, empty data) fails quietly rather than breaking the page.
 *
 * These are the *display* forms shown on a laid-out page (e.g. the home page);
 * the full-page routes (/roster, /events, …) remain the place to manage things.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MorphIcon } from 'morphicons/react';
import { X, Pin, Medal, Trophy, Gamepad2, Play, type IconNode } from 'lucide';
import { api } from '../lib/api';
import { sanitizeHtml, sanitizePageHtml, excerptFromHtml } from '../lib/richtext';
import { isServerServedPath } from '../../shared/nav';
import { memberName } from '../../shared/names';
import { memberAvatar } from '../../shared/avatar';
import { embedSrcForPage, isAllowedEmbedSrc } from '../../shared/embeds';
import { isAllowedSlidesSrc } from '../../shared/trainingEmbed';
import type { ModuleType } from '../../shared/layout';

type Config = Record<string, unknown>;

const str = (c: Config, k: string, d = ''): string => (typeof c[k] === 'string' ? (c[k] as string) : d);
const num = (c: Config, k: string, d: number): number => {
  const n = Number(c[k]);
  return Number.isFinite(n) ? n : d;
};

/** A link that stays inside the SPA for internal paths and opens externally otherwise. */
function SmartLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  if (href.startsWith('/')) {
    // Worker-served pages (/about, /product, …) aren't SPA routes — a client
    // <Link> lands on the router's 404 until a refresh; use a real navigation.
    if (isServerServedPath(href)) {
      return (
        <a href={href} className={className}>
          {children}
        </a>
      );
    }
    return (
      <Link to={href} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={className} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** A small image gallery shared by the medals / war-records / games modules. */
function GalleryModule({
  title,
  endpoint,
  pick,
  limit,
  fallbackIcon,
}: {
  title: string;
  endpoint: string;
  pick: (data: unknown) => { key: string | number; name: string; image: string | null; note?: string }[];
  limit: number;
  fallbackIcon: IconNode;
}) {
  const [items, setItems] = useState<ReturnType<typeof pick> | null>(null);

  useEffect(() => {
    api
      .get<unknown>(endpoint)
      .then((data) => setItems(pick(data)))
      .catch(() => setItems([]));
    // pick/endpoint are stable per module instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  if (items === null) return <ModuleCard title={title}><p className="muted">Loading…</p></ModuleCard>;

  return (
    <ModuleCard title={title}>
      {items.length === 0 ? (
        <p className="muted">Nothing here yet.</p>
      ) : (
        <ul className="module-gallery">
          {items.slice(0, limit).map((it) => (
            <li key={it.key} className="module-gallery-item" title={it.note ? `${it.name} — ${it.note}` : it.name}>
              {it.image ? (
                <img src={it.image} alt="" loading="lazy" />
              ) : (
                <span className="module-gallery-icon" aria-hidden>
                  <MorphIcon icon={fallbackIcon} size={24} aria-hidden />
                </span>
              )}
              <span className="module-gallery-name">{it.name}</span>
            </li>
          ))}
        </ul>
      )}
    </ModuleCard>
  );
}

/** Shared card chrome so every module reads as part of one system. */
function ModuleCard({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel module">
      {(title || action) && (
        <header className="panel-head">
          {title ? <h2>{title}</h2> : <span />}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Heading + rich text — static content, no fetching.
 * ------------------------------------------------------------------ */

function HeadingModule({ config }: { config: Config }) {
  const text = str(config, 'text', 'Heading');
  const level = num(config, 'level', 2);
  const Tag = (level === 1 ? 'h1' : level === 3 ? 'h3' : 'h2') as 'h1' | 'h2' | 'h3';
  return <Tag className="module-heading">{text}</Tag>;
}

function TextModule({ config }: { config: Config }) {
  const html = sanitizeHtml(str(config, 'html'));
  return (
    <section className="panel module module-text">
      <div className="news-body" dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  );
}

/**
 * Hand-written HTML from a page author. Sanitized here at render time with the
 * wider page allow-list — this render-time pass is the authoritative backstop
 * (the stored html is never trusted), so even a hand-crafted API write can't
 * execute. See sanitizePageHtml for exactly what survives.
 */
function HtmlModule({ config }: { config: Config }) {
  const html = sanitizePageHtml(str(config, 'html'));
  if (!html.trim()) return null;
  return (
    <section className="module module-html">
      <div className="news-body page-html" dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  );
}

/**
 * A video embed. `config.src` is produced by resolveEmbed inside sanitizeLayout,
 * but we re-verify it here against the origin allow-list before emitting an
 * iframe — belt and suspenders. The frame is sandboxed and cross-origin, so the
 * provider's player runs boxed off from the page.
 */
function EmbedModule({ config }: { config: Config }) {
  const src = str(config, 'src');
  const title = str(config, 'title') || 'Embedded video';
  const ratio = str(config, 'ratio', '16:9') === '4:3' ? '4:3' : '16:9';

  if (!isAllowedEmbedSrc(src)) {
    return (
      <section className="panel module module-embed-empty">
        <p className="muted small">
          No video yet — add a YouTube, Twitch, Vimeo, or Streamable link in the editor.
        </p>
      </section>
    );
  }

  return (
    <div className="module module-embed" data-ratio={ratio}>
      <iframe
        src={embedSrcForPage(src)}
        title={title}
        loading="lazy"
        allowFullScreen
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
        allow="autoplay; fullscreen; picture-in-picture; encrypted-media; clipboard-write"
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Data modules
 * ------------------------------------------------------------------ */

interface NewsPost {
  id: number;
  slug: string;
  title: string;
  excerpt: string | null;
  body: string;
  pinned: boolean;
  publishedAt: number | null;
  author: string | null;
}

function NewsModule({ config }: { config: Config }) {
  const title = str(config, 'title', 'Latest News');
  const limit = num(config, 'limit', 5);
  const [posts, setPosts] = useState<NewsPost[] | null>(null);

  useEffect(() => {
    api
      .get<{ posts: NewsPost[] }>('/news')
      .then(({ posts }) => setPosts(posts))
      .catch(() => setPosts([]));
  }, []);

  if (posts === null) return <ModuleCard title={title}><p className="muted">Loading…</p></ModuleCard>;

  return (
    <ModuleCard
      title={title}
      action={
        <Link className="btn-link" to="/news">
          All news
        </Link>
      }
    >
      {posts.length === 0 ? (
        <p className="muted">Nothing has been posted yet.</p>
      ) : (
        <ul className="news-feed">
          {posts.slice(0, limit).map((p) => (
            <li key={p.id} className="news-item">
              <Link to={`/news/${p.slug}`} className="news-item-link">
                <div className="news-item-head">
                  {p.pinned && (
                    <span className="tag pin">
                      <MorphIcon icon={Pin} size={12} aria-hidden /> Pinned
                    </span>
                  )}
                  <h3>{p.title}</h3>
                </div>
                <p className="news-excerpt">{p.excerpt || excerptFromHtml(p.body)}</p>
                <div className="muted small news-meta">
                  {p.author ?? 'Unknown'}
                  {p.publishedAt && <> · {new Date(p.publishedAt * 1000).toLocaleDateString()}</>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ModuleCard>
  );
}

interface RosterMember {
  id: number;
  discordId: string;
  username: string;
  globalName: string | null;
  displayName: string | null;
  avatar: string | null;
  profileImageUrl: string | null;
  rankName: string | null;
}

function RosterModule({ config }: { config: Config }) {
  const title = str(config, 'title', 'Roster');
  const limit = num(config, 'limit', 12);
  const [state, setState] = useState<{ members: RosterMember[]; total: number } | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    api
      .get<{ members: RosterMember[]; total: number }>(`/members?limit=${limit}&offset=0`)
      .then(setState)
      .catch(() => {
        // Most commonly a 403 for a viewer without roster.view — hide quietly.
        setDenied(true);
        setState({ members: [], total: 0 });
      });
  }, [limit]);

  if (denied) return null;
  if (state === null) return <ModuleCard title={title}><p className="muted">Loading…</p></ModuleCard>;

  return (
    <ModuleCard
      title={title}
      action={
        <Link className="btn-link" to="/roster">
          {state.total > state.members.length ? `All ${state.total}` : 'Full roster'}
        </Link>
      }
    >
      {state.members.length === 0 ? (
        <p className="muted">No members yet.</p>
      ) : (
        <ul className="roster-mini">
          {state.members.map((m) => (
            <li key={m.id}>
              <Link to={`/members/${m.id}`} className="roster-mini-item">
                <img className="avatar-sm" src={memberAvatar(m, 64)} alt="" loading="lazy" />
                <span className="roster-mini-name">{memberName(m)}</span>
                {m.rankName && <span className="muted small">{m.rankName}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ModuleCard>
  );
}

interface EventItem {
  id: number;
  title: string;
  startsAt: number;
  endsAt: number;
  location: string;
}

function EventsModule({ config }: { config: Config }) {
  const title = str(config, 'title', 'Upcoming Events');
  const limit = num(config, 'limit', 5);
  const [events, setEvents] = useState<EventItem[] | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    api
      .get<{ events: EventItem[] }>('/events')
      .then(({ events }) => setEvents(events))
      .catch(() => {
        // Most commonly a 403 for a viewer without events.view — hide quietly.
        setDenied(true);
        setEvents([]);
      });
  }, []);

  if (denied) return null;
  if (events === null) return <ModuleCard title={title}><p className="muted">Loading…</p></ModuleCard>;

  const now = Math.floor(Date.now() / 1000);
  const upcoming = events.filter((e) => e.endsAt >= now).slice(0, limit);

  return (
    <ModuleCard
      title={title}
      action={
        <Link className="btn-link" to="/events">
          All events
        </Link>
      }
    >
      {upcoming.length === 0 ? (
        <p className="muted">Nothing scheduled.</p>
      ) : (
        <ul className="events-mini">
          {upcoming.map((e) => (
            <li key={e.id} className="events-mini-item">
              <div className="events-mini-date">
                <span className="events-mini-mon">
                  {new Date(e.startsAt * 1000).toLocaleString(undefined, { month: 'short' })}
                </span>
                <span className="events-mini-day">{new Date(e.startsAt * 1000).getDate()}</span>
              </div>
              <div className="events-mini-body">
                <div className="events-mini-title">{e.title}</div>
                <div className="muted small">
                  {new Date(e.startsAt * 1000).toLocaleString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                  {e.location ? ` · ${e.location}` : ''}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </ModuleCard>
  );
}

function ImageModule({ config }: { config: Config }) {
  const url = str(config, 'url');
  if (!url) return null;
  const href = str(config, 'href');
  const alt = str(config, 'alt');
  const caption = str(config, 'caption');
  const img = <img className="module-image-img" src={url} alt={alt} loading="lazy" />;
  return (
    <figure className="module module-image">
      {href ? <SmartLink href={href}>{img}</SmartLink> : img}
      {caption && <figcaption className="muted small module-image-caption">{caption}</figcaption>}
    </figure>
  );
}

function ButtonModule({ config }: { config: Config }) {
  const href = str(config, 'href');
  if (!href) return null;
  const label = str(config, 'label', 'Learn more');
  const primary = str(config, 'style', 'primary') === 'primary';
  return (
    <div className="module module-button">
      <SmartLink href={href} className={primary ? 'btn-cta primary' : 'btn-cta'}>
        {label}
      </SmartLink>
    </div>
  );
}

function DividerModule() {
  return <hr className="module module-divider" />;
}

/* ------------------------------------------------------------------ *
 * Media gallery — a grid of images and YouTube/embed videos that open in a
 * native lightbox (no third-party library). Video items reuse the same
 * origin-locked embed src the Video module does; image src is 'self'/https.
 * ------------------------------------------------------------------ */

interface GalleryItem {
  kind: 'image' | 'video';
  url: string;
  src?: string;
  provider?: string;
  alt?: string;
  caption?: string;
}

/** Derive a YouTube poster from the canonical embed src (…/embed/<id>). */
function youtubePoster(src: string | undefined): string | null {
  if (!src) return null;
  const m = src.match(/youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{11})/);
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : null;
}

/** A single embedded-video iframe, boxed and cross-origin like the embed module. */
function EmbedFrame({ src, title }: { src: string; title: string }) {
  return (
    <iframe
      src={embedSrcForPage(src)}
      title={title}
      loading="lazy"
      allowFullScreen
      sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
      allow="autoplay; fullscreen; picture-in-picture; encrypted-media; clipboard-write"
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );
}

function Lightbox({
  items,
  index,
  onClose,
  onIndex,
}: {
  items: GalleryItem[];
  index: number;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  const many = items.length > 1;
  const step = (dir: number) => onIndex((index + dir + items.length) % items.length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (many && e.key === 'ArrowRight') step(1);
      else if (many && e.key === 'ArrowLeft') step(-1);
    };
    document.addEventListener('keydown', onKey);
    // Lock background scroll while the overlay is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
    // step/onClose are stable enough for this modal's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, items.length]);

  const it = items[index];
  if (!it) return null;

  return (
    <div className="lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} aria-label="Close">
        <MorphIcon icon={X} size={18} aria-hidden />
      </button>
      {many && (
        <button
          className="lightbox-nav prev"
          onClick={(e) => {
            e.stopPropagation();
            step(-1);
          }}
          aria-label="Previous"
        >
          ‹
        </button>
      )}
      <figure className="lightbox-stage" onClick={(e) => e.stopPropagation()}>
        {it.kind === 'video' && isAllowedEmbedSrc(it.src) ? (
          <div className="lightbox-video">
            <EmbedFrame src={it.src} title={it.caption || 'Video'} />
          </div>
        ) : (
          <img src={it.url} alt={it.alt || it.caption || ''} />
        )}
        {it.caption && <figcaption className="lightbox-cap">{it.caption}</figcaption>}
      </figure>
      {many && (
        <button
          className="lightbox-nav next"
          onClick={(e) => {
            e.stopPropagation();
            step(1);
          }}
          aria-label="Next"
        >
          ›
        </button>
      )}
    </div>
  );
}

function MediaGalleryModule({ config }: { config: Config }) {
  const title = str(config, 'title');
  const columns = Math.min(5, Math.max(2, num(config, 'columns', 3)));
  const raw = Array.isArray(config.items) ? (config.items as GalleryItem[]) : [];
  // Only render items that are actually displayable (a real image url, or an
  // embed src on an allowed origin) — mirrors the render-time guard elsewhere.
  const items = raw.filter((it) => it && (it.kind === 'video' ? isAllowedEmbedSrc(it.src) : !!it.url));
  const [open, setOpen] = useState<number | null>(null);

  if (items.length === 0) return null;

  return (
    <section className="panel module module-gallery-block">
      {title && (
        <header className="panel-head">
          <h2>{title}</h2>
        </header>
      )}
      <ul className="gallery-grid" style={{ ['--cols' as string]: columns }}>
        {items.map((it, i) => {
          const poster = it.kind === 'video' ? youtubePoster(it.src) : it.url;
          return (
            <li key={i} className="gallery-cell">
              <button
                type="button"
                className="gallery-thumb"
                onClick={() => setOpen(i)}
                aria-label={it.caption || (it.kind === 'video' ? 'Play video' : 'View image')}
              >
                {poster ? (
                  <img src={poster} alt={it.alt || it.caption || ''} loading="lazy" />
                ) : (
                  <span className="gallery-thumb-fallback" aria-hidden>
                    {it.provider || 'video'}
                  </span>
                )}
                {it.kind === 'video' && (
                  <span className="gallery-play" aria-hidden>
                    <MorphIcon icon={Play} size={18} aria-hidden />
                  </span>
                )}
              </button>
              {it.caption && <span className="gallery-cap muted small">{it.caption}</span>}
            </li>
          );
        })}
      </ul>
      {open !== null && (
        <Lightbox items={items} index={open} onClose={() => setOpen(null)} onIndex={setOpen} />
      )}
    </section>
  );
}

/**
 * A hero CTA link. Unlike SmartLink, a root-relative path that targets a *server*
 * route (/api/…, /media/…) must be a real navigation, not an SPA <Link> — the
 * router would otherwise try to match it as a page and 404. External links open
 * in a new tab; everything else internal stays in the SPA.
 */
function HeroCta({ href, label, primary }: { href: string; label: string; primary: boolean }) {
  const cls = primary ? 'hero-btn hero-btn-primary' : 'hero-btn hero-btn-secondary';
  const external = /^https?:\/\//i.test(href);
  const serverRoute = isServerServedPath(href);
  if (external) {
    return (
      <a className={cls} href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  }
  if (serverRoute) {
    return (
      <a className={cls} href={href}>
        {label}
      </a>
    );
  }
  return (
    <Link className={cls} to={href}>
      {label}
    </Link>
  );
}

interface HeroCard {
  icon: string;
  title: string;
  tag: string;
  body: string;
}

function HeroModule({ config }: { config: Config }) {
  const eyebrow = str(config, 'eyebrow');
  const headline = str(config, 'headline');
  const subhead = str(config, 'subhead');
  const primaryLabel = str(config, 'primaryLabel');
  const primaryHref = str(config, 'primaryHref');
  const secondaryLabel = str(config, 'secondaryLabel');
  const secondaryHref = str(config, 'secondaryHref');
  const chips = (Array.isArray(config.chips) ? config.chips : []).filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );
  const cards = (Array.isArray(config.cards) ? config.cards : [])
    .map((c) => {
      const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      return {
        icon: typeof o.icon === 'string' ? o.icon : '',
        title: typeof o.title === 'string' ? o.title : '',
        tag: typeof o.tag === 'string' ? o.tag : '',
        body: typeof o.body === 'string' ? o.body : '',
      } as HeroCard;
    })
    .filter((c) => c.title || c.body);

  return (
    <div className="module module-hero">
      <section className="hero-panel">
        {eyebrow && <span className="hero-eyebrow">{eyebrow}</span>}
        {headline && <h1 className="hero-headline">{headline}</h1>}
        {subhead && <p className="hero-subhead">{subhead}</p>}
        {(primaryLabel && primaryHref) || (secondaryLabel && secondaryHref) ? (
          <div className="hero-cta">
            {primaryLabel && primaryHref && (
              <HeroCta href={primaryHref} label={primaryLabel} primary />
            )}
            {secondaryLabel && secondaryHref && (
              <HeroCta href={secondaryHref} label={secondaryLabel} primary={false} />
            )}
          </div>
        ) : null}
        {chips.length > 0 && (
          <div className="hero-chips">
            {chips.map((c, i) => (
              <span className="hero-chip" key={i}>
                {c}
              </span>
            ))}
          </div>
        )}
      </section>

      {cards.length > 0 && (
        <div className="hero-grid">
          {cards.map((c, i) => (
            <div className="hero-card" key={i}>
              {c.icon && (
                <span className="hero-card-icon" aria-hidden>
                  {c.icon}
                </span>
              )}
              {c.title && <h3 className="hero-card-title">{c.title}</h3>}
              {c.tag && <p className="hero-card-tag">{c.tag}</p>}
              {c.body && <p className="hero-card-body">{c.body}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MedalsModule({ config }: { config: Config }) {
  return (
    <GalleryModule
      title={str(config, 'title', 'Medals')}
      endpoint="/medals"
      limit={num(config, 'limit', 12)}
      fallbackIcon={Medal}
      pick={(d) =>
        ((d as { medals?: { id: number; name: string; imageUrl: string | null; awardCount?: number }[] }).medals ?? []).map(
          (m) => ({ key: m.id, name: m.name, image: m.imageUrl ?? null, note: m.awardCount ? `${m.awardCount} awarded` : undefined }),
        )
      }
    />
  );
}

function WarRecordsModule({ config }: { config: Config }) {
  return (
    <GalleryModule
      title={str(config, 'title', 'War Records')}
      endpoint="/warrecords"
      limit={num(config, 'limit', 12)}
      fallbackIcon={Trophy}
      pick={(d) =>
        ((d as { warRecords?: { id: number; name: string; imageUrl: string | null; gameName?: string | null }[] }).warRecords ?? []).map(
          (w) => ({ key: w.id, name: w.name, image: w.imageUrl ?? null, note: w.gameName ?? undefined }),
        )
      }
    />
  );
}

function GamesModule({ config }: { config: Config }) {
  return (
    <GalleryModule
      title={str(config, 'title', 'Games We Play')}
      endpoint="/games"
      limit={num(config, 'limit', 12)}
      fallbackIcon={Gamepad2}
      pick={(d) =>
        ((d as { games?: { id: number; name: string; iconUrl: string | null; active?: boolean }[] }).games ?? [])
          .filter((g) => g.active !== false)
          .map((g) => ({ key: g.id, name: g.name, image: g.iconUrl ?? null }))
      }
    />
  );
}

/* ------------------------------------------------------------------ *
 * Leaderboard — top members by events attended (recent or all-time). Members
 * only unless the admin flips the leaderboard public; on a 401 it hides quietly.
 * ------------------------------------------------------------------ */

interface LeaderRow {
  id: number;
  name: string;
  avatar: string | null;
  profileImageUrl: string | null;
  discordId: string;
  count: number;
}

function LeaderboardModule({ config }: { config: Config }) {
  const title = str(config, 'title', 'Most Active');
  const limit = num(config, 'limit', 10);
  const windowMode = str(config, 'window', 'recent') === 'all' ? 'all' : 'recent';
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    api
      .get<{ leaderboard: LeaderRow[] }>(`/attendance/leaderboard?window=${windowMode}`)
      .then(({ leaderboard }) => setRows(leaderboard))
      .catch(() => {
        // 401 for a logged-out visitor when the board isn't public — hide quietly.
        setDenied(true);
        setRows([]);
      });
  }, [windowMode]);

  if (denied) return null;
  if (rows === null) return <ModuleCard title={title}><p className="muted">Loading…</p></ModuleCard>;

  return (
    <ModuleCard title={title} action={<Link className="btn-link" to="/leaderboard">Full board</Link>}>
      {rows.length === 0 ? (
        <p className="muted">No attendance recorded yet.</p>
      ) : (
        <ol className="leaderboard leaderboard-mini">
          {rows.slice(0, limit).map((m, i) => (
            <li key={m.id} className={`leaderboard-row rank-${i + 1 <= 3 ? i + 1 : 'n'}`}>
              <span className="leaderboard-rank">{i + 1}</span>
              <Link to={`/members/${m.id}`} className="leaderboard-member">
                <img className="avatar-sm" src={memberAvatar(m, 64)} alt="" loading="lazy" />
                <span className="name">{m.name}</span>
              </Link>
              <span className="leaderboard-count">{m.count}</span>
            </li>
          ))}
        </ol>
      )}
    </ModuleCard>
  );
}

/* ------------------------------------------------------------------ *
 * Registry — the single map the renderer and editor read.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Training — the course catalog, each an embedded Google Slides deck opened in a
 * modal, with per-member completion (self-attest or officer-marked per course).
 * ------------------------------------------------------------------ */

interface TrainingCourse {
  id: number;
  title: string;
  description: string | null;
  embedSrc: string;
  provider: string | null;
  completionMode: 'self' | 'officer';
  sectionId: number | null;
  requiredRankIds: number[];
  requiredForMe: boolean;
  completed: boolean;
}

interface TrainingSection {
  id: number;
  title: string;
  sortOrder: number;
}

function TrainingModal({
  course,
  busy,
  onClose,
  onMark,
}: {
  course: TrainingCourse;
  busy: boolean;
  onClose: () => void;
  onMark: (done: boolean) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const goFullscreen = () => {
    const el = frameRef.current;
    if (el?.requestFullscreen) el.requestFullscreen().catch(() => {});
  };

  return (
    <div className="lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} aria-label="Close">
        <MorphIcon icon={X} size={18} aria-hidden />
      </button>
      <div className="training-modal" onClick={(e) => e.stopPropagation()}>
        <div className="training-modal-head">
          <h3>{course.title}</h3>
          <div className="training-modal-actions">
            {course.completionMode === 'self' &&
              (course.completed ? (
                <span className="training-done">✓ Completed</span>
              ) : (
                <button type="button" className="primary small" disabled={busy} onClick={() => onMark(true)}>
                  Mark complete
                </button>
              ))}
            {isAllowedSlidesSrc(course.embedSrc) && (
              <button type="button" className="small" onClick={goFullscreen} title="View full screen">
                ⛶ Full screen
              </button>
            )}
          </div>
        </div>
        <div className="training-embed">
          {isAllowedSlidesSrc(course.embedSrc) ? (
            <iframe
              ref={frameRef}
              src={course.embedSrc}
              title={course.title}
              loading="lazy"
              allowFullScreen
              sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
              referrerPolicy="strict-origin-when-cross-origin"
            />
          ) : (
            <p className="muted">This course’s slides link is unavailable.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function TrainingModule({ config }: { config: Config }) {
  const title = str(config, 'title', 'Training');
  const [courses, setCourses] = useState<TrainingCourse[] | null>(null);
  const [sections, setSections] = useState<TrainingSection[]>([]);
  const [sortMode, setSortMode] = useState<'custom' | 'alpha'>('custom');
  const [open, setOpen] = useState<TrainingCourse | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = () =>
    api
      .get<{ trainings: TrainingCourse[]; sections: TrainingSection[]; sortMode?: string }>('/training')
      .then((d) => {
        setCourses(d.trainings);
        setSections(d.sections ?? []);
        setSortMode(d.sortMode === 'alpha' ? 'alpha' : 'custom');
      })
      .catch(() => setCourses([]));

  useEffect(() => {
    void load();
  }, []);

  const mark = async (course: TrainingCourse, done: boolean) => {
    setBusy(course.id);
    try {
      if (done) await api.post(`/training/${course.id}/complete`);
      else await api.del(`/training/${course.id}/complete`);
      setCourses((cs) => cs?.map((c) => (c.id === course.id ? { ...c, completed: done } : c)) ?? cs);
      setOpen((o) => (o && o.id === course.id ? { ...o, completed: done } : o));
    } catch {
      /* leave state as-is on failure */
    } finally {
      setBusy(null);
    }
  };

  const item = (c: TrainingCourse) => (
    <li key={c.id} className="training-item">
      {/* The whole card opens the course; the mark buttons sit outside it. */}
      <button type="button" className="training-item-open" onClick={() => setOpen(c)} title="Open training">
        <span className="training-item-head">
          <span className="training-name">{c.title}</span>
          {c.requiredForMe && <span className="training-req">Required</span>}
          {c.completed && <span className="training-done">✓ Completed</span>}
        </span>
        {c.description && <span className="training-desc muted small">{c.description}</span>}
      </button>
      {c.completionMode === 'self' && (
        <div className="training-item-actions">
          {c.completed ? (
            <button type="button" className="mini" disabled={busy === c.id} onClick={() => mark(c, false)}>
              Undo
            </button>
          ) : (
            <button type="button" className="mini primary" disabled={busy === c.id} onClick={() => mark(c, true)}>
              Mark done
            </button>
          )}
        </div>
      )}
    </li>
  );

  if (courses === null)
    return (
      <ModuleCard title={title}>
        <p className="muted">Loading…</p>
      </ModuleCard>
    );
  if (courses.length === 0) return null;

  // Ungrouped courses render flat at the top; each non-empty section becomes a
  // collapsible group (default open). A course whose section was deleted falls
  // back to ungrouped.
  // Custom keeps the admin's drag order (already sorted server-side); alpha sorts
  // by title within each group. Filtering preserves order, so sort the whole list
  // once up front.
  const ordered =
    sortMode === 'alpha' ? [...courses].sort((a, b) => a.title.localeCompare(b.title)) : courses;
  const sectionIds = new Set(sections.map((s2) => s2.id));
  const ungrouped = ordered.filter((c) => c.sectionId == null || !sectionIds.has(c.sectionId));
  const groups = sections
    .map((sec) => ({ sec, items: ordered.filter((c) => c.sectionId === sec.id) }))
    .filter((g) => g.items.length > 0);

  return (
    <ModuleCard title={title}>
      {ungrouped.length > 0 && <ul className="training-list">{ungrouped.map(item)}</ul>}
      {groups.map((g) => (
        <details key={g.sec.id} className="training-section" open>
          <summary>
            <span className="training-section-title">{g.sec.title}</span>
            <span className="training-section-count">{g.items.length}</span>
          </summary>
          <ul className="training-list">{g.items.map(item)}</ul>
        </details>
      ))}
      {open && (
        <TrainingModal course={open} busy={busy === open.id} onClose={() => setOpen(null)} onMark={(d) => mark(open, d)} />
      )}
    </ModuleCard>
  );
}

/* ------------------------------------------------------------------ *
 * Tournaments — active and upcoming tournaments, newest first. Hides quietly
 * for a logged-out visitor with no public tournaments.
 * ------------------------------------------------------------------ */

interface TournamentCardRow {
  id: number;
  name: string;
  slug: string;
  status: string;
  competitorType: string;
  entrantCount: number;
}

const T_STATUS: Record<string, string> = {
  draft: 'Draft',
  registration: 'Registration open',
  seeding: 'Seeding',
  in_progress: 'In progress',
  complete: 'Complete',
};

function TournamentsModule({ config }: { config: Config }) {
  const title = str(config, 'title', 'Tournaments');
  const limit = num(config, 'limit', 5);
  const [rows, setRows] = useState<TournamentCardRow[] | null>(null);

  useEffect(() => {
    api
      .get<{ tournaments: TournamentCardRow[] }>('/tournaments')
      .then(({ tournaments }) => setRows(tournaments))
      .catch(() => setRows([]));
  }, []);

  if (rows === null) return <ModuleCard title={title}><p className="muted">Loading…</p></ModuleCard>;
  // Active first (not complete), then the rest — and only as many as `limit`.
  const active = rows.filter((t) => t.status !== 'complete');
  const shown = (active.length ? active : rows).slice(0, limit);
  if (shown.length === 0) return null;

  return (
    <ModuleCard title={title} action={<Link className="btn-link" to="/tournaments">All</Link>}>
      <ul className="module-tournaments">
        {shown.map((t) => (
          <li key={t.id}>
            <Link to={`/tournaments/${t.slug}`} className="module-tournament">
              <span className="module-tournament-name">{t.name}</span>
              <span className="module-tournament-meta">
                <span className={`status-chip status-${t.status}`}>{T_STATUS[t.status] ?? t.status}</span>
                <span className="muted small">{t.entrantCount} {t.competitorType === 'team' ? 'teams' : 'entrants'}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </ModuleCard>
  );
}

export const MODULE_RENDERERS: Record<ModuleType, (props: { config: Config }) => ReactNode> = {
  heading: HeadingModule,
  text: TextModule,
  html: HtmlModule,
  hero: HeroModule,
  image: ImageModule,
  gallery: MediaGalleryModule,
  button: ButtonModule,
  embed: EmbedModule,
  divider: DividerModule,
  news: NewsModule,
  roster: RosterModule,
  events: EventsModule,
  medals: MedalsModule,
  warrecords: WarRecordsModule,
  games: GamesModule,
  training: TrainingModule,
  leaderboard: LeaderboardModule,
  tournaments: TournamentsModule,
};
