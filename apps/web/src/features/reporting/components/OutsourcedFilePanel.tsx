'use client';
// 04-UI-UX §2.3 file card: scan/sanitise states, rejection reasons, and the "I have checked …" confirmation (reporting.outsourced.attach).
// Scan/sanitise states are polled every 5 s for up to 2 minutes, then a manual Refresh (02-CV §2.4).
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { useToast } from '@lims/ui/components/Toast';
import { confirmOutsourcedAction, listOutsourcedFilesAction } from '../server/actions';
import type { InputFile } from '../server/types';
import { Chip, errorText, hasPerm, newKey, whenText } from './format';

const POLL_MS = 5_000;
const POLL_MAX = 24;
const WORKING = ['pending_scan', 'scanning', 'sanitizing'];
const REJECT: Record<string, string> = {
  pdf_encrypted: 'the file is encrypted', pdf_malformed: 'the file is damaged', pdf_too_many_pages: 'it has too many pages', pdf_timeout: 'checking it took too long',
  pdf_active_content: 'it contains active content', pdf_too_large: 'the file is too large',
};
export const fileStateLabel = (s?: string) => (!s ? 'Awaiting file' : s === 'ready' ? 'Awaiting confirmation' : s === 'confirmed' ? 'Confirmed' : s === 'pending_scan' || s === 'scanning' ? 'Checking' : s === 'sanitizing' ? 'Preparing' : s === 'quarantined' ? 'Blocked' : s === 'rejected' ? 'Rejected' : s);
const size = (b?: number) => (b === undefined ? '' : b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function OutsourcedFilePanel({ file, patientDisplayName, permissions }: { file: InputFile; patientDisplayName: string; permissions: readonly string[] }) {
  const router = useRouter();
  const toast = useToast();
  const [cur, setCur] = useState(file);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ticks, setTicks] = useState(0);
  const [error, setError] = useState<string>();
  const key = useRef(newKey());
  useEffect(() => { setCur(file); }, [file]);

  useEffect(() => {
    if (!WORKING.includes(cur.state) || ticks >= POLL_MAX) return;
    const t = setTimeout(async () => {
      const r = await listOutsourcedFilesAction(cur.order_item_id);
      const next = r.ok ? r.data.find((x) => x.id === cur.id) : undefined;
      if (next) setCur(next);
      setTicks((n) => n + 1);
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [cur, ticks]);

  const confirm = async () => {
    if (busy || !checked) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await confirmOutsourcedAction(cur.id, cur.version, key.current);
      if (r.ok) { key.current = newKey(); setCur(r.data); toast.show({ tone: 'success', title: 'File confirmed.' }); router.refresh(); } else setError(errorText(r.code));
    } finally { setBusy(false); }
  };

  const copy =
    cur.state === 'pending_scan' || cur.state === 'scanning' ? 'Checking the file for viruses…'
      : cur.state === 'sanitizing' ? 'Preparing the file…'
        : cur.state === 'ready' ? 'Ready. Open it and confirm it belongs to this patient.'
          : cur.state === 'quarantined' ? 'This file was blocked by the virus scanner and has been isolated.'
            : cur.state === 'rejected' ? `This PDF could not be used (${REJECT[cur.last_error_code ?? ''] ?? 'it could not be read'}).`
              : null;
  const canConfirm = cur.state === 'ready' && hasPerm(permissions, 'reporting.outsourced.attach');
  return (
    <section className="lims-card" aria-label="Outsourced file">
      <p><strong>{cur.original_filename ?? 'Outsourced report'}</strong> <Chip status={cur.state} label={fileStateLabel(cur.state)} /></p>
      <p className="lims-description">{[cur.external_lab_name, size(cur.size_bytes), cur.page_count ? `${cur.page_count} pages` : ''].filter(Boolean).join(' · ')}</p>
      {copy ? <p>{copy}</p> : null}
      {cur.state === 'confirmed' ? <p>{`Confirmed by ${cur.confirmed_by_name ?? 'staff'} at ${cur.confirmed_at ? whenText(cur.confirmed_at) : '—'}`}</p> : null}
      {WORKING.includes(cur.state) && ticks >= POLL_MAX ? <Button size="sm" variant="ghost" onPress={() => setTicks(0)}>Refresh</Button> : null}
      {cur.state === 'ready' || cur.state === 'confirmed' ? <p><a className="lims-link" href={`/reporting/outsourced-files/${cur.id}/pdf`}>Open the PDF</a></p> : null}
      {canConfirm ? (
        <>
          <Checkbox label={`I have checked that this report belongs to ${patientDisplayName}`} isSelected={checked} onChange={setChecked} />
          <Button variant="primary" isDisabled={!checked} isLoading={busy} onPress={() => void confirm()}>Confirm</Button>
        </>
      ) : null}
      {error ? <p role="alert" className="lims-error">{error}</p> : null}
    </section>
  );
}
