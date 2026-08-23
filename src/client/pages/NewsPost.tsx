/**
 * A single news post. The body is HTML from the editor, re-sanitized here
 * before it's inserted — stored markup is never trusted at render time.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MorphIcon } from 'morphicons/react';
import { Pin } from 'lucide';
import { api } from '../lib/api';
import { ApiError } from '../lib/api';
import { sanitizeHtml } from '../lib/richtext';
import { useRecordRecent } from '../lib/recent';

interface Post {
  id: number;
  slug: string;
  title: string;
  body: string;
  status: string;
  pinned: boolean;
  publishedAt: number | null;
  updatedAt: number;
  author: string | null;
}

export default function NewsPost() {
  const { slug } = useParams();
  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .get<{ post: Post }>(`/news/${slug}`)
      .then(({ post }) => setPost(post))
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? 'Post not found.' : 'Failed to load post.'))
      .finally(() => setLoading(false));
  }, [slug]);

  useRecordRecent(post ? { group: 'content', label: post.title, to: `/news/${post.slug}` } : null);

  if (loading) return <div className="loading">Loading…</div>;
  if (error || !post) return <div className="empty">{error ?? 'Post not found.'}</div>;

  return (
    <section className="panel news-post">
      <Link className="back" to="/news">
        ← News
      </Link>

      <header className="news-post-head">
        {post.status !== 'published' && <span className="tag">{post.status}</span>}
        {post.pinned && (
          <span className="tag pin">
            <MorphIcon icon={Pin} size={12} aria-hidden /> Pinned
          </span>
        )}
        <h1>{post.title}</h1>
        <div className="muted small">
          {post.author ?? 'Unknown'}
          {post.publishedAt && <> · {new Date(post.publishedAt * 1000).toLocaleDateString()}</>}
        </div>
      </header>

      <article
        className="news-body"
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(post.body) }}
      />
    </section>
  );
}
