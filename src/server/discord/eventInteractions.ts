/**
 * Handles clicks on the event sign-up buttons (MESSAGE_COMPONENT interactions).
 *
 * custom_id forms (built in discord/events.ts):
 *   evt:role:<eventId>:<roleId>   → attend as that role
 *   evt:role:<eventId>:none       → attend with no specific role
 *   evt:withdraw:<eventId>        → withdraw
 *   evt:checkin:<eventId>         → check in (record attendance), window-gated
 *
 * Runs after a deferred-update ack (index.ts): it writes the same event_signups
 * rows the website uses, refreshes the source message with new counts, and
 * sends the clicker a private confirmation. Never throws — a failure just means
 * the click had no visible effect, which the member can retry.
 */

import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema';
import * as s from '../../db/schema';
import type { Env } from '../env';
import { loadConfig } from '../config';
import { setSignup, removeSignup, loadEventState } from '../events/signups';
import { buildEventMessage } from './events';
import { loadAttendanceConfig, checkIn } from '../attendance';
import { selfCheckinOpen } from '../../shared/attendance';
import { awardActivityMedals } from '../medals/activity';
import { editOriginalMessage, followUpEphemeral, type Interaction } from './interactions';

/** True if this component interaction is one of our event buttons. */
export function isEventComponent(i: Interaction): boolean {
  return !!i.data?.custom_id?.startsWith('evt:');
}

export async function handleEventComponent(env: Env, i: Interaction): Promise<void> {
  const customId = i.data?.custom_id;
  if (!customId?.startsWith('evt:')) return;

  const [, kind, eventIdStr, arg] = customId.split(':');
  const eventId = Number(eventIdStr);
  if (!Number.isFinite(eventId)) return;

  const db = drizzle(env.DB, { schema });
  const discordId = (i.member?.user ?? i.user)?.id;
  if (!discordId) return;

  const user = await db.query.users.findFirst({ where: eq(s.users.discordId, discordId) });

  let note: string;
  if (!user) {
    note = 'You need a mustr account first — sign in on the website once, then try again.';
  } else if (user.status === 'banned') {
    note = 'Your account is not active.';
  } else if (kind === 'withdraw') {
    await removeSignup(db, eventId, user.id);
    note = 'You’ve withdrawn from this event.';
  } else if (kind === 'role') {
    const roleId = arg === 'none' ? null : Number(arg);
    const res = await setSignup(db, eventId, user.id, roleId);
    note = res.ok ? '✅ You’re signed up.' : `⚠️ ${res.error}`;
  } else if (kind === 'checkin') {
    const cfg = await loadAttendanceConfig(env, db);
    const event = await db.query.events.findFirst({ where: eq(s.events.id, eventId) });
    if (cfg.mode === 'officers') {
      note = '⚠️ Self check-in is off — an officer records attendance for this event.';
    } else if (!event) {
      note = '⚠️ That event no longer exists.';
    } else if (!selfCheckinOpen(event, Math.floor(Date.now() / 1000), cfg.checkinWindowHours)) {
      note = '⚠️ Check-in isn’t open for this event yet (or has closed).';
    } else {
      const res = await checkIn(db, { eventId, userId: user.id, source: 'discord', eventStartsAt: event.startsAt });
      note = res.created ? '✅ Checked in — thanks for coming!' : '✅ You were already checked in.';
      if (res.created) await awardActivityMedals(db, { userId: user.id }).catch(() => {});
    }
  } else {
    note = 'Unknown action.';
  }

  // Refresh the sign-up message with new counts (edits the button's own message).
  try {
    const state = await loadEventState(db, eventId);
    if (state) {
      const { siteUrl, siteSigilPng, siteSigilGif } = await loadConfig(env, db);
      const checkinEnabled = (await loadAttendanceConfig(env, db)).mode !== 'officers';
      await editOriginalMessage(i.application_id, i.token, buildEventMessage(state, siteUrl, checkinEnabled, siteSigilGif || siteSigilPng));
    }
  } catch (err) {
    console.error('Event component message refresh failed', err);
  }

  // Private confirmation to the clicker.
  try {
    await followUpEphemeral(i.application_id, i.token, note);
  } catch (err) {
    console.error('Event component follow-up failed', err);
  }
}
