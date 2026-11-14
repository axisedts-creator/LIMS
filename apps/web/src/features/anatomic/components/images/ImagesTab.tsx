'use client';
// 04-UI-UX §4.2.5 Images tab: gallery of the case's active images, [Upload images] (png/jpeg, 15 MB, up to 10 files, one request per file with its own Idempotency-Key),
// per image Kind / Part / Caption + [Save] and [Remove from case]. Thumbnails are same-origin <img> served by the BFF route (D-67): no signed URL, no API origin, no
// blob / data URL preview of the user's file (REQ-SEC-085). Only `ready` images are requested; processing and quarantined ones show a chip, never a preview.
// A processing image is polled with router.refresh() every 3 s for at most 2 minutes (03-APP-FLOW). Captions are text, never HTML (REQ-SEC-088).
// Upload stays available on a signed-out case (AC-12.8, D-66 (a)); Kind / Part / Caption of an image in a signed version are rejected by the API (409 signout_locked, shown).
// LD-140 (2026-11-13, binding): kit components only; every status shows tone, icon and word.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { FileUpload } from '@lims/ui/components/FileUpload';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { deactivateImageAction, updateImageAction, uploadImageAction } from '../../server/actions.material';
import type { CaseDetail, CaseImage, ImageKind } from '../../server/types';
import { Chip, failText, newKey, type Fail } from '../common';

const MAX_BYTES = 15 * 1024 * 1024;
const POLL_MS = 3000;
const POLL_MAX = 40; // 2 minutes
const KINDS: readonly { value: ImageKind; label: string }[] = [{ value: 'gross', label: 'Gross' }, { value: 'microscopy', label: 'Microscopy' }, { value: 'other', label: 'Other' }];

interface Props { detail: CaseDetail; canWork: boolean; onFail: (f: Fail) => void; onMfa: () => void }

function ImageCard({ n, image, detail, canWork, onFail, onMfa }: Props & { n: number; image: CaseImage }) {
  const router = useRouter();
  const toast = useToast();
  const [kind, setKind] = useState<ImageKind>(image.kind);
  const [part, setPart] = useState<string | undefined>(image.part_id);
  const [caption, setCaption] = useState(image.caption ?? '');
  const [removing, setRemoving] = useState(false);
  const [pending, setPending] = useState(false);
  const letter = detail.parts.find((p) => p.id === image.part_id)?.letter;
  const alt = image.caption || `Image ${n}, ${image.kind}${letter ? `, part ${letter}` : ''}`;
  const fail = (f: Fail) => (f.code === 'auth.mfa_required' ? onMfa() : onFail(f));

  useEffect(() => {
    setKind(image.kind);
    setPart(image.part_id);
    setCaption(image.caption ?? '');
  }, [image.version, image.kind, image.part_id, image.caption]);

  const save = async () => {
    if (pending) return;
    setPending(true);
    try {
      const r = await updateImageAction(image.id, image.version, { kind, ...(part ? { part_id: part } : {}), ...(caption ? { caption } : {}) });
      if (r.ok) {
        toast.show({ tone: 'success', title: 'Image saved' });
        router.refresh();
      } else fail(r);
    } finally {
      setPending(false);
    }
  };

  const remove = async () => {
    const r = await deactivateImageAction(image.id, image.version, newKey());
    setRemoving(false);
    if (r.ok) router.refresh();
    else fail(r);
  };

  return (
    <li>
      <Card title={`Image ${n}`}>
        {image.state === 'ready' ? (
          // eslint-disable-next-line @next/next/no-img-element -- same-origin BFF stream (D-67), not a static asset
          <img src={`/anatomic/images/${image.id}/content`} alt={alt} width={image.width_px ?? 160} height={image.height_px ?? 160} loading="lazy" />
        ) : image.state === 'processing' ? (
          <Chip tone="info" label="Processing…" />
        ) : (
          <Chip tone="danger" label="Blocked by security scan" />
        )}
        {image.state === 'ready' && canWork ? (
          <>
            <Select label="Kind" name={`kind_${image.id}`} options={KINDS} value={kind} onChange={setKind} />
            <Select label="Part" name={`part_${image.id}`} options={detail.parts.map((p) => ({ value: p.id, label: `Part ${p.letter}` }))} {...(part ? { value: part } : {})} onChange={setPart} />
            <TextField label="Caption" name={`caption_${image.id}`} maxLength={200} description="Do not type patient names in captions." value={caption} onChange={setCaption} />
            <Button isLoading={pending} onPress={() => void save()}>Save</Button>
          </>
        ) : null}
        {canWork ? <Button variant="ghost" onPress={() => setRemoving(true)}>Remove from case</Button> : null}
      </Card>
      <ConfirmDialog
        title="Remove image"
        tone="danger"
        confirmLabel="Remove from case"
        isOpen={removing}
        onCancel={() => setRemoving(false)}
        body="Remove this image from the case? Signed reports that include it keep it."
        onConfirm={remove}
      />
    </li>
  );
}

export function ImagesTab(props: Props) {
  const { detail, canWork, onFail, onMfa } = props;
  const router = useRouter();
  const toast = useToast();
  const images = detail.images.filter((i) => i.is_active);
  const processing = images.some((i) => i.state === 'processing');

  useEffect(() => {
    if (!processing) return;
    let ticks = 0;
    const t = setInterval(() => {
      if (++ticks > POLL_MAX) return clearInterval(t);
      router.refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [processing, router]);

  const upload = async (files: readonly File[]) => {
    let any = false;
    for (const f of files) {
      const fd = new FormData();
      fd.set('file', f);
      fd.set('kind', 'gross');
      const r = await uploadImageAction(detail.id, fd, newKey());
      if (r.ok) any = true;
      else if (r.code === 'auth.mfa_required') return onMfa();
      else toast.show({ tone: 'danger', title: failText(r, detail.status) });
    }
    if (any) {
      toast.show({ tone: 'success', title: 'Upload finished' });
      router.refresh();
    }
  };

  return (
    <>
      {canWork ? <FileUpload label="Upload images" name="images" accept={['image/png', 'image/jpeg']} maxBytes={MAX_BYTES} multiple maxFiles={10} description="PNG or JPEG, up to 15 MB each." onSelect={(f) => void upload(f)} /> : null}
      {images.length === 0 ? (
        <EmptyState title="No images. Upload gross or microscopy photos." />
      ) : (
        <ul className="lims-image-list">
          {images.map((img, i) => <ImageCard key={img.id} n={i + 1} image={img} {...props} />)}
        </ul>
      )}
    </>
  );
}
