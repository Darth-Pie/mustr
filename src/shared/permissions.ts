/**
 * The permission vocabulary.
 *
 * The 2003 version gated actions on `member.rank >= auth.<action>` — a single
 * linear ladder. That made "trusted member who isn't an officer" impossible to
 * express. Here, rank is prestige and roles carry capability; they move
 * independently.
 */

export const PERMISSIONS = {
  'roster.view': 'See the member list (roster page + home page)',
  'roster.edit': 'Edit member details and profiles',
  'roster.promote': 'Change a member’s rank',
  'roster.remove': 'Remove or retire a member',
  'members.approve': 'Approve or reject people applying to join',
  'members.ban': 'Ban a Discord user from the site and manage the ban list',

  'roles.assign': 'Grant and revoke roles on members',
  'roles.manage': 'Create, edit, and delete roles and their permissions',
  'ranks.manage': 'Create, edit, reorder, and delete ranks',

  'news.create': 'Write news posts',
  'news.publish': 'Publish and unpublish news posts',
  'news.delete': 'Delete news posts',

  'medals.award': 'Award and revoke medals',
  'medals.manage': 'Create, edit, and delete medal definitions',

  'training.view': 'See any member’s training completion status',
  'training.manage': 'Create and edit training courses, and mark members complete',

  'games.manage': 'Create, edit, and delete games',
  'matches.record': 'Record match results',
  'matches.manage': 'Edit and delete any match record',

  'warrecords.manage': 'Create, edit, and delete war records',
  'warrecords.award': 'Award and revoke war records',

  'events.view': 'See the events page',
  'events.manage': 'Create, edit, and cancel events',
  'events.attendees': 'See who has signed up for an event',

  'tournaments.manage': 'Create tournaments, seed brackets, and report match results',

  // Viewing a gallery needs no permission — each album carries its own audience
  // (everyone / members / one role). This is only the right to build them.
  'gallery.manage': 'Create gallery albums, upload media, and set who can see each album',

  'theme.manage': 'Edit site theme and appearance',
  'pages.manage': 'Arrange page layouts and modules',
  'settings.manage': 'Edit site settings',

  'alliance.manage': 'Link allied orgs and manage cross-org broadcasts',

  'hangar.view': 'View other members’ Star Citizen hangars (when they’ve shared them)',
  'hangar.value': 'See the monetary value of members’ hangars (hidden from others)',

  'audit.view': 'View the audit log',
  'discord.sync': 'Trigger Discord role synchronization',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/**
 * What a pending applicant is granted in demo/preview mode (a per-install setting,
 * off by default — see the OAuth/viewer flow). It opens read-only visibility into
 * the community content and the content/people admin panels so a prospective buyer
 * can tour the product. Writes are still blocked server-side (a method guard), so
 * these read as "look but don't touch".
 *
 * Deliberately EXCLUDES the Settings group (settings.manage, theme.manage,
 * discord.sync) and the people-management actions (roster.edit/promote/remove,
 * members.approve/ban) — nothing here can expose a secret or another applicant's
 * queue, even read-only.
 */
export const PREVIEW_PERMISSIONS: Permission[] = [
  'roster.view',
  'events.view',
  'events.attendees',
  'hangar.view',
  'audit.view',
  'pages.manage',
  'news.create',
  'ranks.manage',
  'roles.manage',
  'medals.manage',
  'warrecords.manage',
  'games.manage',
  'gallery.manage',
];

export function isPermission(value: string): value is Permission {
  return value in PERMISSIONS;
}

/** What the session endpoint hands to the React app. */
export interface Viewer {
  id: number;
  discordId: string;
  username: string;
  globalName: string | null;
  displayName: string | null;
  avatar: string | null;
  profileImageUrl: string | null;
  isGod: boolean;
  rank: { id: number; name: string; sortOrder: number } | null;
  roles: { id: number; name: string; color: string | null }[];
  permissions: Permission[];
  /**
   * An applicant who signed in via Discord but isn't an approved member yet.
   * Authenticated, but authorized like a logged-out visitor (can only edit their
   * own profile) — unless `preview` is set (the mustr.gg demo).
   */
  pending?: boolean;
  /**
   * Demo/preview mode (a per-install setting, off by default): a pending user is
   * granted read-only visibility into members-only content and the admin panel.
   * All writes are still blocked server-side. Only meaningful when `pending`.
   */
  preview?: boolean;
}

/**
 * The single authority on "can this person do this".
 *
 * God status bypasses everything by design — it is the recovery hatch that
 * prevents anyone, including the founder, from locking themselves out of
 * their own site. Grant it sparingly; it is not assignable through the UI.
 */
export function can(viewer: Viewer | null, permission: Permission): boolean {
  if (!viewer) return false;
  if (viewer.isGod) return true;
  return viewer.permissions.includes(permission);
}

export function canAll(viewer: Viewer | null, ...permissions: Permission[]): boolean {
  return permissions.every((p) => can(viewer, p));
}

export function canAny(viewer: Viewer | null, ...permissions: Permission[]): boolean {
  return permissions.some((p) => can(viewer, p));
}

/**
 * True if every permission in `permissions` is one the actor already holds
 * themselves (or the actor is God). This is the ceiling on every action that
 * hands out capability — granting a role to a member, setting a role's
 * permission list, or attaching a role to a rank — so that a role with
 * `roles.assign` or `roles.manage` can delegate at most what it already has,
 * never more. Without this, "can assign roles" and "can design roles" quietly
 * become "can become an admin".
 */
export function permissionsWithinGrant(actor: Viewer, permissions: Permission[]): boolean {
  if (actor.isGod) return true;
  return permissions.every((p) => actor.permissions.includes(p));
}

/**
 * Rank-ladder guard, kept separate from permissions on purpose.
 *
 * Even with `roster.promote`, you should not be able to promote someone above
 * yourself or demote a peer. God ignores this.
 */
export function outranks(
  actor: Pick<Viewer, 'isGod' | 'rank'>,
  targetRankOrder: number | null,
): boolean {
  if (actor.isGod) return true;
  if (actor.rank == null) return false;
  if (targetRankOrder == null) return true;
  return actor.rank.sortOrder > targetRankOrder;
}
