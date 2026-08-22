import { lazy, Suspense, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { MorphIcon } from 'morphicons/react';
import { Menu, X } from 'lucide';
import { useSession } from './lib/session';
import { useBranding } from './lib/branding';
import type { Permission } from '../shared/permissions';
import AccountMenu from './components/AccountMenu';
import NotificationBell from './components/NotificationBell';
import SiteNav from './components/SiteNav';
import SigilLoader from './components/SigilLoader';
import type { NavItem } from '../shared/nav';
// Setup stays a static import: fetchSetupStatus below is called during boot,
// outside the Suspense-wrapped route tree, so the module loads eagerly either
// way — lazy-loading just the default export here wouldn't save anything.
import Setup, { fetchSetupStatus, type SetupStatus } from './pages/Setup';
import { decorateWordmark, wordmarkEnabled, isMustrHost } from './lib/wordmark';
import { api } from './lib/api';
import { sanitizeHtml } from './lib/richtext';
import type { FooterConfig } from '../shared/footer';

// The admin panel pulls in the WYSIWYG editor (TipTap/ProseMirror), which is
// large and admin-only — load it on demand so the feed and roster stay light.
const Admin = lazy(() => import('./pages/Admin'));

// The gallery brings its own layout + lightbox libraries and their stylesheets.
// Only visitors who actually open it should pay for that, so it loads on demand
// the same way the admin panel does.
const Gallery = lazy(() => import('./pages/Gallery'));
const GalleryAlbum = lazy(() => import('./pages/GalleryAlbum'));

// The public Sigil Forge share page carries the whole animation engine; it's a
// standalone viral landing, so load it on demand and keep it out of the app's
// initial bundle.
const ForgeShare = lazy(() => import('./pages/ForgeShare'));

// Every routed page loads on demand — a visit to any one route shouldn't pay
// for the code of the other eleven. The <Suspense> already wrapping <Routes>
// below (unchanged) covers all of these; this is a pure packaging change.
const Login = lazy(() => import('./pages/Login'));
const MemberDetail = lazy(() => import('./pages/MemberDetail'));
const AccountSettings = lazy(() => import('./pages/AccountSettings'));
const Roster = lazy(() => import('./pages/Roster'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const Tournaments = lazy(() => import('./pages/Tournaments'));
const TournamentDetail = lazy(() => import('./pages/TournamentDetail'));
const Home = lazy(() => import('./pages/Home'));
const CustomPage = lazy(() => import('./pages/CustomPage'));
const News = lazy(() => import('./pages/News'));
const NewsPost = lazy(() => import('./pages/NewsPost'));
const Events = lazy(() => import('./pages/Events'));

/** Shown to a pending applicant who lands on a members-only area. */
function PendingNotice() {
  const { viewer } = useSession();
  return (
    <div className="pending-notice">
      <h2>⏳ Your application is in review</h2>
      <p>
        Thanks for signing in! You’re not a member yet — an officer will review your application soon. In the
        meantime you can complete your profile so they know who you are.
      </p>
      {viewer && (
        <Link className="btn-cta primary" to={`/members/${viewer.id}`}>
          Complete your profile
        </Link>
      )}
    </div>
  );
}

function Protected({
  permission,
  allowPending,
  children,
}: {
  permission?: Permission;
  allowPending?: boolean;
  children: ReactNode;
}) {
  const { viewer, loading, can } = useSession();
  if (loading) return <SigilLoader />;
  if (!viewer) return <Navigate to="/login" replace />;
  // A pending applicant (not in demo preview mode) can only reach their own
  // profile; every other members-only area shows the "in review" notice.
  if (viewer.pending && !viewer.preview && !allowPending) {
    return <PendingNotice />;
  }
  if (permission && !can(permission)) {
    return <div className="empty">You don’t have access to this area.</div>;
  }
  return <>{children}</>;
}

/**
 * A route that renders for signed-in members always, and for logged-out visitors
 * only when its built-in page (`pageKey`) is public — otherwise it sends them to
 * /login. Waits for `ready` (the public list) before deciding, so an anonymous
 * visitor to a public page is never briefly bounced.
 */
function PublicOr({
  pageKey,
  publicSlugs,
  ready,
  children,
}: {
  pageKey: string;
  publicSlugs: Set<string>;
  ready: boolean;
  children: ReactNode;
}) {
  const { viewer, loading } = useSession();
  if (loading || (!viewer && !ready)) return <SigilLoader />;
  if (viewer) return <>{children}</>;
  return publicSlugs.has(pageKey) ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  const { viewer, siteName, loading } = useSession();
  const { branding } = useBranding();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  // mustr.gg-only: auto-style the "mustr" wordmark in page copy (off by default).
  const [wordmarkOn, setWordmarkOn] = useState(false);
  const [navItems, setNavItems] = useState<NavItem[]>([]);
  // Slugs of pages a logged-out visitor may open ('home' included when the home
  // page is public). Passed to SiteNav so it can hide menu links that would just
  // bounce an anonymous visitor to /login.
  const [publicSlugs, setPublicSlugs] = useState<Set<string>>(new Set());
  // True once the public list has loaded at least once, so a public-capable route
  // can wait for it before deciding to bounce an anonymous visitor to /login.
  const [accessReady, setAccessReady] = useState(false);
  const [footer, setFooter] = useState<FooterConfig | null>(null);
  // First-run detection: undefined = still checking, null = check failed (treat as
  // claimed so a transient error never hides a live site), object = known state.
  // An unclaimed install renders the wizard ahead of everything else.
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null | undefined>(undefined);
  const [scrolled, setScrolled] = useState(false);
  // Logo aspect ratio (width/height), measured on load, so the header can
  // reserve exactly the collapsed logo's width and the nav never jumps.
  const [logoAspect, setLogoAspect] = useState(1);

  // Keep the browser-tab title in sync with the configured site name (the served
  // HTML title is set server-side; this covers client-side navigation + updates).
  useEffect(() => {
    if (siteName) document.title = siteName;
  }, [siteName]);

  // Is this a brand-new, unclaimed install? Checked once on mount; if so, the
  // whole app is replaced by the setup wizard below.
  useEffect(() => {
    void fetchSetupStatus().then(setSetupStatus);
  }, []);

  // mustr.gg-only wordmark styling: check the toggle once, then decorate the
  // content on every navigation (rAF for the sync render, a delayed pass for
  // content that loads async). No-op on any other host.
  useEffect(() => {
    if (isMustrHost()) void wordmarkEnabled().then(setWordmarkOn);
  }, []);
  useEffect(() => {
    if (!wordmarkOn) return;
    const raf = requestAnimationFrame(() => decorateWordmark());
    const t = setTimeout(() => decorateWordmark(), 500);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [wordmarkOn, location.pathname]);

  // The site footer is public (shows on the login page too) and rarely changes,
  // so load it once on mount regardless of auth.
  useEffect(() => {
    api
      .get<{ footer: FooterConfig }>('/settings/footer')
      .then((d) => setFooter(d.footer))
      .catch(() => setFooter(null));
  }, []);

  // Which pages a logged-out visitor may open, for gating the nav. Loaded for
  // everyone (the endpoint is public) and refreshed when a page's public flag or
  // existence changes (ct-pages-changed).
  useEffect(() => {
    const loadPublic = () =>
      api
        .get<{ slugs: string[] }>('/pages/public/list')
        .then((d) => setPublicSlugs(new Set(d.slugs)))
        .catch(() => setPublicSlugs(new Set()))
        .finally(() => setAccessReady(true));
    void loadPublic();
    window.addEventListener('ct-pages-changed', loadPublic);
    return () => window.removeEventListener('ct-pages-changed', loadPublic);
  }, []);

  // Shrink the header (and its logo) once the page scrolls past the top.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // The admin-arranged menu tree. Loaded for everyone (the endpoint is public;
  // SiteNav gates each entry per viewer, so a logged-out visitor still sees Home
  // and any public page). Reloaded when the viewer changes (permissions may add
  // or remove entries), when the Navigation builder saves (`ct-nav-changed`), or
  // when a page is created/deleted (`ct-pages-changed` — the server prunes it).
  useEffect(() => {
    const loadNav = () =>
      api
        .get<{ nav: { items: NavItem[] } }>('/nav')
        .then((d) => setNavItems(d.nav.items))
        .catch(() => setNavItems([]));
    void loadNav();
    window.addEventListener('ct-nav-changed', loadNav);
    window.addEventListener('ct-pages-changed', loadNav);
    return () => {
      window.removeEventListener('ct-nav-changed', loadNav);
      window.removeEventListener('ct-pages-changed', loadNav);
    };
  }, [viewer]);

  if (loading || setupStatus === undefined) return <SigilLoader />;

  // A fresh install with no owner yet: the setup wizard is the only thing that
  // should render, full-bleed, regardless of the requested route.
  if (setupStatus && !setupStatus.claimed) return <Setup status={setupStatus} />;

  // The public Sigil Forge share page renders full-bleed (its own cinematic
  // chrome), outside the app shell and with no login — a link works for anyone.
  if (location.pathname === '/forge') {
    return (
      <Suspense fallback={<SigilLoader />}>
        <ForgeShare />
      </Suspense>
    );
  }

  const hasLogo = !!branding.logoUrl;
  const collapsed = 38; // logo height (px) once docked inside the bar
  const cap = 460; // matches the logo's CSS max-width, so the reserved slot agrees
  const topbarStyle = {
    '--logo-expanded': `${branding.logoSize}px`,
    '--logo-collapsed': `${collapsed}px`,
    // Reserve the logo's full (expanded) footprint so it never covers the menu;
    // --logo-fp-min is the docked footprint used on mobile.
    '--logo-fp': `${Math.min(Math.round(branding.logoSize * logoAspect), cap)}px`,
    '--logo-fp-min': `${Math.round(collapsed * logoAspect)}px`,
  } as CSSProperties;

  return (
    <div className="app">
      <header
        className={`topbar${scrolled ? ' scrolled' : ''}${hasLogo ? ' has-logo' : ''}`}
        style={hasLogo ? topbarStyle : undefined}
      >
        {navItems.length > 0 && (
          <button
            className="nav-toggle"
            aria-label="Menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <MorphIcon icon={menuOpen ? X : Menu} size={22} spring="snappy" aria-hidden />
          </button>
        )}
        <Link to="/" className="brand" aria-label={siteName}>
          {hasLogo ? (
            <img
              className="brand-logo"
              src={branding.logoUrl}
              alt={siteName}
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalHeight > 0) setLogoAspect(img.naturalWidth / img.naturalHeight);
              }}
            />
          ) : (
            <span className="brand-name">
              <span className="brand-lead">{(siteName || '').slice(0, 1)}</span>
              {(siteName || '').slice(1)}
            </span>
          )}
        </Link>

        <nav className={menuOpen ? 'nav open' : 'nav'}>
          <SiteNav items={navItems} publicSlugs={publicSlugs} onNavigate={() => setMenuOpen(false)} />
        </nav>

        <div className="account">
          {viewer ? (
            <>
              {!viewer.pending && <NotificationBell />}
              <AccountMenu />
            </>
          ) : (
            <a className="discord-btn" href="/api/auth/login">
              Sign in with Discord
            </a>
          )}
        </div>
      </header>

      {viewer?.preview && (
        <div className="preview-banner">
          👀 Preview mode — you’re exploring {siteName} as a guest. Changes are disabled.
        </div>
      )}

      <main className="content">
        <Suspense fallback={<SigilLoader />}>
          <Routes>
          <Route path="/login" element={<Login />} />
          {/* Setup only renders (full-bleed, above) while unclaimed; once claimed,
              visiting it just goes home. */}
          <Route path="/setup" element={<Navigate to="/" replace />} />

          {/* Home and custom pages are public-capable: they render for logged-out
              visitors when the page is marked public, and redirect to /login
              otherwise. The components make that call (they know each page's flag). */}
          <Route path="/" element={<Home />} />
          <Route
            path="/news"
            element={
              <PublicOr pageKey="news" publicSlugs={publicSlugs} ready={accessReady}>
                <News />
              </PublicOr>
            }
          />
          <Route
            path="/news/:slug"
            element={
              <PublicOr pageKey="news" publicSlugs={publicSlugs} ready={accessReady}>
                <NewsPost />
              </PublicOr>
            }
          />
          {/* Leadership folded into the roster; keep the old path working. */}
          <Route path="/leadership" element={<Navigate to="/roster" replace />} />
          <Route
            path="/roster"
            element={
              <Protected>
                <Roster />
              </Protected>
            }
          />
          <Route
            path="/leaderboard"
            element={
              <PublicOr pageKey="leaderboard" publicSlugs={publicSlugs} ready={accessReady}>
                <Leaderboard />
              </PublicOr>
            }
          />
          {/* Public-capable like the gallery: the list/detail APIs filter by each
              tournament's isPublic flag, so an anonymous visitor only ever sees
              public tournaments. Left unwrapped for the same reason. */}
          <Route path="/tournaments" element={<Tournaments />} />
          <Route path="/tournaments/:key" element={<TournamentDetail />} />
          <Route path="/p/:slug" element={<CustomPage />} />
          {/* Public-capable and deliberately unwrapped: the gallery API filters
              albums by audience, so whatever a visitor gets back is theirs to
              see. Wrapping these in <Protected> would lock out the public
              albums that are the whole point of the module. */}
          <Route path="/gallery" element={<Gallery />} />
          <Route path="/gallery/:slug" element={<GalleryAlbum />} />
          <Route
            path="/events"
            element={
              <Protected permission="events.view">
                <Events />
              </Protected>
            }
          />
          <Route
            path="/members/:id"
            element={
              <Protected allowPending>
                <MemberDetail />
              </Protected>
            }
          />
          <Route
            path="/account"
            element={
              <Protected>
                <AccountSettings />
              </Protected>
            }
          />
          {/* One shell for every admin tool; the panel gates each item/tab.
              /admin/:item is a sidebar entry; /admin/:item/:tab picks a tool
              within a multi-tool item (e.g. Ranks & Roles). */}
          <Route
            path="/admin"
            element={
              <Protected>
                <Admin />
              </Protected>
            }
          />
          <Route
            path="/admin/:item"
            element={
              <Protected>
                <Admin />
              </Protected>
            }
          />
          <Route
            path="/admin/:item/:tab"
            element={
              <Protected>
                <Admin />
              </Protected>
            }
          />
            <Route path="*" element={<div className="empty">Not found.</div>} />
          </Routes>
        </Suspense>
      </main>

      {footer && (footer.text || footer.links.length > 0 || footer.copyright) && (
        <footer className="site-footer">
          {footer.text && (
            <div
              className="site-footer-text"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(footer.text) }}
            />
          )}
          {footer.links.length > 0 && (
            <nav className="site-footer-links" aria-label="Footer">
              {/* Plain anchors (full navigation): footer links may point at
                  server routes like /legal that aren't SPA routes, so a client
                  <Link> would 404. External links open in a new tab. */}
              {footer.links.map((l, i) =>
                /^https?:\/\//i.test(l.href) ? (
                  <a key={i} href={l.href} target="_blank" rel="noopener noreferrer">
                    {l.label}
                  </a>
                ) : (
                  <a key={i} href={l.href}>
                    {l.label}
                  </a>
                ),
              )}
            </nav>
          )}
          <div className="site-footer-copy">
            {footer.copyright || `© ${new Date().getFullYear()} ${siteName}`}
          </div>
        </footer>
      )}
    </div>
  );
}
