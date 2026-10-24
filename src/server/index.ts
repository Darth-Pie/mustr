import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import * as s from '../db/schema';
import type { AppContext, Env } from './env';
import { db, withViewer } from './middleware/auth';
import {
  authorizeUrl,
  newState,
  stateCookie,
  clearedStateCookie,
  exchangeCode,
  fetchUser,
  fetchGuildMember,
  OAUTH_STATE_COOKIE,
} from './auth/discord';
import {
  SESSION_COOKIE,
  createSession,
  invalidateSession,
  purgeExpiredSessions,
  sessionCookie,
  clearedSessionCookie,
} from './auth/session';
import {
  InteractionType,
  verifySignature,
  ephemeral,
  defer,
  deferUpdate,
  editOriginalResponse,
  InteractionResponseType,
  type Interaction,
} from './discord/interactions';
import { handleCommand } from './discord/commands';
import { handleEventComponent, isEventComponent } from './discord/eventInteractions';
import { handleTournamentComponent, isTournamentComponent } from './discord/tournamentInteractions';
import { loadConfig, discordClient } from './config';
import { syncMemberRankRoles, reconcileBatch } from './discord/sync';
import { awardTenureMedals } from './medals/tenure';
import { awardActivityMedals } from './medals/activity';
import { recordActivity } from './attendance';
import { materializeRecurringEvents } from './events/recurrence';
import ranks from './routes/ranks';
import members from './routes/members';
import bansRoutes from './routes/bans';
import training from './routes/training';
import setupRoutes from './routes/setup';
import snapshotsRoutes from './routes/snapshots';
import attendanceRoutes from './routes/attendance';
import { aboutPageHtml } from './marketing/about';
import { productPageHtml } from './marketing/product';
import { setupGuideHtml } from './marketing/setup-guide';
import { botTrustHtml } from './marketing/bot-trust';
import { loadThemeAccent } from './marketing/palette';
import settings from './routes/settings';
import rolesRoutes from './routes/roles';
import medalsRoutes from './routes/medals';
import mediaRoutes, { serveMediaObject } from './routes/media';
import newsRoutes from './routes/news';
import usageRoutes from './routes/usage';
import gamesRoutes from './routes/games';
import warRecordsRoutes from './routes/warrecords';
import eventsRoutes from './routes/events';
import auditRoutes from './routes/audit';
import pagesRoutes from './routes/pages';
import navRoutes from './routes/nav';
import adminNavRoutes from './routes/admin-nav';
import notificationsRoutes from './routes/notifications';
import { emitNotification } from './notifications';
import hangarRoutes from './routes/hangar';
import galleryRoutes from './routes/gallery';
import scVerifyRoutes from './routes/scVerify';
import { loadSeo, renderHead } from './seo';
import tokensRoutes from './routes/tokens';
import orgChartRoutes from './routes/orgchart';
import tournamentsRoutes from './routes/tournaments';
import wowRoutes from './routes/wow';
import allianceRoutes from './routes/alliance';
import { escapeHtml, renderLayoutBody } from './pages/render';

const app = new Hono<AppContext>();

/* ------------------------------------------------------------------ *
 * Canonical host — redirect `www.` to the bare apex, preserving path and
 * query, so a link to www.<domain> (or a browser that auto-prepends www)
 * lands on the one host where cookies and OAuth live instead of dead-ending.
 * Registered first so it runs ahead of every route and auth check. Host-based
 * (not domain-hardcoded) so it works for any install's own domain.
 * ------------------------------------------------------------------ */

app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname.startsWith('www.')) {
    url.hostname = url.hostname.slice(4);
    return c.redirect(url.toString(), 301);
  }
  return next();
});

/* ------------------------------------------------------------------ *
 * Discord interactions — must be registered BEFORE withViewer, because
 * it authenticates by Ed25519 signature, not by session cookie, and the
 * raw body has to stay unparsed until the signature is checked.
 * ------------------------------------------------------------------ */

app.post('/api/discord/interactions', async (c) => {
  const raw = await c.req.text();

  // Verify with the public key from the env var when present (instant, no D1),
  // falling back to the stored config only when it isn't (buyer installs enter
  // it in the setup wizard). Keeping D1 off this path means the 3-second Discord
  // ack deadline is never at the mercy of a cold database read.
  const publicKey = c.env.DISCORD_PUBLIC_KEY || (await loadConfig(c.env)).discord.publicKey;
  const valid = await verifySignature(
    raw,
    c.req.header('x-signature-ed25519') ?? null,
    c.req.header('x-signature-timestamp') ?? null,
    publicKey,
  );
  // Discord probes with bad signatures on purpose when you save the endpoint
  // URL; 401 here is what proves the endpoint is genuine.
  if (!valid) return c.text('Invalid request signature', 401);

  const interaction = JSON.parse(raw) as Interaction;

  if (interaction.type === InteractionType.PING) {
    return c.json({ type: InteractionResponseType.PONG });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    // Acknowledge inside Discord's 3-second window, then run the command in the
    // background and edit the placeholder with the result. A cold start plus a
    // handful of D1 round-trips can otherwise miss the deadline, which Discord
    // reports to the user as "didn't respond in time".
    const baseUrl = new URL(c.req.url).origin;
    c.executionCtx.waitUntil(
      (async () => {
        let content: string;
        try {
          const result = await handleCommand(c.env, interaction, baseUrl);
          content = result.data.content;
        } catch (err) {
          console.error('Slash command failed', err);
          content = `Something broke: ${(err as Error).message}`;
        }
        await editOriginalResponse(interaction.application_id, interaction.token, content);
      })(),
    );

    return c.json(defer(true));
  }

  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    // Event sign-up buttons. Acknowledge with a deferred update (no visible
    // spinner), then apply the change and refresh the message in the background.
    if (isEventComponent(interaction)) {
      c.executionCtx.waitUntil(
        handleEventComponent(c.env, interaction).catch((err) =>
          console.error('Event component handler failed', err),
        ),
      );
      return c.json(deferUpdate());
    }
    if (isTournamentComponent(interaction)) {
      c.executionCtx.waitUntil(
        handleTournamentComponent(c.env, interaction).catch((err) =>
          console.error('Tournament component handler failed', err),
        ),
      );
      return c.json(deferUpdate());
    }
    return c.json(ephemeral('This control is no longer active.'));
  }

  return c.json(ephemeral('Unsupported interaction type.'));
});

/* ------------------------------------------------------------------ *
 * Session
 * ------------------------------------------------------------------ */

// API responses must never be cached by the browser or an intermediary.
// A cached /api/auth/login redirect (or a stale 404 from an earlier deploy)
// otherwise means the sign-in click is answered from cache and never reaches
// the Worker at all — which looks exactly like a broken login.
app.use('/api/*', async (c, next) => {
  await next();
  // Re-wrap so the header sticks regardless of who built the response: a
  // mounted sub-router (e.g. /api/ranks) hands back a response with immutable
  // headers, so a direct .set() there silently no-ops. A fresh Response copies
  // the status, body, and existing headers into a mutable set.
  c.res = new Response(c.res.body, c.res);
  c.res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
});

app.use('/api/*', withViewer);

// Pending applicants are read-only. In demo/preview mode they're granted read
// permissions to tour the product, but this hard method guard still blocks every
// write — the belt behind the permission grant, so "preview" can never mutate
// anything. The only exceptions are genuine self-service writes: their own
// profile, their own avatar, and signing out. Approved members are unaffected.
app.use('/api/*', async (c, next) => {
  const viewer = c.get('viewer');
  const method = c.req.method.toUpperCase();
  if (viewer?.pending && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const path = new URL(c.req.url).pathname;
    const selfService =
      path === '/api/auth/logout' ||
      path === '/api/media/avatars' ||
      /^\/api\/members\/\d+\/profile$/.test(path);
    if (!selfService) {
      return c.json({ error: 'This is a read-only preview — sign-in is pending approval.' }, 403);
    }
  }
  await next();
});

app.get('/api/auth/login', async (c) => {
  const { discord } = await loadConfig(c.env);
  const state = newState();
  const redirectUri = new URL('/api/auth/callback', c.req.url).toString();
  c.header('Set-Cookie', stateCookie(state));
  return c.redirect(authorizeUrl(discord.clientId, redirectUri, state));
});

app.get('/api/auth/callback', async (c) => {
  // Discord signals its own failures (consent_required, access_denied, an
  // unregistered redirect_uri, …) with an `error` query param and no code.
  // Surface it verbatim instead of mislabelling everything as a state error.
  const discordError = c.req.query('error');
  if (discordError) {
    console.error('Discord OAuth error:', discordError, c.req.query('error_description'));
    return c.redirect(`/login?error=discord&detail=${encodeURIComponent(discordError)}`);
  }

  const code = c.req.query('code');
  const state = c.req.query('state');
  const expected = getCookie(c, OAUTH_STATE_COOKIE);

  if (!code || !state || !expected || state !== expected) {
    return c.redirect('/login?error=state');
  }

  const { discord } = await loadConfig(c.env);
  const redirectUri = new URL('/api/auth/callback', c.req.url).toString();
  const token = await exchangeCode(discord.clientId, discord.clientSecret, code, redirectUri);

  const discordUser = await fetchUser(token.access_token);
  const database = db(c.env);

  // The ban list is the first gate: a banned Discord id can never sign in — even
  // with no member record, even if they're in the guild. Deleting the ban row
  // lifts it. This is checked before anything is created or read about them.
  const ban = await database.query.bans.findFirst({ where: eq(s.bans.discordId, discordUser.id) });
  if (ban) {
    c.header('Set-Cookie', clearedStateCookie);
    return c.redirect('/login?error=banned');
  }

  // Guild membership decides member vs. applicant. Not in the guild no longer
  // means "no account" — they sign in as a *pending applicant* (apply-to-join)
  // and can fill out their profile while awaiting approval.
  const guildMember = await fetchGuildMember(token.access_token, discord.guildId);
  const inGuild = !!guildMember;

  // Discord's guild-join date is the authoritative basis for tenure medals.
  const guildJoinedAt = guildMember?.joined_at
    ? Math.floor(Date.parse(guildMember.joined_at) / 1000)
    : null;
  const validGuildJoinedAt =
    guildJoinedAt != null && !Number.isNaN(guildJoinedAt) ? guildJoinedAt : null;

  const existing = await database.query.users.findFirst({
    where: eq(s.users.discordId, discordUser.id),
  });

  // Belt-and-suspenders with the ban list: a record still flagged banned is out.
  if (existing?.status === 'banned') {
    c.header('Set-Cookie', clearedStateCookie);
    return c.redirect('/login?error=banned');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let userId: number;
  let pendingNow = false; // still an unapproved applicant after this login

  if (existing) {
    // A pending applicant who has since joined the guild is auto-approved into a
    // full member on this login (assign the default rank + roles below).
    const autoApprove = existing.status === 'pending' && inGuild;
    pendingNow = existing.status === 'pending' && !inGuild;

    const defaultRank = autoApprove
      ? await database.query.ranks.findFirst({ where: eq(s.ranks.isDefault, true) })
      : null;

    await database
      .update(s.users)
      .set({
        username: discordUser.username,
        globalName: discordUser.global_name,
        avatar: discordUser.avatar,
        email: discordUser.email ?? existing.email,
        // Only set once — the guild-join date doesn't change, and a re-join
        // shouldn't reset accrued tenure.
        guildJoinedAt: existing.guildJoinedAt ?? validGuildJoinedAt,
        ...(autoApprove ? { status: 'active' as const, rankId: existing.rankId ?? defaultRank?.id ?? null } : {}),
        lastSeenAt: nowSec,
        updatedAt: nowSec,
      })
      .where(eq(s.users.id, existing.id));
    userId = existing.id;

    if (autoApprove) {
      await database.insert(s.auditLog).values({
        action: 'member.approve',
        targetType: 'user',
        targetId: String(userId),
        meta: { via: 'guild-join' },
        source: 'system',
      });
      if (defaultRank) {
        const client = await discordClient(c.env, database);
        c.executionCtx.waitUntil(
          syncMemberRankRoles(database, client, { userId, rankId: defaultRank.id, actorId: null }),
        );
      }
    }
  } else {
    // First sign-in. In the guild → a full member with the default rank + roles.
    // Not in the guild → a pending applicant (no rank, no roles) until they join
    // the guild or an officer approves them.
    pendingNow = !inGuild;
    const defaultRank = inGuild
      ? await database.query.ranks.findFirst({ where: eq(s.ranks.isDefault, true) })
      : null;
    const inserted = await database
      .insert(s.users)
      .values({
        discordId: discordUser.id,
        username: discordUser.username,
        globalName: discordUser.global_name,
        avatar: discordUser.avatar,
        email: discordUser.email ?? null,
        rankId: defaultRank?.id ?? null,
        status: inGuild ? 'active' : 'pending',
        guildJoinedAt: validGuildJoinedAt,
        lastSeenAt: nowSec,
      })
      .returning({ id: s.users.id });
    const created = inserted[0];
    if (!created) throw new Error('Failed to create member record');
    userId = created.id;

    await database.insert(s.auditLog).values({
      action: inGuild ? 'member.join' : 'member.apply',
      targetType: 'user',
      targetId: String(userId),
      meta: { discordId: discordUser.id, username: discordUser.username },
      source: 'system',
    });

    // A brand-new applicant (not in the guild) is waiting on approval — notify
    // whichever roles the admin routed this event to. Best-effort, in background.
    if (!inGuild) {
      c.executionCtx.waitUntil(
        emitNotification(c.env, 'applicant.pending', {
          title: `New applicant: ${discordUser.global_name || discordUser.username}`,
          body: 'Someone signed in and is waiting on approval.',
          link: '/admin/admissions',
        }),
      );
    }

    // Apply the default rank's roles to a new member. Done in the background so
    // the Discord round-trips don't hold up the login redirect. (Applicants get
    // no rank/roles until approved.)
    if (inGuild && defaultRank) {
      const client = await discordClient(c.env, database);
      c.executionCtx.waitUntil(
        syncMemberRankRoles(database, client, {
          userId,
          rankId: defaultRank.id,
          actorId: null,
        }),
      );
    }
  }

  const { token: sessionToken, expiresAt } = await createSession(database, userId, {
    userAgent: c.req.header('user-agent'),
    ip: c.req.header('cf-connecting-ip'),
  });

  c.executionCtx.waitUntil(purgeExpiredSessions(database));

  // Hand out any tenure medals this member has earned, so they show up the
  // moment they log in rather than on the next cron sweep. DB-only, so it's
  // safe to fire and forget.
  c.executionCtx.waitUntil(
    awardTenureMedals(database, { userId }).catch((err) =>
      console.error('Tenure award on login failed', err),
    ),
  );

  c.header('Set-Cookie', clearedStateCookie);
  c.header('Set-Cookie', sessionCookie(sessionToken, expiresAt - Math.floor(Date.now() / 1000)), {
    append: true,
  });
  // Applicants land on their own profile page (which shows the "in review" state
  // and lets them fill out their profile); members go to the home page.
  return c.redirect(pendingNow ? `/members/${userId}` : '/');
});

app.post('/api/auth/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await invalidateSession(db(c.env), token);
  c.header('Set-Cookie', clearedSessionCookie);
  return c.json({ ok: true });
});

/** What the React app calls on boot to learn who it is talking to. */
app.get('/api/me', async (c) => {
  const { siteName } = await loadConfig(c.env);
  const viewer = c.get('viewer');
  // A member loading the app is one "web" activity dot for the heatmap. Members
  // only (never pending applicants), best-effort so it never blocks the boot.
  if (viewer && !viewer.pending) {
    c.executionCtx.waitUntil(recordActivity(db(c.env), viewer.id, 'web').catch(() => {}));
  }
  return c.json({ viewer, siteName, authKind: c.get('authKind') });
});

/**
 * API contract version, for the mobile/native client to check compatibility.
 * Public and unauthenticated. `apiVersion` is the integer contract version;
 * bump it only on a breaking change to the documented JSON shapes.
 */
app.get('/api/version', async (c) => {
  const { siteName } = await loadConfig(c.env);
  return c.json({ apiVersion: 1, service: 'mustr', siteName });
});

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

app.route('/api/ranks', ranks);
app.route('/api/members', members);
app.route('/api/bans', bansRoutes);
app.route('/api/training', training);
app.route('/api/settings', settings);
app.route('/api/roles', rolesRoutes);
app.route('/api/medals', medalsRoutes);
app.route('/api/media', mediaRoutes);
app.route('/api/news', newsRoutes);
app.route('/api/usage', usageRoutes);
app.route('/api/games', gamesRoutes);
app.route('/api/warrecords', warRecordsRoutes);
app.route('/api/events', eventsRoutes);
app.route('/api/audit', auditRoutes);
app.route('/api/pages', pagesRoutes);
app.route('/api/nav', navRoutes);
app.route('/api/admin-nav', adminNavRoutes);
app.route('/api/notifications', notificationsRoutes);
app.route('/api/hangar', hangarRoutes);
app.route('/api/gallery', galleryRoutes);
app.route('/api/sc', scVerifyRoutes);
app.route('/api/orgchart', orgChartRoutes);
app.route('/api/auth/tokens', tokensRoutes);
app.route('/api/alliance', allianceRoutes);
app.route('/api/setup', setupRoutes);
app.route('/api/snapshots', snapshotsRoutes);
app.route('/api/attendance', attendanceRoutes);
app.route('/api/tournaments', tournamentsRoutes);
app.route('/api/wow', wowRoutes);

app.get('/api/health', (c) => c.json({ ok: true, service: 'mustr' }));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message || 'Internal error' }, 500);
});

/* ------------------------------------------------------------------ *
 * Fallthrough
 *
 * Requests reach the Worker before the asset handler, so Hono's default
 * 404 would answer client-side routes like /admin/ranks and the SPA would
 * never load on refresh or deep link. Unmatched non-API paths are handed
 * to ASSETS, which wrangler.jsonc configures with
 * not_found_handling: "single-page-application".
 * ------------------------------------------------------------------ */

// Keep unmatched API routes answering JSON rather than serving index.html.
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

// Uploaded images (medal art, …) live in R2 and are served here — deliberately
// outside /api so the no-store middleware doesn't apply and they cache hard.
// wrangler.jsonc puts /media/* in run_worker_first so these reach the Worker.
app.get('/media/*', async (c) => {
  const res = await serveMediaObject(c.env, c.req.raw, c.executionCtx);
  return res ?? c.json({ error: 'Not found' }, 404);
});

// Everything else is a static asset or an SPA navigation, served by ASSETS.
// For HTML (the SPA shell) we rewrite <head> from the site's SEO settings so the
// title and Open Graph tags are correct for the browser tab AND for crawlers /
// social scrapers (Discord, Google) that never run the React app. Non-HTML
// assets pass straight through untouched.
// Public, server-rendered version of the 'legal' custom page. The rest of the
// SPA is auth-gated, so this gives the footer's Legal link (and rights holders
// like RSI) a URL they can read WITHOUT an account — and crawlers can index it.
// Reads the same page_layouts row members see; renders heading + text modules.
app.get('/legal', async (c) => {
  const esc = escapeHtml;

  let title = 'Legal';
  let body = '';
  try {
    const row = await db(c.env).query.pageLayouts.findFirst({
      where: eq(s.pageLayouts.slug, 'legal'),
    });
    if (!row) return c.notFound();
    title = row.title || 'Legal';
    body = await renderLayoutBody(row.layout);
  } catch {
    return c.notFound();
  }

  const { siteName } = await loadConfig(c.env);
  const site = siteName || 'mustr';
  const page =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)} — ${esc(site)}</title><meta name="robots" content="index,follow"><style>` +
    `:root{color-scheme:light dark}` +
    `body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0b0d12;color:#e7ebf3}` +
    `.wrap{max-width:760px;margin:0 auto;padding:3rem 1.25rem 4rem}` +
    `a{color:#5b8cff}h1{font-size:1.9rem;margin:0 0 1rem}h2{font-size:1.25rem;margin:2rem 0 .5rem}` +
    `p,li{color:#c2cadb}hr{border:none;border-top:1px solid #232a39;margin:2rem 0}` +
    `.home{display:inline-block;margin-top:1rem;font-size:.9rem}` +
    `@media(prefers-color-scheme:light){body{background:#fff;color:#1a1f2b}p,li{color:#3a4353}hr{border-top-color:#e3e7ee}}` +
    `</style></head><body><div class="wrap">${body}<hr><a class="home" href="/">← ${esc(site)}</a></div></body></html>`;

  return c.html(page, 200, { 'Cache-Control': 'public, max-age=300' });
});

/**
 * mustr.gg marketing: the public "honest hosting & costs" About page, with a live
 * free-tier estimator. First-party self-contained HTML (its own inline script), so
 * it's a real page rather than a sanitized layout module. This is mustr.gg-only
 * marketing — like /product, it isn't part of a buyer's deployment.
 */
app.get('/about', async (c, next) => {
  const host = new URL(c.req.url).hostname;
  // Host-gated exactly like /product: the copy pitches *mustr's* hosting, so a
  // buyer's install must never serve it to their members. app.mustr.gg (any
  // *.mustr.gg non-marketing host) bounces to the marketing apex, whose /about
  // carries the full site nav; every other host falls through to the app as if
  // the route didn't exist.
  if (!isMarketingHost(host)) {
    if (host.toLowerCase().endsWith('.mustr.gg')) return c.redirect('https://mustr.gg/about', 302);
    return next();
  }
  const accent = await loadThemeAccent(c.env);
  return c.html(aboutPageHtml(accent), 200, { 'Cache-Control': 'public, max-age=300' });
});

/**
 * mustr.gg marketing: the product / go-to-sale landing (a pitch to prospective
 * *buyers*). Deliberately host-gated to mustr.gg — a buyer's own deployment must
 * never show a "buy mustr" page to its members, so on any other host this falls
 * through to the app (app.all below) as if the route didn't exist.
 */
function isMarketingHost(host: string): boolean {
  const h = host.split(':')[0]!.toLowerCase();
  return h === 'mustr.gg' || h === 'www.mustr.gg' || h === 'localhost' || h.endsWith('.localhost') || h.startsWith('127.');
}
app.get('/product', async (c, next) => {
  const host = new URL(c.req.url).hostname;
  if (!isMarketingHost(host)) {
    // The app at app.mustr.gg (any *.mustr.gg host) bounces /product to the
    // marketing apex so a stray link resolves. A buyer's own host falls through
    // to the app instead, so its members never see the "buy mustr" page.
    if (host.toLowerCase().endsWith('.mustr.gg')) return c.redirect('https://mustr.gg/product', 302);
    return next();
  }
  const accent = await loadThemeAccent(c.env);
  return c.html(productPageHtml(accent), 200, { 'Cache-Control': 'public, max-age=300' });
});

/**
 * mustr.gg marketing: the ELI5 buyer setup walkthrough. Host-gated to mustr.gg
 * like /product — a buyer's own deployment must never show a "how to install
 * mustr" page to its members. (The in-app setup *wizard* is a different thing
 * that only ever runs on an unclaimed buyer install, never on mustr.gg.)
 */
app.get('/setup', async (c, next) => {
  const host = new URL(c.req.url).hostname;
  if (!isMarketingHost(host)) {
    if (host.toLowerCase().endsWith('.mustr.gg')) return c.redirect('https://mustr.gg/setup', 302);
    return next();
  }
  const accent = await loadThemeAccent(c.env);
  return c.html(setupGuideHtml(accent), 200, { 'Cache-Control': 'public, max-age=300' });
});

/**
 * The "what the bot can & can't do" trust page. Unlike /product and /setup this
 * is NOT host-gated — it's accurate on every install and is meant to be linked
 * as the Discord app's Privacy Policy URL, so a buyer's own members can read it.
 */
app.get('/bot', async (c) => {
  const host = new URL(c.req.url).hostname;
  if (!isMarketingHost(host) && host.toLowerCase().endsWith('.mustr.gg')) return c.redirect('https://mustr.gg/bot', 302);
  const accent = await loadThemeAccent(c.env);
  return c.html(botTrustHtml(accent), 200, { 'Cache-Control': 'public, max-age=300' });
});

app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) return res;

  let head;
  try {
    head = renderHead(await loadSeo(c.env));
  } catch {
    return res; // never let a settings hiccup take the whole site down
  }

  const rewritten = new HTMLRewriter()
    .on('title', {
      element(el) {
        el.setInnerContent(head.title, { html: false });
      },
    })
    .on('meta[name="theme-color"]', {
      element(el) {
        if (head.themeColor) el.setAttribute('content', head.themeColor);
      },
    })
    .on('meta[name="apple-mobile-web-app-title"]', {
      element(el) {
        el.setAttribute('content', head.title);
      },
    })
    // Swap the default /icon.svg for the operator's uploaded favicon. We rewrite
    // the existing tags (rather than appending) so no competing icon lingers;
    // drop the stale `type` so the browser sniffs the uploaded format.
    .on('link[rel="icon"]', {
      element(el) {
        if (head.favicon) {
          el.setAttribute('href', head.favicon);
          el.removeAttribute('type');
        }
      },
    })
    .on('link[rel="apple-touch-icon"]', {
      element(el) {
        if (head.favicon) el.setAttribute('href', head.favicon);
      },
    })
    .on('head', {
      element(el) {
        el.append(head.tags, { html: true });
      },
    })
    .transform(res);

  // Never edge-cache the shell: it's tiny, references hashed (cached) assets, and
  // caching it would serve a stale injected <head> (old title/OG). no-store keeps
  // the injected tags always fresh; a settings change shows on the next load.
  const out = new Response(rewritten.body, rewritten);
  out.headers.set('Cache-Control', 'no-store, must-revalidate');
  return out;
});

/* ------------------------------------------------------------------ *
 * Scheduled work — two cadences, set in wrangler.jsonc (triggers.crons):
 *
 *  - every 5 min  → a bounded batch of the Discord reconcile sweep, so its
 *                   cost stays flat as the roster grows (see reconcileBatch).
 *  - hourly       → the tenure-medal sweep. Tenure only changes on a daily
 *                   boundary, so a per-hour scan is plenty; new members still
 *                   get their tenure medals instantly at login.
 * ------------------------------------------------------------------ */

const TENURE_CRON = '7 * * * *';

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const database = db(env);

    if (controller.cron === TENURE_CRON) {
      // DB-only — runs regardless of whether the bot is configured.
      ctx.waitUntil(
        awardTenureMedals(database)
          .then((r) => console.log('Hourly tenure award:', r.awarded.length, 'granted'))
          .catch((err) => console.error('Tenure award failed', err)),
      );
      // Activity medals — same cheap DB-only sweep, based on events attended.
      ctx.waitUntil(
        awardActivityMedals(database)
          .then((r) => console.log('Hourly activity award:', r.awarded.length, 'granted'))
          .catch((err) => console.error('Activity award failed', err)),
      );
      // Roll ended recurring events forward to their next occurrence. Safe with
      // or without the bot (the Discord sync no-ops when it's absent).
      ctx.waitUntil(
        materializeRecurringEvents(env)
          .then((r) => r.spawned && console.log('Recurring events spawned:', r.spawned))
          .catch((err) => console.error('Recurrence sweep failed', err)),
      );
      return;
    }

    // The 5-minute reconcile tick needs the bot.
    const rest = await discordClient(env, database);
    if (!rest) return;
    ctx.waitUntil(
      reconcileBatch(database, rest)
        .then((r) => console.log('Reconcile batch:', JSON.stringify(r)))
        .catch((err) => console.error('Reconcile batch failed', err)),
    );
    // Backstop keepalive for the Discord Gateway listener (no-ops unless the
    // chat-activity feature is on). Its own alarm is the steady-state heartbeat;
    // this restarts it if the DO ever fully died. Best-effort.
    ctx.waitUntil(
      env.DISCORD_GATEWAY.getByName('main')
        .start()
        .catch((err) => console.error('Gateway keepalive failed', err)),
    );
  },
} satisfies ExportedHandler<Env>;

export { DiscordGateway } from './discord/gateway';
