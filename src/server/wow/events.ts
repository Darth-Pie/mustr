/**
 * After a sweep: award medals for new badges and post milestones to Discord.
 *
 * Runs in the sweep's own invocation, so Discord posts share its 50-request
 * budget with the Blizzard calls — hence WOW_POST_BUDGET. Per character: at most
 * one milestone post (the first enabled of milestonePosts' preference order),
 * then its medal posts. A character's first check posts nothing, medals
 * included: those badges were earned before mustr was watching. Medals from
 * gear read for the first time (it couldn't be read at the first check) are
 * awarded the same quiet way. Everything here is best-effort; a failure never
 * undoes the timeline rows already saved.
 */

import { drizzle } from 'drizzle-orm/d1';
import { inArray } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { Env } from '../env';
import { loadConfig } from '../config';
import { loadWowConfig } from '../modules';
import { announce, loadAnnouncementConfig } from '../discord/announce';
import { awardWowMedals } from '../medals/wow';
import { memberName } from '../../shared/names';
import { discordAvatar } from '../../shared/avatar';
import { milestonePosts } from './milestones';
import { computeRace } from './records';
import { loadRaceCharacters } from './race';
import type { WowEvent } from './poll';

export const WOW_POST_BUDGET = 8;

export async function handleWowEvents(env: Env, events: WowEvent[], now: number): Promise<{ posted: number; medals: number }> {
  const result = { posted: 0, medals: 0 };
  if (!events.length) return result;

  const database = drizzle(env.DB, { schema: s });
  const wow = await loadWowConfig(env, database);
  const [config, race, app, users] = await Promise.all([
    loadAnnouncementConfig(database),
    loadRaceCharacters(database, wow),
    loadConfig(env, database),
    database
      .select({
        id: s.users.id,
        discordId: s.users.discordId,
        avatar: s.users.avatar,
        username: s.users.username,
        globalName: s.users.globalName,
        displayName: s.users.displayName,
      })
      .from(s.users)
      .where(inArray(s.users.id, [...new Set(events.map((e) => e.userId))])),
  ]);
  // Guild firsts are judged on mains, matching the Leveling page's default view.
  const firsts = computeRace(race, false).firsts;
  const byId = new Map(users.map((u) => [u.id, u]));
  const baseUrl = app.siteUrl || undefined;
  const canPost = (key: 'wowLevel' | 'wowFirst' | 'medalAward') =>
    !!config.channelId && config.events[key] && result.posted < WOW_POST_BUDGET;

  for (const ev of events) {
    const u = byId.get(ev.userId);
    if (!u) continue;
    const ref = {
      memberName: memberName(u),
      memberDiscordId: u.discordId,
      memberAvatarUrl: discordAvatar(u.discordId, u.avatar, 128),
    };

    let awards: Awaited<ReturnType<typeof awardWowMedals>> = [];
    try {
      // Badges from gear first read this check predate tracking, like a first check's.
      awards = await awardWowMedals(database, ev.userId, ev.characterName, ev.badges, ev.firstCheck || ev.gearBaseline);
      result.medals += awards.length;
    } catch (err) {
      console.error('WoW medal award failed', err);
    }
    if (ev.firstCheck) continue;

    const post = milestonePosts({
      characterId: ev.characterId,
      firstCheck: ev.firstCheck,
      entries: ev.entries,
      firsts,
      now,
    }).find((p) => canPost(p.type));
    if (post) {
      await announce(
        env,
        post.type === 'wowFirst'
          ? { ...ref, type: 'wowFirst', characterName: ev.characterName, level: post.level, shared: post.shared }
          : { ...ref, type: 'wowLevel', characterName: ev.characterName, className: ev.className, level: post.level },
        baseUrl,
      );
      result.posted++;
    }
    for (const a of ev.gearBaseline ? [] : awards) {
      if (!canPost('medalAward')) break;
      await announce(
        env,
        { ...ref, type: 'medalAward', medalName: a.medalName, medalImageUrl: a.medalImageUrl, citation: a.citation },
        baseUrl,
      );
      result.posted++;
    }
  }
  return result;
}
