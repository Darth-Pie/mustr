/**
 * The top-right account menu.
 *
 * Replaces the bare "Sign out" button with the viewer's avatar + name, opening
 * a dropdown of account actions. "Admin" only appears when the viewer can reach
 * at least one admin section (derived from the same ADMIN_SECTIONS registry the
 * panel uses, so the two never drift apart).
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MorphIcon } from 'morphicons/react';
import { ChevronDown, ChevronUp, Star } from 'lucide';
import { useSession } from '../lib/session';
import { memberName } from '../../shared/names';
import { memberAvatar } from '../../shared/avatar';
import { canAccessAdmin } from '../lib/adminSections';

export default function AccountMenu() {
  const { viewer, can, logout } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!viewer) return null;

  const showAdmin = canAccessAdmin(can);

  return (
    <div className="account-menu" ref={ref}>
      <button
        className="account-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <img className="avatar sm" src={memberAvatar(viewer, 64)} alt="" width={28} height={28} />
        <span className="account-name">{memberName(viewer)}</span>
        {viewer.pending && <span className="pending-chip" title="Application in review">Pending</span>}
        {viewer.rank && <span className="rank-chip">{viewer.rank.name}</span>}
        {viewer.isGod && (
          <span className="god-chip" title="God status">
            <MorphIcon icon={Star} size={12} aria-hidden />
          </span>
        )}
        <MorphIcon className="caret" icon={open ? ChevronUp : ChevronDown} size={16} aria-hidden />
      </button>

      {open && (
        <div className="account-dropdown" role="menu">
          <Link
            className="menu-item"
            role="menuitem"
            to={`/members/${viewer.id}`}
            onClick={() => setOpen(false)}
          >
            Edit Profile
          </Link>
          <Link className="menu-item" role="menuitem" to="/account" onClick={() => setOpen(false)}>
            Settings
          </Link>
          {showAdmin && (
            <Link className="menu-item" role="menuitem" to="/admin" onClick={() => setOpen(false)}>
              Admin
            </Link>
          )}
          <div className="menu-sep" />
          <button
            className="menu-item"
            role="menuitem"
            onClick={async () => {
              setOpen(false);
              await logout();
              // Land on the home page (a full navigation, so any admin/member data
              // held in memory is cleared) rather than staying on a now-forbidden
              // route that would bounce to /login.
              window.location.assign('/');
            }}
          >
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
}
