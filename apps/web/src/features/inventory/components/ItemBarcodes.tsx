'use client';
// S3 Barcodes tab: scanner add-barcode (04-UI-UX §2.4). Barcodes are PHI-class P2 (REQ-SEC-098): the scanned value goes only into the
// POST body — never a URL, query string, router call or log. A duplicate shows the registry title and is never re-submitted by itself.
// LD-140: kit components only.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BarcodeInput } from '@lims/ui/components/BarcodeInput';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Select } from '@lims/ui/components/Select';
import { Stack } from '@lims/ui/components/Stack';
import { useToast } from '@lims/ui/components/Toast';
import { addBarcodeAction, deactivateBarcodeAction } from '../server/actions';
import type { Barcode, Item } from '../server/types';
import { BARCODE_VALUE, NONE } from './codes';
import { ActiveChip, newKey, ProblemBanner, type Failure } from './shared';

export function ItemBarcodes({ item, canManage }: { item: Item; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [packId, setPackId] = useState(NONE);
  const [problem, setProblem] = useState<Failure>();
  const [target, setTarget] = useState<Barcode>();

  const onScan = async (value: string) => {
    const r = await addBarcodeAction(item.id, { barcode_value: value, ...(packId !== NONE ? { pack_id: packId } : {}) }, newKey());
    if (!r.ok) return setProblem(r);
    setProblem(undefined);
    toast.show({ tone: 'success', title: 'Barcode added' });
    router.refresh();
  };
  const deactivate = async () => {
    const t = target;
    setTarget(undefined);
    if (!t) return;
    const r = await deactivateBarcodeAction(item.id, t.id, t.version);
    if (!r.ok) return setProblem(r);
    setProblem(undefined);
    router.refresh();
  };
  const packName = (id: string | undefined) => item.packs.find((p) => p.id === id)?.pack_code ?? 'Any pack';
  const columns: ColumnDef<Barcode>[] = [
    { id: 'value', header: 'Barcode', isRowHeader: true, cell: (b) => b.barcode_value },
    { id: 'pack', header: 'Pack', cell: (b) => packName(b.pack_id) },
    { id: 'active', header: 'Active', cell: (b) => <ActiveChip active={b.is_active} /> },
    ...(canManage ? [{ id: 'actions', header: 'Actions', cell: (b: Barcode) => (b.is_active ? <Button size="sm" variant="ghost" onPress={() => setTarget(b)}>Deactivate</Button> : null) }] : []),
  ];
  return (
    <Stack>
      <ProblemBanner problem={problem} />
      {canManage ? (
        <>
          <Select label="Pack" name="pack_id" options={[{ value: NONE, label: 'Any pack' }, ...item.packs.filter((p) => p.is_active).map((p) => ({ value: p.id, label: `${p.pack_code} — ${p.label}` }))]} value={packId} onChange={setPackId} />
          <BarcodeInput label="Scan or type barcode" name="barcode_value" pattern={BARCODE_VALUE} clearAfterScan onScan={(v) => void onScan(v)} />
        </>
      ) : null}
      <DataTable caption="Barcodes" columns={columns} rows={item.barcodes} getRowId={(b) => b.id} emptyState={{ title: 'No barcodes yet.' }} />
      <ConfirmDialog
        title="Deactivate barcode?"
        body="Scans of this barcode will no longer find the item."
        confirmLabel="Deactivate"
        tone="danger"
        isOpen={!!target}
        onCancel={() => setTarget(undefined)}
        onConfirm={deactivate}
      />
    </Stack>
  );
}
