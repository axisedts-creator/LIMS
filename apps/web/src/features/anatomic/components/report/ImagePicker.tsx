'use client';
// 04-UI-UX §4.2.7 images in the report: a Checkbox per READY image (caption as its label), the order of the ticked ones is the print order ([Move up] / [Move down]),
// at most settings.max_report_images. Thumbnails are the same-origin BFF route only (D-67, REQ-SEC-085); captions are text, never HTML (REQ-SEC-088). Each ticked image
// also shows as a read-only field named `image_ids/{k}`, so a server error about /image_ids/{k} becomes a summary link that focuses it.
// LD-140 (2026-11-13, binding): kit components and token class names only.
import { Checkbox } from '@lims/ui/components/Checkbox';
import { IconButton } from '@lims/ui/components/IconButton';
import { TextField } from '@lims/ui/components/TextField';
import type { CaseImage } from '../../server/types';

const caption = (i: CaseImage, n: number) => i.caption || `Image ${n}`;

export function ImagePicker({ images, selected, max, readOnly, onChange }: { images: readonly CaseImage[]; selected: readonly string[]; max: number; readOnly: boolean; onChange: (ids: string[]) => void }) {
  const ready = images.filter((i) => i.is_active && i.state === 'ready');
  const byId = new Map(ready.map((i, n) => [i.id, caption(i, n + 1)]));
  const full = selected.length >= max;
  const move = (k: number, d: -1 | 1) => {
    const j = k + d;
    if (j < 0 || j >= selected.length) return;
    const next = [...selected];
    [next[k], next[j]] = [next[j]!, next[k]!];
    onChange(next);
  };
  return (
    <section aria-labelledby="report-images">
      <h3 id="report-images" className="lims-card-title">Images in report</h3>
      {ready.length === 0 ? <p className="lims-description">No ready images on this case.</p> : null}
      <ul className="lims-image-list">
        {ready.map((i, n) => {
          const on = selected.includes(i.id);
          return (
            <li key={i.id}>
              {/* eslint-disable-next-line @next/next/no-img-element -- same-origin BFF stream (D-67), not a static asset */}
              <img src={`/anatomic/images/${i.id}/content`} alt="" width={64} height={64} loading="lazy" />
              <Checkbox
                label={caption(i, n + 1)}
                name={`pick_${i.id}`}
                isSelected={on}
                isDisabled={readOnly || (!on && full)}
                onChange={(c) => onChange(c ? [...selected, i.id] : selected.filter((x) => x !== i.id))}
              />
            </li>
          );
        })}
      </ul>
      {selected.length ? <p className="lims-description">Print order, top to bottom ({selected.length} of {max}).</p> : null}
      <ol>
        {selected.map((id, k) => (
          <li key={id}>
            <TextField label={`Print position ${k + 1}`} name={`image_ids/${k}`} maxLength={200} isReadOnly value={byId.get(id) ?? 'Image no longer available'} />
            {readOnly ? null : (
              <>
                <IconButton label={`Move up ${byId.get(id) ?? `image ${k + 1}`}`} icon="arrow-up" onPress={() => move(k, -1)} />
                <IconButton label={`Move down ${byId.get(id) ?? `image ${k + 1}`}`} icon="arrow-down" onPress={() => move(k, 1)} />
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
