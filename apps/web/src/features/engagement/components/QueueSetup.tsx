'use client';
// C16.T-Q4 W7 queue setup (04-UI-UX W7; 03-APP-FLOW §7.2; TRD Q1b/Q1c/Q2b/Q2c/Q8). Props are injected (see __tests__/t-q4.harness.tsx header).
// Pairing: pairDisplay() resolves with nothing — the BFF keeps the one-time secret server-side, so this file never sees it (REQ-SEC-068).
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { Dialog } from '@lims/ui/components/Dialog';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextField } from '@lims/ui/components/TextField';
import { checkCode, checkName, checkOrder, checkPrefix, problemMessage, type Queue, type QueueCounter, type QueueDisplayRow } from './queue-model';

export interface QueueBody { centre_id: string; code: string; display_name: string; token_prefix: string; sort_order: number; is_active: boolean }
export interface CounterBody { centre_id: string; display_name: string; sort_order: number; is_active: boolean }
export interface QueueSetupActions {
  createQueue(body: QueueBody): Promise<void>;
  updateQueue(queue: Queue, body: QueueBody): Promise<void>;
  createCounter(body: CounterBody): Promise<void>;
  updateCounter(counter: QueueCounter, body: CounterBody): Promise<void>;
  pairDisplay(body: { display_name: string; queue_ids: string[] }): Promise<void>;
  revokeDisplay(display: QueueDisplayRow): Promise<void>;
}
export interface QueueSetupProps {
  centreId: string;
  queues: readonly Queue[];
  counters: readonly QueueCounter[];
  displays: readonly QueueDisplayRow[];
  actions: QueueSetupActions;
}

type Errors = Record<string, string | undefined>;
// LD-140: statuses show tone + word via the kit StatusChip (10-DESIGN-SYSTEM §6).
const chip = (on: boolean, off: string) => <StatusChip kind="generic" status={on ? 'active' : off.toLowerCase()} tone={on ? 'success' : 'neutral'} label={on ? 'Active' : off} />;
const yesNo = (b: boolean) => chip(b, 'Inactive');
/** [CONV] The kit TextField needs a maxLength. The real limits (W7: code 32, name 60/40, prefix 2) are checked in queue-model so an over-long entry is
 *  rejected with a message instead of being silently cut by the input; this cap only bounds pasted junk. */
const INPUT_CAP = 255;
/** Spreadable `error` prop for a TextField (omitted when the field is valid; exactOptionalPropertyTypes). */
const fe = (e: Errors, k: string): { error?: string } => { const v = e[k]; return v ? { error: v } : {}; };

function QueueForm({ centreId, queue, actions, onClose }: { centreId: string; queue?: Queue; actions: QueueSetupActions; onClose: () => void }) {
  const [code, setCode] = useState(queue?.code ?? '');
  const [name, setName] = useState(queue?.display_name ?? '');
  const [prefix, setPrefix] = useState(queue?.token_prefix ?? '');
  const [order, setOrder] = useState(String(queue?.sort_order ?? 0));
  const [isActive, setActive] = useState(queue?.is_active ?? true);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const e: Errors = { code: checkCode(code), name: checkName(name, 60), prefix: checkPrefix(prefix), order: checkOrder(order) };
    setErrors(e);
    if (Object.values(e).some(Boolean) || busy) return;
    const body: QueueBody = { centre_id: centreId, code, display_name: name, token_prefix: prefix, sort_order: Number(order), is_active: isActive };
    setBusy(true);
    try { await (queue ? actions.updateQueue(queue, body) : actions.createQueue(body)); onClose(); } catch (err) { setFailure(problemMessage(err)); } finally { setBusy(false); }
  };
  return (
    <Dialog
      title={queue ? 'Edit queue' : 'New queue'}
      isOpen
      onClose={onClose}
      size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" isLoading={busy} onPress={() => void save()}>{queue ? 'Save' : 'Create'}</Button></>}
    >
      <TextField label="Code" name="code" value={code} onChange={setCode} maxLength={INPUT_CAP} {...fe(errors, 'code')} />
      <TextField label="Name" name="display_name" value={name} onChange={setName} maxLength={INPUT_CAP} {...fe(errors, 'name')} />
      <TextField label="Token prefix" name="token_prefix" value={prefix} onChange={setPrefix} maxLength={INPUT_CAP} {...fe(errors, 'prefix')} />
      <TextField label="Order" name="sort_order" inputMode="numeric" value={order} onChange={setOrder} maxLength={INPUT_CAP} {...fe(errors, 'order')} />
      <Checkbox label="Active" isSelected={isActive} onChange={setActive} />
      {failure ? <p role="alert" className="lims-error">{failure}</p> : null}
    </Dialog>
  );
}

function CounterForm({ centreId, counter, actions, onClose }: { centreId: string; counter?: QueueCounter; actions: QueueSetupActions; onClose: () => void }) {
  const [name, setName] = useState(counter?.display_name ?? '');
  const [order, setOrder] = useState(String(counter?.sort_order ?? 0));
  const [isActive, setActive] = useState(counter?.is_active ?? true);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const e: Errors = { name: checkName(name, 40), order: checkOrder(order) };
    setErrors(e);
    if (Object.values(e).some(Boolean) || busy) return;
    const body: CounterBody = { centre_id: centreId, display_name: name, sort_order: Number(order), is_active: isActive };
    setBusy(true);
    try { await (counter ? actions.updateCounter(counter, body) : actions.createCounter(body)); onClose(); } catch (err) { setFailure(problemMessage(err)); } finally { setBusy(false); }
  };
  return (
    <Dialog
      title={counter ? 'Edit counter' : 'New counter'}
      isOpen
      onClose={onClose}
      size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" isLoading={busy} onPress={() => void save()}>{counter ? 'Save' : 'Create'}</Button></>}
    >
      <TextField label="Name" name="display_name" value={name} onChange={setName} maxLength={INPUT_CAP} {...fe(errors, 'name')} />
      <TextField label="Order" name="sort_order" inputMode="numeric" value={order} onChange={setOrder} maxLength={INPUT_CAP} {...fe(errors, 'order')} />
      <Checkbox label="Active" isSelected={isActive} onChange={setActive} />
      {failure ? <p role="alert" className="lims-error">{failure}</p> : null}
    </Dialog>
  );
}

function PairDialog({ queues, actions, onClose }: { queues: readonly Queue[]; actions: QueueSetupActions; onClose: () => void }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const offered = queues.filter((q) => q.is_active);

  const pair = async () => {
    const e: Errors = { name: checkName(name, 40), queues: picked.length < 1 ? 'Choose at least 1 queue' : picked.length > 10 ? 'Choose at most 10 queues' : undefined };
    setErrors(e);
    if (Object.values(e).some(Boolean) || busy) return;
    setBusy(true);
    try { await actions.pairDisplay({ display_name: name, queue_ids: picked }); onClose(); } catch (err) { setFailure(problemMessage(err)); } finally { setBusy(false); }
  };
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? (p.includes(id) ? p : [...p, id]) : p.filter((x) => x !== id)));
  return (
    <Dialog
      title="Pair this screen"
      isOpen
      onClose={onClose}
      size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" isLoading={busy} onPress={() => void pair()}>Pair</Button></>}
    >
      <p>Use this button on the TV's own browser. After pairing, sign out — the screen keeps showing the queue.</p>
      <TextField label="Name" name="display_name" value={name} onChange={setName} maxLength={INPUT_CAP} {...fe(errors, 'name')} />
      <fieldset className="lims-fieldset">
        <legend>Queues to show</legend>
        {offered.map((q) => <Checkbox key={q.id} label={q.display_name} isSelected={picked.includes(q.id)} onChange={(on) => toggle(q.id, on)} />)}
        {errors['queues'] ? <p className="lims-error">{errors['queues']}</p> : null}
      </fieldset>
      {failure ? <p role="alert" className="lims-error">{failure}</p> : null}
    </Dialog>
  );
}

export function QueueSetup({ centreId, queues, counters, displays, actions }: QueueSetupProps) {
  const [tab, setTab] = useState('queues');
  const [form, setForm] = useState<{ kind: 'queue'; row?: Queue } | { kind: 'counter'; row?: QueueCounter } | { kind: 'pair' } | null>(null);
  const [revoking, setRevoking] = useState<QueueDisplayRow | null>(null);
  const [failure, setFailure] = useState<string>();
  const close = () => setForm(null);
  const queueNames = new Map(queues.map((q) => [q.id, q.display_name]));

  return (
    <div className="lims-queue-setup">
      {failure ? <p role="alert" className="lims-error">{failure}</p> : null}
      <Tabs aria-label="Queue setup" items={[{ id: 'queues', label: 'Queues' }, { id: 'counters', label: 'Counters' }, { id: 'displays', label: 'Displays' }]} selectedId={tab} onChange={setTab}>
        {tab === 'queues' ? (
          <>
            <Button variant="primary" onPress={() => setForm({ kind: 'queue' })}>New queue</Button>
            <DataTable
              caption="Queue definitions"
              rows={[...queues].sort((a, b) => a.sort_order - b.sort_order)}
              getRowId={(q) => q.id}
              emptyState={{ title: 'No queues yet.' }}
              columns={[
                { id: 'code', header: 'Code', isRowHeader: true, cell: (q) => q.code },
                { id: 'name', header: 'Name', cell: (q) => q.display_name },
                { id: 'prefix', header: 'Prefix', cell: (q) => q.token_prefix },
                { id: 'order', header: 'Order', align: 'end', cell: (q) => String(q.sort_order) },
                { id: 'active', header: 'Active', cell: (q) => yesNo(q.is_active) },
                { id: 'edit', header: 'Edit', cell: (q) => <Button size="sm" onPress={() => setForm({ kind: 'queue', row: q })}>Edit</Button> },
              ]}
            />
          </>
        ) : null}
        {tab === 'counters' ? (
          <>
            <Button variant="primary" onPress={() => setForm({ kind: 'counter' })}>New counter</Button>
            <DataTable
              caption="Counters"
              rows={[...counters].sort((a, b) => a.sort_order - b.sort_order)}
              getRowId={(c) => c.id}
              emptyState={{ title: 'No counters yet.' }}
              columns={[
                { id: 'name', header: 'Name', isRowHeader: true, cell: (c) => c.display_name },
                { id: 'order', header: 'Order', align: 'end', cell: (c) => String(c.sort_order) },
                { id: 'active', header: 'Active', cell: (c) => yesNo(c.is_active) },
                { id: 'edit', header: 'Edit', cell: (c) => <Button size="sm" onPress={() => setForm({ kind: 'counter', row: c })}>Edit</Button> },
              ]}
            />
          </>
        ) : null}
        {tab === 'displays' ? (
          <>
            <Button variant="primary" onPress={() => setForm({ kind: 'pair' })}>Pair this screen</Button>
            <DataTable
              caption="Displays"
              rows={displays}
              getRowId={(d) => d.id}
              emptyState={{ title: 'No screens paired yet.' }}
              columns={[
                { id: 'name', header: 'Name', isRowHeader: true, cell: (d) => d.display_name },
                { id: 'queues', header: 'Queues', cell: (d) => d.queue_ids.map((id) => queueNames.get(id) ?? '—').join(', ') },
                { id: 'status', header: 'Status', cell: (d) => chip(d.status === 'active', 'Revoked') },
                { id: 'seen', header: 'Last seen', cell: (d) => (d.last_seen_at ? <DateText value={d.last_seen_at as DateTextProps['value']} withTime /> : '—') },
                { id: 'revoke', header: 'Revoke', cell: (d) => (d.status === 'active' ? <Button size="sm" variant="danger" onPress={() => setRevoking(d)}>Revoke</Button> : null) },
              ]}
            />
          </>
        ) : null}
      </Tabs>

      {form?.kind === 'queue' ? <QueueForm centreId={centreId} actions={actions} onClose={close} {...(form.row ? { queue: form.row } : {})} /> : null}
      {form?.kind === 'counter' ? <CounterForm centreId={centreId} actions={actions} onClose={close} {...(form.row ? { counter: form.row } : {})} /> : null}
      {form?.kind === 'pair' ? <PairDialog queues={queues} actions={actions} onClose={close} /> : null}

      <ConfirmDialog
        title="Revoke this screen?"
        body={<p>{`"${revoking?.display_name ?? ''}" will stop showing the queue.`}</p>}
        confirmLabel="Revoke"
        tone="danger"
        isOpen={!!revoking}
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          const d = revoking;
          if (!d) return;
          try { await actions.revokeDisplay(d); setFailure(undefined); } catch (err) { setFailure(problemMessage(err)); }
          setRevoking(null);
        }}
      />
    </div>
  );
}
