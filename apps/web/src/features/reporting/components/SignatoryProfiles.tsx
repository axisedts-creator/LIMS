'use client';
// T0D-PRINTCFG-1 done_when (2) (LD-316): Signatories list on the reporting settings. One row per staff user holding lab.result.approve; the row editor
// sets the printed name, title, registration number, active flag and the signature image. The image is shrunk in the browser to fit 600 x 200 pixels
// (never enlarged, aspect kept), must be PNG or JPEG and at most 300 KB after shrinking, and goes through the existing branding upload route.
// Images are shown through the existing branding image proxy (/engagement/content/assets/<id>); no new route.
import { useEffect, useRef, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { listSignatoriesAction, uploadSignatureAction, upsertSignatoryAction } from '../server/actions';
import { plainError, type SignatoryRow } from '../server/types';
import { errorText, hasPerm, newKey } from './format';
import { SimpleTable, type Col } from './SimpleTable';
import './print-stationery.css';

const MAX_W = 600;
const MAX_H = 200;
const MAX_BYTES = 300 * 1024;
const TYPES = ['image/png', 'image/jpeg'];
const imageSrc = (assetId: string) => `/engagement/content/assets/${encodeURIComponent(assetId)}`;
const nameOf = (r: SignatoryRow) => r.profile?.display_name ?? r.user_name;

/** Fits w x h into 600 x 200 keeping the ratio; never enlarges. */
export const fitSize = (w: number, h: number) => {
  const s = Math.min(1, MAX_W / w, MAX_H / h);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
};

async function shrink(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const { w, h } = fitSize(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  if (file.type === 'image/jpeg') { ctx.fillStyle = 'white'; ctx.fillRect(0, 0, w, h); }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('no image'))), file.type, 0.9));
}

export function SignatoryProfiles({ permissions }: { permissions: readonly string[] }) {
  const canManage = hasPerm(permissions, 'reporting.settings.manage');
  const [rows, setRows] = useState<SignatoryRow[]>([]);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<SignatoryRow | null>(null);
  const load = async () => {
    setError(undefined);
    const r = await listSignatoriesAction().catch(() => null);
    if (r?.ok) setRows(r.data);
    else setError(r ? errorText(r.code) : 'The signers could not be read');
  };
  useEffect(() => { void load(); }, []);

  const cols: Col<SignatoryRow>[] = [
    { id: 'name', header: 'Name', rowHeader: true, cell: nameOf },
    { id: 'title', header: 'Title', cell: (r) => r.profile?.title || '—' },
    { id: 'reg', header: 'Registration number', cell: (r) => r.profile?.registration_no || '—' },
    { id: 'sig', header: 'Signature', cell: (r) => (r.profile?.signature_asset_id ? <img src={imageSrc(r.profile.signature_asset_id)} alt={`Signature of ${nameOf(r)}`} className="pcfg-sig-thumb" /> : 'No signature') },
    { id: 'active', header: 'Active', cell: (r) => (r.profile?.is_active ? 'Yes' : 'No') },
    ...(canManage ? [{ id: 'edit', header: 'Actions', cell: (r: SignatoryRow) => <button type="button" className="lims-btn lims-btn-secondary lims-btn-sm" aria-label={`Edit ${nameOf(r)}`} onClick={() => setEditing(r)}>Edit</button> }] : []), // native button: the kit Button takes no aria-label
  ];
  return (
    <section aria-label="Signatories" className="lims-card">
      <h2>Signatories</h2>
      <p className="lims-description">Only pathologist sign-offs print as signatures. Technologist sign-offs never print as a signature.</p>
      {error ? <div role="alert"><Banner tone="danger" title="Could not load the signers">{error} <Button onPress={() => void load()}>Retry</Button></Banner></div> : null}
      <SimpleTable caption="Signatories" columns={cols} rows={rows} getRowId={(r) => r.user_id} empty={{ title: 'No signers yet.', body: 'Staff whose role can approve results are listed here.' }} />
      {editing ? <SignerDialog row={editing} onClose={() => setEditing(null)} onSaved={(p) => { setRows((all) => all.map((r) => (r.user_id === p.user_id ? { ...r, profile: p } : r))); setEditing(null); }} /> : null}
    </section>
  );
}

function SignerDialog({ row, onClose, onSaved }: { row: SignatoryRow; onClose: () => void; onSaved: (p: NonNullable<SignatoryRow['profile']>) => void }) {
  const toast = useToast();
  const [name, setName] = useState(nameOf(row));
  const [title, setTitle] = useState(row.profile?.title ?? '');
  const [reg, setReg] = useState(row.profile?.registration_no ?? '');
  const [active, setActive] = useState(row.profile?.is_active ?? true);
  const [asset, setAsset] = useState<string | undefined>(row.profile?.signature_asset_id);
  const [pickError, setPickError] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef<Promise<void> | null>(null);

  const pick = (file: File | undefined) => {
    setPickError(undefined);
    setError(undefined);
    if (!file) return;
    if (!TYPES.includes(file.type)) { setPickError('Choose a PNG or JPEG picture.'); return; }
    pending.current = (async () => {
      let blob: Blob;
      try { blob = await shrink(file); } catch { setPickError('This picture could not be read. Choose another one.'); return; }
      if (blob.size > MAX_BYTES) { setPickError('The picture is larger than 300 KB after shrinking. Choose a smaller or simpler picture.'); return; }
      const form = new FormData();
      form.append('file', new File([blob], file.type === 'image/png' ? 'signature.png' : 'signature.jpg', { type: file.type }));
      const r = await uploadSignatureAction(form, newKey()).catch(() => null);
      if (r?.ok) setAsset(r.data.asset_id);
      else setPickError(`Could not upload the picture: ${r ? errorText(r.code) : 'the server did not answer'}.`);
    })();
  };

  const fieldError = name.trim() === '' ? 'Enter a name.' : plainError(name) ?? plainError(title) ?? plainError(reg);
  const save = async () => {
    if (busy) return;
    await pending.current;
    if (fieldError) { setError(fieldError); return; }
    if (pickError) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await upsertSignatoryAction(row.user_id, { display_name: name, ...(title ? { title } : {}), ...(reg ? { registration_no: reg } : {}), ...(asset ? { signature_asset_id: asset } : {}), is_active: active });
      if (r.ok) { toast.show({ tone: 'success', title: 'Signer saved.' }); onSaved(r.data); } else setError(`Could not save the signer: ${errorText(r.code)}.`);
    } finally { setBusy(false); }
  };
  const message = error ?? pickError;
  return (
    <Dialog
      title={`Signer: ${nameOf(row)}`} isOpen onClose={onClose} size="md"
      footer={<><Button variant="ghost" onPress={onClose} isDisabled={busy}>Cancel</Button><Button variant="primary" isLoading={busy} onPress={() => void save()}>Save</Button></>}
    >
      <TextField label="Name" name="display_name" maxLength={120} value={name} onChange={(v) => { setName(v); setError(undefined); }} />
      <TextField label="Title" name="title" maxLength={120} value={title} onChange={(v) => { setTitle(v); setError(undefined); }} />
      <TextField label="Registration number" name="registration_no" maxLength={60} value={reg} onChange={(v) => { setReg(v); setError(undefined); }} />
      <Switch label="Active" isSelected={active} onChange={setActive} />
      <div className="lims-field">
        <label className="lims-label" htmlFor={`sig-${row.user_id}`}>Signature image</label>
        <input id={`sig-${row.user_id}`} type="file" accept="image/png,image/jpeg" onChange={(e) => pick(e.currentTarget.files?.[0])} />
        <p className="lims-description">The picture is shrunk to fit {MAX_W} x {MAX_H} pixels before it is sent.</p>
      </div>
      {asset ? (
        <div>
          <img src={imageSrc(asset)} alt={`Signature of ${nameOf(row)}`} className="pcfg-sig-image" />
          <Button variant="ghost" onPress={() => { setAsset(undefined); setPickError(undefined); }}>Remove signature</Button>
        </div>
      ) : null}
      {message ? <p role="alert" className="lims-error">{message}</p> : null}
    </Dialog>
  );
}
