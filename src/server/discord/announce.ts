/**
 * Discord announcements.
 *
 * When something worth celebrating happens on the site — a medal or war record
 * awarded, a promotion — the bot posts an embed to a configured channel and
 * pings the member. Everything here is best-effort and fire-and-forget: an
 * announcement failure (misconfigured channel, missing permission, rate limit)
 * must never affect the action that triggered it, so callers invoke this inside
 * ctx.waitUntil and it swallows its own errors.
 *
 * Which events fire, and where, is set in the admin panel (settings key
 * 'announcements'); nothing posts until a channel is chosen and the event is
 * enabled.
 */

import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { Env } from '../env';
import { type Embed } from './rest';
import { discordClient } from '../config';

export type AnnouncementEventKey = 'medalAward' | 'warRecordAward' | 'promotion' | 'wowLevel' | 'wowFirst';

export const ANNOUNCEMENT_EVENT_KEYS: AnnouncementEventKey[] = ['medalAward', 'warRecordAward', 'promotion', 'wowLevel', 'wowFirst'];

/** Per-event customization. Any field left blank falls back to the built-in. */
export interface AnnouncementTemplate {
  /** Overrides the embed title (the bold headline). */
  title?: string;
  /** Overrides the body text; supports {placeholders} (see PLACEHOLDERS below). */
  text?: string;
  /** A banner image for this event, overriding the shared one. /media or http(s). */
  imageUrl?: string;
}

export interface AnnouncementConfig {
  channelId: string | null;
  events: Record<AnnouncementEventKey, boolean>;
  /** Embed accent colour ('#rrggbb'); null → each event's built-in colour. */
  accentColor: string | null;
  /** Footer line shown under every announcement (e.g. your org name); null → none. */
  footer: string | null;
  /** A shared banner image shown on every announcement; per-event overrides win. */
  imageUrl: string | null;
  /** Per-event title/text/image overrides. */
  templates: Partial<Record<AnnouncementEventKey, AnnouncementTemplate>>;
}

/** The placeholder tokens each event's custom text may use. */
export const PLACEHOLDERS: Record<AnnouncementEventKey, string[]> = {
  medalAward: ['{member}', '{medal}', '{citation}'],
  warRecordAward: ['{member}', '{record}', '{game}', '{citation}'],
  promotion: ['{member}', '{rank}', '{by}'],
  wowLevel: ['{member}', '{character}', '{level}', '{class}'],
  wowFirst: ['{member}', '{character}', '{level}'],
};

export const DEFAULT_ANNOUNCEMENTS: AnnouncementConfig = {
  channelId: null,
  events: { medalAward: false, warRecordAward: false, promotion: false, wowLevel: false, wowFirst: false },
  accentColor: null,
  footer: null,
  imageUrl: null,
  templates: {},
};

type DB = ReturnType<typeof drizzle<typeof s>>;

/** Accept a same-origin ('/media/…') or absolute http(s) URL; anything else → ''. */
function cleanImageUrl(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t) return '';
  if (t.startsWith('/') && !t.startsWith('//')) return t.slice(0, 500);
  if (/^https?:\/\//i.test(t)) return t.slice(0, 500);
  return '';
}

/**
 * Coerce arbitrary JSON into a valid AnnouncementConfig. Unknown keys are
 * dropped, strings are length-capped, and only a well-formed hex colour / URL is
 * kept — so a stored blob can never inject markup or an off-site colour value.
 */
export function cleanAnnouncementConfig(raw: unknown): AnnouncementConfig {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const events = { ...DEFAULT_ANNOUNCEMENTS.events };
  const rawEvents = (o.events ?? {}) as Record<string, unknown>;
  for (const k of ANNOUNCEMENT_EVENT_KEYS) events[k] = Boolean(rawEvents[k]);

  const templates: AnnouncementConfig['templates'] = {};
  const rawTemplates = (o.templates ?? {}) as Record<string, unknown>;
  for (const k of ANNOUNCEMENT_EVENT_KEYS) {
    const t = (rawTemplates[k] ?? {}) as Record<string, unknown>;
    const title = typeof t.title === 'string' ? t.title.trim().slice(0, 200) : '';
    const text = typeof t.text === 'string' ? t.text.trim().slice(0, 600) : '';
    const imageUrl = cleanImageUrl(t.imageUrl);
    if (title || text || imageUrl) {
      templates[k] = { ...(title && { title }), ...(text && { text }), ...(imageUrl && { imageUrl }) };
    }
  }

  const accent = typeof o.accentColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.accentColor.trim())
    ? o.accentColor.trim().toLowerCase()
    : null;
  const footer = typeof o.footer === 'string' && o.footer.trim() ? o.footer.trim().slice(0, 150) : null;
  const imageUrl = cleanImageUrl(o.imageUrl) || null;
  const channelId = typeof o.channelId === 'string' && /^\d+$/.test(o.channelId) ? o.channelId : null;

  return { channelId, events, accentColor: accent, footer, imageUrl, templates };
}

export async function loadAnnouncementConfig(db: DB): Promise<AnnouncementConfig> {
  const row = await db.query.settings.findFirst({ where: eq(s.settings.key, 'announcements') });
  return cleanAnnouncementConfig(row?.value);
}

interface MemberRef {
  memberName: string;
  memberDiscordId: string;
  memberAvatarUrl: string;
}

export type AnnounceEvent =
  | (MemberRef & { type: 'medalAward'; medalName: string; medalImageUrl: string | null; citation: string | null })
  | (MemberRef & {
      type: 'warRecordAward';
      recordName: string;
      recordImageUrl: string | null;
      gameName: string | null;
      citation: string | null;
    })
  | (MemberRef & { type: 'promotion'; rankName: string; rankImageUrl: string | null; byName: string | null })
  // World of Warcraft module: a character reached a tenth level (or 60), or was
  // the guild's first to reach one.
  | (MemberRef & { type: 'wowLevel'; characterName: string; className: string; level: number })
  | (MemberRef & { type: 'wowFirst'; characterName: string; level: number; shared: boolean });

const COLORS = { medalAward: 0xc0392b, warRecordAward: 0xd4af37, promotion: 0x2f9e5f, wowLevel: 0x4a90d9, wowFirst: 0xe6a23c };

/** Absolute-ise a stored /media/ URL so Discord can fetch it; pass through http(s) URLs. */
function absolute(url: string | null | undefined, baseUrl?: string): string | undefined {
  if (!url) return undefined;
  if (/^https?:\/\//i.test(url)) return url;
  return baseUrl ? `${baseUrl}${url}` : undefined;
}

/** Fill {placeholders} in a custom template with the event's values. */
function fillTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? vars[key]! : m));
}

/** The default (built-in) title, body and item art for each event type. */
function defaults(event: AnnounceEvent): { title: string; description: string; art: string | null; vars: Record<string, string> } {
  switch (event.type) {
    case 'medalAward':
      return {
        title: '🎖️ Medal awarded',
        description: `**${event.memberName}** was awarded the **${event.medalName}** medal.${event.citation ? `\n*“${event.citation}”*` : ''}`,
        art: event.medalImageUrl,
        vars: { member: event.memberName, medal: event.medalName, citation: event.citation ?? '' },
      };
    case 'warRecordAward':
      return {
        title: '🏆 War record awarded',
        description: `**${event.memberName}** earned the **${event.recordName}** war record${event.gameName ? ` (${event.gameName})` : ''}.${event.citation ? `\n*“${event.citation}”*` : ''}`,
        art: event.recordImageUrl,
        vars: { member: event.memberName, record: event.recordName, game: event.gameName ?? '', citation: event.citation ?? '' },
      };
    case 'promotion':
      return {
        title: '⬆️ Promotion',
        description: `**${event.memberName}** was promoted to **${event.rankName}**.${event.byName ? `\n_by ${event.byName}_` : ''}`,
        art: event.rankImageUrl,
        vars: { member: event.memberName, rank: event.rankName, by: event.byName ?? '' },
      };
    case 'wowLevel':
      return {
        title: '✨ Level milestone',
        description: `**${event.characterName}** (${event.className}) reached level **${event.level}**.`,
        art: null,
        vars: { member: event.memberName, character: event.characterName, level: String(event.level), class: event.className },
      };
    case 'wowFirst':
      return {
        title: '🥇 Guild first',
        description: event.shared
          ? `**${event.characterName}** shares first place to level **${event.level}**.`
          : `**${event.characterName}** is the first in the guild to reach level **${event.level}**.`,
        art: null,
        vars: { member: event.memberName, character: event.characterName, level: String(event.level) },
      };
  }
}

/**
 * Build the embed for an event, layering the admin's customization over the
 * built-in defaults: accent colour, footer line, a shared/per-event banner
 * image, and per-event title/body overrides (with {placeholder} substitution).
 * The member's own item art (medal/record/rank image) stays the thumbnail.
 */
function buildEmbed(event: AnnounceEvent, config: AnnouncementConfig, baseUrl?: string): Embed {
  const author = { name: event.memberName, icon_url: event.memberAvatarUrl };
  const base = defaults(event);
  const tpl = config.templates[event.type] ?? {};

  const color = config.accentColor ? parseInt(config.accentColor.slice(1), 16) : COLORS[event.type];
  const title = tpl.title?.trim() ? fillTemplate(tpl.title, base.vars) : base.title;
  const description = tpl.text?.trim() ? fillTemplate(tpl.text, base.vars) : base.description;
  const banner = absolute(tpl.imageUrl ?? config.imageUrl, baseUrl);
  const thumb = absolute(base.art, baseUrl);

  return {
    author,
    color,
    title,
    description,
    ...(thumb ? { thumbnail: { url: thumb } } : {}),
    ...(banner ? { image: { url: banner } } : {}),
    ...(config.footer ? { footer: { text: config.footer } } : {}),
  };
}

/**
 * Post an announcement if the event is enabled and a channel is configured.
 * Safe to call unconditionally inside ctx.waitUntil — it no-ops without a bot,
 * channel, or when the event is switched off, and never throws.
 */
export async function announce(env: Env, event: AnnounceEvent, baseUrl?: string): Promise<void> {
  try {
    const db = drizzle(env.DB, { schema: s });
    const rest = await discordClient(env, db);
    if (!rest) return;
    const config = await loadAnnouncementConfig(db);
    if (!config.channelId || !config.events[event.type]) return;

    await rest.createMessage(config.channelId, {
      content: `<@${event.memberDiscordId}>`,
      embeds: [buildEmbed(event, config, baseUrl)],
      allowed_mentions: { users: [event.memberDiscordId] },
    });
  } catch (err) {
    console.error('Announcement failed', err);
  }
}
