'use client';
// S5 Suppliers (04-UI-UX §3 S5). LD-140: list + right Drawer; ONE primary "New supplier" (inventory.master.manage only);
// the supplier drawer has tabs Details | Items, each with its own Save.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Drawer } from '@lims/ui/components/Drawer';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import { useToast } from '@lims/ui/components/Toast';
import type { CodedValue, Supplier, SupplierItem, SupplierSummary } from '../server/types';
import { SupplierForm } from './SupplierForm';
import { SupplierItems, type ItemInfo } from './SupplierItems';
import { ActiveChip } from './shared';

const dash = (v: string | number | undefined) => (v === undefined || v === '' ? '—' : String(v));

export interface SuppliersViewProps {
  suppliers: readonly SupplierSummary[];
  canManage: boolean;
  canCost: boolean;
  tax: readonly CodedValue[];
  selected?: Supplier;
  supplierItems: readonly SupplierItem[];
  itemInfo: Readonly<Record<string, ItemInfo>>;
}

export function SuppliersView(p: SuppliersViewProps) {
  const router = useRouter();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(!!p.selected); // the page remounts this view (key) when ?supplier= changes
  const [tab, setTab] = useState('details');
  const columns: ColumnDef<SupplierSummary>[] = [
    { id: 'code', header: 'Code', isRowHeader: true, cell: (s) => <a className="lims-link" href={`/inventory/suppliers?supplier=${s.id}`}>{s.supplier_code}</a> },
    { id: 'name', header: 'Name', cell: (s) => s.name },
    { id: 'pan', header: 'PAN', cell: (s) => dash(s.pan_text) },
    { id: 'phone', header: 'Phone', cell: (s) => dash(s.phone_display) },
    { id: 'active', header: 'Active', cell: (s) => <ActiveChip active={s.is_active} /> },
  ];
  const close = () => {
    setOpen(false);
    setCreating(false);
    if (p.selected) router.replace('/inventory/suppliers');
  };
  const saved = (msg: string) => {
    close();
    toast.show({ tone: 'success', title: msg });
    router.refresh();
  };
  const s = p.selected;
  return (
    <section aria-label="Suppliers">
      <PageHeader title="Suppliers" helpKey="inventory.suppliers" {...(p.canManage ? { actions: <Button variant="primary" onPress={() => setCreating(true)}>New supplier</Button> } : {})} />
      <DataTable
        caption="Suppliers"
        columns={columns}
        rows={p.suppliers}
        getRowId={(x) => x.id}
        emptyState={{ title: 'No suppliers yet.' }}
        onRowAction={(x) => router.push(`/inventory/suppliers?supplier=${x.id}`)}
      />
      <Drawer title="New supplier" isOpen={creating} onClose={close}>
        {creating ? <SupplierForm onDone={() => saved('Supplier created')} /> : null}
      </Drawer>
      {s ? (
        <Drawer title={`Supplier ${s.supplier_code}`} isOpen={open} onClose={close} width="lg">
          {open ? (
            <Tabs items={[{ id: 'details', label: 'Details' }, { id: 'items', label: 'Items' }]} selectedId={tab} onChange={setTab} aria-label="Supplier sections">
              {tab === 'details' ? (
                p.canManage ? (
                  <SupplierForm supplier={s} onDone={() => saved('Supplier saved')} />
                ) : (
                  <DescriptionList
                    items={[
                      { term: 'Code', value: s.supplier_code },
                      { term: 'Name', value: s.name },
                      { term: 'PAN / VAT no.', value: dash(s.pan_text) },
                      { term: 'Contact name', value: dash(s.contact_name) },
                      { term: 'Phone', value: dash(s.phone_display) },
                      { term: 'Email', value: dash(s.email) },
                      { term: 'Address', value: dash(s.address_text) },
                      { term: 'Payment terms (days)', value: dash(s.payment_terms_days) },
                      { term: 'Notes', value: dash(s.notes) },
                    ]}
                  />
                )
              ) : (
                <SupplierItems supplierId={s.id} rows={p.supplierItems} info={p.itemInfo} canManage={p.canManage} canCost={p.canCost} tax={p.tax} />
              )}
            </Tabs>
          ) : null}
        </Drawer>
      ) : null}
    </section>
  );
}
