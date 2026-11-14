'use client';
// 04-UI-UX §8.6 Credit parties list: code, name, limit, used (outstanding), credit days, lock state (text, never colour-only).
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { PageHeader } from '@lims/ui/components/PageHeader';
import type { CreditParty } from '../server/types';
import { formatNpr, humanize, npr } from './format';

export function CreditPartiesList({ parties }: { parties: readonly CreditParty[]; permissions: readonly string[] }) {
  const columns: ColumnDef<CreditParty>[] = [
    { id: 'code', header: 'Code', isRowHeader: true, cell: (p) => p.code },
    { id: 'name', header: 'Name', cell: (p) => <a className="lims-link" href={`/billing/credit-parties/${p.id}`}>{p.name}</a> },
    { id: 'limit', header: 'Limit', align: 'end', cell: (p) => formatNpr(p.credit_limit_paisa) },
    { id: 'used', header: 'Used', align: 'end', cell: (p) => npr(p.outstanding) },
    { id: 'days', header: 'Credit days', align: 'end', cell: (p) => String(p.credit_days) },
    { id: 'lock', header: 'Lock', cell: (p) => (p.is_locked ? `Locked${p.lock_reason_code ? ` — ${humanize(p.lock_reason_code)}` : ''}` : 'Open') },
  ];
  return (
    <section aria-label="Credit parties">
      <PageHeader title="Credit parties" helpKey="billing.credit_parties" />
      <DataTable caption="Credit parties" columns={columns} rows={parties} getRowId={(p) => p.id} emptyState={{ title: 'No credit parties yet.' }} />
    </section>
  );
}
