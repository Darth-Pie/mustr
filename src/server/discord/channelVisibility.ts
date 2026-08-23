/**
 * Grants a role's mirrored Discord role View Channel access on specific
 * channels — the "website roles → Discord channel visibility" mapping that
 * was deliberately deferred out of the original rewrite (see the roadmap
 * memory: "a discord side project that isn't something necessary to do here
 * today").
 *
 * Scoped deliberately narrow: mustr only ever writes or removes ITS OWN
 * allow-overwrite for the mapped role on the channels an admin picks here.
 * It never touches @everyone or any other role's/member's overwrite, so
 * applying this can only ever ADD visibility, never take it away from
 * someone else. To actually GATE a channel (hide it from everyone else),
 * the admin still has to deny @everyone → View Channel on that channel in
 * Discord itself — mustr won't do that automatically, since that action
 * could hide a channel from people who aren't managed by this role mapping.
 */

import { DiscordRest, DiscordError } from './rest';

const VIEW_CHANNEL = '1024';
const NO_PERMS = '0';

export interface ChannelSyncFailure {
  channelId: string;
  error: string;
}

export interface ChannelSyncResult {
  applied: string[];
  removed: string[];
  failed: ChannelSyncFailure[];
}

/**
 * Applies a diff of channel ids to add/remove the View Channel overwrite for
 * one Discord role. Best-effort per channel — one failure doesn't stop the
 * rest, mirroring discord/sync.ts's "site is authoritative, report don't
 * throw" pattern. Pass `rest: null` (bot unconfigured) or `discordRoleId:
 * null` (role has no Discord mirror) to no-op with every channel reported failed.
 */
export async function applyRoleChannelOverwrites(
  rest: DiscordRest | null,
  discordRoleId: string | null,
  diff: { add: string[]; remove: string[] },
  reason: string,
): Promise<ChannelSyncResult> {
  const result: ChannelSyncResult = { applied: [], removed: [], failed: [] };
  const unconfigured = !rest || !discordRoleId;

  for (const channelId of diff.add) {
    if (unconfigured) {
      result.failed.push({ channelId, error: 'Discord bot is not configured, or this role has no mirrored Discord role.' });
      continue;
    }
    try {
      await rest!.setChannelRoleOverwrite(channelId, discordRoleId!, { allow: VIEW_CHANNEL, deny: NO_PERMS }, reason);
      result.applied.push(channelId);
    } catch (err) {
      result.failed.push({ channelId, error: describeError(err) });
    }
  }

  for (const channelId of diff.remove) {
    if (unconfigured) {
      result.failed.push({ channelId, error: 'Discord bot is not configured, or this role has no mirrored Discord role.' });
      continue;
    }
    try {
      await rest!.deleteChannelRoleOverwrite(channelId, discordRoleId!, reason);
      result.removed.push(channelId);
    } catch (err) {
      result.failed.push({ channelId, error: describeError(err) });
    }
  }

  return result;
}

function describeError(err: unknown): string {
  if (err instanceof DiscordError && err.status === 403) {
    return 'the bot needs Manage Roles and View Channel access there, and its role must sit above this one in Server Settings → Roles.';
  }
  return (err as Error).message;
}
