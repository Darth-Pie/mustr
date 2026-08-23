/**
 * One gallery album — a justified grid that opens into a lightbox.
 *
 * Layout comes from react-photo-album (MIT): it packs each row to a target
 * height using the intrinsic size we stored at upload, which is what gives the
 * mixed-size look rather than a uniform grid of squares. The lightbox is
 * yet-another-react-lightbox (MIT).
 *
 * Videos ride in the same album as images. They're always third-party embeds —
 * nothing is self-hosted — and the URL that reaches the iframe is the canonical
 * one shared/embeds.ts rebuilt on an allow-listed origin, re-checked here right
 * before it's framed.
 *
 * The server has already decided whether this viewer may see the album at all;
 * a 404 here means "not for you" as much as "no such thing", on purpose.
 */

import { useEffect, useState } from 'react';
import { MorphIcon } from 'morphicons/react';
import { Play } from 'lucide';
import { Link, useParams } from 'react-router-dom';
import { RowsPhotoAlbum, type Photo } from 'react-photo-album';
// GenericSlide isn't imported: inside the `declare module` block below it
// resolves in the augmented module's own scope, exactly as the library's
// bundled plugins declare their slide types.
import Lightbox, { type Slide } from 'yet-another-react-lightbox';
import Captions from 'yet-another-react-lightbox/plugins/captions';
import Counter from 'yet-another-react-lightbox/plugins/counter';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import 'react-photo-album/rows.css';
import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/captions.css';
import 'yet-another-react-lightbox/plugins/counter.css';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { embedSrcForPage, isAllowedEmbedSrc } from '../../shared/embeds';
import {
  audienceLabel,
  itemThumb,
  type GalleryAlbum as Album,
  type GalleryItem,
} from '../../shared/gallery';

/**
 * A slide type for third-party video embeds. The lightbox ships an HTML5 <video>
 * plugin, which is no use to us — YouTube and friends are iframes — so we add
 * our own type and render it ourselves. This is the library's documented
 * extension point (its own video plugin augments SlideTypes the same way).
 */
declare module 'yet-another-react-lightbox' {
  interface SlideTypes {
    embed: SlideEmbed;
  }
  interface SlideEmbed extends GenericSlide {
    type: 'embed';
    /** Canonical, origin-locked embed URL — never author input. */
    src: string;
    title?: string;
  }
}

/** A photo carrying enough of its item to draw a play badge over videos. */
type GalleryPhoto = Photo & { kind: GalleryItem['kind'] };

/**
 * Stand-in tile for a video whose provider gives us no poster (Twitch, Vimeo,
 * Streamable). Inline SVG so it costs no request and can't 404.
 */
const VIDEO_PLACEHOLDER =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">' +
      '<rect width="1280" height="720" fill="#141821"/>' +
      '<circle cx="640" cy="360" r="86" fill="none" stroke="#4b5563" stroke-width="6"/>' +
      '</svg>',
  );

export default function GalleryAlbumPage() {
  const { slug } = useParams<{ slug: string }>();
  const { viewer } = useSession();
  const [album, setAlbum] = useState<Album | null>(null);
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(-1);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setMissing(false);
    api
      .get<{ album: Album; items: GalleryItem[] }>(`/gallery/albums/${slug}`)
      .then((r) => {
        if (!live) return;
        setAlbum(r.album);
        setItems(r.items);
      })
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404) setMissing(true);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [slug]);

  if (loading) return <div className="loading">Loading…</div>;

  if (missing || !album) {
    return (
      <div className="empty">
        <p>This album isn’t available.</p>
        {!viewer && (
          <p className="muted small">
            Some albums are only shown to members — <Link to="/login">sign in</Link> if you have an
            account.
          </p>
        )}
        <p>
          <Link to="/gallery">← Back to the gallery</Link>
        </p>
      </div>
    );
  }

  const photos: GalleryPhoto[] = items.map((it) => ({
    key: String(it.id),
    src: itemThumb(it) ?? VIDEO_PLACEHOLDER,
    width: it.width,
    height: it.height,
    alt: it.alt ?? it.caption ?? '',
    kind: it.kind,
  }));

  const slides: Slide[] = items.map((it) =>
    it.kind === 'video' && isAllowedEmbedSrc(it.src)
      ? { type: 'embed', src: it.src, title: it.caption ?? undefined }
      : {
          src: it.url,
          alt: it.alt ?? undefined,
          width: it.width,
          height: it.height,
          title: it.caption ?? undefined,
        },
  );

  return (
    <section className="gallery-album">
      <header className="gallery-album-head">
        <Link className="gallery-back" to="/gallery">
          ← Gallery
        </Link>
        <h1>{album.title}</h1>
        {album.description && <p className="muted">{album.description}</p>}
        <p className="muted small">
          {album.itemCount} {album.itemCount === 1 ? 'item' : 'items'}
          {album.audience !== 'public' && (
            <>
              {' · '}
              <span className="gallery-audience">{audienceLabel(album)}</span>
            </>
          )}
        </p>
      </header>

      {items.length === 0 ? (
        <div className="empty">Nothing in this album yet.</div>
      ) : (
        <RowsPhotoAlbum
          photos={photos}
          targetRowHeight={240}
          spacing={8}
          onClick={({ index }) => setOpen(index)}
          render={{
            // A play badge over video tiles, so a still frame doesn't read as
            // just another photo.
            extras: (_, { photo }) =>
              photo.kind === 'video' ? (
                <span className="gallery-play" aria-hidden>
                  <MorphIcon icon={Play} size={18} aria-hidden />
                </span>
              ) : null,
          }}
        />
      )}

      <Lightbox
        open={open >= 0}
        index={Math.max(0, open)}
        close={() => setOpen(-1)}
        slides={slides}
        plugins={[Captions, Counter, Zoom]}
        captions={{ descriptionTextAlign: 'center' }}
        carousel={{ finite: true }}
        render={{
          slide: ({ slide }) =>
            slide.type === 'embed' && isAllowedEmbedSrc(slide.src) ? (
              <div className="gallery-lightbox-embed">
                <iframe
                  src={embedSrcForPage(slide.src)}
                  title={slide.title ?? 'Video'}
                  allowFullScreen
                  sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
                  allow="autoplay; fullscreen; picture-in-picture; encrypted-media; clipboard-write"
                  referrerPolicy="strict-origin-when-cross-origin"
                />
              </div>
            ) : undefined,
        }}
      />
    </section>
  );
}
