/**
 * News administration — the writer's side of the feed.
 *
 * Left: every post with its status. Right: the WYSIWYG editor for the selected
 * one. Writing needs news.create; the Publish/Unpublish/Archive controls need
 * news.publish; Delete needs news.delete — so the buttons a given admin sees
 * match what they're allowed to do.
 */

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MorphIcon } from 'morphicons/react';
import { Pin } from 'lucide';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import { useSession } from '../lib/session';
import Switch from '../components/Switch';

// TipTap/ProseMirror is heavy; only pull it in when a post is actually open.
const RichTextEditor = lazy(() => import('../components/RichTextEditor'));

interface PostSummary {
  id: number;
  slug: string;
  title: string;
  status: 'draft' | 'published' | 'archived';
  pinned: boolean;
  updatedAt: number;
  author: string | null;
}

interface FullPost extends PostSummary {
  excerpt: string | null;
  body: string;
  publishedAt: number | null;
}

export default function NewsAdmin() {
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selected, setSelected] = useState<FullPost | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [loading, setLoading] = useState(true);

  const loadList = useCallback(async () => {
    const { posts } = await api.get<{ posts: PostSummary[] }>('/news/manage');
    setPosts(posts);
  }, []);

  const loadSelected = useCallback(async (id: number, slug: string) => {
    const { post } = await api.get<{ post: FullPost }>(`/news/${slug}`);
    setSelected(post);
    setSelectedId(id);
  }, []);

  const refresh = useCallback(async () => {
    await loadList();
    if (selected) {
      const { post } = await api.get<{ post: FullPost }>(`/news/${selected.slug}`);
      setSelected(post);
    }
  }, [loadList, selected]);

  const { run, busy, error, notice, warning } = useAction(refresh);

  useEffect(() => {
    loadList().finally(() => setLoading(false));
  }, [loadList]);

  const create = () =>
    run(async () => {
      if (!newTitle.trim()) return;
      const { post } = await api.post<{ post: FullPost }>('/news', { title: newTitle.trim() });
      setNewTitle('');
      await loadSelected(post.id, post.slug);
      return `Created draft “${post.title}”.`;
    });

  if (loading) return <div className="loading">Loading news…</div>;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>News</h2>
        <p className="muted">
          {posts.length} post{posts.length === 1 ? '' : 's'}. Drafts are only visible to writers.
        </p>
      </header>

      <Alerts error={error} warning={warning} notice={notice} />

      <div className="add-row">
        <input
          value={newTitle}
          placeholder="New post title"
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void create()}
          disabled={busy}
        />
        <button onClick={() => void create()} disabled={busy || !newTitle.trim()}>
          New draft
        </button>
      </div>

      <div className="roles-layout">
        <ul className="news-admin-list">
          {posts.map((p) => (
            <li key={p.id}>
              <button
                className={p.id === selectedId ? 'news-admin-item active' : 'news-admin-item'}
                onClick={() => void loadSelected(p.id, p.slug)}
              >
                <span className="news-admin-title">
                  {p.pinned && (
                    <span className="pin-dot" title="Pinned">
                      <MorphIcon icon={Pin} size={12} aria-hidden />
                    </span>
                  )}
                  {p.title}
                </span>
                <span className={`status-chip status-${p.status}`}>{p.status}</span>
              </button>
            </li>
          ))}
          {posts.length === 0 && <li className="muted small">No posts yet.</li>}
        </ul>

        {selected ? (
          <PostEditor key={`${selected.id}:${selected.updatedAt}`} post={selected} busy={busy} run={run} onDeleted={() => { setSelected(null); setSelectedId(null); }} />
        ) : (
          <div className="role-editor empty-editor">Select a post to edit, or start a new draft.</div>
        )}
      </div>
    </section>
  );
}

function PostEditor({
  post,
  busy,
  run,
  onDeleted,
}: {
  post: FullPost;
  busy: boolean;
  run: (fn: () => Promise<string | { warning: string } | void | null>) => void;
  onDeleted: () => void;
}) {
  const { can } = useSession();
  const [title, setTitle] = useState(post.title);
  const [excerpt, setExcerpt] = useState(post.excerpt ?? '');
  const [pinned, setPinned] = useState(post.pinned);
  const [body, setBody] = useState(post.body);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const dirty =
    title !== post.title ||
    excerpt !== (post.excerpt ?? '') ||
    pinned !== post.pinned ||
    body !== post.body;

  const save = () =>
    run(async () => {
      if (!title.trim()) return { warning: 'A title is required.' };
      await api.patch(`/news/${post.id}`, { title: title.trim(), excerpt, body, pinned });
      return 'Saved.';
    });

  const setStatus = (status: 'draft' | 'published' | 'archived', label: string) =>
    run(async () => {
      await api.post(`/news/${post.id}/status`, { status });
      return label;
    });

  const remove = () =>
    run(async () => {
      await api.del(`/news/${post.id}`);
      onDeleted();
      return 'Post deleted.';
    });

  return (
    <div className="role-editor news-editor">
      <div className="news-editor-head">
        <span className={`status-chip status-${post.status}`}>{post.status}</span>
        <Link className="btn-link small" to={`/news/${post.slug}`} target="_blank" rel="noopener">
          View ↗
        </Link>
      </div>

      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
      </label>

      <label>
        Excerpt <span className="muted small">(optional — shown on the feed)</span>
        <input
          value={excerpt}
          placeholder="A one-line summary"
          onChange={(e) => setExcerpt(e.target.value)}
          disabled={busy}
        />
      </label>

      <div className="check">
        <Switch checked={pinned} onChange={setPinned} disabled={busy} label="Pin to the top of the feed" hideState />
        <span>Pin to the top of the feed</span>
      </div>

      <label className="rte-label">Body</label>
      <Suspense fallback={<div className="loading">Loading editor…</div>}>
        <RichTextEditor value={body} onChange={setBody} disabled={busy} />
      </Suspense>

      <div className="news-editor-actions">
        <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>
          Save
        </button>

        {can('news.publish') && (
          <>
            {post.status !== 'published' ? (
              <button disabled={busy} onClick={() => void setStatus('published', 'Published.')}>
                Publish
              </button>
            ) : (
              <button disabled={busy} onClick={() => void setStatus('draft', 'Unpublished — back to draft.')}>
                Unpublish
              </button>
            )}
            {post.status !== 'archived' && (
              <button disabled={busy} onClick={() => void setStatus('archived', 'Archived.')}>
                Archive
              </button>
            )}
          </>
        )}
      </div>

      {can('news.delete') && (
        <div className="editor-footer">
          {confirmDelete ? (
            <span className="confirm-row">
              <span className="small">Delete “{post.title}” permanently?</span>
              <button className="danger" disabled={busy} onClick={() => void remove()}>
                Confirm delete
              </button>
              <button disabled={busy} onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button className="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              Delete post
            </button>
          )}
        </div>
      )}
    </div>
  );
}
