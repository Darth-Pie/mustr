/**
 * Mirrors a mustr event into Discord: a native guild scheduled event (so
 * members get reminders) AND an announcement message that doubles as the
 * sign-up sheet — an embed with live per-role counts plus a row of buttons
 * (one per role, "Attending", "Withdraw"). Clicking a button is a
 * MESSAGE_COMPONENT interaction handled in discord/eventInteractions.ts, which
 * writes the same event_signups rows the website uses, so the two stay in sync.
 *
 * Everything here is best-effort — a Discord failure is logged and swallowed,
 * never blocking the site action. The announcement channel is the one the
 * medal/promotion announcements use (settings key 'announcements'); the native
 * scheduled event needs the bot's MANAGE_EVENTS permission.
 */

import { drizzle } from 'drizzle-orm/d1';
import * as s from '../../db/schema';
import type { Env } from '../env';
import { type ActionRow, type Embed } from './rest';
import { loadConfig, discordRestFromConfig } from '../config';
import { loadAnnouncementConfig } from './announce';
import { loadEventState, type EventState } from '../events/signups';
import { loadAttendanceConfig } from '../attendance';

type EventRow = typeof s.events.$inferSelect;

const iso = (unixSec: number) => new Date(unixSec * 1000).toISOString();

/** base64-encode raw bytes (chunked so a ~1 MB image doesn't blow the call stack). */
function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Turn a stored relative media URL into an absolute one Discord can fetch. */
function absoluteMedia(siteUrl: string | undefined, url: string | null): string | null {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  if (!siteUrl) return null;
  return `${siteUrl.replace(/\/$/, '')}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * The event banner as a data URI, for the scheduled event's cover image —
 * Discord stores the bytes rather than fetching a URL, so we read the object
 * out of R2 (a binding call, not a subrequest) and base64 it. Best-effort:
 * any problem just means no cover image. Falls back to fetching the public URL
 * if the media binding isn't available.
 */
async function eventCoverDataUri(
  env: Env,
  imageUrl: string | null,
  siteUrl?: string,
): Promise<string | undefined> {
  if (!imageUrl) return undefined;
  try {
    let bytes: ArrayBuffer;
    let contentType = 'image/png';
    if (env.MEDIA && imageUrl.startsWith('/media/')) {
      const key = imageUrl.replace(/^\/media\//, '');
      const obj = await env.MEDIA.get(key);
      if (!obj) return undefined;
      bytes = await obj.arrayBuffer();
      contentType = obj.httpMetadata?.contentType || contentType;
    } else {
      const abs = absoluteMedia(siteUrl, imageUrl);
      if (!abs) return undefined;
      const res = await fetch(abs);
      if (!res.ok) return undefined;
      bytes = await res.arrayBuffer();
      contentType = res.headers.get('content-type') || contentType;
    }
    return `data:${contentType};base64,${bytesToBase64(bytes)}`;
  } catch (err) {
    console.error('Event cover image load failed', err);
    return undefined;
  }
}

const RECURRENCE_LABEL: Record<string, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
};

function eventEmbed(state: EventState, siteUrl?: string, sigilPng?: string): Embed {
  const { event, gameName } = state;
  const lines = [
    event.description || undefined,
    `**When:** <t:${event.startsAt}:F> (<t:${event.startsAt}:R>)`,
    `**Where:** ${event.location}`,
    gameName ? `**Game:** ${gameName}` : undefined,
    event.recurrence && event.recurrence !== 'none'
      ? `**Repeats:** 🔁 ${RECURRENCE_LABEL[event.recurrence] ?? event.recurrence}`
      : undefined,
  ].filter(Boolean) as string[];

  const fields: NonNullable<Embed['fields']> = [];
  for (const r of state.roles) {
    const names = state.signups.filter((su) => su.roleId === r.id).map((su) => su.name);
    fields.push({
      name: `${r.emoji ? r.emoji + ' ' : ''}${r.name} — ${r.count}${r.capacity != null ? `/${r.capacity}` : ''}`.slice(0, 256),
      value: (names.length ? names.join(', ') : '—').slice(0, 1024),
      inline: true,
    });
  }
  const noRole = state.signups.filter((su) => su.roleId === null).map((su) => su.name);
  if (noRole.length) {
    fields.push({ name: `Attending — ${noRole.length}`, value: noRole.join(', ').slice(0, 1024), inline: true });
  }

  const embed: Embed = {
    color: 0x5865f2,
    title: `📅 ${event.title}`,
    description: lines.join('\n'),
    footer: { text: `${state.total} signed up` },
  };
  if (fields.length) embed.fields = fields;
  const img = absoluteMedia(siteUrl, event.imageUrl);
  if (img) embed.image = { url: img };
  const crest = absoluteMedia(siteUrl, sigilPng ?? null);
  if (crest) embed.thumbnail = { url: crest };
  return embed;
}

/**
 * The sign-up buttons: one per role (secondary, showing its count), then a
 * final row with "Attending" (join with no specific role), an optional "I'm
 * here" check-in button, and "Withdraw". Discord caps a message at 5 action rows
 * of 5 buttons; role buttons take up to four rows (20 roles) and the controls
 * take the fifth. `checkinEnabled` adds the check-in button (the click validates
 * the open window server-side, so the button can sit there permanently).
 */
function eventComponents(state: EventState, checkinEnabled: boolean): ActionRow[] {
  const eid = state.event.id;
  const rows: ActionRow[] = [];

  const roleButtons = state.roles.slice(0, 20).map((r) => {
    const count = r.capacity != null ? ` ${r.count}/${r.capacity}` : r.count ? ` (${r.count})` : '';
    const button: ActionRow['components'][number] = {
      type: 2,
      style: 2,
      label: `${r.name}${count}`.slice(0, 80),
      custom_id: `evt:role:${eid}:${r.id}`,
    };
    if (r.emoji) button.emoji = { name: r.emoji };
    return button;
  });
  for (let i = 0; i < roleButtons.length; i += 5) {
    rows.push({ type: 1, components: roleButtons.slice(i, i + 5) });
  }

  const controls: ActionRow['components'] = [
    { type: 2, style: 1, label: 'Attending', custom_id: `evt:role:${eid}:none` },
  ];
  if (checkinEnabled) {
    controls.push({ type: 2, style: 3, label: "I'm here", emoji: { name: '✅' }, custom_id: `evt:checkin:${eid}` });
  }
  controls.push({ type: 2, style: 4, label: 'Withdraw', custom_id: `evt:withdraw:${eid}` });
  rows.push({ type: 1, components: controls });
  return rows;
}

/** The full announcement message payload for an event's current state. */
export function buildEventMessage(
  state: EventState,
  siteUrl?: string,
  checkinEnabled = false,
  sigilPng?: string,
): { embeds: Embed[]; components: ActionRow[] } {
  return { embeds: [eventEmbed(state, siteUrl, sigilPng)], components: eventComponents(state, checkinEnabled) };
}

export interface DiscordEventIds {
  discordEventId: string | null;
  discordMessageId: string | null;
}

/**
 * Create or update the Discord scheduled event and announcement message for an
 * event. Reuses the ids already on the row when present (an edit). Returns the
 * ids to persist. Never throws.
 */
export async function syncEventToDiscord(env: Env, eventId: number): Promise<DiscordEventIds> {
  const db = drizzle(env.DB, { schema: s });
  const state = await loadEventState(db, eventId);
  if (!state) return { discordEventId: null, discordMessageId: null };

  const ids: DiscordEventIds = {
    discordEventId: state.event.discordEventId,
    discordMessageId: state.event.discordMessageId,
  };
  const cfg = await loadConfig(env, db);
  const rest = discordRestFromConfig(cfg);
  if (!rest) return ids;

  const event = state.event;

  const scheduled = {
    name: event.title.slice(0, 100),
    description: event.description?.slice(0, 1000) || undefined,
    scheduled_start_time: iso(event.startsAt),
    scheduled_end_time: iso(event.endsAt),
    privacy_level: 2 as const,
    entity_type: 3 as const,
    entity_metadata: { location: event.location.slice(0, 100) },
    image: await eventCoverDataUri(env, event.imageUrl, cfg.siteUrl),
  };

  try {
    if (ids.discordEventId) {
      await rest.modifyScheduledEvent(ids.discordEventId, scheduled);
    } else {
      ids.discordEventId = await rest.createScheduledEvent(scheduled);
    }
  } catch (err) {
    console.error('Scheduled-event sync failed', err);
  }

  try {
    const channelId = (await loadAnnouncementConfig(db)).channelId;
    if (channelId) {
      const checkinEnabled = (await loadAttendanceConfig(env, db)).mode !== 'officers';
      const message = buildEventMessage(state, cfg.siteUrl, checkinEnabled, cfg.siteSigilGif || cfg.siteSigilPng);
      if (ids.discordMessageId) {
        await rest.editMessage(channelId, ids.discordMessageId, message);
      } else {
        ids.discordMessageId = await rest.createMessage(channelId, message);
      }
    }
  } catch (err) {
    console.error('Event announcement failed', err);
  }

  return ids;
}

/**
 * Re-render just the announcement message (embed counts + button labels) after
 * a sign-up changes on the website. No scheduled-event touch. Never throws.
 */
export async function refreshEventMessage(env: Env, eventId: number): Promise<void> {
  const db = drizzle(env.DB, { schema: s });
  const cfg = await loadConfig(env, db);
  const rest = discordRestFromConfig(cfg);
  if (!rest) return;
  const state = await loadEventState(db, eventId);
  if (!state || !state.event.discordMessageId) return;

  try {
    const channelId = (await loadAnnouncementConfig(db)).channelId;
    if (channelId) {
      const checkinEnabled = (await loadAttendanceConfig(env, db)).mode !== 'officers';
      await rest.editMessage(channelId, state.event.discordMessageId, buildEventMessage(state, cfg.siteUrl, checkinEnabled, cfg.siteSigilGif || cfg.siteSigilPng));
    }
  } catch (err) {
    console.error('Event message refresh failed', err);
  }
}

/** Remove an event's Discord scheduled event and announcement message. Never throws. */
export async function removeEventFromDiscord(env: Env, event: EventRow): Promise<void> {
  const rest = discordRestFromConfig(await loadConfig(env));
  if (!rest) return;

  if (event.discordEventId) {
    try {
      await rest.deleteScheduledEvent(event.discordEventId);
    } catch (err) {
      console.error('Scheduled-event delete failed', err);
    }
  }
  if (event.discordMessageId) {
    try {
      const db = drizzle(env.DB, { schema: s });
      const channelId = (await loadAnnouncementConfig(db)).channelId;
      if (channelId) await rest.deleteMessage(channelId, event.discordMessageId);
    } catch (err) {
      console.error('Event message delete failed', err);
    }
  }
}
