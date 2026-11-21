'use client';
// T0D-CONTENT-1 Profile Images (done_when 5): the list of set and cleared images, a search by profile type and name (the search belongs to
// the module that owns the profiles and is injected), then set the image (upload, then setProfileImage) or clear it (clearProfileImage,
// which deactivates the row; history is kept).
import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { t } from '@/core/i18n/messages';
import { clearProfileImageAction, setProfileImageAction } from '../../server/content-actions';
import { ImageField, Thumb } from './ImageField';
import type { ProfileHit, ProfileImage, ProfileKind } from './content-model';

export type SearchProfiles = (kind: ProfileKind, q: string) => Promise<ProfileHit[]>;
const KINDS: readonly ProfileKind[] = ['doctor', 'centre', 'staff'];
const kindLabel = (k: ProfileKind) => t(`engagement.content.profile.${k}`);
const keyOf = (k: ProfileKind, id: string) => `${k}:${id}`;

export function ProfileImages({ images: initial, canManage, canUpload, searchProfiles }: { images: readonly ProfileImage[]; canManage: boolean; canUpload: boolean; searchProfiles: SearchProfiles }) {
  const router = useRouter();
  const searchId = useId();
  const [images, setImages] = useState<readonly ProfileImage[]>(initial);
  useEffect(() => setImages(initial), [initial]);
  const [kind, setKind] = useState<ProfileKind>('doctor');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ProfileHit[]>([]);
  const [picked, setPicked] = useState<{ kind: ProfileKind; hit: ProfileHit }>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const n = ++seq.current;
    if (!q.trim()) { setHits([]); return; }
    searchProfiles(kind, q.trim()).then((r) => { if (n === seq.current) setHits(Array.isArray(r) ? r : []); }, () => { if (n === seq.current) setHits([]); });
  }, [kind, q, searchProfiles]);

  const current = picked ? images.find((i) => i.profile_kind === picked.kind && i.profile_id === picked.hit.id) : undefined;
  const upsert = (p: ProfileImage) => setImages((l) => [p, ...l.filter((i) => keyOf(i.profile_kind, i.profile_id) !== keyOf(p.profile_kind, p.profile_id))]);

  const set = async (assetId: string) => {
    if (!picked) return;
    setBusy(true);
    const r = await setProfileImageAction(picked.kind, picked.hit.id, assetId);
    setBusy(false);
    if (r.ok) { upsert({ ...r.data, profile_kind: picked.kind, profile_id: picked.hit.id, image_attachment_id: r.data.image_attachment_id ?? assetId, is_active: true, profile_name: picked.hit.name }); setFailure(undefined); router.refresh(); }
    else setFailure(t('engagement.content.profile.set_failed'));
  };
  const clear = async () => {
    if (!picked || !current) return;
    setBusy(true);
    const r = await clearProfileImageAction(picked.kind, picked.hit.id);
    setBusy(false);
    if (r.ok) { upsert({ ...current, is_active: false }); setFailure(undefined); router.refresh(); }
    else setFailure(t('engagement.content.profile.clear_failed'));
  };

  return (
    <div className="lims-stack">
      <div className="lims-inline lims-align-end">
        <RadioGroup<ProfileKind>
          label={t('engagement.content.profile.kind')}
          name="profile_kind"
          orientation="horizontal"
          value={kind}
          onChange={(k) => { setKind(k); setPicked(undefined); }}
          options={KINDS.map((k) => ({ value: k, label: kindLabel(k) }))}
        />
        <div className="lims-field">
          <label className="lims-label" htmlFor={searchId}>{t('engagement.content.profile.search')}</label>
          <input id={searchId} type="search" className="lims-input" maxLength={64} autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {q.trim() ? (
        hits.length ? (
          <ul className="lims-inline lims-plain-list" aria-label={t('engagement.content.profile.results')}>
            {hits.map((h) => (
              <li key={h.id}>
                <button type="button" className="lims-btn lims-btn-secondary lims-btn-sm" aria-pressed={picked?.hit.id === h.id} onClick={() => { setPicked({ kind, hit: h }); setFailure(undefined); }}>{h.name}</button>
              </li>
            ))}
          </ul>
        ) : <p className="lims-description">{t('engagement.content.profile.no_results')}</p>
      ) : null}
      {picked ? (
        <section className="lims-stack lims-form-narrow" aria-label={picked.hit.name}>
          <p className="lims-label">{kindLabel(picked.kind)}: {picked.hit.name}</p>
          {current?.is_active ? <Thumb assetId={current.image_attachment_id} alt={picked.hit.name} /> : <p className="lims-description">{t('engagement.content.profile.none')}</p>}
          {canManage ? (
            <>
              <ImageField name="profile_image" canUpload={canUpload} onUploaded={(id) => void set(id)} />
              {current?.is_active ? <div className="lims-inline"><Button variant="secondary" isLoading={busy} onPress={() => void clear()}>{t('engagement.content.profile.clear')}</Button></div> : null}
            </>
          ) : null}
          {failure ? <p role="alert" className="lims-error">{failure}</p> : null}
        </section>
      ) : null}
      <DataTable
        caption={t('engagement.content.tab.profile')}
        density="compact"
        cellTitle
        rows={images}
        getRowId={(i) => keyOf(i.profile_kind, i.profile_id)}
        emptyState={{ title: t('engagement.content.profile.empty'), body: t('engagement.content.profile.empty_hint') }}
        columns={[
          { id: 'kind', header: t('engagement.content.profile.kind'), cell: (i) => kindLabel(i.profile_kind) },
          { id: 'name', header: t('engagement.content.profile.name'), isRowHeader: true, cell: (i) => i.profile_name ?? i.profile_id },
          { id: 'image', header: t('engagement.content.profile.image'), cell: (i) => (i.is_active ? <Thumb assetId={i.image_attachment_id} alt={i.profile_name ?? kindLabel(i.profile_kind)} /> : t('engagement.content.profile.cleared')) },
          { id: 'updated', header: t('engagement.content.profile.updated'), cell: (i) => (i.updated_at ? <DateText value={i.updated_at as DateTextProps['value']} withTime /> : '—') },
        ]}
      />
    </div>
  );
}
