export interface ThumbnailImage {
  id: string;
  /** Same-origin path (e.g. /bff/images/{id}/content). Off-origin or scheme URLs are never loaded (REQ-SEC-141). */
  src: string;
  alt: string;
  caption?: string;
  state: 'ready' | 'processing' | 'quarantined';
}

export interface ImageThumbnailGridProps {
  label: string;
  images: readonly ThumbnailImage[];
  onSelect?: (id: string) => void;
  'data-testid'?: string;
}

/** Root-relative path only: "/x", not "//host" or "/\host" (browsers treat both as protocol-relative). */
export const isSameOriginPath = (src: string) => /^\/(?![/\\])/.test(src) && !/[\s\u0000-\u001f\\]/.test(src);

const STATE_TEXT = { processing: ['info', 'Processing…'], quarantined: ['danger', 'Blocked by security scan'] } as const;

/** Thumbnails (C6 gross images, C11). Only READY images are requested; other states are text chips. */
export function ImageThumbnailGrid({ label, images, onSelect, ...rest }: ImageThumbnailGridProps) {
  return (
    <ul aria-label={label} className="lims-thumbs" {...rest}>
      {images.map((im) => {
        const showable = im.state === 'ready' && isSameOriginPath(im.src);
        const body = (
          <>
            {showable ? <img className="lims-thumb-img" src={im.src} alt={im.alt} loading="lazy" /> : <span className="lims-thumb-placeholder">{im.alt}</span>}
            {im.state !== 'ready' ? (
              <span className={`lims-chip lims-chip-sm lims-tone-${STATE_TEXT[im.state][0]}`} data-tone={STATE_TEXT[im.state][0]}>
                {STATE_TEXT[im.state][1]}
              </span>
            ) : null}
            {im.caption ? <span className="lims-thumb-caption">{im.caption}</span> : null}
          </>
        );
        return (
          <li key={im.id} className="lims-thumb">
            {showable && onSelect ? (
              <button type="button" className="lims-thumb-button" onClick={() => onSelect(im.id)}>
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}
