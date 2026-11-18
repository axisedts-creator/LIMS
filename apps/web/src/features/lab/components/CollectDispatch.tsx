'use client';
// /lab/collect (04-UI-UX §3.2, 03-APP-FLOW §3.2). Collect tab: scan a barcode or enter a registration no → `ordered` specimens → bulk-collect.
// Dispatch tab: scan collected specimens into a batch → bulk-dispatch. Scanner behaviour = kit defaults (C5 sets no own timings, 04-UI-UX §3.3).
// Barcode / registration no live only in POST bodies (REQ-SEC-028/098, S-09): no URL, no web storage, no logging.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BarcodeInput, useScanCapture, type BarcodeInputProps, type OnScan } from '@lims/ui/components/BarcodeInput';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { EmptyRow, PlaceholderRows } from '@lims/ui/components/DataTable';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Tabs } from '@lims/ui/components/Tabs';
import { useToast } from '@lims/ui/components/Toast';
import { bulkCollectAction, bulkDispatchAction, lookupSpecimenAction } from '../server/actions';
import type { Specimen } from '../server/types';
import { FAILED, NOT_FOUND, call, enterOnEmptyBox, newKey, plural, rowError, statusText } from './shared';
import { useSerial } from './useSerial';
import { t } from '@/core/i18n/messages';

const BARCODE = /^[A-Z0-9]{1,20}$/;
const REGISTRATION = /^[A-Z0-9]{1,40}$/; // registration_no charset (IC §9.3); a value that also fits BARCODE is looked up as a barcode
const MAX_ROWS = 200; // bulk limit
type PickRow = { s: Specimen; picked: boolean; done?: boolean; note?: string };
type BatchRow = { s: Specimen; sent?: boolean; note?: string };
type Setter<R> = (f: (p: R[]) => R[]) => void;

export function CollectDispatch({ permissions }: { permissions: readonly string[] }) {
  // T0D-UISCAN-1 (LD-353 rule 6): the denial keeps the page title
  return permissions.includes('lab.specimen.collect') ? <Screen /> : (
    <section aria-label="Collect and dispatch">
      <PageHeader title={t('lab.nav.collect')} helpKey="lab.collect" />
      <p role="alert">{"You don't have access to this screen."}</p>
    </section>
  );
}

/** T0D-UISCAN-1 (LD-353 template 3): the kit ScanPanel markup, written out so the screen keeps the kit <BarcodeInput> itself ([CONV] lab-t11.static pins it). */
function Panel({ result, children, ...input }: BarcodeInputProps & { result: string; children: ReactNode }) {
  return (
    <div className="lims-scan-panel">
      <div className="lims-scan-input"><BarcodeInput {...input} /></div>
      {result ? <div className="lims-scan-result" role="status"><p className="lims-description">{result}</p></div> : null}
      <div className="lims-scan-queue">{children}</div>
    </div>
  );
}

/** T0D-UISCAN-1 (LD-353 rule 5): the queue table in the kit scroll box, header row always drawn, the EmptyState in the body. */
function Queue({ caption, heads, empty, children }: { caption: string; heads: readonly string[]; empty?: string | undefined; children: ReactNode }) {
  return (
    <div className="lims-data-table"><div className="lims-table-scroll">
      <table className="lims-table">
        <caption className="lims-visually-hidden">{caption}</caption>
        <thead>
          <tr>{heads.map((h) => <th key={h} scope="col">{h}</th>)}</tr>
        </thead>
        <tbody>
          {empty ? <EmptyRow colSpan={heads.length}><EmptyState title={empty} /></EmptyRow> : children}
        </tbody>
        {empty ? <PlaceholderRows colSpan={heads.length} /> : null}
      </table>
    </div></div>
  );
}

function Screen() {
  const [tab, setTab] = useState<'collect' | 'dispatch'>('collect');
  // Lists live here so switching tabs does not lose a half-built batch.
  const [pick, setPick] = useState<PickRow[]>([]);
  const [batch, setBatch] = useState<BatchRow[]>([]);
  return (
    <section aria-label="Collect and dispatch">
      <PageHeader title={t('lab.nav.collect')} helpKey="lab.collect" />
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
      setMsg(open.length ? `${open.map((s) => s.barcode).join(', ')}: added to the list` : r.data.length ? 'No specimens are waiting for collection here.' : byBarcode ? NOT_FOUND : 'No specimens found for this registration number.');
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
      {/* T0D-UISCAN-1 (LD-353 template 3): scan input, last result card, queue table */}
      <Panel label="Scan barcode or enter registration number" name="scan" pattern={REGISTRATION} onScan={onScan} result={msg}>
        <Queue caption="Specimens to collect" heads={['Barcode', 'Type', 'Tests']} empty={rows.length === 0 ? 'Scan a label to start.' : undefined}>
          {rows.map(({ s, picked, done, note }) => (
            <tr key={s.id}>
              <td>
                <Checkbox
                  label={s.barcode}
                  isSelected={picked}
                  isDisabled={!!done}
                  onChange={(v) => setRows((p) => p.map((x) => (x.s.id === s.id ? { ...x, picked: v } : x)))}
                  {...(done || note ? { description: done ? 'Collected' : (note as string) } : {})}
                />
              </td>
              <td>{s.specimen_type_code}</td>
              <td>{s.tests.map((t) => t.test_code).join(', ')}</td>
            </tr>
          ))}
        </Queue>
      </Panel>
      {rows.length ? (
        <Button variant="primary" shortcut="Enter" isLoading={busy} isDisabled={selected.length === 0} onPress={() => void collect()}>
          Collect selected
        </Button>
      ) : null}
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
      setMsg(`${s.barcode}: ${issue(s) ?? 'added to the list'}`);
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
      {/* T0D-UISCAN-1 (LD-353 template 3): scan input, last result card, queue table */}
      <Panel label="Scan barcode" name="dispatch-scan" onScan={onScan} result={msg}>
        <Queue caption="Specimens to dispatch" heads={['Barcode', 'Type', 'Status', 'Note']} empty={rows.length === 0 ? 'Scan collected specimens to build a dispatch list.' : undefined}>
          {rows.map(({ s, sent, note }) => (
            <tr key={s.id}>
              <td>{s.barcode}</td>
              <td>{s.specimen_type_code}</td>
              <td>{statusText(s.status)}</td>
              <td>{sent ? 'Dispatched' : (note ?? issue(s) ?? '')}</td>
            </tr>
          ))}
        </Queue>
      </Panel>
      {rows.length ? (
        <>
          {valid.length ? (
            <Button variant="primary" shortcut="Ctrl+Enter" isLoading={busy} onPress={() => void dispatch()}>
              {`Dispatch ${plural(valid.length, 'specimen')}`}
            </Button>
          ) : null}
          <Button variant="ghost" onPress={() => { setRows(() => []); setMsg(''); }}>Clear list</Button>
        </>
      ) : null}
    </div>
  );
}
