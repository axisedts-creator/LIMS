'use client';
// 04-UI-UX §2.5 Delivery detail: attempt timeline and a plain-language reason. Never the message text, link, OTP or the full number.
import { useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Timeline } from '@lims/ui/components/Timeline';
import { useToast } from '@lims/ui/components/Toast';
import { retryDeliveryAction } from '../server/actions';
import type { Delivery } from '../server/types';
import { CHANNEL } from './DeliveriesList';
import { Chip, FAILURE_TEXT, errorText, hasPerm, humanize, newKey } from './format';

export function DeliveryDetail({ delivery, permissions }: { delivery: Delivery; permissions: readonly string[] }) {
  const router = useRouter();
  const toast = useToast();
  const inFlight = useRef(false);
  const canResend = hasPerm(permissions, 'reporting.delivery.resend') && delivery.status === 'failed';
  const resend = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const r = await retryDeliveryAction(delivery.id, newKey());
      if (r.ok) { toast.show({ tone: 'success', title: 'Queued to send again.' }); router.refresh(); } else toast.show({ tone: 'danger', title: 'Could not resend', description: errorText(r.code) });
    } finally { inFlight.current = false; }
  };
  return (
    <section aria-label="Delivery">
      <PageHeader
        title="Delivery" helpKey="reporting.delivery" status={<Chip status={delivery.status} />}
        actions={canResend ? <Button onPress={() => void resend()}>Resend</Button> : null}
      />
      <p><a className="lims-link" href="/reporting/deliveries">Back to delivery log</a></p>
      {/* T0D-UIGUARD-1-REPORTING (LD-436 Card title rows, LD-439 a): kit Cards; attempts are a kit Timeline with the outcome chip in `extra`. */}
      <Card title="Delivery">
        {/* T0D-UIX-4 (LD-442): label and value pairs are the kit DescriptionList */}
        <DescriptionList items={[
          { term: 'Channel', value: CHANNEL[delivery.channel] ?? humanize(delivery.channel) },
          { term: 'Purpose', value: humanize(delivery.purpose) },
          { term: 'Recipient', value: humanize(delivery.recipient_kind) },
          { term: 'To', value: delivery.destination_masked ?? '—' },
          ...(delivery.report_id ? [{ term: 'Report', value: <a className="lims-link" href={`/reporting/reports/${delivery.report_id}`}>Open report</a> }] : []),
        ]} />
        {delivery.failure_code ? <p>{FAILURE_TEXT[delivery.failure_code] ?? delivery.failure_code}</p> : null}
      </Card>
      <Card title="Attempts">
        {(delivery.attempts ?? []).length === 0 ? <p>No attempts recorded yet.</p> : (
          <Timeline aria-label="Delivery attempts" labelFirst items={delivery.attempts!.map((a) => ({ at: a.started_at, label: `Attempt ${a.attempt_no}`, extra: <>· <Chip status={a.outcome} /></> }))} />
        )}
      </Card>
    </section>
  );
}
