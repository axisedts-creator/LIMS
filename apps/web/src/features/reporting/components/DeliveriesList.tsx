'use client';
// 04-UI-UX §2.5 Delivery log: masked destinations only (never message text, links, OTPs or full numbers); Resend on failed rows (reporting.delivery.resend).
import { useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { useToast } from '@lims/ui/components/Toast';
import { retryDeliveryAction } from '../server/actions';
import type { Delivery } from '../server/types';
import { Chip, When, errorText, hasPerm, humanize, newKey } from './format';
import { SimpleTable, type Col } from './SimpleTable';
import { useUrlFilters } from './useUrlFilters';

export const CHANNEL: Record<string, string> = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', print: 'Print', portal: 'Portal' };
const STATUS_FILTER = [['queued', 'Queued'], ['sent', 'Sent'], ['delivered', 'Delivered'], ['read', 'Read'], ['failed', 'Failed (all tries used)'], ['suppressed', 'Not sent (suppressed)']] as const;
const CHANNEL_FILTER = [['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email'], ['print', 'Printed copy'], ['portal', 'Portal link']] as const;
const PURPOSE_FILTER = [['report_ready', 'Report ready'], ['critical_alert', 'Critical alert'], ['dues_link', 'Dues link'], ['link_reissue', 'Link re-issue']] as const;

export function DeliveriesList({ deliveries, permissions, nextCursor }: { deliveries: readonly Delivery[]; permissions: readonly string[]; nextCursor?: string | undefined }) {
  const router = useRouter();
  const toast = useToast();
  const f = useUrlFilters(['status', 'channel', 'purpose', 'range']);
  const canResend = hasPerm(permissions, 'reporting.delivery.resend');
  const busy = useRef(new Set<string>());

  const resend = async (id: string) => {
    if (busy.current.has(id)) return;
    busy.current.add(id);
    try {
      const r = await retryDeliveryAction(id, newKey());
      if (r.ok) { toast.show({ tone: 'success', title: 'Queued to send again.' }); router.refresh(); } else toast.show({ tone: 'danger', title: 'Could not resend', description: errorText(r.code) });
    } finally { busy.current.delete(id); }
  };

  const columns: Col<Delivery>[] = [
    { id: 'created', header: 'Created', cell: (d) => (d.queued_at ? <When value={d.queued_at} /> : '—') },
    { id: 'channel', header: 'Channel', cell: (d) => CHANNEL[d.channel] ?? humanize(d.channel) },
    { id: 'purpose', header: 'Purpose', cell: (d) => humanize(d.purpose) },
    { id: 'recipient', header: 'Recipient', cell: (d) => humanize(d.recipient_kind) },
    { id: 'to', header: 'To', cell: (d) => d.destination_masked ?? '—' },
    { id: 'status', header: 'Status', cell: (d) => <Chip status={d.status} /> },
    { id: 'attempts', header: 'Attempts', cell: (d) => String(d.attempt_no) },
    { id: 'report', header: 'Report', cell: (d) => (d.report_id ? <a className="lims-link" href={`/reporting/reports/${d.report_id}`}>{d.report_version_no ? `Report v${d.report_version_no}` : 'Open report'}</a> : '—') },
    { id: 'act', header: 'Actions', cell: (d) => (
      <>
        <a className="lims-link" href={`/reporting/deliveries/${d.id}`}>Details</a>
        {canResend && d.status === 'failed' ? <> <Button size="sm" onPress={() => void resend(d.id)}>Resend</Button></> : null}
      </>
    ) },
  ];
  return (
    <section aria-label="Delivery log">
      <PageHeader title="Delivery log" helpKey="reporting.deliveries" />
      <FilterBar
        filters={[
          { id: 'status', label: 'Status', kind: 'select', options: STATUS_FILTER.map(([value, label]) => ({ value, label })) },
          { id: 'channel', label: 'Channel', kind: 'select', options: CHANNEL_FILTER.map(([value, label]) => ({ value, label })) },
          { id: 'purpose', label: 'Purpose', kind: 'select', options: PURPOSE_FILTER.map(([value, label]) => ({ value, label })) },
          { id: 'range', label: 'Date range', kind: 'date_range' },
        ]}
        value={f.value} onChange={f.onChange} onReset={f.onReset}
      />
      <SimpleTable caption="Deliveries" columns={columns} rows={deliveries} getRowId={(d) => d.id} empty={{ title: 'No deliveries match these filters.' }} />
      {nextCursor ? <p><a className="lims-link" href={`/reporting/deliveries?cursor=${encodeURIComponent(nextCursor)}`}>Next page</a></p> : null}
    </section>
  );
}
