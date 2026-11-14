'use client';
// /lab/collect (04-UI-UX §3.2, 03-APP-FLOW §3.2). Collect tab: scan a barcode or enter a registration no → `ordered` specimens → bulk-collect.
// Dispatch tab: scan collected specimens into a batch → bulk-dispatch. Scanner behaviour = kit defaults (C5 sets no own timings, 04-UI-UX §3.3).
// Barcode / registration no live only in POST bodies (REQ-SEC-028/098, S-09): no URL, no web storage, no logging.
import { useEffect, useRef, useState } from 'react';
import { BarcodeInput, useScanCapture, type OnScan } from '@lims/ui/components/BarcodeInput';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import { useToast } from '@lims/ui/components/Toast';
import { bulkCollectAction, bulkDispatchAction, lookupSpecimenAction } from '../server/actions';
import type { Specimen } from '../server/types';
import { FAILED, NOT_FOUND, call, enterOnEmptyBox, newKey, plural, rowError, statusText, useSerial } from './shared';

const BARCODE = /^[A-Z0-9]{1,20}$/;
const REGISTRATION = /^[A-Z0-9]{1,40}$/; // registration_no charset (IC §9.3); a value that also fits BARCODE is looked up as a barcode
const MAX_ROWS = 200; // bulk limit
type PickRow = { s: Specimen; picked: boolean; done?: boolean; note?: string };
type BatchRow = { s: Specimen; sent?: boolean; note?: string };
type Setter<R> = (f: (p: R[]) => R[]) => void;

export function CollectDispatch({ permissions }: { permissions: readonly string[] }) {
  return permissions.includes('lab.specimen.collect') ? <Screen /> : <p role="alert">{"You don't have access to this screen."}</p>;
}

function Screen() {
  const [tab, setTab] = useState<'collect' | 'dispatch'>('collect');
  // Lists live here so switching tabs does not lose a half-built batch.
  const [pick, setPick] = useState<PickRow[]>([]);
  const [batch, setBatch] = useState<BatchRow[]>([]);
  return (
    <section aria-label="Collect and dispatch">
      <PageHeader title="Collect & dispatch" helpKey="lab.collect" />
      <Tabs
        aria-label="Collect and dispatch"
        items={[{ id: 'collect', label: 'Collect', count: pick.length }, { id: 'dispatch', label: 'Dispatch', count: batch.length }]}
        selectedId={tab}
        onChange={(id) => setTab(id === 'dispatch' ? 'dispatch' : 'collect')}
      >
        {tab === 'collect' ? <CollectPanel rows={pick} setRows={setPick} /> : <DispatchPanel rows={batch} setRows={setBatch} />}
      </Tabs>
    </section>
  );
}

function CollectPanel({ rows, setRows }: { rows: PickRow[]; setRows: Setter<PickRow> }) {
  const toast = useToast();
  const serial = useSerial();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const onScan: OnScan = (v) =>
    serial(async () => {
      const byBarcode = BARCODE.test(v);
      const r = await call(lookupSpecimenAction(byBarcode ? { barcode: v } : { registration_no: v }));
      if (!r.ok) return setMsg(r.status === 404 ? NOT_FOUND : (r.title ?? FAILED));
      const open = r.data.filter((s) => s.status === 'ordered' && s.is_active);
      setMsg(open.length ? '' : r.data.length ? 'No specimens are waiting for collection here.' : byBarcode ? NOT_FOUND : 'No specimens found for this registration number.');
      setRows((p) => [...p, ...open.filter((s) => !p.some((x) => x.s.id === s.id)).map((s) => ({ s, picked: true }))]);
    });
  useScanCapture({ onScan, enabled: true, pattern: REGISTRATION });

  const selected = rows.filter((r) => r.picked && !r.done);
  async function collect() {
    if (busyRef.current || selected.length === 0) return;
    busyRef.current = true;
    setBusy(true);
    const r = await call(bulkCollectAction(selected.map(({ s }) => ({ id: s.id, version: s.version })), newKey()));
    busyRef.current = false;
    setBusy(false);
    if (!r.ok) return toast.show({ tone: 'danger', title: r.title ?? FAILED });
    const by = new Map(r.data.map((x) => [x.id, x]));
    setRows((p) => p.map((x) => {
      const o = by.get(x.s.id);
      return !o ? x : o.outcome === 'ok' ? { s: o.specimen ?? x.s, picked: false, done: true } : { ...x, note: rowError(o.code) };
    }));
    const n = r.data.filter((x) => x.outcome === 'ok').length;
    if (n) toast.show({ tone: 'success', title: `Collected ${plural(n, 'specimen')}.` });
  }

  return (
    <div onKeyDown={(e) => { if (enterOnEmptyBox(e)) void collect(); }}>
      <BarcodeInput label="Scan barcode or enter registration number" name="scan" pattern={REGISTRATION} onScan={onScan} />
      <p role="status" className="lims-description">{msg}</p>
      {rows.length === 0 ? (
        <EmptyState title="Scan a label to start." />
      ) : (
        <>
          <ul>
            {rows.map(({ s, picked, done, note }) => (
              <li key={s.id}>
                <Checkbox
                  label={`${s.barcode} · ${s.specimen_type_code} · ${s.tests.map((t) => t.test_code).join(', ')}`}
                  isSelected={picked}
                  isDisabled={!!done}
                  onChange={(v) => setRows((p) => p.map((x) => (x.s.id === s.id ? { ...x, picked: v } : x)))}
                  {...(done || note ? { description: done ? 'Collected' : (note as string) } : {})}
                />
              </li>
            ))}
          </ul>
          <Button variant="primary" shortcut="Enter" isLoading={busy} isDisabled={selected.length === 0} onPress={() => void collect()}>
            Collect selected
          </Button>
        </>
      )}
    </div>
  );
}

const issue = (s: Specimen) => (s.status !== 'collected' ? `Not ready to dispatch (status: ${s.status})` : s.is_active ? undefined : rowError('lab.specimen_inactive'));

function DispatchPanel({ rows, setRows }: { rows: BatchRow[]; setRows: Setter<BatchRow> }) {
  const toast = useToast();
  const serial = useSerial();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const count = useRef(rows.length);
  count.current = rows.length;

  const onScan: OnScan = (v) =>
    serial(async () => {
      const r = await call(lookupSpecimenAction({ barcode: v }));
      if (!r.ok) return setMsg(r.status === 404 ? NOT_FOUND : (r.title ?? FAILED));
      const s = r.data[0];
      if (!s) return setMsg(NOT_FOUND);
      if (count.current >= MAX_ROWS) return setMsg(`The list is full (${MAX_ROWS}). Dispatch or clear it first.`);
      setMsg('');
      setRows((p) => (p.some((x) => x.s.id === s.id) ? p : [...p, { s }]));
    });
  useScanCapture({ onScan, enabled: true });

  const valid = rows.filter((r) => !r.sent && !issue(r.s));
  async function dispatch() {
    if (busyRef.current || valid.length === 0) return;
    busyRef.current = true;
    setBusy(true);
    const r = await call(bulkDispatchAction(valid.map(({ s }) => ({ id: s.id, version: s.version })), newKey()));
    busyRef.current = false;
    setBusy(false);
    if (!r.ok) return toast.show({ tone: 'danger', title: r.title ?? FAILED });
    const by = new Map(r.data.map((x) => [x.id, x]));
    setRows((p) => p.map((x) => {
      const o = by.get(x.s.id);
      return !o ? x : o.outcome === 'ok' ? { s: o.specimen ?? x.s, sent: true } : { ...x, note: rowError(o.code) };
    }));
    const n = r.data.filter((x) => x.outcome === 'ok').length;
    if (n) toast.show({ tone: 'success', title: `Dispatched ${plural(n, 'specimen')}.` });
  }
  const latest = useRef(dispatch);
  latest.current = dispatch;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !e.ctrlKey) return;
      e.preventDefault();
      void latest.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div>
      <BarcodeInput label="Scan barcode" name="dispatch-scan" onScan={onScan} />
      <p role="status" className="lims-description">{msg}</p>
      {rows.length === 0 ? (
        <EmptyState title="Scan collected specimens to build a dispatch list." />
      ) : (
        <>
          <table>
            <caption className="lims-visually-hidden">Specimens to dispatch</caption>
            <thead>
              <tr><th scope="col">Barcode</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Note</th></tr>
            </thead>
            <tbody>
              {rows.map(({ s, sent, note }) => (
                <tr key={s.id}>
                  <td>{s.barcode}</td>
                  <td>{s.specimen_type_code}</td>
                  <td>{statusText(s.status)}</td>
                  <td>{sent ? 'Dispatched' : (note ?? issue(s) ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {valid.length ? (
            <Button variant="primary" shortcut="Ctrl+Enter" isLoading={busy} onPress={() => void dispatch()}>
              {`Dispatch ${plural(valid.length, 'specimen')}`}
            </Button>
          ) : null}
          <Button variant="ghost" onPress={() => { setRows(() => []); setMsg(''); }}>Clear list</Button>
        </>
      )}
    </div>
  );
}
