'use client';
// /lab/specimens/{specimen_id} (04-UI-UX §3.14, 03-APP-FLOW §3.14): header, parent / replaces links, timeline, tests, results summary and the actions the
// specimen's status and the actor's permissions allow. The permission list is a UI hint only; the API enforces (REQ-SEC-068).
// Which action when = 02-TRD §4 transition table: Store S13, Discard S14 (incl. recollection_ordered, 08 A13 D-15), Reject S11, Recollect S12, Aliquot S5.
// Store / Discard / Aliquot need lab.specimen.receive, Reject / Recollect lab.specimen.reject, Print lab.specimen.label_print (02-TRD §5.1).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Dialog } from '@lims/ui/components/Dialog';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { Timeline } from '@lims/ui/components/Timeline';
import { createAliquotsAction, discardSpecimenAction, rejectSpecimenAction, requestRecollectionAction, storeSpecimenAction } from '../../server/actions';
import type { ActionResult, RejectionReason, SpecimenDetail as Detail } from '../../server/types';
import { FAILED, call, newKey, plural, statusText, utc } from '../shared';

const STORE = ['received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported'];
const DISCARD = ['stored', 'reported', 'rejected', 'recollection_ordered'];
const REJECT = ['ordered', 'collected', 'in_transit', 'received', 'aliquoted', 'in_process', 'resulted', 'verified'];
const RECOLLECT = ['rejected'];
const ALIQUOT = ['received'];
const LOCATION_MAX = 120, REASON_MAX = 200, COMMENT_MAX = 500, ALIQUOT_MAX = 10;

type Kind = 'store' | 'discard' | 'reject' | 'aliquot';
type Notice = { tone: 'success' | 'danger'; title: string };

export interface SpecimenDetailProps {
  specimen: Detail;
  rejectionReasons: readonly RejectionReason[];
  recollectionDefault: boolean;
  permissions: readonly string[];
}

const label = (s: string) => { const t = statusText(s); return t.charAt(0).toUpperCase() + t.slice(1); };
const byTime = (a: Detail['transitions'][number], b: Detail['transitions'][number]) => Date.parse(a.at) - Date.parse(b.at);

export function SpecimenDetail({ specimen: s, rejectionReasons, recollectionDefault, permissions }: SpecimenDetailProps) {
  const router = useRouter();
  const has = (p: string) => permissions.includes(p);
  const canReceive = has('lab.specimen.receive'), canReject = has('lab.specimen.reject');

  const [kind, setKind] = useState<Kind | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const keyRef = useRef(''); // one Idempotency-Key per opened dialog / pressed action: a retry after a failure replays the same request
  const [formErr, setFormErr] = useState('');
  const [fieldErr, setFieldErr] = useState('');
  const [location, setLocation] = useState('');
  const [discardReason, setDiscardReason] = useState('');
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [recollect, setRecollect] = useState(recollectionDefault);
  const [count, setCount] = useState<number | undefined>(1);
  const [picked, setPicked] = useState<string[][]>([]);

  const open = (k: Kind) => {
    setLocation(''); setDiscardReason(''); setReason(''); setComment(''); setRecollect(recollectionDefault); setCount(1); setPicked([]);
    setFormErr(''); setFieldErr(''); setNotice(null);
    keyRef.current = newKey();
    setKind(k);
  };
  const close = () => setKind(null);

  /** Runs one mutation: a failure keeps the dialog open with the API title; a success closes it, announces and refreshes the screen. */
  async function submit<T>(f: () => Promise<ActionResult<T>>, done: (data: T) => string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const r = await call(f());
    busyRef.current = false;
    setBusy(false);
    if (!r.ok) {
      const title = r.title ?? FAILED;
      if (kind) setFormErr(title); else setNotice({ tone: 'danger', title });
      return;
    }
    setKind(null);
    setNotice({ tone: 'success', title: done(r.data) });
    router.refresh();
  }

  const confirmStore = () => {
    if (!location.trim()) return setFieldErr('Location is required');
    setFieldErr('');
    void submit(() => storeSpecimenAction(s.id, s.version, { location: location.trim() }, keyRef.current), () => 'Specimen stored.');
  };
  const confirmDiscard = () => {
    if (!discardReason.trim()) return setFieldErr('Discard reason is required');
    setFieldErr('');
    void submit(() => discardSpecimenAction(s.id, s.version, { discard_reason: discardReason.trim() }, keyRef.current), () => 'Specimen discarded.');
  };
  const confirmReject = () => {
    if (!reason) return setFieldErr('Choose a reason');
    setFieldErr('');
    const body = { reason_code: reason, ...(comment.trim() ? { comment: comment.trim() } : {}), recollection_required: recollect };
    void submit(() => rejectSpecimenAction(s.id, s.version, body, keyRef.current), (d) => {
      const fresh = d?.recollection_specimen?.barcode;
      return fresh ? `Specimen rejected. New barcode ${fresh} created for recollection.` : 'Specimen rejected.';
    });
  };
  const rows = count !== undefined && count >= 1 && count <= ALIQUOT_MAX ? count : 0;
  const confirmAliquot = () => {
    if (!rows) return setFieldErr(`Number of aliquots must be between 1 and ${ALIQUOT_MAX}`);
    const aliquots = Array.from({ length: rows }, (_, i) => ({ test_ids: picked[i] ?? [] }));
    if (aliquots.some((a) => a.test_ids.length === 0)) return setFieldErr('Choose at least one test for every aliquot');
    setFieldErr('');
    void submit(() => createAliquotsAction(s.id, s.version, { aliquots }, keyRef.current), (d) => `Created ${plural(d?.aliquots?.length ?? rows, 'aliquot')}. Print their labels from the order label page.`);
  };
  const recollectNow = () => {
    keyRef.current = newKey();
    setNotice(null);
    void submit(() => requestRecollectionAction(s.id, s.version, keyRef.current), () => 'Recollection requested.');
  };
  const toggle = (i: number, testId: string) =>
    setPicked((p) => { const n = [...p]; const cur = n[i] ?? []; n[i] = cur.includes(testId) ? cur.filter((x) => x !== testId) : [...cur, testId]; return n; });

  const reasonText = (code?: string) => rejectionReasons.find((r) => r.code === code)?.display ?? code ?? '';
  const timeline = [...s.transitions].sort(byTime);
  const st = s.status;
  const confirmBtn = (text: string, onPress: () => void, variant: 'primary' | 'danger' = 'primary') => (
    <>
      <Button variant="ghost" onPress={close}>Cancel</Button>
      <Button variant={variant} isDisabled={busy} onPress={onPress}>{text}</Button>
    </>
  );
  const err = formErr ? <Banner tone="danger" title={formErr} /> : null;
  const fe = fieldErr ? { error: fieldErr } : {};

  return (
    <section aria-label="Specimen">
      <PageHeader title={`Specimen ${s.barcode}`} helpKey="lab.specimen.detail" />
      {notice ? <Banner tone={notice.tone} title={notice.title} /> : null}
      {!s.is_active ? <Banner tone="danger" title="Order cancelled — do not process" /> : null}
      {s.collection_barcode_unverified ? <Banner tone="warning" title="Collection barcode was not verified on the phlebotomy app" /> : null}

      {/* review C5.T-30 #1/#2: 04-UI-UX §3.14 DescriptionList incl. centre + processing centre (when present) */}
      <DescriptionList items={[
        { term: 'Status', value: label(st) },
        { term: 'Registration no', value: s.registration_no },
        { term: 'Specimen type', value: s.specimen_type_code },
        ...(s.container_code ? [{ term: 'Container', value: s.container_code }] : []),
        { term: 'Priority', value: label(s.priority) },
        { term: 'Centre', value: s.centre_id },
        ...(s.processing_centre_id ? [{ term: 'Processing centre', value: s.processing_centre_id }] : []),
        { term: 'Label prints', value: s.label_print_count },
        ...(s.parent_specimen_id ? [{ term: 'Parent specimen', value: <a href={`/lab/specimens/${encodeURIComponent(s.parent_specimen_id)}`}>Open parent specimen</a> }] : []),
        ...(s.replaces_specimen_id ? [{ term: 'Replaces', value: <a href={`/lab/specimens/${encodeURIComponent(s.replaces_specimen_id)}`}>Open replaced specimen</a> }] : []),
        ...(s.rejection_reason_code ? [{ term: 'Rejection', value: <>{reasonText(s.rejection_reason_code)}{s.rejected_at ? <> (<time dateTime={s.rejected_at}>{utc(s.rejected_at)}</time>)</> : null}</> }] : []),
        ...(s.rejection_comment ? [{ term: 'Rejection comment', value: s.rejection_comment }] : []),
      ]} />

      <div role="group" aria-label="Actions">
        {canReceive && STORE.includes(st) ? <Button variant="secondary" onPress={() => open('store')}>Store</Button> : null}
        {canReceive && ALIQUOT.includes(st) ? <Button variant="secondary" onPress={() => open('aliquot')}>Aliquot</Button> : null}
        {canReject && REJECT.includes(st) ? <Button variant="danger" onPress={() => open('reject')}>Reject</Button> : null}
        {canReject && RECOLLECT.includes(st) ? <Button variant="secondary" isDisabled={busy} onPress={recollectNow}>Recollect</Button> : null}
        {canReceive && DISCARD.includes(st) ? <Button variant="danger" onPress={() => open('discard')}>Discard</Button> : null}
        {has('lab.specimen.label_print') ? <a className="lims-btn lims-btn-ghost lims-btn-md" href={`/lab/orders/${encodeURIComponent(s.order_id)}/labels`}>Print labels</a> : null}
      </div>

      {has('lab.result.read') && s.results_summary ? (
        <section aria-label="Results summary">
          <h2>Results summary</h2>
          <p>{s.results_summary.total} total, {s.results_summary.resulted} resulted, {s.results_summary.verified} verified, {s.results_summary.approved} approved</p>
        </section>
      ) : null}

      <h2>Tests</h2>
      <table>
        <caption className="lims-visually-hidden">Tests on this specimen</caption>
        <thead><tr><th scope="col">Test</th></tr></thead>
        <tbody>{s.tests.map((t) => <tr key={t.test_id}><td>{t.test_code}</td></tr>)}</tbody>
      </table>

      <h2>Timeline</h2>
      <Timeline aria-label="Timeline" items={timeline.map((t) => ({ at: t.at, label: label(t.to_status) }))} />

      {kind === 'store' ? (
        <Dialog title="Store specimen" isOpen onClose={close} footer={confirmBtn('Store', confirmStore)}>
          {err}
          <TextField label="Location" name="location" isRequired maxLength={LOCATION_MAX} value={location} onChange={setLocation} {...fe} />
        </Dialog>
      ) : null}

      {kind === 'discard' ? (
        <Dialog title="Discard specimen" isOpen onClose={close} footer={confirmBtn('Discard', confirmDiscard, 'danger')}>
          {err}
          <TextField label="Discard reason" name="discard_reason" isRequired maxLength={REASON_MAX} value={discardReason} onChange={setDiscardReason} {...fe} />
        </Dialog>
      ) : null}

      {kind === 'reject' ? (
        <Dialog title={`Reject specimen ${s.barcode}`} isOpen onClose={close} footer={confirmBtn('Reject', confirmReject, 'danger')}>
          {err}
          <RadioGroup label="Reason" name="reason" isRequired value={reason} onChange={setReason} options={rejectionReasons.map((r) => ({ value: r.code, label: r.display }))} {...fe} />
          <TextArea label="Comment" name="comment" maxLength={COMMENT_MAX} value={comment} onChange={setComment} />
          <Checkbox label="Request recollection" isSelected={recollect} onChange={setRecollect} />
        </Dialog>
      ) : null}

      {kind === 'aliquot' ? (
        <Dialog title="Create aliquots" isOpen onClose={close} footer={confirmBtn('Create aliquots', confirmAliquot)}>
          {err}
          <IntegerField label="Number of aliquots" name="count" min={1} max={ALIQUOT_MAX} {...(count !== undefined ? { value: count } : {})} onChange={setCount} {...fe} />
          {Array.from({ length: rows }, (_, i) => (
            <fieldset key={i}>
              <legend>{`Aliquot ${i + 1} — Tests`}</legend>
              {s.tests.map((t) => <Checkbox key={t.test_id} label={t.test_code} isSelected={(picked[i] ?? []).includes(t.test_id)} onChange={() => toggle(i, t.test_id)} />)}
            </fieldset>
          ))}
        </Dialog>
      ) : null}
    </section>
  );
}
