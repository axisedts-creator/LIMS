'use client';
// C13.T19 PO-1 Samples (04-UI-UX PO-1; US-07.1/07.5/07.6/07.8). Patient search POSTs through the BFF with the term in the body (REQ-SEC-098: never in a URL, never GET).
// Filters (status, manifest, doctor, registered, only-new-reports) are non-PHI and live in the URL so dashboard tiles can link to them.
// LD-140 (2026-11-13): @lims/ui components only; one primary button per page (none here).
import { useState } from 'react';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { Chip, Dt, ListScreen, RowLink, useApplyFilters, type ListColumn, type Tone } from '../common/ui';
import type { PartnerOrder } from '../common/types';

export const TRACKING: Readonly<Record<string, readonly [Tone, string]>> = { // 03-APP-FLOW §3 T1–T7 words + tones (04-UI-UX PO-1)
  registered: ['neutral', 'Registered'], in_transit: ['info', 'On the way to lab'], in_lab: ['info', 'In lab'], action_needed: ['warning', 'New sample needed'],
  partially_reported: ['info', 'Partly reported'], reported: ['success', 'Report ready'], cancelled: ['danger', 'Cancelled by lab'],
};
const STATUS_OPTIONS = Object.entries(TRACKING).map(([value, [, label]]) => ({ value, label }));

export interface OrderListProps {
  rows: PartnerOrder[];
  nextCursor?: string | undefined;
  manifests: { value: string; label: string }[];
  doctors: { value: string; label: string }[];
  initial: { tracking_status?: string; manifest_id?: string; referrer_id?: string; registered_at_from?: string; registered_at_to?: string; has_new_report?: string };
}

export function OrderList({ rows, nextCursor, manifests, doctors, initial }: OrderListProps) {
  const apply = useApplyFilters();
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<PartnerOrder[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [onlyNew, setOnlyNew] = useState(initial.has_new_report === 'true');
  const [filters, setFilters] = useState<FilterValue>({
    ...(initial.tracking_status ? { status: initial.tracking_status.split(',') } : {}),
    ...(initial.manifest_id ? { manifest: initial.manifest_id } : {}),
    ...(initial.referrer_id ? { doctor: initial.referrer_id } : {}),
    ...(initial.registered_at_from && initial.registered_at_to ? { registered: [initial.registered_at_from, initial.registered_at_to] } : {}),
  });

  const push = (v: FilterValue, only = onlyNew) => {
    setFilters(v);
    const reg = Array.isArray(v['registered']) ? (v['registered'] as readonly string[]) : [];
    apply({
      tracking_status: Array.isArray(v['status']) ? (v['status'] as readonly string[]).join(',') : undefined,
      manifest_id: typeof v['manifest'] === 'string' ? v['manifest'] : undefined,
      referrer_id: typeof v['doctor'] === 'string' ? v['doctor'] : undefined,
      registered_at_from: reg[0], registered_at_to: reg[1], has_new_report: only ? 'true' : undefined,
    });
  };

  // O2 searchPartnerOrders through the BFF: the term travels in the POST body only.
  const search = async () => {
    const q = term.trim();
    if (q.length === 0) { setFound(null); setFailed(false); return; } // clearing returns to the list
    if (q.length < 2 || q.length > 64) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch('/api/bff/orders/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q, limit: 50 }) });
      const body = (await res.json().catch(() => undefined)) as { data?: PartnerOrder[] } | undefined;
      if (res.ok && Array.isArray(body?.data)) setFound(body.data);
      else setFailed(true);
    } catch {
      setFailed(true);
    }
    setBusy(false);
  };

  const columns: ListColumn<PartnerOrder>[] = [
    { id: 'registration_no', header: 'Registration no.', isRowHeader: true, cell: (r) => <RowLink href={`/orders/${encodeURIComponent(r.order_id)}`}><span className="lims-mono">{r.registration_no}</span></RowLink> },
    { id: 'patient', header: 'Patient', cell: (r) => r.patient.full_name },
    { id: 'ref', header: 'Your ref', hideBelow: 'md', cell: (r) => r.partner_sample_ref ?? '—' },
    { id: 'status', header: 'Status', cell: (r) => <Chip table={TRACKING} code={r.tracking_status} /> },
    { id: 'doctor', header: 'Doctor', hideBelow: 'lg', cell: (r) => r.referrer?.display_name ?? '—' },
    { id: 'registered_at', header: 'Registered', cell: (r) => <Dt value={r.registered_at} withTime /> },
    { id: 'new_report', header: 'New report', cell: (r) => (r.has_new_report ? <Badge tone="info">New</Badge> : null), card: (r) => (r.has_new_report ? 'New report ready' : null) },
  ];
  const shown = found ?? rows;

  return (
    <>
      <PageHeader title="Samples" helpKey="partners.orders" />
      <Stack gap={4}>
        <Form onSubmit={search} submitShortcut={false}>
          <div className="partner-toolbar">
            <TextField label="Search by patient name, your reference or registration no." name="q" maxLength={64} value={term} onChange={setTerm} />
            <Button type="submit" isLoading={busy}>Search</Button>
          </div>
        </Form>
        {failed ? <Banner tone="danger" title="Could not search. Try again in a moment." /> : null}
        {found ? null : (
          <>
            <FilterBar
              filters={[
                { id: 'status', label: 'Status', kind: 'select', multiple: true, options: STATUS_OPTIONS },
                { id: 'manifest', label: 'Manifest', kind: 'select', options: manifests },
                { id: 'doctor', label: 'Doctor', kind: 'select', options: doctors },
                { id: 'registered', label: 'Registered', kind: 'date_range' },
              ]}
              value={filters}
              onChange={(v) => push(v)}
              onReset={() => { setOnlyNew(false); push({}, false); }}
            />
            <Switch label="Only with new reports" isSelected={onlyNew} onChange={(v) => { setOnlyNew(v); push(filters, v); }} />
          </>
        )}
        <ListScreen
          caption="Samples"
          columns={columns}
          rows={shown}
          getRowId={(r) => r.order_id}
          href={(r) => `/orders/${encodeURIComponent(r.order_id)}`}
          nextCursor={found ? undefined : nextCursor}
          empty={found ? { title: 'No samples match your search.' } : { title: 'No samples yet.', body: 'Samples appear here after the lab registers your manifest.' }}
        />
      </Stack>
    </>
  );
}
