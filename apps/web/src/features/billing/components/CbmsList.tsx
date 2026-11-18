'use client';
// 04-UI-UX §8.9 CBMS: stub-mode banner; table kind/no/date/state/attempts/last outcome; Retry on failed_permanent with billing.settings.manage.
// Copy rule (US-BL-16): never wording that implies approval by the tax authority.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { useToast } from '@lims/ui/components/Toast';
import { retryCbmsAction } from '../server/actions';
import type { CbmsDocumentRow } from '../server/types';
import { Ad, StubBanner, cbmsLabel, errorText, hasPerm, humanize } from './format';
import type { ListFailure } from './listRead';

export const CBMS_COLUMNS = ['Kind', 'Document no', 'Last attempt', 'State', 'Attempts', 'Last outcome'] as const;
const STATES = ['pending', 'sent', 'failed_retry', 'failed_permanent', 'not_required'] as const;

export function CbmsList({ documents, mode, permissions, failure }: { documents: readonly CbmsDocumentRow[]; mode: 'stub' | 'live'; permissions: readonly string[]; failure?: ListFailure }) {
  const router = useRouter();
  // T0D-UILIST-2 (LD-353 template 1): one FilterBar over the loaded rows (display only, no new query parameter)
  const [f, setF] = useState<FilterValue>({});
  const kind = typeof f['kind'] === 'string' ? f['kind'] : undefined;
  const state = typeof f['state'] === 'string' ? f['state'] : undefined;
  const rows = documents.filter((d) => (!kind || d.document_kind === kind) && (!state || d.cbms_state === state));
  const toast = useToast();
  const canRetry = hasPerm(permissions, 'billing.settings.manage');
  const busy = useRef(new Set<string>());
  const retry = async (d: CbmsDocumentRow) => {
    if (busy.current.has(d.document_id)) return;
    busy.current.add(d.document_id);
    try {
      const r = await retryCbmsAction(d.document_kind, d.document_id, crypto.randomUUID());
      if (r.ok) { toast.show({ tone: 'success', title: 'Retry queued.' }); router.refresh(); } else toast.show({ tone: 'danger', title: 'Could not retry', description: errorText(r.code) });
    } finally {
      busy.current.delete(d.document_id);
    }
  };
  const columns: ColumnDef<CbmsDocumentRow>[] = [
    { id: 'kind', header: 'Kind', cell: (d) => humanize(d.document_kind) },
    { id: 'no', header: 'Document no', isRowHeader: true, cell: (d) => d.document_no },
    { id: 'date', header: 'Last attempt', cell: (d) => (d.last_attempt_at ? <Ad value={d.last_attempt_at} withTime /> : '—') },
    { id: 'state', header: 'State', cell: (d) => cbmsLabel(d.cbms_state, mode) },
    { id: 'attempts', header: 'Attempts', numeric: true, cell: (d) => String(d.attempts) },
    { id: 'outcome', header: 'Last outcome', cell: (d) => d.last_outcome ?? '—' },
    ...(canRetry ? [{ id: 'actions', header: 'Actions', cell: (d: CbmsDocumentRow) => (d.cbms_state === 'failed_permanent' ? <Button size="sm" onPress={() => void retry(d)}>Retry</Button> : null) }] : []),
  ];
  return (
    <section aria-label="CBMS">
      <PageHeader title="CBMS" helpKey="billing.cbms" />
      {mode === 'stub' ? <StubBanner /> : null}
      <FilterBar
        filters={[
          { id: 'kind', label: 'Kind', kind: 'select', options: [...new Set(documents.map((d) => d.document_kind))].map((k) => ({ value: k, label: humanize(k) })) },
          { id: 'state', label: 'State', kind: 'select', options: STATES.map((s) => ({ value: s, label: cbmsLabel(s, mode) })) },
        ]}
        value={f}
        onChange={setF}
        onReset={() => setF({})}
      />
      <DataTable caption="CBMS documents" columns={columns} rows={rows} getRowId={(d) => `${d.document_kind}-${d.document_id}`} cellTitle emptyState={{ title: 'No documents to show.' }}
        {...(failure ? { error: { title: 'CBMS documents could not be loaded', ...failure, onRetry: () => router.refresh() } } : {})} />
    </section>
  );
}
