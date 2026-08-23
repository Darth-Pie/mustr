/**
 * The news feed — the site's front page. Published posts only, pinned first.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MorphIcon } from 'morphicons/react';
import { Pin } from 'lucide';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { excerptFromHtml } from '../lib/richtext';

interface Post {
  id: number;
  slug: string;
  title: string;
  excerpt: string | null;
  body: string;
  pinned: boolean;
  publishedAt: number | null;
  author: string | null;
}

export default function News() {
  const { can } = useSession();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ posts: Post[] }>('/news')
      .then(({ posts }) => setPosts(posts))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">Loading news…</div>;

  return (
    <section className="panel">
      <header className="panel-head news-head">
        <div>
          <h2>News</h2>
          <p className="muted">{posts.length === 0 ? 'No posts yet.' : `${posts.length} post${posts.length === 1 ? '' : 's'}`}</p>
        </div>
        {can('news.create') && (
          <Link className="btn-link" to="/admin/news">
            Manage posts
          </Link>
        )}
      </header>

      {posts.length === 0 ? (
        <p className="muted">Nothing has been posted yet.</p>
      ) : (
        <ul className="news-feed">
          {posts.map((p) => (
            <li key={p.id} className="news-item">
              <Link to={`/news/${p.slug}`} className="news-item-link">
                <div className="news-item-head">
                  {p.pinned && (
                    <span className="tag pin">
                      <MorphIcon icon={Pin} size={12} aria-hidden /> Pinned
                    </span>
                  )}
                  <h3>{p.title}</h3>
                </div>
                <p className="news-excerpt">{p.excerpt || excerptFromHtml(p.body)}</p>
                <div className="muted small news-meta">
                  {p.author ?? 'Unknown'}
                  {p.publishedAt && <> · {new Date(p.publishedAt * 1000).toLocaleDateString()}</>}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
