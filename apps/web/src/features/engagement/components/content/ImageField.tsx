'use client';
// T0D-CONTENT-1 image field for banners and profile images (done_when 3, LD-313 d): the kit FileUpload with its queue (progress, 3 retries with
// backoff, Try again), PNG or JPEG up to 2 MB, sent through uploadBrandingAsset (the existing branding path; no new upload route). The
// thumbnail is served by the BFF proxy at /engagement/content/assets/{asset_id}; the browser never reads the file bytes itself.
import { useRef } from 'react';
import { FileUpload } from '@lims/ui/components/FileUpload';
import { t } from '@/core/i18n/messages';
import { uploadContentImageAction } from '../../server/content-actions';
import { IMAGE_MAX_BYTES } from './content-model';

export const thumbSrc = (assetId: string) => `/engagement/content/assets/${encodeURIComponent(assetId)}`;

export function Thumb({ assetId, alt }: { assetId: string; alt: string }) {
  return <img className="lims-content-thumb" src={thumbSrc(assetId)} alt={alt} width={160} height={90} loading="lazy" />;
}

/** A 4xx (type, size, quarantine, permission) is final; 5xx, 429 and network failures are retried by the kit queue. */
class UploadFailure extends Error {
  constructor(readonly status: number) { super(`upload ${status}`); }
  get retryable() { return this.status >= 500 || this.status === 429; }
}

export function ImageField({ name, canUpload, error, onUploaded }: { name: string; canUpload: boolean; error?: string | undefined; onUploaded: (assetId: string) => void }) {
  const last = useRef<string | undefined>(undefined);
  const uploadFile = async (file: File, c: { onProgress: (percent: number) => void }) => {
    const form = new FormData();
    form.set('file', file);
    const r = await uploadContentImageAction(form);
    if (!r.ok) throw new UploadFailure(r.status);
    if (r.data.scan_state === 'infected') throw new UploadFailure(422);
    last.current = r.data.asset_id;
    c.onProgress(100);
  };
  return (
    <FileUpload
      label={t('engagement.content.field.image')}
      name={name}
      accept={['image/png', 'image/jpeg']}
      maxBytes={IMAGE_MAX_BYTES}
      description={canUpload ? t('engagement.content.upload.limits') : `${t('engagement.content.upload.denied')} ${t('engagement.content.upload.limits')}`}
      isDisabled={!canUpload}
      {...(error ? { error } : {})}
      onSelect={() => { last.current = undefined; }}
      uploadFile={uploadFile}
      onUploaded={() => { if (last.current) onUploaded(last.current); }}
    />
  );
}
