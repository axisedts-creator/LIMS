'use client';
// S11 Stock counts list + "New count" drawer (04-UI-UX §3 S11). LD-140 (2026-11-13): list + right Drawer, "New count" is the ONE primary.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Drawer } from '@lims/ui/components/Drawer';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { createCountAction } from '../server/actions';
import type { Category, CountStatus, CountSummary, CountCreate, Store } from '../server/types';
import { CATEGORIES } from './codes';
import { Chip, isoDate, Pick, ProblemBanner, useAttemptKey, type Failure } from './shared';

export const COUNT_STATUS: Record<CountStatus, { tone: 'neutral' | 'info' | 'success'; label: string }> = {
  open: { tone: 'info', label: 'Open' },
  posted: { tone: 'success', label: 'Posted' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
};
export const CountStatusChip = ({ status }: { status: CountStatus }) => <Chip tone={COUNT_STATUS[status]?.tone ?? 'neutral'} label={COUNT_STATUS[status]?.label ?? status} />;

export function CountsView({ counts, stores, canManage }: { counts: readonly CountSummary[]; stores: readonly Store[]; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? id;
  const columns: ColumnDef<CountSummary>[] = [
    { id: 'no', header: 'No.', isRowHeader: true, cell: (c) => <a className="lims-link" href={`/inventory/counts/${c.id}`}>{c.count_no}</a> },
    { id: 'store', header: 'Store', cell: (c) => storeName(c.store_id) },
    { id: 'status', header: 'Status', cell: (c) => <CountStatusChip status={c.status} /> },
    { id: 'opened', header: 'Opened', cell: (c) => isoDate(c.snapshot_at) },
    { id: 'posted', header: 'Posted', cell: (c) => isoDate(c.posted_at) },
  ];
  return (
    <section aria-label="Stock counts">
      <PageHeader title="Stock counts" helpKey="inventory.counts" {...(canManage ? { actions: <Button variant="primary" onPress={() => setCreating(true)}>New count</Button> } : {})} />
      <DataTable caption="Stock counts" columns={columns} rows={counts} getRowId={(c) => c.id} emptyState={{ title: 'No counts' }} onRowAction={(c) => router.push(`/inventory/counts/${c.id}`)} />
      <Drawer title="New count" isOpen={creating} onClose={() => setCreating(false)}>
        {creating ? (
          <NewCount
            stores={stores}
            onDone={(id, no) => {
              setCreating(false);
              toast.show({ tone: 'success', title: `Count ${no} opened` });
              router.push(`/inventory/counts/${id}`);
            }}
          />
        ) : null}
      </Drawer>
    </section>
  );
}

function NewCount({ stores, onDone }: { stores: readonly Store[]; onDone: (id: string, no: string) => void }) {
  const key = useAttemptKey();
  const [store, setStore] = useState<string>();
  const [category, setCategory] = useState<string>();
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string>();
  const [problem, setProblem] = useState<Failure>();
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!store) return setError('Store is required');
    setError(undefined);
    const body: CountCreate = { store_id: store, ...(category ? { scope_category: category as Category } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) };
    setSaving(true);
    const r = await createCountAction(body, key.get(JSON.stringify(body)));
    setSaving(false);
    if (!r.ok) return setProblem(r);
    key.reset();
    onDone(r.data.id, r.data.count_no);
  };
  return (
    <Stack>
      <ProblemBanner problem={problem} />
      <Pick label="Store" name="store_id" isRequired options={stores.filter((s) => s.is_active).map((s) => ({ value: s.id, label: `${s.store_code} — ${s.name}` }))} value={store} error={error} onChange={setStore} />
      <Pick label="Category" name="scope_category" options={CATEGORIES} value={category} onChange={setCategory} />
      <TextArea label="Notes" name="notes" maxLength={1000} value={notes} onChange={setNotes} />
      <div>
        <Button variant="primary" isLoading={saving} onPress={() => void submit()}>Open count</Button>
      </div>
    </Stack>
  );
}
