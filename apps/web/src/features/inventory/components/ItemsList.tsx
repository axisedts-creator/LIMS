'use client';
// S2 Items list (04-UI-UX §3 S2). LD-140: list + right Drawer, ONE primary "New item" (only with inventory.master.manage).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Drawer } from '@lims/ui/components/Drawer';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { useToast } from '@lims/ui/components/Toast';
import type { CodedValue, ItemSummary } from '../server/types';
import { CATEGORIES, label } from './codes';
import { ItemForm } from './ItemForm';
import { ActiveChip, isoDate, useUrlFilters, yesNo } from './shared';

const FILTERS = [
  { id: 'q', label: 'Search code or name', kind: 'text', maxLength: 60 },
  { id: 'category', label: 'Category', kind: 'select', options: CATEGORIES },
  { id: 'is_active', label: 'Status', kind: 'select', options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }] },
] as const;

export function ItemsList({ items, nextCursor, hasPrevious, canManage, uom, tax }: { items: readonly ItemSummary[]; nextCursor?: string; hasPrevious: boolean; canManage: boolean; uom: readonly CodedValue[]; tax: readonly CodedValue[] }) {
  const router = useRouter();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const filters = useUrlFilters(['q', 'category', 'is_active']);
  const columns: ColumnDef<ItemSummary>[] = [
    { id: 'code', header: 'Code', isRowHeader: true, cell: (i) => <a className="lims-link" href={`/inventory/items/${i.id}`}>{i.item_code}</a> },
    { id: 'name', header: 'Name', cell: (i) => i.name },
    { id: 'category', header: 'Category', cell: (i) => label(CATEGORIES, i.category) },
    { id: 'uom', header: 'Base unit', cell: (i) => i.base_uom_code },
    { id: 'lot', header: 'Lot-tracked', cell: (i) => yesNo(i.is_lot_tracked) },
    { id: 'active', header: 'Active', cell: (i) => <ActiveChip active={i.is_active} /> },
    { id: 'updated', header: 'Updated', cell: (i) => isoDate(i.updated_at) },
  ];
  const goNext = () => {
    const p = new URLSearchParams(window.location.search);
    if (nextCursor) p.set('cursor', nextCursor);
    router.push(`/inventory/items?${p.toString()}`);
  };
  return (
    <section aria-label="Items">
      <PageHeader
        title="Items"
        helpKey="inventory.items"
        {...(canManage ? { actions: <Button variant="primary" onPress={() => setCreating(true)}>New item</Button> } : {})}
      />
      <FilterBar filters={FILTERS} value={filters.value} onChange={filters.onChange} onReset={filters.onReset} />
      <DataTable
        caption="Items"
        columns={columns}
        rows={items}
        getRowId={(i) => i.id}
        emptyState={{ title: 'No items yet.' }}
        onRowAction={(i) => router.push(`/inventory/items/${i.id}`)}
        page={{ hasNext: !!nextCursor, hasPrevious, onNext: goNext, onPrevious: () => router.back(), limit: 50 }}
      />
      <Drawer title="New item" isOpen={creating} onClose={() => setCreating(false)}>
        {creating ? (
          <ItemForm
            uom={uom}
            tax={tax}
            onDone={() => {
              setCreating(false);
              toast.show({ tone: 'success', title: 'Item created' });
              router.refresh();
            }}
          />
        ) : null}
      </Drawer>
    </section>
  );
}
