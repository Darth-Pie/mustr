/**
 * The header notification bell — a member's role-gated in-app feed.
 *
 * Polls /notifications (and refreshes on window focus) for the unread count;
 * opening the dropdown marks everything currently visible read. Each card links
 * to where the event happened. Notifications are gated server-side by role, so
 * this only ever shows what the viewer is allowed to see.
 */

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MorphIcon } from 'morphicons/react';
import { Bell, BellRing } from 'lucide';
import { api } from '../lib/api';

interface Reviewer {
  id: number;
  name: string;
}
interface Notif {
  id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: number;
  read: boolean;
  reviewedAt: number | null;
  reviewer: Reviewer | null;
}

function timeAgo(sec: number): string {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export default function NotificationBell() {
  const [items, setItems] = useState<Notif[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = () =>
    api
      .get<{ notifications: Notif[]; unread: number }>('/notifications')
      .then((d) => {
        setItems(d.notifications);
        setUnread(d.unread);
      })
      .catch(() => {
        /* offline / not configured — leave the bell quiet */
      });

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 90_000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Opening the tray is the "seen" signal — mark everything visible read.
    if (next && unread > 0) {
      setUnread(0);
      setItems((prev) => prev.map((n) => ({ ...n, read: true })));
      void api.post('/notifications/read').catch(() => {});
    }
  };

  // Claim a notification as reviewed. Shared, first-come: the server may return a
  // different reviewer if someone beat us to it, so we adopt whatever it says.
  const review = (id: number) => {
    api
      .post<{ reviewedAt: number | null; reviewer: Reviewer | null }>(`/notifications/${id}/review`)
      .then((d) => setItems((prev) => prev.map((n) => (n.id === id ? { ...n, reviewedAt: d.reviewedAt, reviewer: d.reviewer } : n))))
      .catch(() => {});
  };

  return (
    <div className="notif" ref={ref}>
      <button
        type="button"
        className="notif-btn"
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        aria-expanded={open}
        onClick={toggle}
      >
        {/* Morphs to a ringing bell while anything is unread — the icon itself
            carries the state instead of leaving the badge to do all the work. */}
        <MorphIcon icon={unread > 0 ? BellRing : Bell} size={18} spring="snappy" aria-hidden />
        {unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className="notif-pop" role="menu">
          <div className="notif-pop-head">Notifications</div>
          {items.length === 0 ? (
            <div className="notif-empty muted small">Nothing here yet.</div>
          ) : (
            <ul className="notif-list">
              {items.map((n) => {
                const inner = (
                  <>
                    <span className="notif-title">{n.title}</span>
                    {n.body && <span className="notif-text muted small">{n.body}</span>}
                    <span className="notif-time muted small">{timeAgo(n.createdAt)}</span>
                  </>
                );
                return (
                  <li key={n.id} className={n.read ? 'notif-item' : 'notif-item unread'}>
                    {n.link ? (
                      <Link to={n.link} className="notif-link" onClick={() => setOpen(false)}>
                        {inner}
                      </Link>
                    ) : (
                      <div className="notif-link">{inner}</div>
                    )}
                    <div className="notif-review">
                      {n.reviewer ? (
                        <span className="notif-reviewed muted small">✓ Reviewed by {n.reviewer.name}</span>
                      ) : (
                        <button type="button" className="notif-review-btn" onClick={() => review(n.id)}>
                          Mark as reviewed
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
