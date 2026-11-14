'use client';
// C13.T19 PM-3 Manifest detail (non-draft) (04-UI-UX PM-3; US-04.7/04.9/04.10). Read-only: lines with partner wording (03-APP-FLOW §3), actions Print / Request pickup / Withdraw.
// Withdraw only when submitted, conversion mode on_receipt and nothing registered yet (D-104). Failure codes are never shown: a failed line reads "Lab is checking this sample".
// LD-140 (2026-11-13): @lims/ui components only; no primary button on this page.
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { Chip, Dt, ListScreen, RowLink, type ListColumn, type Tone } from '../common/ui';
import { codesText, sexAge } from '../common/format';
import type { Manifest, ManifestLine } from '../common/types';
import { MANIFEST_STATE } from './ManifestList';
import { withdrawManifestAction } from './actions';

const LINE_STATE: Readonly<Record<string, readonly [Tone, string]>> = {
  draft: ['neutral', 'Draft'], submitted: ['info', 'Waiting for lab'], converting: ['info', 'Registering'], conversion_failed: ['warning', 'Lab is checking this sample'],
  not_received: ['warning', 'Not received'], withdrawn: ['neutral', 'Withdrawn'], discarded: ['neutral', 'Discarded'], converted: ['success', 'Registered'],
};
const WITHDRAW_REASONS = [ // 05-SCHEMA §7 manifest_withdraw_reasons
  { code: 'entered_in_error', display: 'Entered by mistake' }, { code: 'samples_not_sent', display: 'Samples not sent' },
  { code: 'duplicate_manifest', display: 'Duplicate manifest' }, { code: 'other', display: 'Other' },
];
const BTN = 'lims-btn lims-btn-secondary lims-btn-md';

export interface ManifestDetailProps { manifest: Manifest; conversionMode: 'on_receipt' | 'on_submit'; canSubmit: boolean; canPickup: boolean }

// canSubmit = partners.manifest.submit (M9 withdraw); canPickup = partners.pickup.request (K1 createPickupRequest).
export function ManifestDetail({ manifest: m, conversionMode, canSubmit, canPickup: mayPickup }: ManifestDetailProps) {
  const router = useRouter();
  const [ask, setAsk] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const id = encodeURIComponent(m.id);
  const registered = (m.lines_converted ?? 0) > 0 || m.lines.some((l) => l.state === 'converted' || !!l.order);
  const canPickup = mayPickup && (m.state === 'submitted' || m.state === 'partially_received') && !m.pickup_request_id;
  const canWithdraw = canSubmit && m.state === 'submitted' && conversionMode === 'on_receipt' && !registered;

  const withdraw = async (r: { reasonCode?: string; reasonText?: string }) => {
    const res = await withdrawManifestAction(m.id, m.version ?? 0, r.reasonCode ?? '', r.reasonText ?? '', crypto.randomUUID());
    setAsk(false);
    if (res.ok) { setFailed(null); router.refresh(); } else setFailed(res.code === 'common.version_conflict' ? 'This manifest was changed somewhere else. Reload and try again.' : 'Could not withdraw the manifest.');
  };

  const columns: ListColumn<ManifestLine>[] = [
    { id: 'line_no', header: '#', isRowHeader: true, align: 'end', cell: (l) => l.line_no },
    { id: 'ref', header: 'Sample ref', cell: (l) => l.partner_sample_ref ?? '—' },
    { id: 'patient', header: 'Patient', cell: (l) => <>{l.patient.full_name} <small>{sexAge(l.patient)}</small></> },
    { id: 'tests', header: 'Tests', hideBelow: 'md', cell: (l) => codesText(l.orderables.map((o) => o.code)) },
    { id: 'status', header: 'Status', cell: (l) => <Chip table={LINE_STATE} code={l.state} /> },
    { id: 'registration', header: 'Registration no.', cell: (l) => (l.order ? <RowLink href={`/orders/${encodeURIComponent(l.order.order_id)}`}>{l.order.registration_no}</RowLink> : '—') },
    // PM-3 "Updated" (04-UI-UX.md:111): contract ManifestLine has no updated_at, so no value is read -> "—" until .orchestra/cr/C13.T19-line-updated-at.md lands.
    { id: 'updated', header: 'Updated', hideBelow: 'lg', cell: () => '—' },
  ];

  return (
    <>
      <PageHeader
        title={`Manifest ${m.manifest_no}`}
        helpKey="partners.manifest"
        status={<Chip table={MANIFEST_STATE} code={m.state} size="md" />}
        actions={
          <>
            <Link className={BTN} href={`/manifests/${id}/print`}>Print</Link>
            {canPickup ? <Link className={BTN} href={`/pickups/new?manifest_id=${id}`}>Request pickup</Link> : null}
            {canWithdraw ? <Button variant="danger" onPress={() => setAsk(true)}>Withdraw</Button> : null}
          </>
        }
      />
      {failed ? <Banner tone="danger" title={failed} /> : null}
      <Stack gap={4}>
        <DescriptionList
          columns={2}
          items={[
            { term: 'Receiving centre', value: m.receiving_centre?.name ?? '—' },
            { term: 'Submitted', value: <Dt value={m.submitted_at} withTime /> },
            { term: 'Received', value: <Dt value={m.received_at} withTime /> },
            { term: 'Pickup state', value: m.pickup_request_id ? 'Pickup requested' : 'No pickup' },
            { term: 'Notes', value: m.notes ?? '—' },
          ]}
        />
        <section aria-label="Samples">
          <h2>Samples</h2>
          <ListScreen caption="Samples in this manifest" columns={columns} rows={m.lines} getRowId={(l) => l.id} empty={{ title: 'No samples in this manifest.' }} />
        </section>
      </Stack>
      <ConfirmDialog
        title="Withdraw manifest" confirmLabel="Withdraw" tone="danger" isOpen={ask} onCancel={() => setAsk(false)} onConfirm={withdraw}
        body="The lab will not expect these samples. This cannot be undone."
        requireReason={{ codedSet: 'manifest_withdraw_reasons', options: WITHDRAW_REASONS, freeText: { maxLength: 300, isRequired: false } }}
      />
    </>
  );
}
