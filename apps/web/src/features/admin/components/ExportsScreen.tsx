'use client';
// AD-13 Exports (US-D4): list + [New export] dialog (CSV only, ≤31 days, warning banner D4.2/A-7). [Download] only on the requester's READY
// rows with downloads left, as a link to the BFF route (AC-D4.5). Queued/building rows refresh the list on a bounded timer.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { useToast } from '@lims/ui/components/Toast';
import { createAuditExport } from '../actions';
import { Grid, Time } from '../Grid';
import { Alert, Field, Radios } from '../ui';
import { DAY_MS, MAX_RANGE_DAYS, RANGE_COPY, copyFor, fmt, fmtNum, shortId } from '../lib';

export interface AuditExport { export_id: string; source: string; status: string; requested_by_membership_id: string; range_from: string; range_to: string; row_count?: number; expires_at?: string; downloads_remaining: number; created_at: string }
const SOURCE: Record<string, string> = { audit_log: 'Audit log', access_log: 'Access log', auth_events: 'Sign-in events' };
const STATUS: Record<string, string> = { queued: 'Queued', building: 'Building', ready: 'Ready', failed: 'Failed', expired: 'Expired' };
const POLL_MS = 2000;
const POLL_MAX = 60; // ponytail: ~2 minutes of polling per page view; a notification/SSE channel replaces this if exports get slower

export function ExportsScreen({ exports, me, defaultRange }: { exports: AuditExport[]; me: string | undefined; defaultRange: { from: string; to: string } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const pending = exports.some((e) => e.status === 'queued' || e.status === 'building');
  useEffect(() => {
    if (!pending) return;
    let n = 0;
    const t = setInterval(() => { n += 1; if (n > POLL_MAX) clearInterval(t); else router.refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [pending, router]);
  return (
    <main className="lims-page">
      <header className="lims-page-header">
        <h1>Exports</h1>
        <Button variant="primary" onPress={() => setOpen(true)}>New export</Button>
      </header>
      {exports.length ? (
        <Grid
          label="Exports"
          columns={['Created', 'Requested by', 'Source', 'Range', 'Status', 'Rows', 'Expires', 'Downloads left', 'File']}
          rows={exports.map((e) => ({
            key: e.export_id,
            cells: [
              <Time key="c" iso={e.created_at} label={fmt(e.created_at)} />,
              e.requested_by_membership_id === me ? 'You' : <code title={e.requested_by_membership_id}>{shortId(e.requested_by_membership_id)}</code>,
              SOURCE[e.source] ?? e.source,
              `${fmt(e.range_from)} – ${fmt(e.range_to)}`,
              STATUS[e.status] ?? e.status,
              fmtNum(e.row_count),
              fmt(e.expires_at),
              String(e.downloads_remaining),
              e.requested_by_membership_id === me && e.status === 'ready' && e.downloads_remaining > 0
                ? <a key="d" href={`/admin/exports/${encodeURIComponent(e.export_id)}/file`} className="lims-btn lims-btn-sm">Download</a>
                : '',
            ],
          }))}
        />
      ) : <p>No exports yet.</p>}
      {open ? <NewExport defaultRange={defaultRange} onClose={() => setOpen(false)} onCreated={() => { setOpen(false); router.refresh(); }} /> : null}
    </main>
  );
}

function NewExport({ defaultRange, onClose, onCreated }: { defaultRange: { from: string; to: string }; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [source, setSource] = useState('audit_log');
  const [from, setFrom] = useState(defaultRange.from);
  const [to, setTo] = useState(defaultRange.to);
  const [error, setError] = useState<string>();
  const [fail, setFail] = useState<{ text: string; requestId?: string | undefined } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    const f = Date.parse(from), t = Date.parse(to);
    setFail(null);
    if (Number.isNaN(f) || Number.isNaN(t) || f > t) { setError('Enter a valid start and end (UTC, e.g. 2026-11-01T00:00:00Z)'); return; }
    if (t - f > MAX_RANGE_DAYS * DAY_MS) { setError(RANGE_COPY); return; }
    setError(undefined);
    setBusy(true);
    const r = await createAuditExport({ source, occurred_at_from: new Date(f).toISOString(), occurred_at_to: new Date(t).toISOString() });
    setBusy(false);
    if (!r.ok) {
      setFail({ text: r.code === 'auth.forbidden' ? 'Exports need access to all centres. Ask another administrator.' : copyFor(r.code), requestId: r.requestId });
      return;
    }
    toast.show({ tone: 'success', title: 'Export requested. It appears here when ready.' });
    onCreated();
  };
  return (
    <Dialog title="New export" isOpen onClose={onClose}
      footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" onPress={() => void submit()} isLoading={busy}>Create export</Button></>}>
      <Banner tone="warning" title="Exports are limited, recorded, and every administrator of your lab is notified. Exports do not include changed values." />
      {fail ? <Alert text={fail.text} requestId={fail.requestId} /> : null}
      <Radios legend="Source" name="source" value={source} onChange={setSource} options={Object.entries(SOURCE).map(([value, label]) => ({ value, label }))} />
      <Field label="From (UTC)" value={from} onChange={setFrom} error={error} />
      <Field label="To (UTC)" value={to} onChange={setTo} hint="Up to 31 days." />
      <p>Format: CSV</p>
    </Dialog>
  );
}
