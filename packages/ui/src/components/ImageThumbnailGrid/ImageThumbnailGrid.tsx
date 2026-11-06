export interface ThumbnailItem {
  id: string;
  /** BFF URL: same-origin path (e.g. /bff/images/{id}/content). Off-origin or scheme URLs are never loaded (REQ-SEC-141). */
  src: string;
  caption?: string;
  state: 'scanning' | 'ready' | 'rejected';
}

/** C6 04-UI-UX:323-324. */
export interface ImageThumbnailGridProps {
  items: readonly ThumbnailItem[];
  onCaptionChange?: (id: string, caption: string) => void;
  onRemove?: (id: string) => void;
  onReorder?: (ids: readonly string[]) => void;
  captionMaxLength: number;
  max: number;
  'data-testid'?: string;
}

/** Root-relative path only: "/x", not "//host" or "/\host" (browsers treat both as protocol-relative). */
export const isSameOriginPath = (src: string) => /^\/(?![/\\])/.test(src) && !/[\s\u0000-\u001f\\]/.test(src);

/** scanning: C6 04-UI-UX:116; rejected: [CONV]. */
const STATE_TEXT = { scanning: ['info', 'Checking the file for viruses…'], rejected: ['danger', 'This image could not be used.'] } as const;

function move(ids: string[], from: number, to: number) {
  const out = ids.slice();
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x!);
  return out;
}

/** Thumbnails (C6 gross images, C11). Only READY images are requested; other states are text chips. Reorder via earlier/later buttons (keyboard-operable). */
export function ImageThumbnailGrid({ items, onCaptionChange, onRemove, onReorder, captionMaxLength, max, ...rest }: ImageThumbnailGridProps) {
  const ids = items.map((i) => i.id);
  return (
    <div className="lims-thumbs-wrap" {...rest}>
      {/* [CONV] count copy */}
      <p className="lims-description">
        {items.length} of {max} images
      </p>
      <ul className="lims-thumbs">
        {items.map((im, i) => {
          const name = `image ${i + 1}`;
          const showable = im.state === 'ready' && isSameOriginPath(im.src);
          return (
            <li key={im.id} className="lims-thumb">
              {showable ? (
                <img className="lims-thumb-img" src={im.src} alt={im.caption || `Image ${i + 1}`} loading="lazy" />
              ) : (
                <span className="lims-thumb-placeholder">{`Image ${i + 1}`}</span>
              )}
              {im.state !== 'ready' && Object.hasOwn(STATE_TEXT, im.state) ? (
                <span className={`lims-chip lims-chip-sm lims-tone-${STATE_TEXT[im.state][0]}`} data-tone={STATE_TEXT[im.state][0]}>
                  {STATE_TEXT[im.state][1]}
                </span>
              ) : null}
              {onCaptionChange ? (
                <input
                  type="text"
                  className="lims-input lims-thumb-caption"
                  aria-label={`Caption for ${name}`}
                  maxLength={captionMaxLength}
                  value={im.caption ?? ''}
                  onChange={(e) => onCaptionChange(im.id, e.target.value)}
                />
              ) : im.caption ? (
                <span className="lims-thumb-caption">{im.caption}</span>
              ) : null}
              {onReorder || onRemove ? (
                <div className="lims-thumb-actions">
                  {onReorder ? (
                    <>
                      <button type="button" className="lims-btn lims-btn-sm" aria-label={`Move ${name} earlier`} disabled={i === 0} onClick={() => onReorder(move(ids, i, i - 1))}>
                        ←
                      </button>
                      <button type="button" className="lims-btn lims-btn-sm" aria-label={`Move ${name} later`} disabled={i === items.length - 1} onClick={() => onReorder(move(ids, i, i + 1))}>
                        →
                      </button>
                    </>
                  ) : null}
                  {onRemove ? (
                    <button type="button" className="lims-btn lims-btn-sm" aria-label={`Remove ${name}`} onClick={() => onRemove(im.id)}>
                      Remove
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
