/**
 * Renders a stored PageLayout: a stack of rows, each a responsive 12-unit grid
 * of columns, each column an ordered list of modules. Columns collapse to a
 * single readable stack on narrow screens (see .page-grid in styles.css). The
 * same component renders the live page and the editor preview, so what an admin
 * arranges is exactly what members see.
 *
 * Each module has one of three audiences (see LayoutModule): a specific role, the
 * public (anyone, including logged-out visitors), or — the default — any signed-in
 * member. On the live page a module is skipped when the current viewer isn't in its
 * audience: role modules need that role (god bypasses), member modules need any
 * login, public modules are always shown. In the editor preview (`showHidden`)
 * every module renders with an audience badge so the admin sees exactly who gets
 * what — pass `roles` there so a role badge can be named.
 */

import type { CSSProperties } from 'react';
import { MorphIcon } from 'morphicons/react';
import { Lock, Globe, Users, type IconNode } from 'lucide';
import type { PageLayout } from '../../shared/layout';
import { useSession } from '../lib/session';
import { MODULE_RENDERERS } from './modules';

export default function PageRenderer({
  layout,
  showHidden = false,
  roles,
}: {
  layout: PageLayout;
  showHidden?: boolean;
  /** All roles, by id → name; only needed to label gated modules in the preview. */
  roles?: { id: number; name: string }[];
}) {
  const { viewer } = useSession();

  const canSeeRole = (roleId: number): boolean =>
    !!viewer && (viewer.isGod || viewer.roles.some((r) => r.id === roleId));
  const roleName = (roleId: number): string =>
    roles?.find((r) => r.id === roleId)?.name ?? 'Restricted';

  /** Is this module hidden from the current viewer on the live page? */
  const isHidden = (m: PageLayout['rows'][number]['columns'][number]['modules'][number]): boolean => {
    if (m.visibleToRole != null) return !canSeeRole(m.visibleToRole); // role only
    if (m.public) return false; // public: everyone, including logged-out
    return !viewer; // members: hidden from anonymous visitors only
  };

  /** The audience badge shown in the editor preview. */
  const audienceBadge = (
    m: PageLayout['rows'][number]['columns'][number]['modules'][number],
  ): { icon: IconNode; label: string; cls: string } => {
    if (m.visibleToRole != null) return { icon: Lock, label: roleName(m.visibleToRole), cls: 'role' };
    if (m.public) return { icon: Globe, label: 'Public', cls: 'public' };
    return { icon: Users, label: 'Members', cls: 'members' };
  };

  if (!layout.rows.length) {
    return <p className="empty">This page has no content yet.</p>;
  }

  return (
    <div className="page-rows">
      {layout.rows.map((row) => (
        <div className="page-grid" key={row.id}>
          {row.columns.map((col) => (
            <div
              className="page-col"
              key={col.id}
              style={{ '--span': col.span } as CSSProperties}
            >
              {col.modules.map((m) => {
                const Renderer = MODULE_RENDERERS[m.type];
                if (!Renderer) return null;

                const hidden = isHidden(m);
                if (hidden && !showHidden) return null;

                const node = <Renderer config={m.config} />;
                if (showHidden) {
                  // Editor preview: render every module with an audience badge so
                  // the admin can see and manage what each viewer would get.
                  const b = audienceBadge(m);
                  return (
                    <div className={`module-gated audience-${b.cls}`} key={m.id}>
                      <span className="module-gated-badge" title={`Visible to: ${b.label}`}>
                        <MorphIcon icon={b.icon} size={12} aria-hidden /> {b.label}
                      </span>
                      {node}
                    </div>
                  );
                }
                return <div key={m.id}>{node}</div>;
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
