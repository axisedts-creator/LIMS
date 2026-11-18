'use client';
// 04-UI-UX §8.8 Audit trail: time (B.S./A.D.), user, action, document, details summary. Export needs billing.data.export (the page's own permission).
// T0D-UILIST-2 (LD-353 template 1, rule 6): one FilterBar (date range in the URL, the page already reads it), cut off cells carry title,
// a failed read keeps the title and the filters with the ErrorState in the table body.
import { useRouter } from 'next/navigation';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import type { ActivityRow } from '../server/types';
import { ExportButtons } from './ExportButtons';
import { BsAd, hasPerm, humanize } from './format';
import type { ListFailure } from './listRead';
import { useUrlFilters } from './useUrlFilters';

export const AUDIT_COLUMNS = ['Time', 'User', 'Action', 'Document', 'Details'] as const;

export function AuditTrail({ rows, permissions, failure }: { rows: readonly ActivityRow[]; permissions: readonly string[]; failure?: ListFailure }) {
  const router = useRouter();
  const f = useUrlFilters(['date_range']);
  const columns: ColumnDef<ActivityRow>[] = [
    { id: 'time', header: 'Time', cell: (r) => <BsAd utc={r.occurred_at} withTime /> },
    { id: 'user', header: 'User', isRowHeader: true, cell: (r) => r.actor.display_name },
    { id: 'action', header: 'Action', cell: (r) => r.action },
    { id: 'document', header: 'Document', cell: (r) => `${humanize(r.entity_type)} ${r.entity_id.slice(0, 8)}` },
    { id: 'details', header: 'Details', cell: (r) => r.summary ?? '—' },
  ];
  return (
    <section aria-label="Audit trail">
      <PageHeader title="Audit trail" helpKey="billing.audit_trail" actions={hasPerm(permissions, 'billing.data.export') ? <ExportButtons kind="audit_trail" formats={['xlsx']} /> : null} />
      <FilterBar filters={[{ id: 'date_range', label: 'Date range', kind: 'date_range' }]} value={f.value} onChange={f.onChange} onReset={f.onReset} />
      <DataTable caption="Audit trail" columns={columns} rows={rows} getRowId={(r) => `${r.occurred_at}-${r.entity_id}-${r.action}`} cellTitle emptyState={{ title: 'No activity for the selected filters.' }}
        {...(failure ? { error: { title: 'The audit trail could not be loaded', ...failure, onRetry: () => router.refresh() } } : {})} />
    </section>
  );
}
