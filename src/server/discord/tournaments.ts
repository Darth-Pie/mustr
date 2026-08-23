/**
 * Tournament announcements — a best-effort Discord embed when a tournament
 * opens for registration and when its champion is crowned. Outbound only (no
 * interactive buttons), posted to the same channel the other announcements use
 * (settings key 'announcements'). Fire-and-forget: call inside ctx.waitUntil;
 * it no-ops without a bot or channel and swallows its own errors so a Discord
 * problem never affects the web action that triggered it.
 */

import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { Env } from '../env';
import { type Embed, type ActionRow } from './rest';
import { discordClient, loadConfig } from '../config';
import { loadAnnouncementConfig } from './announce';
import { FORMAT_LABELS, type TournamentFormat } from '../../shared/tournament';
import { championName } from '../tournaments';

function accentToInt(hex: string | null): number | undefined {
  if (!hex) return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? parseInt(m[1]!, 16) : undefined;
}

export async function announceTournament(
  env: Env,
  opts: { tournamentId: number; kind: 'open' | 'champion'; baseUrl?: string },
): Promise<void> {
  try {
    const db = drizzle(env.DB, { schema: s });
    const rest = await discordClient(env, db);
    if (!rest) return;
    const cfg = await loadAnnouncementConfig(db);
    if (!cfg.channelId) return;

    const t = await db.query.tournaments.findFirst({ where: eq(s.tournaments.id, opts.tournamentId) });
    if (!t) return;

    const url = opts.baseUrl ? `${opts.baseUrl.replace(/\/$/, '')}/tournaments/${t.slug}` : undefined;
    const color = accentToInt(cfg.accentColor);
    const footer = cfg.footer ? { text: cfg.footer } : undefined;

    // The org's sigil (when enabled) as the embed crest. Absolutise the same-origin
    // "/media/…" path against the canonical site URL so Discord can fetch it.
    const full = await loadConfig(env, db);
    const abs = (u: string) => (!u ? '' : /^https?:\/\//i.test(u) ? u : full.siteUrl ? full.siteUrl.replace(/\/$/, '') + u : '');
    // Prefer the animated crest — Discord plays GIFs in embed thumbnails.
    const crest = abs(full.siteSigilGif || full.siteSigilPng);
    const thumbnail = crest ? { url: crest } : undefined;

    let embed: Embed;
    if (opts.kind === 'open') {
      const format = FORMAT_LABELS[t.format as TournamentFormat] ?? 'tournament';
      embed = {
        title: `🏆 ${t.name}`,
        description:
          `Registration is open for a new **${format}** tournament` +
          `${t.competitorType === 'team' ? ' (teams)' : ''}.` +
          (url ? `\n\n[Sign up & view details](${url})` : ''),
        color,
        footer,
        thumbnail,
      };
    } else {
      const champ = await championName(db, t.id);
      if (!champ) return; // nothing to celebrate yet
      embed = {
        title: `🏆 ${t.name} — Champion`,
        description: `Congratulations to **${champ}**!` + (url ? `\n\n[View the final results](${url})` : ''),
        color,
        footer,
        thumbnail,
      };
    }

    // Individual tournaments that are open for sign-ups get Register / Withdraw
    // buttons (handled in discord/tournamentInteractions.ts). Team tournaments
    // and the champion post are link-only — the embed already points to the site.
    const components: ActionRow[] = [];
    if (opts.kind === 'open' && t.competitorType === 'individual' && t.status === 'registration') {
      components.push({
        type: 1,
        components: [
          { type: 2, style: 3, label: 'Register', emoji: { name: '✅' }, custom_id: `trn:register:${t.id}` },
          { type: 2, style: 4, label: 'Withdraw', custom_id: `trn:withdraw:${t.id}` },
        ],
      });
    }

    await rest.createMessage(cfg.channelId, { embeds: [embed], components });
  } catch (err) {
    console.error('Tournament announcement failed', err);
  }
}
