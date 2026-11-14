'use client';
// /lab/receive (04-UI-UX §3.3, 03-APP-FLOW §3.3): receiving location + Auto-accept, scan → specimen card → Accept (Enter) / Reject, session log (last 50, memory only).
// Scanner behaviour = kit defaults (BarcodeInput + useScanCapture; C5 sets no own timings). Barcode / registration no live only in POST bodies;
// the one thing kept in browser storage is the receiving centre id (REQ-SEC-028/098, S-09).
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { BarcodeInput, useScanCapture, type OnScan } from '@lims/ui/components/BarcodeInput';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { lookupSpecimenAction, receiveSpecimenAction, rejectSpecimenAction } from '../server/actions';
import type { RejectionReason, Specimen } from '../server/types';
import { FAILED, NOT_FOUND, call, enterOnEmptyBox, newKey, useSerial } from './shared';

const LOCATION_KEY = 'lims.lab.receive.location'; // value = centre id only
const LOG_MAX = 50; // [CONV] 03-APP-FLOW §3.3
const COMMENT_MAX = 500;
type Entry = { n: number; barcode: string; text: string };
type LogTab = 'all' | 'received' | 'rejected' | 'errors';
const tabOf = (e: Entry): LogTab => (e.text === 'Received' ? 'received' : e.text === 'Rejected' ? 'rejected' : 'errors'); // RS-C5 (LD-140): counts come from the in-memory session log only
type Errs = { reason?: string; comment?: string; form?: string };

export interface ReceiveScreenProps {
  centres: readonly { id: string; name: string }[];
  rejectionReasons: readonly RejectionReason[];
  recollectionDefault: boolean;
  permissions: readonly string[];
}

const day = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' }) : '');

export function ReceiveScreen(props: ReceiveScreenProps) {
  return props.permissions.includes('lab.specimen.receive') ? <Screen {...props} /> : <p role="alert">{"You don't have access to this screen."}</p>;
}

function Screen({ centres, rejectionReasons, recollectionDefault, permissions }: ReceiveScreenProps) {
  const router = useRouter();
  const toast = useToast();
  const serial = useSerial();
  const [centreId, setCentreId] = useState('');
  const [locErr, setLocErr] = useState('');
  const [auto, setAuto] = useState(false);
  const [current, setCurrent] = useState<Specimen | null>(null);
  const [log, setLog] = useState<Entry[]>([]);
  const [logTab, setLogTab] = useState<LogTab>('all');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const seq = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  // Scan jobs run later than the render that queued them: they read the latest choices from here.
  const live = useRef({ centreId, auto });
  live.current = { centreId, auto };
  // reject dialog
  const [dialog, setDialog] = useState(false);
  const [closeHint, setCloseHint] = useState('');
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [recollect, setRecollect] = useState(recollectionDefault);
  const [errs, setErrs] = useState<Errs>({});

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LOCATION_KEY);
      if (saved && centres.some((c) => c.id === saved)) setCentreId(saved);
    } catch {
      /* storage blocked: the location is simply not remembered */
    }
  }, [centres]);

  // [CONV] The kit Switch (input role="switch") exposes its state only through `checked`; mirror it to aria-checked for assistive tech (same approach as catalog ImportCommitDialog).
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bar.current?.querySelectorAll<HTMLInputElement>('input[role="switch"]').forEach((i) => i.setAttribute('aria-checked', String(i.checked)));
  }, [auto]);

  const focusBox = () => box.current?.querySelector('input')?.focus();
  const addLog = (barcode: string, text: string) => setLog((p) => [{ n: ++seq.current, barcode, text }, ...p].slice(0, LOG_MAX));
  const choose = (id: string) => {
    setCentreId(id);
    setLocErr('');
    try {
      localStorage.setItem(LOCATION_KEY, id);
    } catch {
      /* storage blocked */
    }
  };

  async function receive(s: Specimen) {
    const centre = live.current.centreId;
    if (!centre) return setLocErr('Choose a receiving location');
    if (!s.is_active) return addLog(s.barcode, 'Error: Order cancelled — do not process');
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const r = await call(receiveSpecimenAction(s.id, s.version, centre, newKey()));
    busyRef.current = false;
    setBusy(false);
    if (r.ok) {
      setCurrent(r.data);
      addLog(s.barcode, 'Received');
    } else addLog(s.barcode, `Error: ${r.title ?? 'Could not receive'}`);
    focusBox();
  }

  const onScan: OnScan = (v) =>
    serial(async () => {
      setMsg('');
      const r = await call(lookupSpecimenAction({ barcode: v }));
      if (!r.ok) return setMsg(r.status === 404 ? NOT_FOUND : (r.title ?? FAILED));
      const s = r.data[0];
      if (!s) return setMsg(NOT_FOUND);
      setCurrent(s);
      if (live.current.auto) await receive(s);
    });
  useScanCapture({ onScan, enabled: !dialog });
  useScanCapture({ onScan: () => setCloseHint('Close the dialog before scanning'), enabled: dialog });

  const canAccept = !!current && current.is_active && current.status !== 'received';
  const openReject = () => {
    setReason('');
    setComment('');
    setRecollect(recollectionDefault);
    setErrs({});
    setCloseHint('');
    focusBox(); // the kit returns focus to whatever had it when the dialog opened: make that the scan box
    setDialog(true);
  };
  async function confirmReject() {
    if (!current || busyRef.current) return;
    const e: Errs = {};
    if (!reason) e.reason = 'Choose a reason';
    if (comment.length > COMMENT_MAX) e.comment = `Comment must be ${COMMENT_MAX} characters or fewer`;
    setErrs(e);
    if (e.reason || e.comment) return;
    busyRef.current = true;
    setBusy(true);
    const body = { reason_code: reason, ...(comment.trim() ? { comment: comment.trim() } : {}), recollection_required: recollect };
    const r = await call(rejectSpecimenAction(current.id, current.version, body, newKey()));
    busyRef.current = false;
    setBusy(false);
    if (!r.ok) {
      addLog(current.barcode, `Error: ${r.title ?? FAILED}`);
      return setErrs({ form: r.title ?? FAILED });
    }
    setDialog(false);
    setCloseHint('');
    setCurrent(r.data.specimen);
    addLog(current.barcode, 'Rejected');
    const fresh = r.data.recollection_specimen?.barcode;
    toast.show({ tone: 'success', title: fresh ? `Specimen rejected. New barcode ${fresh} created for recollection.` : 'Specimen rejected.' });
    setTimeout(focusBox, 0);
  }

  const shown = logTab === 'all' ? log : log.filter((e) => tabOf(e) === logTab);
  const reasonText = (code?: string) => rejectionReasons.find((r) => r.code === code)?.display ?? code ?? '';
  return (
    <section aria-label="Receive specimens">
      <PageHeader title="Receive specimens" helpKey="lab.receive" />
      <div ref={bar}>
        <Select
          label="Receiving location"
          name="location"
          isRequired
          placeholder="Choose a location"
          options={centres.map((c) => ({ value: c.id, label: c.name }))}
          value={centreId}
          onChange={choose}
          {...(locErr ? { error: locErr } : {})}
        />
        <Switch label="Auto-accept" isSelected={auto} onChange={setAuto} />
      </div>
      <div ref={box} onKeyDown={(e) => { if (enterOnEmptyBox(e) && current && canAccept) void receive(current); }}>
        <BarcodeInput label="Scan barcode" name="scan" onScan={onScan} />
      </div>
      <p role="status" className="lims-description">{msg}</p>

      {current ? (
        <section aria-label="Current specimen">
          <p><strong>{current.barcode}</strong></p>
          <dl>
            <dt>Registration no</dt>
            <dd>{current.registration_no}</dd>
            <dt>Specimen</dt>
            <dd>{current.container_code ? `${current.specimen_type_code} / ${current.container_code}` : current.specimen_type_code}</dd>
            <dt>Tests</dt>
            <dd>{current.tests.map((t) => t.test_code).join(', ')}{current.priority === 'urgent' ? ' ★ Urgent' : ''}</dd>
            {current.collected_at ? <><dt>Collected</dt><dd>{day(current.collected_at)}</dd></> : null}
          </dl>
          {current.collection_barcode_unverified ? <Banner tone="warning" title="Collection barcode was not verified on the phlebotomy app" /> : null}
          {!current.is_active ? <Banner tone="danger" title="Order cancelled — do not process" /> : null}
          {current.status === 'rejected' ? <Banner tone="warning" title={current.rejected_at ? `Rejected on ${day(current.rejected_at)}: ${reasonText(current.rejection_reason_code)}` : 'Rejected'} /> : null}
          <Button variant="primary" shortcut="Enter" isDisabled={!canAccept || busy} onPress={() => void receive(current)}>Accept</Button>
          {permissions.includes('lab.specimen.reject') ? <Button variant="danger" isDisabled={busy} onPress={openReject}>Reject</Button> : null}
          {permissions.includes('lab.specimen.read') ? <Button variant="ghost" onPress={() => router.push(`/lab/specimens/${current.id}`)}>Open specimen</Button> : null}
        </section>
      ) : null}

      <Tabs
        aria-label="Session log"
        items={(['all', 'received', 'rejected', 'errors'] as const).map((t) => ({ id: t, label: t[0]!.toUpperCase() + t.slice(1), count: t === 'all' ? log.length : log.filter((e) => tabOf(e) === t).length }))}
        selectedId={logTab}
        onChange={(id) => setLogTab(id as LogTab)}
      >
        {shown.length ? (
          <table className="lims-table">
            <caption className="lims-visually-hidden">Session log</caption>
            <thead>
              <tr><th scope="col">Barcode</th><th scope="col">Outcome</th></tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.n}>
                  <td>{e.barcode}</td>
                  <td>{e.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Tabs>

      {dialog && current ? (
        <Dialog
          title={`Reject specimen ${current.barcode}`}
          isOpen
          onClose={() => setDialog(false)}
          footer={
            <>
              <Button variant="ghost" onPress={() => setDialog(false)}>Cancel</Button>
              <Button variant="danger" isDisabled={busy} onPress={() => void confirmReject()}>Reject</Button>
            </>
          }
        >
          {errs.form ? <Banner tone="danger" title={errs.form} /> : null}
          <RadioGroup
            label="Reason"
            name="reason"
            isRequired
            value={reason}
            onChange={setReason}
            options={rejectionReasons.map((r) => ({ value: r.code, label: r.display }))}
            {...(errs.reason ? { error: errs.reason } : {})}
          />
          <TextArea label="Comment" name="comment" maxLength={COMMENT_MAX} value={comment} onChange={setComment} {...(errs.comment ? { error: errs.comment } : {})} />
          <Checkbox label="Request recollection" isSelected={recollect} onChange={setRecollect} />
          <p aria-live="polite" className="lims-visually-hidden">{closeHint}</p>
        </Dialog>
      ) : null}
    </section>
  );
}
