/**
 * Content → Gallery — build albums, fill them, and decide who sees each one.
 *
 * Two panes: the album list on the left, the selected album's contents on the
 * right. The audience picker is the important control here, so it sits in the
 * album form rather than behind an advanced toggle: an operator should never
 * have to go looking for "who can see this".
 *
 * Images are downscaled in the browser before upload (see lib/galleryImage.ts)
 * — a full-size photo and a grid-size thumbnail, both WebP — so this page
 * uploads two small objects per photo instead of one large one. Videos are
 * embeds: the pasted URL is validated server-side by shared/embeds.ts and only
 * a rebuilt, origin-locked src is ever stored.
 *
 * Ordering uses explicit move buttons rather than drag. It's the one interaction
 * here that has to work on a phone, with a keyboard, and while an upload is in
 * flight, and buttons do all three without ceremony.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { MorphIcon } from 'morphicons/react';
import { Play } from 'lucide';
import { api } from '../lib/api';
import { useAction, Alerts } from '../lib/action';
import { useDragOrder } from '../lib/dragOrder';
import { prepareGalleryImage } from '../lib/galleryImage';
import {
  ALBUM_AUDIENCES,
  audienceLabel,
  itemThumb,
  type AlbumAudience,
  type GalleryAlbum,
  type GalleryItem,
} from '../../shared/gallery';

interface RoleOption {
  id: number;
  name: string;
  color: string | null;
}

/** The album form's working copy — separate from the saved album until saved. */
interface AlbumDraft {
  title: string;
  description: string;
  audience: AlbumAudience;
  visibleToRole: number | null;
}

const AUDIENCE_HELP: Record<AlbumAudience, string> = {
  public: 'Anyone, including people who aren’t signed in.',
  members: 'Any signed-in member of this site.',
  role: 'Only members holding the role you pick.',
};

function draftFrom(album: GalleryAlbum): AlbumDraft {
  return {
    title: album.title,
    description: album.description ?? '',
    audience: album.audience,
    visibleToRole: album.visibleToRole,
  };
}

export default function GalleryAdmin() {
  const [albums, setAlbums] = useState<GalleryAlbum[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<AlbumDraft | null>(null);
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [videoUrl, setVideoUrl] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { run, busy, error, notice, warning } = useAction();

  const selected = albums.find((a) => a.id === selectedId) ?? null;

  const loadAlbums = useCallback(async () => {
    const { albums: list } = await api.get<{ albums: GalleryAlbum[] }>('/gallery/admin/albums');
    setAlbums(list);
    return list;
  }, []);

  useEffect(() => {
    void loadAlbums().catch(() => setAlbums([]));
    api
      .get<{ roles: RoleOption[] }>('/gallery/meta/roles')
      .then((r) => setRoles(r.roles))
      .catch(() => setRoles([]));
  }, [loadAlbums]);

  // Pull the selected album's items, and reset the form to it.
  useEffect(() => {
    if (selectedId == null) {
      setItems([]);
      setDraft(null);
      return;
    }
    const album = albums.find((a) => a.id === selectedId);
    if (album) setDraft(draftFrom(album));
    let live = true;
    api
      .get<{ items: GalleryItem[] }>(`/gallery/admin/albums/${selectedId}/items`)
      .then((r) => live && setItems(r.items))
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
    // `albums` is intentionally excluded: refetching the list after a save
    // shouldn't blow away edits in progress on the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  /**
   * Created with its real name from the start: the slug is derived from the
   * title once, at creation, and never changes afterwards (links to an album
   * shouldn't rot because someone retitled it). Creating a placeholder called
   * "New album" and renaming it later would leave every album living at
   * /gallery/new-album-3.
   */
  const createAlbum = () =>
    run(async () => {
      const title = newTitle.trim();
      if (!title) return;
      const { album } = await api.post<{ album: GalleryAlbum | null }>('/gallery/albums', {
        title,
        audience: 'members',
      });
      setNewTitle('');
      await loadAlbums();
      if (album) setSelectedId(album.id);
      return 'Album created. It’s members-only until you change that.';
    });

  const saveAlbum = () =>
    run(async () => {
      if (!selected || !draft) return;
      await api.patch(`/gallery/albums/${selected.id}`, {
        title: draft.title,
        description: draft.description,
        audience: draft.audience,
        visibleToRole: draft.visibleToRole,
      });
      await loadAlbums();
      return 'Album saved.';
    });

  const deleteAlbum = () =>
    run(async () => {
      if (!selected) return;
      if (!window.confirm(`Delete “${selected.title}” and everything in it? This can’t be undone.`)) {
        return;
      }
      await api.del(`/gallery/albums/${selected.id}`);
      setSelectedId(null);
      await loadAlbums();
      return 'Album deleted.';
    });

  // Drag to reorder albums — optimistic, then persist the id order.
  const reorderAlbums = (nextKeys: string[]) => {
    const byId = new Map(albums.map((a) => [String(a.id), a]));
    const next = nextKeys.map((k) => byId.get(k)).filter((a): a is GalleryAlbum => !!a);
    setAlbums(next);
    void run(async () => {
      await api.put('/gallery/albums/order', { ids: next.map((x) => x.id) });
      return 'Order saved.';
    });
  };
  const albumDnd = useDragOrder(
    albums.map((a) => String(a.id)),
    reorderAlbums,
  );

  /** Upload each picked photo as a full + thumbnail pair, then add them all at once. */
  const addImages = (files: FileList) =>
    run(async () => {
      if (!selected) return;
      const list = Array.from(files);
      const prepared: Record<string, unknown>[] = [];
      const failed: string[] = [];

      for (let i = 0; i < list.length; i += 1) {
        const file = list[i]!;
        setProgress(`Preparing ${i + 1} of ${list.length}…`);
        try {
          const image = await prepareGalleryImage(file);
          const [full, thumb] = await Promise.all([
            api.upload<{ url: string }>('/media/gallery', image.full),
            api.upload<{ url: string }>('/media/gallery', image.thumb),
          ]);
          prepared.push({
            kind: 'image',
            url: full.url,
            thumbUrl: thumb.url,
            width: image.width,
            height: image.height,
            alt: '',
            caption: '',
          });
        } catch {
          failed.push(file.name);
        }
      }

      setProgress(null);
      if (fileRef.current) fileRef.current.value = '';
      // useAction only surfaces ApiError messages verbatim, so report a wholly
      // failed batch as a warning rather than throwing into "Something went wrong".
      if (prepared.length === 0) {
        return { warning: `None of those files could be read as images: ${failed.join(', ')}.` };
      }

      const { items: added } = await api.post<{ items: GalleryItem[] }>(
        `/gallery/albums/${selected.id}/items`,
        { items: prepared },
      );
      setItems((prev) => [...prev, ...added]);
      await loadAlbums();
      return failed.length
        ? `Added ${added.length}. Skipped: ${failed.join(', ')}.`
        : `Added ${added.length} ${added.length === 1 ? 'photo' : 'photos'}.`;
    });

  const addVideo = () =>
    run(async () => {
      if (!selected) return;
      const url = videoUrl.trim();
      if (!url) return;
      const { items: added } = await api.post<{ items: GalleryItem[] }>(
        `/gallery/albums/${selected.id}/items`,
        { items: [{ kind: 'video', url }] },
      );
      setVideoUrl('');
      setItems((prev) => [...prev, ...added]);
      await loadAlbums();
      return 'Video added.';
    });

  const saveItemText = (item: GalleryItem, caption: string, alt: string) =>
    run(async () => {
      await api.patch(`/gallery/items/${item.id}`, { caption, alt });
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, caption: caption || null, alt: alt || null } : i)),
      );
      return 'Saved.';
    });

  const deleteItem = (item: GalleryItem) =>
    run(async () => {
      await api.del(`/gallery/items/${item.id}`);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      await loadAlbums();
      return 'Removed.';
    });

  // Drag to reorder items within the selected album.
  const reorderItems = (nextKeys: string[]) => {
    if (!selected) return;
    const byId = new Map(items.map((i) => [String(i.id), i]));
    const next = nextKeys.map((k) => byId.get(k)).filter((i): i is GalleryItem => !!i);
    setItems(next);
    void run(async () => {
      await api.put(`/gallery/albums/${selected.id}/items/order`, { ids: next.map((x) => x.id) });
      return 'Order saved.';
    });
  };
  const itemDnd = useDragOrder(
    items.map((i) => String(i.id)),
    reorderItems,
  );

  return (
    <section className="panel gallery-admin">
      <header className="panel-head">
        <h2>Gallery</h2>
        <p className="muted">
          Albums of photos and videos. Each album decides its own audience, so a public showcase and
          a leadership-only album can live side by side.
        </p>
      </header>

      <Alerts error={error} warning={warning} notice={notice} />

      <div className="gallery-admin-body">
        <aside className="gallery-admin-list">
          <div className="gallery-admin-new">
            <input
              type="text"
              value={newTitle}
              maxLength={80}
              placeholder="New album name"
              disabled={busy}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newTitle.trim()) void createAlbum();
              }}
            />
            <button
              type="button"
              className="primary small"
              disabled={busy || !newTitle.trim()}
              onClick={() => void createAlbum()}
            >
              Create
            </button>
          </div>
          {albums.length === 0 ? (
            <p className="muted small">No albums yet.</p>
          ) : (
            <ul>
              {albums.map((a) => {
                const key = String(a.id);
                const cls = `${a.id === selectedId ? 'is-selected ' : ''}${albumDnd.isDragging(key) ? 'dragging ' : ''}${albumDnd.dropClass(key)}`.trim();
                return (
                  <li key={a.id} className={cls || undefined} {...albumDnd.rowProps(key)}>
                    <span
                      className="drag-grip gallery-admin-grip"
                      title="Drag to reorder"
                      aria-label={`Drag to reorder ${a.title}`}
                      {...(busy ? {} : albumDnd.handleProps(key))}
                    >
                      ⠿
                    </span>
                    <button type="button" className="gallery-admin-pick" onClick={() => setSelectedId(a.id)}>
                      <span className="gallery-admin-thumb">
                        {a.coverUrl ? <img src={a.coverUrl} alt="" loading="lazy" /> : null}
                      </span>
                      <span>
                        <strong>{a.title}</strong>
                        <span className="muted small">
                          {a.itemCount} · {audienceLabel(a, roles.find((r) => r.id === a.visibleToRole)?.name)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <div className="gallery-admin-detail">
          {!selected || !draft ? (
            <p className="muted">Pick an album, or create one.</p>
          ) : (
            <>
              <div className="gallery-admin-form">
                <label>
                  Title
                  <input
                    type="text"
                    value={draft.title}
                    maxLength={80}
                    disabled={busy}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  />
                </label>
                <label>
                  Description
                  <input
                    type="text"
                    value={draft.description}
                    maxLength={400}
                    placeholder="Optional"
                    disabled={busy}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </label>
                <label>
                  Who can see it
                  <select
                    value={draft.audience}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({ ...draft, audience: e.target.value as AlbumAudience })
                    }
                  >
                    {ALBUM_AUDIENCES.map((a) => (
                      <option key={a} value={a}>
                        {a === 'public' ? 'Everyone' : a === 'members' ? 'Members' : 'A specific role'}
                      </option>
                    ))}
                  </select>
                  <span className="muted small">{AUDIENCE_HELP[draft.audience]}</span>
                </label>
                {draft.audience === 'role' && (
                  <label>
                    Role
                    <select
                      value={draft.visibleToRole ?? ''}
                      disabled={busy}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          visibleToRole: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                    >
                      <option value="">Pick a role…</option>
                      {roles.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="gallery-admin-actions">
                  <button
                    type="button"
                    className="primary"
                    // A role-gated album with no role chosen reads as closed to
                    // everyone, so block the save rather than storing a dead end.
                    disabled={busy || (draft.audience === 'role' && draft.visibleToRole == null)}
                    onClick={() => void saveAlbum()}
                  >
                    Save album
                  </button>
                  <button type="button" className="danger" disabled={busy} onClick={() => void deleteAlbum()}>
                    Delete album
                  </button>
                  <a className="muted small" href={`/gallery/${selected.slug}`} target="_blank" rel="noreferrer">
                    View page ↗
                  </a>
                </div>
              </div>

              <div className="gallery-admin-add">
                <label className="gallery-admin-upload">
                  Add photos
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    multiple
                    disabled={busy}
                    onChange={(e) => e.target.files && void addImages(e.target.files)}
                  />
                  <span className="muted small">
                    Resized in your browser before uploading, so large photos are fine.
                  </span>
                </label>
                <label>
                  Add a video
                  <div className="module-config-row">
                    <input
                      type="url"
                      value={videoUrl}
                      placeholder="YouTube, Twitch, Vimeo or Streamable URL"
                      disabled={busy}
                      onChange={(e) => setVideoUrl(e.target.value)}
                    />
                    <button
                      type="button"
                      className="primary small"
                      disabled={busy || !videoUrl.trim()}
                      onClick={() => void addVideo()}
                    >
                      Add
                    </button>
                  </div>
                  <span className="muted small">
                    Videos are embedded from the host — nothing is stored here.
                  </span>
                </label>
              </div>

              {progress && <p className="muted small">{progress}</p>}

              {items.length === 0 ? (
                <p className="muted">This album is empty.</p>
              ) : (
                <ul className="gallery-admin-items">
                  {items.map((item) => {
                    const key = String(item.id);
                    return (
                      <ItemRow
                        key={item.id}
                        item={item}
                        busy={busy}
                        dragging={itemDnd.isDragging(key)}
                        dropClass={itemDnd.dropClass(key)}
                        handleProps={busy ? undefined : itemDnd.handleProps(key)}
                        rowProps={itemDnd.rowProps(key)}
                        onSave={(caption, alt) => void saveItemText(item, caption, alt)}
                        onDelete={() => void deleteItem(item)}
                      />
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** One item, with its caption/alt fields kept local until saved. */
function ItemRow({
  item,
  busy,
  dragging,
  dropClass,
  handleProps,
  rowProps,
  onSave,
  onDelete,
}: {
  item: GalleryItem;
  busy: boolean;
  dragging: boolean;
  dropClass: string;
  handleProps?: {
    draggable: true;
    onDragStart: (e: DragEvent) => void;
    onDragEnd: () => void;
  };
  rowProps: {
    onDragOver: (e: DragEvent<HTMLElement>) => void;
    onDrop: (e: DragEvent<HTMLElement>) => void;
  };
  onSave: (caption: string, alt: string) => void;
  onDelete: () => void;
}) {
  const [caption, setCaption] = useState(item.caption ?? '');
  const [alt, setAlt] = useState(item.alt ?? '');
  const thumb = itemThumb(item);
  const dirty = caption !== (item.caption ?? '') || alt !== (item.alt ?? '');

  return (
    <li className={`gallery-admin-item ${dragging ? 'dragging ' : ''}${dropClass}`.trim()} {...rowProps}>
      <span
        className="drag-grip"
        title="Drag to reorder"
        aria-label="Drag to reorder this item"
        {...handleProps}
      >
        ⠿
      </span>
      <span className="gallery-admin-thumb">
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <span aria-hidden><MorphIcon icon={Play} size={16} aria-hidden /></span>}
      </span>
      <div className="gallery-admin-item-fields">
        <input
          type="text"
          value={caption}
          maxLength={200}
          placeholder="Caption (shown under the image)"
          disabled={busy}
          onChange={(e) => setCaption(e.target.value)}
        />
        <input
          type="text"
          value={alt}
          maxLength={200}
          placeholder="Alt text (described to screen readers)"
          disabled={busy}
          onChange={(e) => setAlt(e.target.value)}
        />
        {item.kind === 'video' && <span className="muted small">{item.provider} · {item.url}</span>}
      </div>
      <div className="gallery-admin-item-actions">
        <button type="button" className="small primary" disabled={busy || !dirty} onClick={() => onSave(caption, alt)}>
          Save
        </button>
        <button type="button" className="small danger" disabled={busy} onClick={onDelete}>
          Remove
        </button>
      </div>
    </li>
  );
}
