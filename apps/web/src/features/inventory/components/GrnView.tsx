'use client';
// S7 Goods receipts (04-UI-UX §3 S7). LD-140 (2026-11-13): list + right Drawer; "New receipt" is the ONE primary of the list; status = tone + icon + word.
// ?po=<id> opens "New receipt" prefilled from that PO's open lines, ?grn=<id> opens "Goods receipt <grn_no>": a draft is edited, a posted receipt is read-only (AC-06.5).
// Receiving needs inventory.stock.manage; opening balance inventory.stock.adjust; money columns inventory.cost.read.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Drawer } from '@lims/ui/components/Drawer';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import type { CodedValue, Grn, GrnLine, GrnSummary, Item, Po, Store, SupplierSummary } from '../server/types';
import { GrnEditor } from './GrnEditor';
import { GrnStatusChip, KIND_LABEL, rs, taxText } from './PoShared';
import { isoDate, useUrlFilters } from './shared';

export interface GrnViewProps {
  grns: readonly GrnSummary[];
  stores: readonly Store[];
  suppliers: readonly SupplierSummary[];
  selected?: Grn;
  prefillPo?: Po;
  items: readonly Item[];
  taxCodes: readonly CodedValue[];
  perms: readonly string[];
}

export function GrnView(p: GrnViewProps) {
  const router = useRouter();
  const canManage = p.perms.includes('inventory.stock.manage');
  const canCost = p.perms.includes('inventory.cost.read');
  const [creating, setCreating] = useState(canManage && !!p.prefillPo);
  const [posted, setPosted] = useState<Grn>();
  const stale = useRef(false);
  const filters = useUrlFilters(['status', 'store', 'supplier']);
  const supplierName = (id: string | undefined) => (id ? (p.suppliers.find((s) => s.id === id)?.name ?? id) : '—');
  const storeName = (id: string) => p.stores.find((s) => s.id === id)?.name ?? id;
  const close = () => {
    setCreating(false);
    setPosted(undefined);
    if (stale.current) {
      stale.current = false;
      router.refresh();
    }
    if (p.selected || p.prefillPo) router.replace('/inventory/receipts');
  };
  const defs = [
    { id: 'status', label: 'Status', kind: 'select', options: [{ value: 'draft', label: 'Draft' }, { value: 'posted', label: 'Posted' }, { value: 'cancelled', label: 'Cancelled' }] },
    { id: 'store', label: 'Store', kind: 'select', options: p.stores.map((s) => ({ value: s.id, label: s.name })) },
    { id: 'supplier', label: 'Supplier', kind: 'select', options: p.suppliers.map((s) => ({ value: s.id, label: s.name })) },
  ] as const;

  const columns: ColumnDef<GrnSummary>[] = [
    { id: 'no', header: 'GRN no.', isRowHeader: true, cell: (r) => <a className="lims-link" href={`/inventory/receipts?grn=${r.id}`}>{r.grn_no}</a> },
    { id: 'kind', header: 'Kind', cell: (r) => KIND_LABEL[r.kind] ?? r.kind },
    { id: 'store', header: 'Store', cell: (r) => storeName(r.store_id) },
    { id: 'supplier', header: 'Supplier', cell: (r) => supplierName(r.supplier_id) },
    { id: 'status', header: 'Status', cell: (r) => <GrnStatusChip status={r.status} /> },
    { id: 'received', header: 'Received at', cell: (r) => isoDate(r.received_at) },
    ...(canCost ? [{ id: 'total', header: 'Total', align: 'end' as const, cell: (r: GrnSummary) => (r.total_paisa === undefined ? '—' : <MoneyText value={{ amountPaisa: r.total_paisa, currency: 'NPR' }} />) }] : []),
  ];
  const sel = posted ?? p.selected;
  const editable = !!sel && sel.status === 'draft' && canManage;
  return (
    <section aria-label="Goods receipts">
      <PageHeader title="Receipts" helpKey="inventory.receipts" {...(canManage ? { actions: <Button variant="primary" onPress={() => setCreating(true)}>New receipt</Button> } : {})} />
      <Stack>
        <FilterBar filters={defs} {...filters} />
        <DataTable caption="Goods receipts" columns={columns} rows={p.grns} getRowId={(r) => r.id} emptyState={{ title: 'No receipts' }} onRowAction={(r) => router.push(`/inventory/receipts?grn=${r.id}`)} />
      </Stack>
      <Drawer title="New receipt" isOpen={creating && !posted} onClose={close} width="lg">
        {creating && !posted ? <GrnEditor {...(p.prefillPo ? { prefillPo: p.prefillPo } : {})} items={p.items} suppliers={p.suppliers} stores={p.stores} taxCodes={p.taxCodes} perms={p.perms} onPosted={setPosted} onChanged={() => { stale.current = true; }} /> : null}
      </Drawer>
      {sel ? (
        <Drawer title={`Goods receipt ${sel.grn_no}`} isOpen onClose={close} width="lg">
          {editable ? (
            <GrnEditor key={sel.id} grn={sel} items={p.items} suppliers={p.suppliers} stores={p.stores} taxCodes={p.taxCodes} perms={p.perms} onPosted={setPosted} onChanged={() => { stale.current = true; }} />
          ) : (
            <GrnDetail grn={sel} items={p.items} suppliers={p.suppliers} stores={p.stores} taxCodes={p.taxCodes} canCost={canCost} />
          )}
        </Drawer>
      ) : null}
    </section>
  );
}

/** Read-only receipt: posted and cancelled receipts are immutable (AC-06.5); lot and expiry are plain text. */
function GrnDetail({ grn, items, suppliers, stores, taxCodes, canCost }: { grn: Grn; items: readonly Item[]; suppliers: readonly SupplierSummary[]; stores: readonly Store[]; taxCodes: readonly CodedValue[]; canCost: boolean }) {
  const itemOf = (id: string) => items.find((i) => i.id === id);
  const columns: ColumnDef<GrnLine>[] = [
    { id: 'item', header: 'Item', isRowHeader: true, cell: (l) => { const i = itemOf(l.item_id); return i ? `${i.item_code} · ${i.name}` : l.item_id; } },
    { id: 'pack', header: 'Pack', cell: (l) => itemOf(l.item_id)?.packs.find((x) => x.id === l.pack_id)?.label ?? l.pack_id },
    { id: 'qty', header: 'Qty packs', align: 'end', cell: (l) => l.qty_packs },
    { id: 'lot', header: 'Lot no.', cell: (l) => l.lot_no ?? '—' },
    { id: 'expiry', header: 'Expiry', cell: (l) => isoDate(l.expiry_on) },
    ...(canCost
      ? [
          { id: 'price', header: 'Unit price', align: 'end' as const, cell: (l: GrnLine) => (l.unit_price_paisa === undefined ? '—' : <MoneyText value={{ amountPaisa: l.unit_price_paisa, currency: 'NPR' }} />) },
          { id: 'tax', header: 'Tax', cell: (l: GrnLine) => taxText(l.is_exempt ? undefined : l.tax_code, l.tax_rate_bp, taxCodes) },
          { id: 'total', header: 'Line total', align: 'end' as const, cell: (l: GrnLine) => (l.line_total_paisa === undefined ? '—' : <MoneyText value={{ amountPaisa: l.line_total_paisa, currency: 'NPR' }} />) },
        ]
      : []),
  ];
  const supplier = suppliers.find((s) => s.id === grn.supplier_id);
  const mismatch = canCost && grn.supplier_invoice_total_paisa !== undefined && grn.invoice_total_mismatch_paisa ? grn.invoice_total_mismatch_paisa : undefined;
  return (
    <Stack>
      <GrnStatusChip status={grn.status} />
      {mismatch !== undefined && grn.supplier_invoice_total_paisa !== undefined ? (
        <Banner tone="warning" title={`Invoice total ${rs(grn.supplier_invoice_total_paisa)} differs from the calculated total ${rs(grn.total_paisa ?? 0)} by ${rs(Math.abs(mismatch))}.`} />
      ) : null}
      <DescriptionList
        columns={2}
        items={[
          { term: 'Kind', value: KIND_LABEL[grn.kind] ?? grn.kind },
          { term: 'Store', value: stores.find((s) => s.id === grn.store_id)?.name ?? grn.store_id },
          ...(grn.kind === 'purchase' ? [{ term: 'Supplier', value: supplier ? `${supplier.supplier_code} — ${supplier.name}` : '—' }] : []),
          { term: 'Received at', value: isoDate(grn.received_at) },
          ...(grn.supplier_invoice_no ? [{ term: 'Supplier invoice no.', value: grn.supplier_invoice_no }] : []),
          ...(canCost && grn.total_paisa !== undefined ? [{ term: 'Total', value: <MoneyText value={{ amountPaisa: grn.total_paisa, currency: 'NPR' }} /> }] : []),
          ...(grn.notes ? [{ term: 'Notes', value: grn.notes }] : []),
        ]}
      />
      <DataTable caption="Receipt lines" columns={columns} rows={grn.lines} getRowId={(l) => l.id} density="compact" emptyState={{ title: 'No lines.' }} />
    </Stack>
  );
}
