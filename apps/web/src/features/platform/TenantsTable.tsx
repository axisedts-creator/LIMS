'use client';
// PL-2 tenants table: 50 per page, [Load more] follows next_cursor (cursor paging only, CV §4.3).
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { loadTenantsAction } from './actions';
import { tenantStatusLabel, type PageOf, type Tenant } from './shared';
import { Alert, fmtDateTime, useSingleFlight } from './ui';

const TONE = { active: 'success', suspended: 'warning', provisioning: 'info', offboarded: 'neutral' } as const;

const COLUMNS: readonly ColumnDef<Tenant>[] = [
  { id: 'code', header: 'Code', isRowHeader: true, cell: (t) => <a href={`/platform/tenants/${t.tenant_id}`}>{t.code}</a> },
  { id: 'display_name', header: 'Display name', cell: (t) => t.display_name },
  { id: 'status', header: 'Status', cell: (t) => <StatusChip kind="generic" status={t.status} tone={TONE[t.status] ?? 'neutral'} label={tenantStatusLabel(t.status)} /> },
  // the listTenants row carries no counts / annex readiness (see .orchestra/cr/C2.T26.md); shown on the detail page
  { id: 'users', header: 'Users', cell: () => '—', align: 'end' },
  { id: 'centres', header: 'Centres', cell: () => '—', align: 'end' },
  { id: 'ird', header: 'IRD readiness', cell: () => '—' },
  { id: 'created_at', header: 'Created', cell: (t) => fmtDateTime(t.created_at) },
];

export function TenantsTable({ initial }: { initial: PageOf<Tenant> }) {
  const [rows, setRows] = useState(initial.data);
  const [cursor, setCursor] = useState(initial.page?.next_cursor);
  const [error, setError] = useState<string>();
  const { run, pending } = useSingleFlight();
  const more = () => run(async () => {
    if (!cursor) return;
    const r = await loadTenantsAction(cursor);
    if (!r.ok) { setError(`Could not load more tenants.${r.requestId ? ` Reference: ${r.requestId}` : ''}`); return; }
    setError(undefined);
    setRows((prev) => [...prev, ...r.data.data]);
    setCursor(r.data.page?.next_cursor);
  });
  return (
    <>
      <DataTable caption="Tenants" columns={COLUMNS} rows={rows} getRowId={(t) => t.tenant_id} emptyState={{ title: 'No tenants yet' }} />
      <Alert>{error}</Alert>
      {cursor ? <Button onPress={more} isLoading={pending}>Load more</Button> : null}
    </>
  );
}
