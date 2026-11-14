'use client';
// 04-UI-UX §8.8 Audit trail: time (B.S./A.D.), user, action, document, details summary. Export needs billing.data.export (the page's own permission).
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import type { ActivityRow } from '../server/types';
import { ExportButtons } from './ExportButtons';
import { BsAd, hasPerm, humanize } from './format';

export function AuditTrail({ rows, permissions }: { rows: readonly ActivityRow[]; permissions: readonly string[] }) {
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
      <DataTable caption="Audit trail" columns={columns} rows={rows} getRowId={(r) => `${r.occurred_at}-${r.entity_id}-${r.action}`} emptyState={{ title: 'No activity for the selected filters.' }} />
    </section>
  );
}
