'use client';
// S4 Stores + S14 Analyser bindings (04-UI-UX §3 S4/S14). LD-140: list + right Drawer; the New store button is the ONE primary on the
// Stores tab, "Bind" the one primary on the Analysers tab; the store drawer has per-section Save (Details | Reorder settings).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Drawer } from '@lims/ui/components/Drawer';
import { Icon } from '@lims/ui/components/Icon';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Tabs } from '@lims/ui/components/Tabs';
import { useToast } from '@lims/ui/components/Toast';
import type { Binding, Branch, Instrument, ItemSummary, Store, StoreItemSetting, SupplierSummary } from '../server/types';
import { label, STORE_KINDS } from './codes';
import { AnalyserBindings } from './AnalyserBindings';
import { ReorderSettings } from './ReorderSettings';
import { StoreForm } from './StoreForm';
import { ActiveChip } from './shared';

export interface StoresViewProps {
  stores: readonly Store[];
  canManage: boolean;
  branches: readonly Branch[];
  bindings: readonly Binding[];
  instruments: readonly Instrument[];
  initialTab: 'stores' | 'analysers';
  selected?: Store;
  settings: readonly StoreItemSetting[];
  items: readonly ItemSummary[];
  suppliers: readonly SupplierSummary[];
}

export function StoresView(p: StoresViewProps) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<string>(p.initialTab);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(!!p.selected); // the page remounts this view (key) when ?store= changes
  const [drawerTab, setDrawerTab] = useState('details');
  const columns: ColumnDef<Store>[] = [
    { id: 'code', header: 'Code', isRowHeader: true, cell: (s) => <a className="lims-link" href={`/inventory/stores?store=${s.id}`}>{s.store_code}</a> },
    { id: 'name', header: 'Name', cell: (s) => s.name },
    { id: 'branch', header: 'Branch', cell: (s) => s.branch_name },
    { id: 'kind', header: 'Kind', cell: (s) => label(STORE_KINDS, s.store_kind) },
    {
      id: 'default', header: 'Default consumption',
      cell: (s) => (s.is_default_consumption ? <Inline gap={1}><Icon name="check" /><StatusChip kind="generic" status="default" tone="info" label="Default" size="sm" /></Inline> : '—'),
    },
    { id: 'active', header: 'Active', cell: (s) => <ActiveChip active={s.is_active} /> },
  ];
  const close = () => {
    setOpen(false);
    setCreating(false);
    if (p.selected) router.replace('/inventory/stores');
  };
  const saved = (msg: string) => {
    close();
    toast.show({ tone: 'success', title: msg });
    router.refresh();
  };

  return (
    <section aria-label="Stores">
      <PageHeader
        title="Stores"
        helpKey="inventory.stores"
        {...(p.canManage && tab === 'stores' ? { actions: <Button variant="primary" onPress={() => setCreating(true)}>New store</Button> } : {})}
      />
      <Tabs items={[{ id: 'stores', label: 'Stores' }, { id: 'analysers', label: 'Analysers' }]} selectedId={tab} onChange={setTab} aria-label="Store sections">
        {tab === 'stores' ? (
          <DataTable
            caption="Stores"
            columns={columns}
            rows={p.stores}
            getRowId={(s) => s.id}
            emptyState={{ title: 'No stores yet.' }}
            onRowAction={(s) => router.push(`/inventory/stores?store=${s.id}`)}
          />
        ) : (
          <AnalyserBindings bindings={p.bindings} instruments={p.instruments} stores={p.stores} canManage={p.canManage} />
        )}
      </Tabs>
      <Drawer title="New store" isOpen={creating} onClose={close}>
        {creating ? <StoreForm branches={p.branches} onDone={() => saved('Store created')} /> : null}
      </Drawer>
      {p.selected ? (
        <Drawer title={`Store ${p.selected.store_code}`} isOpen={open} onClose={close}>
          {open ? (
            <Tabs items={[{ id: 'details', label: 'Details' }, { id: 'reorder', label: 'Reorder settings' }]} selectedId={drawerTab} onChange={setDrawerTab} aria-label="Store details">
              {drawerTab === 'details' ? (
                p.canManage ? <StoreForm store={p.selected} branches={p.branches} onDone={() => saved('Store saved')} /> : <StoreSummary store={p.selected} />
              ) : (
                <ReorderSettings storeId={p.selected.id} items={p.items} settings={p.settings} suppliers={p.suppliers} canManage={p.canManage} />
              )}
            </Tabs>
          ) : null}
        </Drawer>
      ) : null}
    </section>
  );
}

function StoreSummary({ store }: { store: Store }) {
  return (
    <Inline>
      <span>{store.name}</span>
      <ActiveChip active={store.is_active} />
    </Inline>
  );
}
