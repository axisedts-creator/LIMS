'use client';
// 04-UI-UX §8.6 Credit parties list: code, name, limit, used (outstanding), credit days, lock state (text, never colour-only).
// T0D-UILIST-2 (LD-353 template 1, rules 3, 5, 6): one FilterBar (filters the loaded rows, display only), money right aligned with NPR in the header,
// a failed read keeps the title and the filters with the ErrorState in the table body.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { FilterBar, type FilterValue } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import type { CreditParty } from '../server/types';
import { amount, formatAmount, humanize } from './format';
import type { ListFailure } from './listRead';

export const CREDIT_PARTY_COLUMNS = ['Code', 'Name', 'Limit (NPR)', 'Used (NPR)', 'Credit days', 'Lock'] as const;

export function CreditPartiesList({ parties, failure }: { parties: readonly CreditParty[]; permissions: readonly string[]; failure?: ListFailure }) {
  const router = useRouter();
  const [f, setF] = useState<FilterValue>({});
  const q = typeof f['q'] === 'string' ? f['q'].toLowerCase() : '';
  const rows = q ? parties.filter((p) => `${p.code} ${p.name}`.toLowerCase().includes(q)) : parties;
  const columns: ColumnDef<CreditParty>[] = [
    { id: 'code', header: 'Code', isRowHeader: true, cell: (p) => p.code },
    { id: 'name', header: 'Name', cell: (p) => <a className="lims-link" href={`/billing/credit-parties/${p.id}`}>{p.name}</a> },
    { id: 'limit', header: 'Limit (NPR)', numeric: true, cell: (p) => formatAmount(p.credit_limit_paisa) },
    { id: 'used', header: 'Used (NPR)', numeric: true, cell: (p) => amount(p.outstanding) },
    { id: 'days', header: 'Credit days', numeric: true, cell: (p) => String(p.credit_days) },
    { id: 'lock', header: 'Lock', cell: (p) => (p.is_locked ? `Locked${p.lock_reason_code ? ` — ${humanize(p.lock_reason_code)}` : ''}` : 'Open') },
  ];
  return (
    <section aria-label="Credit parties">
      <PageHeader title="Credit parties" helpKey="billing.credit_parties" />
      <FilterBar
        filters={[{ id: 'q', label: 'Code or name', kind: 'text', maxLength: 64 }]}
        value={f}
        onChange={setF}
        onReset={() => setF({})}
      />
      <DataTable caption="Credit parties" columns={columns} rows={rows} getRowId={(p) => p.id} cellTitle emptyState={{ title: 'No credit parties yet.' }}
        {...(failure ? { error: { title: 'Credit parties could not be loaded', ...failure, onRetry: () => router.refresh() } } : {})} />
    </section>
  );
}
