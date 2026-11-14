'use client';
// 04-UI-UX §4.6 Batches list: PageHeader ([New batch], the page's one primary button, only with anatomic.case.work) → Status / Assay filters → DataTable
// (Batch no, Assay, Status, Kit lot, Run at, Members / capacity). The filters live in the URL (server component re-reads); an unknown value never reaches the API (the page validates).
// Empty list: an EmptyState, not an empty table. Server text is rendered as text, never HTML (REQ-SEC-088).
// LD-140 (2026-11-13, binding): kit components and token class names only; every status shows tone, icon and word.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable } from '@lims/ui/components/DataTable';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import type { Assay, Batch, BatchStatus } from '../../server/types';
import { When } from '../common';
import { BatchStatusChip, MfaDialog } from './batch-shared';
import { NewBatchDialog } from './NewBatchDialog';

const ALL = 'all';
const STATUS_OPTIONS = [{ value: ALL, label: 'All' }, { value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }];

export interface BatchesScreenProps {
  batches: readonly Batch[];
  assays: readonly Assay[];
  canWork: boolean;
  status?: BatchStatus;
  assayCode?: string;
  /** Opaque cursor of the next page (absent on the last page). */
  nextCursor?: string;
  /** This page was reached with a cursor (so there is a page before it). */
  hasCursor: boolean;
}

export function BatchesScreen({ batches, assays, canWork, status, assayCode, nextCursor, hasCursor }: BatchesScreenProps) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [mfa, setMfa] = useState(false);

  const go = (q: { status?: string | undefined; assay_code?: string | undefined; cursor?: string | undefined }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
    const s = p.toString();
    router.push(s ? `/anatomic/batches?${s}` : '/anatomic/batches');
  };
  const pick = (v: string) => (v === ALL ? undefined : v);

  const assayOptions = [{ value: ALL, label: 'All assays' }, ...assays.filter((a) => a.is_active || a.code === assayCode).map((a) => ({ value: a.code, label: a.display }))];
  if (assayCode && !assayOptions.some((o) => o.value === assayCode)) assayOptions.push({ value: assayCode, label: assayCode });
  const filtered = status !== undefined || assayCode !== undefined;

  return (
    <>
      <PageHeader
        title="Molecular batches"
        helpKey="anatomic.batches"
        breadcrumbs={[{ label: 'Pathology cases', href: '/anatomic' }, { label: 'Molecular batches' }]}
        actions={canWork ? <Button variant="primary" iconStart="plus" onPress={() => setCreating(true)}>New batch</Button> : null}
      />
      <Inline align="end">
        <Select label="Status" name="status_filter" options={STATUS_OPTIONS} value={status ?? ALL} onChange={(v) => go({ status: pick(v), assay_code: assayCode })} />
        <Select label="Assay" name="assay_filter" options={assayOptions} value={assayCode ?? ALL} onChange={(v) => go({ status, assay_code: pick(v) })} />
      </Inline>
      {batches.length === 0 ? (
        <EmptyState title={filtered ? 'No batches match these filters.' : 'No batches yet'} body={filtered ? 'Change or clear the filters.' : canWork ? 'Create a batch to group molecular samples for one run.' : 'Batches appear here when the lab creates them.'} />
      ) : (
        <DataTable
          caption="Molecular batches"
          density="compact"
          rows={batches}
          getRowId={(b) => b.id}
          emptyState={{ title: 'No batches' }}
          onRowAction={(b) => router.push(`/anatomic/batches/${b.id}`)}
          {...(nextCursor !== undefined || hasCursor ? { page: { hasNext: nextCursor !== undefined, hasPrevious: hasCursor, onNext: () => go({ status, assay_code: assayCode, cursor: nextCursor }), onPrevious: () => router.back(), limit: 50 } } : {})}
          columns={[
            { id: 'no', header: 'Batch no', isRowHeader: true, cell: (b) => <a className="lims-link lims-mono" href={`/anatomic/batches/${b.id}`}>{b.batch_no}</a> },
            { id: 'assay', header: 'Assay', cell: (b) => <span className="lims-mono">{b.assay_code}</span> },
            { id: 'status', header: 'Status', cell: (b) => <BatchStatusChip status={b.status} /> },
            { id: 'lot', header: 'Kit lot', hideBelow: 'md', cell: (b) => b.kit_lot ?? '—' },
            { id: 'run', header: 'Run at', hideBelow: 'md', cell: (b) => <When value={b.run_at} time /> },
            { id: 'members', header: 'Members / capacity', align: 'end', cell: (b) => `${b.member_count} / ${b.capacity}` },
          ]}
        />
      )}
      {creating && canWork ? <NewBatchDialog assays={assays} onClose={() => setCreating(false)} onMfa={() => { setCreating(false); setMfa(true); }} /> : null}
      <MfaDialog isOpen={mfa} onClose={() => setMfa(false)} />
    </>
  );
}
