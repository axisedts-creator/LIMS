'use client';
// S6 Purchase orders (04-UI-UX §3 S6). LD-140 (2026-11-13): list + right Drawer; "New PO" is the ONE primary of the list; status = tone + icon + word.
// ?po=<id> opens the Drawer: a draft opens the editor ("Edit purchase order"), any other state the read-only detail with its actions.
// Money columns need inventory.cost.read (the API omits the amounts otherwise); creating and editing need inventory.po.manage.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Drawer } from '@lims/ui/components/Drawer';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import type { CodedValue, Item, Po, PoSummary, Store, SupplierSummary } from '../server/types';
import { PoDetail } from './PoDetail';
import { PoEditor } from './PoEditor';
import { PO_TONE, PoStatusChip } from './PoShared';
import { isoDate, useUrlFilters } from './shared';

const STATUS_OPTIONS = Object.entries(PO_TONE).map(([value, t]) => ({ value, label: t.label }));

export interface PoViewProps {
  pos: readonly PoSummary[];
  stores: readonly Store[];
  suppliers: readonly SupplierSummary[];
  selected?: Po;
  items: readonly Item[];
  taxCodes: readonly CodedValue[];
  perms: readonly string[];
  reasons: { cancel: readonly CodedValue[]; close: readonly CodedValue[] };
}

export function PoView(p: PoViewProps) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const canManage = p.perms.includes('inventory.po.manage');
  const canCost = p.perms.includes('inventory.cost.read');
  const filters = useUrlFilters(['status', 'supplier', 'branch'], [{ id: 'created', from: 'created_from', to: 'created_to' }]);
  const supplierName = (id: string) => p.suppliers.find((s) => s.id === id)?.name ?? id;
  const storeName = (id: string) => p.stores.find((s) => s.id === id)?.name ?? id;
  const close = () => {
    setCreating(false);
    if (p.selected) router.replace('/inventory/purchase-orders');
  };
  const branches = [...new Map(p.stores.map((s) => [s.branch_id, s.branch_name])).entries()].map(([value, label]) => ({ value, label }));

  const defs = [
    { id: 'status', label: 'Status', kind: 'select', options: STATUS_OPTIONS },
    { id: 'supplier', label: 'Supplier', kind: 'select', options: p.suppliers.map((s) => ({ value: s.id, label: s.name })) },
    { id: 'branch', label: 'Branch', kind: 'select', options: branches },
    { id: 'created', label: 'Created', kind: 'date_range' },
  ] as const;

  const columns: ColumnDef<PoSummary>[] = [
    { id: 'no', header: 'PO no.', isRowHeader: true, cell: (r) => <a className="lims-link" href={`/inventory/purchase-orders?po=${r.id}`}>{r.po_no}</a> },
    { id: 'supplier', header: 'Supplier', cell: (r) => supplierName(r.supplier_id) },
    { id: 'store', header: 'Store', cell: (r) => storeName(r.store_id) },
    { id: 'status', header: 'Status', cell: (r) => <PoStatusChip status={r.status} /> },
    ...(canCost ? [{ id: 'total', header: 'Total', align: 'end' as const, cell: (r: PoSummary) => (r.total_paisa === undefined ? '—' : <MoneyText value={{ amountPaisa: r.total_paisa, currency: 'NPR' }} />) }] : []),
    { id: 'created', header: 'Created', cell: (r) => isoDate(r.created_at) },
    { id: 'expected', header: 'Expected', cell: (r) => isoDate(r.expected_on) },
  ];
  const sel = p.selected;
  const editable = !!sel && sel.status === 'draft' && canManage;
  return (
    <section aria-label="Purchase orders">
      <PageHeader title="Purchase orders" helpKey="inventory.purchase_orders" {...(canManage ? { actions: <Button variant="primary" onPress={() => setCreating(true)}>New PO</Button> } : {})} />
      <Stack>
        <FilterBar filters={defs} {...filters} />
        <DataTable caption="Purchase orders" columns={columns} rows={p.pos} getRowId={(r) => r.id} emptyState={{ title: 'No purchase orders' }} onRowAction={(r) => router.push(`/inventory/purchase-orders?po=${r.id}`)} />
      </Stack>
      <Drawer title="New purchase order" isOpen={creating} onClose={close} width="lg">
        {creating ? <PoEditor items={[]} suppliers={p.suppliers} stores={p.stores} taxCodes={p.taxCodes} perms={p.perms} onClose={close} /> : null}
      </Drawer>
      {sel ? (
        <Drawer title={editable ? 'Edit purchase order' : `Purchase order ${sel.po_no}`} isOpen onClose={close} width="lg">
          {editable ? (
            <PoEditor key={sel.id} po={sel} items={p.items} suppliers={p.suppliers} stores={p.stores} taxCodes={p.taxCodes} perms={p.perms} onClose={close} />
          ) : (
            <PoDetail po={sel} items={p.items} suppliers={p.suppliers} stores={p.stores} taxCodes={p.taxCodes} perms={p.perms} reasons={p.reasons} onClose={close} />
          )}
        </Drawer>
      ) : null}
    </section>
  );
}
