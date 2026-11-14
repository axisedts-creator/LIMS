'use client';
// /lab/ingest-exceptions (04-UI-UX §3.10, route staff.lab.ingest_exceptions, CR-C7-014): read-only queue of instrument results that could not be applied (AC-14.3).
// No raw value and nothing patient-linked in the URL (REQ-SEC-028): filters carry status / reason only. Actions live on the detail screen.
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { EXCEPTION_REASONS, EXCEPTION_STATUSES, type IngestException } from '../server/types';
import { NativeSelect } from './NativeSelect';
import { REASON_TEXT } from './exceptionText';

export interface IngestExceptionListProps { items: readonly IngestException[]; permissions?: readonly string[]; status?: string; nextCursor?: string }

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

export function IngestExceptionList({ items, status = 'open', nextCursor }: IngestExceptionListProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (key: 'reason' | 'status', value: string) => {
    const q = new URLSearchParams(params.toString());
    q.delete('cursor');   // a new filter starts at the first page
    if (value) q.set(key, value); else q.delete(key);
    router.push(q.size ? `${pathname}?${q}` : pathname);
  };
  const more = (() => { const q = new URLSearchParams(params.toString()); if (nextCursor) q.set('cursor', nextCursor); return `${pathname}?${q}`; })();
  return (
    <section aria-label="Instrument exceptions">
      <PageHeader title="Instrument exceptions" helpKey="lab.ingest_exceptions" />
      <NativeSelect label="Reason" name="reason" value={params.get('reason') ?? ''} onChange={(v) => go('reason', v)} placeholder="All reasons"
        options={EXCEPTION_REASONS.map((r) => ({ value: r, label: REASON_TEXT[r] ?? r }))} />
      <NativeSelect label="Status" name="status" value={params.get('status') ?? status} onChange={(v) => go('status', v)} placeholder={null}
        options={EXCEPTION_STATUSES.map((s) => ({ value: s, label: s }))} />
      {items.length === 0 ? (
        <EmptyState title={`No ${status} instrument exceptions.`} />
      ) : (
        <table>
          <caption className="lims-visually-hidden">Instrument exceptions</caption>
          <thead>
            <tr>
              <th scope="col">Barcode</th>
              <th scope="col">Reason</th>
              <th scope="col">Instrument code</th>
              <th scope="col">Instrument</th>
              <th scope="col">Status</th>
              <th scope="col">Received</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id}>
                <td><Link href={`/lab/ingest-exceptions/${encodeURIComponent(e.id)}`}>{e.sample_barcode ?? 'No barcode'}</Link></td>
                <td>{REASON_TEXT[e.reason] ?? e.reason}</td>
                <td>{e.instrument_analyte_code ?? ''}</td>
                <td>{e.instrument_id ?? ''}</td>
                <td>{e.status}</td>
                <td>{when(e.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {nextCursor ? <p><Link href={more}>Next page</Link></p> : null}
    </section>
  );
}
