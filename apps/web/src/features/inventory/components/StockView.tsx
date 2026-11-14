'use client';
// S8 Stock & issue (04-UI-UX §3 S8). LD-140 (2026-11-13): list + right Drawer; no primary on the list (the Issue drawer owns its one primary);
// expiry and lot status are words with a tone + icon, never colour alone. Row actions need inventory.stock.manage.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Drawer } from '@lims/ui/components/Drawer';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { Inline } from '@lims/ui/components/Inline';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { useScanCapture } from '@lims/ui/components/BarcodeInput';
import { listMovementsAction, lookupBarcodeAction } from '../server/actions';
import type { BalanceRow, Department, Instrument, Store, StockMovement, TransferSummary } from '../server/types';
import { BARCODE_VALUE, CATEGORIES } from './codes';
import { ExpiryText, IssueDrawer } from './IssueDrawer';
import { Chip, isoDate, LOT_STATUS_LABEL, useUrlFilters } from './shared';

const FILTER_KEYS = ['store', 'category', 'q', 'below_reorder', 'expiring_within_days', 'show_zero'] as const;
const YES = [{ value: 'true', label: 'Yes' }] as const;
const LOT_TONE = { available: 'success', quarantined: 'warning', blocked: 'danger' } as const;

export interface StockViewProps {
  stores: readonly Store[];
  storeId: string | undefined;
  rows: readonly BalanceRow[];
  transfers: readonly TransferSummary[];
  canManage: boolean;
  departments: readonly Department[];
  instruments: readonly Instrument[];
}

export function StockView(p: StockViewProps) {
  const router = useRouter();
  const [issuing, setIssuing] = useState<BalanceRow>();
  const [moving, setMoving] = useState<BalanceRow>();
  const filters = useUrlFilters(FILTER_KEYS);
  // Scan-first (04-UI-UX §2.4): a scanned item barcode opens its Issue drawer. The value goes in the POST body only, never a URL or a log.
  useScanCapture({
    enabled: p.canManage && !issuing && !moving,
    pattern: BARCODE_VALUE,
    onScan: (v) => {
      void lookupBarcodeAction(v).then((r) => {
        const row = r.ok ? p.rows.find((b) => b.item_id === r.data.id) : undefined;
        if (row) setIssuing(row);
      });
    },
  });
  const storeName = (id: string) => p.stores.find((s) => s.id === id)?.name ?? id;
  const inTransit = p.transfers.filter((t) => t.status === 'dispatched' && (t.from_store_id === p.storeId || t.to_store_id === p.storeId));

  const defs = [
    { id: 'store', label: 'Store', kind: 'select', options: p.stores.map((s) => ({ value: s.id, label: `${s.store_code} — ${s.name}` })) },
    { id: 'category', label: 'Category', kind: 'select', options: CATEGORIES },
    { id: 'q', label: 'Item', kind: 'text', maxLength: 60 },
    { id: 'below_reorder', label: 'Below reorder', kind: 'select', options: YES },
    { id: 'expiring_within_days', label: 'Expiring within days', kind: 'select', options: [{ value: '7', label: '7' }, { value: '30', label: '30' }, { value: '90', label: '90' }] },
    { id: 'show_zero', label: 'Show zero', kind: 'select', options: YES },
  ] as const;

  const columns: ColumnDef<BalanceRow>[] = [
    { id: 'code', header: 'Item code', isRowHeader: true, cell: (b) => b.item_code },
    { id: 'item', header: 'Item', cell: (b) => b.item_name },
    { id: 'lot', header: 'Lot', cell: (b) => b.lot_no ?? '—' },
    { id: 'expiry', header: 'Expiry', cell: (b) => <ExpiryText expiryOn={b.expiry_on} /> },
    { id: 'status', header: 'Lot status', cell: (b) => (b.lot_status ? <Chip tone={LOT_TONE[b.lot_status] ?? 'neutral'} label={LOT_STATUS_LABEL[b.lot_status] ?? b.lot_status} /> : '—') },
    { id: 'qty', header: 'Qty', align: 'end', cell: (b) => b.qty_base },
    { id: 'avail', header: 'Available', align: 'end', cell: (b) => b.available_qty_base },
    { id: 'open', header: 'Open container', cell: (b) => (b.has_open_container ? <Chip tone="info" label="Open" /> : '—') },
    { id: 'reorder', header: 'Reorder level', align: 'end', cell: (b) => b.reorder_level_base ?? '—' },
    ...(p.canManage
      ? [
          {
            id: 'actions',
            header: 'Actions',
            cell: (b: BalanceRow) => (
              <Inline gap={1}>
                <Button size="sm" onPress={() => setIssuing(b)}>Issue</Button>
                <Button size="sm" onPress={() => router.push('/inventory/transfers')}>Transfer</Button>
                <Button size="sm" onPress={() => router.push(`/inventory/wastage?store=${b.store_id}`)}>Wastage</Button>
                <Button size="sm" variant="ghost" onPress={() => setMoving(b)}>Movements</Button>
              </Inline>
            ),
          },
        ]
      : []),
  ];

  return (
    <section aria-label="Stock">
      <PageHeader title="Stock" helpKey="inventory.stock" />
      <Stack>
        <FilterBar
          filters={defs}
          value={{ ...filters.value, store: filters.value['store'] ?? p.storeId }}
          onChange={filters.onChange}
          onReset={filters.onReset}
        />
        <Card title="In transit">
          {inTransit.length ? (
            <ul>
              {inTransit.map((t) => (
                <li key={t.id}>{`${t.transfer_no}: ${storeName(t.from_store_id)} to ${storeName(t.to_store_id)}, dispatched ${isoDate(t.dispatched_at)}`}</li>
              ))}
            </ul>
          ) : (
            <p>No transfers on the way.</p>
          )}
        </Card>
        <DataTable caption="Stock balances" columns={columns} rows={p.rows} getRowId={(b) => `${b.item_id}:${b.lot_id ?? ''}`} emptyState={{ title: 'No stock for these filters.' }} />
      </Stack>
      {p.storeId ? <IssueDrawer storeId={p.storeId} row={issuing} departments={p.departments} instruments={p.instruments} onClose={() => setIssuing(undefined)} /> : null}
      <Drawer title="Movements" isOpen={!!moving} onClose={() => setMoving(undefined)}>
        {moving ? <Movements row={moving} /> : null}
      </Drawer>
    </section>
  );
}

function Movements({ row }: { row: BalanceRow }) {
  const [rows, setRows] = useState<StockMovement[]>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void listMovementsAction(row.store_id, row.item_id).then((r) => {
      if (!live) return;
      setFailed(!r.ok);
      if (r.ok) setRows(r.data);
    });
    return () => {
      live = false;
    };
  }, [row.store_id, row.item_id]);
  const columns: ColumnDef<StockMovement>[] = [
    { id: 'when', header: 'When', isRowHeader: true, cell: (m) => m.occurred_at.slice(0, 16).replace('T', ' ') },
    { id: 'kind', header: 'Kind', cell: (m) => m.movement_kind.replace(/_/g, ' ') },
    { id: 'lot', header: 'Lot', cell: (m) => m.lot_no ?? '—' },
    { id: 'qty', header: 'Qty', align: 'end', cell: (m) => m.qty_base },
    { id: 'after', header: 'Balance after', align: 'end', cell: (m) => m.balance_qty_after ?? '—' },
  ];
  return (
    <Stack>
      <p>{`${row.item_code} · ${row.item_name}`}</p>
      {failed ? <p>Movements could not be loaded.</p> : <DataTable caption="Movements" columns={columns} rows={rows ?? []} isLoading={!rows} getRowId={(m) => m.id} density="compact" emptyState={{ title: 'No movements yet.' }} />}
    </Stack>
  );
}
