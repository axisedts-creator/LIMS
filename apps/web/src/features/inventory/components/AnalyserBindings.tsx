'use client';
// S14 Analyser bindings (04-UI-UX §3 S14): which store an analyser's consumption is deducted from. PUT is create-or-replace:
// no If-Match for a new binding, If-Match "<version>" when the analyser already has one. LD-140: kit components only; one primary ("Bind").
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Form } from '@lims/ui/components/Form';
import { Select } from '@lims/ui/components/Select';
import { Stack } from '@lims/ui/components/Stack';
import { useToast } from '@lims/ui/components/Toast';
import { deactivateBindingAction, putBindingAction } from '../server/actions';
import type { Binding, Instrument, Store } from '../server/types';
import { isoDate, ProblemBanner, type Failure } from './shared';

export function AnalyserBindings({ bindings, instruments, stores, canManage }: { bindings: readonly Binding[]; instruments: readonly Instrument[]; stores: readonly Store[]; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [inst, setInst] = useState<Instrument>();
  const [storeId, setStoreId] = useState<string>();
  const [problem, setProblem] = useState<Failure>();
  const [target, setTarget] = useState<Binding>();
  const [n, setN] = useState(0); // remounts the bind form after a success so both pickers clear
  const active = bindings.filter((b) => b.is_active);
  const analyser = (id: string) => instruments.find((i) => i.id === id)?.display_name ?? id; // falls back to the id when the directory is unavailable
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? id;

  const onBind = async () => {
    if (!inst || !storeId) return;
    const r = await putBindingAction(inst.id, bindings.find((b) => b.instrument_id === inst.id)?.version, storeId);
    if (!r.ok) return setProblem(r);
    setProblem(undefined);
    setInst(undefined);
    setStoreId(undefined);
    setN((x) => x + 1);
    toast.show({ tone: 'success', title: 'Linked. Waiting records for this analyser will be posted shortly.' });
    router.refresh();
  };
  const unlink = async () => {
    const t = target;
    setTarget(undefined);
    if (!t) return;
    const r = await deactivateBindingAction(t.instrument_id, t.version);
    if (!r.ok) return setProblem(r);
    setProblem(undefined);
    router.refresh();
  };

  const columns: ColumnDef<Binding>[] = [
    { id: 'analyser', header: 'Analyser', isRowHeader: true, cell: (b) => analyser(b.instrument_id) },
    { id: 'store', header: 'Store', cell: (b) => storeName(b.store_id) },
    { id: 'since', header: 'Since', cell: (b) => isoDate(b.since) },
    ...(canManage ? [{ id: 'actions', header: 'Actions', cell: (b: Binding) => <Button size="sm" variant="ghost" onPress={() => setTarget(b)}>Unlink</Button> }] : []),
  ];
  return (
    <Stack>
      <ProblemBanner problem={problem} />
      {canManage ? (
        <Form key={n} onSubmit={onBind}>
          <Stack>
            <Combobox<Instrument>
              label="Analyser"
              name="instrument_id"
              isRequired
              loadOptions={async (q) => instruments.filter((i) => `${i.display_name} ${i.instrument_code}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 20)}
              getKey={(i) => i.id}
              renderOption={(i) => i.display_name}
              renderValue={(i) => i.display_name}
              value={inst}
              onChange={setInst}
            />
            <Select label="Store" name="store_id" isRequired placeholder="Store — choose one" options={stores.filter((s) => s.is_active).map((s) => ({ value: s.id, label: `${s.name} (${s.store_code})` }))} {...(storeId ? { value: storeId } : {})} onChange={setStoreId} />
            <Button type="submit" variant="primary">
              Bind
            </Button>
          </Stack>
        </Form>
      ) : null}
      <DataTable caption="Analyser bindings" columns={columns} rows={active} getRowId={(b) => b.id} emptyState={{ title: 'No analysers linked to a store yet.' }} />
      <ConfirmDialog
        title="Unlink analyser?"
        body="Consumption from this analyser will fall back to the default consumption store."
        confirmLabel="Unlink"
        tone="danger"
        isOpen={!!target}
        onCancel={() => setTarget(undefined)}
        onConfirm={unlink}
      />
    </Stack>
  );
}
