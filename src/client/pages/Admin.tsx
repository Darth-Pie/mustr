/**
 * The admin panel shell.
 *
 * A grouped left sidebar (Content / People / Settings) of items; each item opens
 * in the content area and may host several tools as tabs (e.g. Ranks & Roles).
 * Everything is gated by permission via the tree in lib/adminSections.ts, so the
 * sidebar only shows what the viewer can touch. Under each group we also surface
 * a few recently-viewed records for quick return.
 *
 * To keep it from feeling like a separate app, the panel wears the same top bar
 * as the rest of the site, adds a breadcrumb so you always know where you are,
 * and the section rail is sticky + icon-led and can be collapsed (a drawer on
 * mobile, so the tool shows first instead of being pushed below the whole menu).
 */

import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Link, useParams } from 'react-router-dom';
import { MorphIcon } from 'morphicons/react';
import {
  PanelLeft,
  FileText,
  Navigation,
  Newspaper,
  Images,
  Users,
  Award,
  Network,
  Bot,
  Gauge,
  Palette,
  ScrollText,
  UserPlus,
  GraduationCap,
  Rocket,
  Bell,
  History,
  Activity,
  Trophy,
  Handshake,
} from 'lucide';
import { useSession } from '../lib/session';
import { api } from '../lib/api';
import { visibleAdminGroups } from '../lib/adminSections';
import type { AdminNavOverride } from '../../shared/adminNav';
import { isMustrHost } from '../lib/wordmark';
import { getRecent } from '../lib/recent';
import UsageBar from '../components/UsageBar';
import MorphingTabs from '../components/MorphingTabs';
import SigilLoader from '../components/SigilLoader';

// Every admin tool is its own chunk, loaded only when its tab is opened — a
// session that only ever visits Ranks & Roles shouldn't pay for News, Alliance,
// the Org Chart designer, and 25 other tools it never renders. TAB_RENDERERS
// below invokes exactly one of these per render, so this is a pure packaging
// change: same components, same props, nothing about behavior moves.
const NewsAdmin = lazy(() => import('./NewsAdmin'));
const GalleryAdmin = lazy(() => import('./GalleryAdmin'));
const Ranks = lazy(() => import('./Ranks'));
const Roles = lazy(() => import('./Roles'));
const Medals = lazy(() => import('./Medals'));
const Games = lazy(() => import('./Games'));
const WarRecords = lazy(() => import('./WarRecords'));
const Announcements = lazy(() => import('./Announcements'));
const IdentityAdmin = lazy(() => import('./IdentityAdmin'));
const AnalyticsAdmin = lazy(() => import('./AnalyticsAdmin'));
const ModulesAdmin = lazy(() => import('./ModulesAdmin'));
const Theme = lazy(() => import('./Theme'));
const BrandingAdmin = lazy(() => import('./BrandingAdmin'));
const BrandmarkAdmin = lazy(() => import('./BrandmarkAdmin'));
const ForgeStudio = lazy(() => import('./ForgeStudio'));
const SeoAdmin = lazy(() => import('./SeoAdmin'));
const FooterAdmin = lazy(() => import('./FooterAdmin'));
const PagesAdmin = lazy(() => import('./PagesAdmin'));
const BuiltinPagesAdmin = lazy(() => import('./BuiltinPagesAdmin'));
const NavAdmin = lazy(() => import('./NavAdmin'));
const OrgChartDesigner = lazy(() => import('./OrgChartDesigner'));
const AttendanceAdmin = lazy(() => import('./AttendanceAdmin'));
const TournamentsAdmin = lazy(() => import('./TournamentsAdmin'));
const AllianceAdmin = lazy(() => import('./AllianceAdmin'));
const ApplicantsAdmin = lazy(() => import('./ApplicantsAdmin'));
const BansAdmin = lazy(() => import('./BansAdmin'));
const TrainingAdmin = lazy(() => import('./TrainingAdmin'));
const MustrGgAdmin = lazy(() => import('./MustrGgAdmin'));
const AdminMenuAdmin = lazy(() => import('./AdminMenuAdmin'));
const NotificationsAdmin = lazy(() => import('./NotificationsAdmin'));
const NotificationsInbox = lazy(() => import('./NotificationsInbox'));
const SnapshotsAdmin = lazy(() => import('./SnapshotsAdmin'));
const AuditLog = lazy(() => import('./AuditLog'));

/** Cached admin-menu arrangement, so the sidebar renders in the saved order on
 *  first paint instead of flashing the default and then reordering. */
const OVERRIDE_CACHE = 'ct-admin-nav-override';

/** Sidebar item key → an icon, so the rail reads like a real nav rail. */
const ITEM_ICONS: Record<string, typeof FileText> = {
  pages: FileText,
  navigation: Navigation,
  news: Newspaper,
  gallery: Images,
  training: GraduationCap,
  admissions: UserPlus,
  'ranks-roles': Users,
  'medals-records': Award,
  'org-chart': Network,
  attendance: Activity,
  tournaments: Trophy,
  discord: Bot,
  analytics: Gauge,
  alliance: Handshake,
  appearance: Palette,
  notifications: Bell,
  logs: ScrollText,
  backups: History,
  mustrgg: Rocket,
};

/** Tab key → its component. Every tab key in adminSections.ts needs an entry. */
const TAB_RENDERERS: Record<string, () => ReactNode> = {
  pages: () => <PagesAdmin />,
  builtinpages: () => <BuiltinPagesAdmin />,
  navigation: () => <NavAdmin />,
  news: () => <NewsAdmin />,
  gallery: () => <GalleryAdmin />,
  training: () => <TrainingAdmin />,
  applicants: () => <ApplicantsAdmin />,
  bans: () => <BansAdmin />,
  ranks: () => <Ranks />,
  roles: () => <Roles />,
  medals: () => <Medals />,
  warrecords: () => <WarRecords />,
  games: () => <Games />,
  orgchart: () => <OrgChartDesigner />,
  attendance: () => <AttendanceAdmin />,
  tournaments: () => <TournamentsAdmin />,
  announcements: () => <Announcements />,
  identity: () => <IdentityAdmin />,
  analytics: () => <AnalyticsAdmin />,
  modules: () => <ModulesAdmin />,
  alliance: () => <AllianceAdmin />,
  theme: () => <Theme />,
  branding: () => <BrandingAdmin />,
  brandmark: () => <BrandmarkAdmin />,
  forge: () => <ForgeStudio />,
  seo: () => <SeoAdmin />,
  footer: () => <FooterAdmin />,
  audit: () => <AuditLog />,
  adminmenu: () => <AdminMenuAdmin />,
  notifinbox: () => <NotificationsInbox />,
  notifrules: () => <NotificationsAdmin />,
  backups: () => <SnapshotsAdmin />,
  mustrgg: () => <MustrGgAdmin />,
};

export default function Admin() {
  const { item: itemParam, tab: tabParam } = useParams();
  const { can, viewer } = useSession();

  // Section rail open/closed. Persisted so a chosen state sticks; defaults open
  // on desktop and closed on mobile (there the rail is a drawer over the tool).
  const [navOpen, setNavOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = localStorage.getItem('ct-admin-nav');
    if (stored === '0') return false;
    if (stored === '1') return true;
    return window.innerWidth > 720;
  });
  useEffect(() => {
    try {
      localStorage.setItem('ct-admin-nav', navOpen ? '1' : '0');
    } catch {
      /* private mode — the toggle still works for the session */
    }
  }, [navOpen]);
  // On a phone the rail overlays the tool, so pick-a-section should close it.
  const closeOnMobile = () => {
    if (typeof window !== 'undefined' && window.innerWidth <= 720) setNavOpen(false);
  };

  // The saved sidebar arrangement. Seed from the localStorage cache so the rail
  // paints in order immediately, then revalidate from the server and refresh live
  // when the Admin Menu editor saves (it fires `ct-adminnav-changed`).
  const [override, setOverride] = useState<AdminNavOverride | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = localStorage.getItem(OVERRIDE_CACHE);
      return raw ? (JSON.parse(raw) as AdminNavOverride) : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const load = () => {
      api
        .get<{ override: AdminNavOverride | null }>('/admin-nav')
        .then((d) => {
          setOverride(d.override);
          try {
            if (d.override) localStorage.setItem(OVERRIDE_CACHE, JSON.stringify(d.override));
            else localStorage.removeItem(OVERRIDE_CACHE);
          } catch {
            /* private mode — arrangement still applies for the session */
          }
        })
        .catch(() => {
          /* offline or unauthorized → fall back to the built-in order */
        });
    };
    load();
    window.addEventListener('ct-adminnav-changed', load);
    return () => window.removeEventListener('ct-adminnav-changed', load);
  }, []);

  // Re-read recently-viewed when it changes (a tool recorded one, another tab wrote it).
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener('ct-recent', bump);
    window.addEventListener('storage', bump);
    return () => {
      window.removeEventListener('ct-recent', bump);
      window.removeEventListener('storage', bump);
    };
  }, []);

  const groups = visibleAdminGroups(can, isMustrHost(), override, !!viewer?.isGod);
  if (groups.length === 0) {
    return <div className="empty">You don’t have access to any admin tools.</div>;
  }

  const items = groups.flatMap((g) => g.items);
  const activeItem = items.find((i) => i.key === itemParam);

  // No item, or one they can't reach → land on the first available item.
  if (!activeItem) return <Navigate to={`/admin/${items[0]!.key}`} replace />;

  const tabs = activeItem.tabs; // already filtered to allowed
  const activeTab = tabs.find((t) => t.key === tabParam) ?? tabs[0]!;

  // Recently-viewed records for the group the active item belongs to, shown as a
  // horizontal strip above the content (not crammed into the sidebar).
  const activeGroup = groups.find((g) => g.items.some((i) => i.key === activeItem.key));
  const recent = activeGroup ? getRecent(activeGroup.key) : [];

  return (
    <>
      <UsageBar />

      {/* Header: the section toggle + a breadcrumb, so entering admin is an
          oriented landing rather than an abrupt layout swap. */}
      <div className="admin-header">
        <button
          type="button"
          className="admin-nav-toggle"
          aria-expanded={navOpen}
          aria-controls="admin-sections"
          onClick={() => setNavOpen((o) => !o)}
        >
          <MorphIcon icon={PanelLeft} size={16} aria-hidden />
          Sections
        </button>
        <nav className="admin-crumbs" aria-label="Breadcrumb">
          <Link to="/admin" className="admin-crumb">
            Admin
          </Link>
          {activeGroup && (
            <>
              <span className="admin-crumb-sep" aria-hidden>
                ›
              </span>
              <span className="admin-crumb">{activeGroup.label}</span>
            </>
          )}
          <span className="admin-crumb-sep" aria-hidden>
            ›
          </span>
          <span className="admin-crumb current">
            <MorphIcon
              className="admin-crumb-icon"
              icon={ITEM_ICONS[activeItem.key] ?? FileText}
              size={15}
              spring="snappy"
              aria-hidden
            />
            {activeItem.label}
          </span>
        </nav>
      </div>

      <div className={navOpen ? 'admin-shell nav-open' : 'admin-shell'}>
        <nav id="admin-sections" className="admin-nav" aria-label="Admin sections">
          {groups.map((g) => (
            <div className="admin-nav-group" key={g.key}>
              <div className="admin-nav-title">{g.label}</div>
              {g.items.map((i) => (
                <NavLink
                  key={i.key}
                  to={`/admin/${i.key}`}
                  onClick={closeOnMobile}
                  className={i.key === activeItem.key ? 'admin-nav-link active' : 'admin-nav-link'}
                >
                  <MorphIcon className="admin-nav-icon" icon={ITEM_ICONS[i.key] ?? FileText} size={16} aria-hidden />
                  {i.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="admin-content">
          {recent.length > 0 && (
            <div className="admin-recentbar">
              <span className="admin-recentbar-title">Recently viewed</span>
              {recent.map((r) => (
                <Link key={r.to} to={r.to} className="admin-recentbar-link" title={r.label}>
                  {r.label}
                </Link>
              ))}
            </div>
          )}

          {tabs.length > 1 && (
            <MorphingTabs
              tabs={tabs}
              activeKey={activeTab.key}
              ariaLabel={activeItem.label}
              hrefFor={(k) => `/admin/${activeItem.key}/${k}`}
            />
          )}
          <Suspense fallback={<SigilLoader />}>{TAB_RENDERERS[activeTab.key]?.()}</Suspense>
        </div>
      </div>
    </>
  );
}
