'use client';
// /lab/ingest-exceptions/{exception_id} (04-UI-UX §3.10, 03-APP-FLOW §1.3; AC-14.3, AC-14.5): the exception with its raw instrument value (P3: only here, the API writes an access-log row)
// and the three actions of an OPEN exception for users with lab.result.enter: Re-apply, Assign (barcode -> order results -> one result), Discard (coded reason + comment <= 300).
// Server state decides: after every call the route is refreshed; the API still enforces permission and state (the UI only hides). No barcode / value in any URL (REQ-SEC-028).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { assignExceptionAction, discardExceptionAction, listOrderResultsAction, lookupSpecimenAction, reapplyExceptionAction } from '../server/actions';
import type { ActionResult, ExceptionAction, IngestExceptionDetailDto, OrderResult, RejectionReason } from '../server/types';
import { LOCKED_COPY, REASON_TEXT } from './exceptionText';
import { NativeSelect } from './NativeSelect';
import { FAILED, NOT_FOUND, call, newKey } from './shared';

export interface IngestExceptionDetailProps { exception: IngestExceptionDetailDto; permissions: readonly string[]; discardReasons: readonly RejectionReason[] }
const COMMENT_MAX = 300;   // contract maxLength of the discard comment

/** Result of a re-apply / assign as text: anything but an applied outcome says the exception is still open (AC-14.3). */
function outcomeText(o: ExceptionAction['outcome']): string {
  switch (o) {
    case 'applied': return 'Applied. The instrument value was saved on the result.';
    case 'held': return 'Applied. The result is on QC hold.';
    case 'duplicate': return 'This record was already applied.';
    case 'not_applicable': return 'This record type is handled elsewhere. Discard it here if it is not needed.';
    default: return 'Still open. The value could not be applied yet.';
  }
}
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) : '');

export function IngestExceptionDetail({ exception: e, permissions, discardReasons }: IngestExceptionDetailProps) {
  const router = useRouter();
  const canAct = e.status === 'open' && permissions.includes('lab.result.enter');
  const [dialog, setDialog] = useState<'discard' | 'assign' | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  // discard
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  // assign
  const [barcode, setBarcode] = useState('');
  const [found, setFound] = useState<OrderResult[] | null>(null);
  const [lookupMsg, setLookupMsg] = useState('');
  const [pick, setPick] = useState('');
  const [other, setOther] = useState(false);
  const key = useRef<{ sig: string; key: string } | null>(null);   // one Idempotency-Key per distinct assign payload: a retry re-sends the same key

  const open = (d: 'discard' | 'assign') => { setErr(''); setMsg(''); setReason(''); setComment(''); setBarcode(''); setFound(null); setLookupMsg(''); setPick(''); setOther(false); setDialog(d); };
  const close = () => { setDialog(null); setErr(''); };
  /** one request at a time; `done` runs on success */
  async function act<T>(send: () => Promise<ActionResult<T>>, done: (d: T) => void) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setErr(''); setMsg('');
    const r = await call(send());
    busyRef.current = false; setBusy(false);
    if (!r.ok) return setErr(r.title ?? FAILED);
    done(r.data);
    router.refresh();
  }
  const reapply = () => act(() => reapplyExceptionAction(e.id), (d) => setMsg(outcomeText(d.outcome)));
  const discard = () => reason && act(() => discardExceptionAction(e.id, { reason_code: reason, ...(comment.trim() ? { comment: comment.trim() } : {}) }), () => { close(); setMsg('Discarded.'); });
  async function find() {
    const b = barcode.trim().toUpperCase();
    if (!b || busyRef.current) return;
    busyRef.current = true; setBusy(true); setLookupMsg(''); setFound(null); setPick('');
    const s = await call(lookupSpecimenAction({ barcode: b }));
    const sp = s.ok ? s.data[0] : undefined;
    const rs = sp ? await call(listOrderResultsAction(sp.order_id)) : undefined;
    busyRef.current = false; setBusy(false);
    if (!s.ok) return setLookupMsg(s.status === 404 ? NOT_FOUND : (s.title ?? FAILED));
    if (!sp) return setLookupMsg(NOT_FOUND);
    if (!rs?.ok) return setLookupMsg(rs?.title ?? FAILED);
    setFound(rs.data);
    if (rs.data.length === 0) setLookupMsg('This specimen has no open results.');
  }
  const assign = () => {
    if (!pick) return;
    const body = { result_id: pick, ...(other ? { override_analyte: true as const } : {}) };
    const sig = JSON.stringify(body);
    if (key.current?.sig !== sig) key.current = { sig, key: newKey() };
    return act(() => assignExceptionAction(e.id, body, key.current!.key), (d) => { close(); setMsg(outcomeText(d.outcome)); });
  };

  const errBox = err ? <p role="alert">{err}</p> : null;
  return (
    <section aria-label="Instrument exception">
      <PageHeader title="Instrument exception" helpKey="lab.ingest_exceptions" />
      <dl>
        <dt>Reason</dt><dd>{REASON_TEXT[e.reason] ?? e.reason}</dd>
        <dt>Status</dt><dd>{e.status}{e.resolution ? ` (${e.resolution})` : ''}</dd>
        <dt>Barcode</dt><dd>{e.sample_barcode ?? ''}</dd>
        <dt>Instrument code</dt><dd>{e.instrument_analyte_code ?? ''}</dd>
        <dt>Instrument</dt><dd>{e.instrument_id ?? ''}</dd>
        <dt>Received</dt><dd>{when(e.created_at)}</dd>
        {e.resolved_at ? <><dt>Resolved</dt><dd>{when(e.resolved_at)}</dd></> : null}
        <dt>Value</dt><dd>{e.raw_value ?? ''}</dd>
        <dt>Unit</dt><dd>{e.unit_raw ?? ''}</dd>
        <dt>Instrument flags</dt><dd>{(e.raw_flags ?? []).join(', ')}</dd>
      </dl>
      {e.reason === 'result_locked' ? <p>{LOCKED_COPY}</p> : null}
      {msg ? <p role="status">{msg}</p> : null}
      {dialog === null ? errBox : null}
      {canAct ? (
        <div>
          <Button variant="primary" isDisabled={busy} onPress={() => void reapply()}>Re-apply</Button>
          <Button variant="secondary" isDisabled={busy} onPress={() => open('assign')}>Assign</Button>
          <Button variant="danger" isDisabled={busy} onPress={() => open('discard')}>Discard</Button>
        </div>
      ) : null}

      <Dialog
        title="Discard exception"
        isOpen={dialog === 'discard'}
        onClose={close}
        footer={<><Button variant="ghost" onPress={close}>Cancel</Button><Button variant="danger" isDisabled={!reason || busy} onPress={() => void discard()}>Discard</Button></>}
      >
        {errBox}
        <NativeSelect label="Reason" name="reason" value={reason} onChange={setReason} options={discardReasons.map((r) => ({ value: r.code, label: r.display }))} />
        <TextArea label="Comment" name="comment" maxLength={COMMENT_MAX} value={comment} onChange={setComment} />
      </Dialog>

      <Dialog
        title="Assign to a result"
        isOpen={dialog === 'assign'}
        onClose={close}
        footer={<><Button variant="ghost" onPress={close}>Cancel</Button><Button variant="primary" isDisabled={!pick || busy} onPress={() => void assign()}>Assign</Button></>}
      >
        {errBox}
        <TextField label="Barcode" name="barcode" maxLength={20} value={barcode} onChange={setBarcode} />
        <Button variant="secondary" isDisabled={!barcode.trim() || busy} onPress={() => void find()}>Find</Button>
        {lookupMsg ? <p>{lookupMsg}</p> : null}
        {found && found.length > 0 ? (
          <>
            <RadioGroup label="Result" name="result" value={pick} onChange={setPick} options={found.map((r) => ({ value: r.id, label: `${r.analyte_code} (${r.status})` }))} />
            <Checkbox label="Apply to a different analyte" isSelected={other} onChange={setOther} />
          </>
        ) : null}
      </Dialog>
    </section>
  );
}
