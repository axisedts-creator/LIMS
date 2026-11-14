'use client';
// S3 Item detail (04-UI-UX §3 S3). LD-140: ONE primary button (Edit); status shows tone + icon + word; Edit opens the right Drawer.
// Stock / Movements / Rules / Suppliers tabs are filled by T-23/T-24; they show an honest placeholder until then.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Drawer } from '@lims/ui/components/Drawer';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { Tabs } from '@lims/ui/components/Tabs';
import { useToast } from '@lims/ui/components/Toast';
import { setItemActiveAction } from '../server/actions';
import type { CodedValue, Item } from '../server/types';
import { CATEGORIES, label, STORAGE } from './codes';
import { ItemBarcodes } from './ItemBarcodes';
import { ItemForm } from './ItemForm';
import { ItemPacks } from './ItemPacks';
import { ActiveChip, isoDate, ProblemBanner, yesNo, type Failure } from './shared';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'packs', label: 'Packs' },
  { id: 'barcodes', label: 'Barcodes' },
  { id: 'stock', label: 'Stock' },
  { id: 'movements', label: 'Movements' },
  { id: 'rules', label: 'Rules' },
  { id: 'suppliers', label: 'Suppliers' },
];
const dash = (v: string | number | undefined) => (v === undefined || v === '' ? '—' : String(v));

export function ItemDetail({ item, canManage, uom, tax }: { item: Item; canManage: boolean; uom: readonly CodedValue[]; tax: readonly CodedValue[] }) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [problem, setProblem] = useState<Failure>();

  const setActive = async (active: boolean) => {
    const r = await setItemActiveAction(item.id, item.version, active);
    setConfirm(false);
    if (!r.ok) return setProblem(r);
    setProblem(undefined);
    toast.show({ tone: 'success', title: active ? 'Item activated' : 'Item deactivated' });
    router.refresh();
  };

  const overview = (
    <DescriptionList
      columns={2}
      items={[
        { term: 'Code', value: item.item_code },
        { term: 'Name', value: item.name },
        { term: 'Category', value: label(CATEGORIES, item.category) },
        { term: 'Base unit', value: item.base_uom_code },
        { term: 'Manufacturer', value: dash(item.manufacturer) },
        { term: 'Catalogue no.', value: dash(item.catalogue_no) },
        { term: 'Storage condition', value: item.storage_condition ? label(STORAGE, item.storage_condition) : '—' },
        { term: 'Open stability (days)', value: dash(item.open_stability_days) },
        { term: 'Container size', value: dash(item.container_qty_base) },
        { term: 'HS code', value: dash(item.hs_code) },
        { term: 'Default tax code', value: dash(item.default_tax_code) },
        { term: 'Track lots', value: yesNo(item.is_lot_tracked) },
        { term: 'Expiry required', value: yesNo(item.requires_expiry) },
        { term: 'Notes', value: dash(item.notes) },
        { term: 'Updated', value: isoDate(item.updated_at) },
      ]}
    />
  );
  const later = <EmptyState title="Not available yet" body="This tab arrives with the stock and purchasing screens." />;
  const content =
    tab === 'overview' ? overview : tab === 'packs' ? <ItemPacks item={item} canManage={canManage} uom={uom} /> : tab === 'barcodes' ? <ItemBarcodes item={item} canManage={canManage} /> : later;

  return (
    <section aria-label="Item">
      <PageHeader
        title={item.name}
        helpKey="inventory.item"
        breadcrumbs={[{ label: 'Items', href: '/inventory/items' }, { label: item.item_code }]}
        status={<ActiveChip active={item.is_active} />}
        actions={
          canManage ? (
            <Inline>
              {item.is_active ? <Button onPress={() => setConfirm(true)}>Deactivate</Button> : <Button onPress={() => void setActive(true)}>Activate</Button>}
              <Button variant="primary" onPress={() => setEditing(true)}>Edit</Button>
            </Inline>
          ) : null
        }
      />
      <Stack>
        <ProblemBanner problem={problem} />
        <Tabs items={TABS} selectedId={tab} onChange={setTab} aria-label="Item sections">
          {content}
        </Tabs>
      </Stack>
      <Drawer title={`Edit ${item.item_code}`} isOpen={editing} onClose={() => setEditing(false)}>
        {editing ? (
          <ItemForm
            item={item}
            uom={uom}
            tax={tax}
            onDone={() => {
              setEditing(false);
              toast.show({ tone: 'success', title: 'Item saved' });
              router.refresh();
            }}
          />
        ) : null}
      </Drawer>
      <ConfirmDialog
        title="Deactivate item?"
        body="The item stays in history. It cannot be deactivated while it has stock or open purchase orders."
        confirmLabel="Deactivate"
        tone="danger"
        isOpen={confirm}
        onCancel={() => setConfirm(false)}
        onConfirm={() => setActive(false)}
      />
    </section>
  );
}
