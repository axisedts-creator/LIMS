'use client';
// 04-UI-UX §2.2 W2 Visit detail. Plain-JSON props from the server page; every write goes through a server action (the token stays on the server).
// LD-140 (2026-11-13): kit components and tokens only; one primary button per page (the dialogs carry theirs); every status shows tone, icon and word.
// Patient card, phone reveal (H21), review (H9), resolve (H8) and the header actions need `homecollection.visit.assign`. The number is only ever held in this
// component's state after "Show phone" and is rendered once as text: never in a URL, attribute, toast, storage or log. Reasons come from H20 (props), not code.
// Dialogs: ConfirmDialog (via ReasonConfirm) for resolve / revisit / cancel / unassign, Dialog + RadioGroup for the review.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { CodedSelect } from '@lims/ui/components/CodedSelect';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Dialog } from '@lims/ui/components/Dialog';
import { Grid } from '@lims/ui/components/Grid';
import { IconButton } from '@lims/ui/components/IconButton';
import { Inline } from '@lims/ui/components/Inline';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Stack } from '@lims/ui/components/Stack';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Timeline } from '@lims/ui/components/Timeline';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import {
  CLOSED_VISIT, OTHER_FAILURE, canRevisit, collectionStatus, dayNpt, dayOfInstant, failText, flagOf, hasPerm, holdReason, humanize, kindLabel, paymentOutcome, reviewFailText,
  SCAN_METHOD, time12, visitStatus,
} from '../labels';
import { resolveFlagAction, revealPhoneAction, revisitAction, reviewAction } from '../server/actions';
import { useSubmissionKey } from '../submission';
import type { CodedValue, Collection, SpecimenRow, VisitCodes, VisitDetail, VisitFlag } from '../types';
import { AssignDialog } from './AssignDialog';
import { CancelVisitDialog } from './CancelVisitDialog';
import { ReasonConfirm } from './ReasonConfirm';
import { ScheduleDialog } from './ScheduleDialog';
import { UnassignDialog } from './UnassignDialog';

type Iso = DateTextProps['value'];
const ASSIGN = 'homecollection.visit.assign';
const LABELS = 'lab.specimen.label_print'; // Print labels link (US-05-1)
const DASH = '—';
const MASK = '••••';
const btn = 'lims-btn lims-btn-secondary lims-btn-md';

type Dlg =
  | { kind: 'schedule' | 'assign' | 'cancel' | 'unassign' | 'revisit' }
  | { kind: 'review'; collection: Collection }
  | { kind: 'resolve'; flag: VisitFlag };

export interface VisitDetailViewProps {
  visit: VisitDetail;
  permissions: readonly string[];
  codes: VisitCodes;
}

const lookup = (set: readonly CodedValue[], code: string | undefined) => (code ? set.find((c) => c.code === code)?.display ?? humanize(code) : DASH);
const at = (iso: string | undefined) => (iso ? <DateText value={iso as Iso} withTime /> : DASH);

function Chip({ tone, label, status }: { tone: Parameters<typeof StatusChip>[0]['tone']; label: string; status: string }) {
  return <StatusChip kind="generic" status={status} {...(tone ? { tone } : {})} label={label} />;
}

/** H21: one POST per press (single-flight); the number only lives in this state. Failure keeps it masked, in plain words. */
function PhoneRow({ visitId }: { visitId: string }) {
  const busy = useRef(false);
  const [phone, setPhone] = useState<string | null | undefined>(undefined); // undefined = masked, null = none on file
  const [error, setError] = useState('');
  const show = async () => {
    if (busy.current) return;
    busy.current = true;
    setError('');
    try {
      const r = await revealPhoneAction(visitId);
      if (r.ok) setPhone(r.phone ?? null);
      else setError(r.code === 'auth.forbidden' ? failText(r) : OTHER_FAILURE);
    } finally {
      busy.current = false;
    }
  };
  if (phone === null) return <>No phone number on file.</>;
  if (phone !== undefined) return <>{phone}</>;
  return (
    <Inline gap={1}>
      <span>{MASK}</span>
      <IconButton label="Show phone" icon="current" onPress={() => void show()} />
      {error ? <span role="alert">{error}</span> : null}
    </Inline>
  );
}

interface ReviewDialogProps { collection: Collection; reasons: readonly CodedValue[]; isOpen: boolean; onClose: () => void }
type Decision = 'apply' | 'discard';
interface Errs { decision?: string; code?: string; text?: string }
const NO_APPLY = ['homecollection.mutation_superseded', 'homecollection.barcode_mismatch'];

/** §2.2 Review dialog (H9): Apply / Discard + reason (H20) + details ≤ 500. After the server refuses Apply only Discard remains (US-09-2). */
function ReviewDialog({ collection, reasons, isOpen, onClose }: ReviewDialogProps) {
  const router = useRouter();
  const toast = useToast();
  const keyFor = useSubmissionKey();
  const inFlight = useRef(false);
  const saved = useRef(false); // done: the dialog is closing, a further click must not send a second request
  const [decision, setDecision] = useState<Decision | ''>('');
  const [code, setCode] = useState<string>();
  const [text, setText] = useState('');
  const [errs, setErrs] = useState<Errs>({});
  const [serverError, setServerError] = useState('');
  const [noApply, setNoApply] = useState(collection.hold_code === 'barcode_mismatch');
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (inFlight.current || saved.current) return;
    const details = text.trim();
    const e: Errs = {};
    if (!decision) e.decision = 'Choose Apply or Discard.';
    if (!code) e.code = 'Choose a reason.';
    else if (reasons.find((r) => r.code === code)?.requires_text && !details) e.text = 'Enter details for this reason.';
    setErrs(e);
    if (!decision || !code || e.text) return;
    inFlight.current = true;
    setPending(true);
    setServerError('');
    try {
      const res = await reviewAction(collection.id, collection.version, decision, code, details || undefined, keyFor(`${decision}|${code}|${details}`));
      if (!res.ok) {
        if (NO_APPLY.includes(res.code)) { setNoApply(true); setDecision(''); }
        setServerError(reviewFailText(res));
        return;
      }
      saved.current = true;
      toast.show({ tone: 'success', title: decision === 'apply' ? 'Collection applied.' : 'Collection discarded.' });
      router.refresh();
      onClose();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      title="Review held tube" isOpen={isOpen} onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={pending}>Cancel</Button>
          <Button variant="primary" onPress={() => void submit()} isLoading={pending}>{decision === 'apply' ? 'Apply' : decision === 'discard' ? 'Discard' : 'Confirm'}</Button>
        </>
      }
    >
      <p>{holdReason(collection.hold_code)}</p>
      {noApply ? <p>This tube cannot be applied. Discard it, and collect it again if it is still needed.</p> : null}
      <RadioGroup<Decision | ''>
        label="Decision" name="decision" value={decision} onChange={setDecision}
        options={[{ value: 'apply', label: 'Apply', isDisabled: noApply }, { value: 'discard', label: 'Discard' }]}
        {...(errs.decision ? { error: errs.decision } : {})}
      />
      <CodedSelect
        label="Reason" name="reason_code" codedSet="homecollection.review_reasons" isRequired
        options={reasons.map((r) => ({ code: r.code, display: r.display, isActive: r.is_active !== false }))}
        {...(code ? { value: code } : {})} {...(errs.code ? { error: errs.code } : {})} onChange={setCode}
      />
      <TextField label="Details" name="reason_text" maxLength={500} value={text} onChange={setText} {...(errs.text ? { error: errs.text } : {})} />
      {serverError ? <div role="alert"><Banner tone="danger" title={serverError} /></div> : null}
    </Dialog>
  );
}

/** The latest collection of a tube wins (the array is the server's order). */
const latestOf = (cols: readonly Collection[], specimenId: string) => [...cols].reverse().find((c) => c.specimen_id === specimenId);

export function VisitDetailView({ visit, permissions, codes }: VisitDetailViewProps) {
  const router = useRouter();
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const canAssign = hasPerm(permissions, ASSIGN);
  const canLabels = canAssign && hasPerm(permissions, LABELS) && !!visit.order_id;
  const close = () => setDlg(null);
  const [tone, label] = visitStatus(visit.status);
  const closed = (CLOSED_VISIT as readonly string[]).includes(visit.status);
  const held = visit.collections.filter((c) => c.status === 'held');
  const boardDate = dayOfInstant(visit.window_start) ?? visit.route_date ?? dayNpt();
  const a = visit.address;

  const actions = canAssign ? (
    <Inline gap={2}>
      {!closed && (visit.status === 'unassigned' || visit.status === 'assigned') ? <Button onPress={() => setDlg({ kind: 'schedule' })}>Schedule</Button> : null}
      {visit.status === 'unassigned' ? <Button onPress={() => setDlg({ kind: 'assign' })}>Assign</Button> : null}
      {visit.status === 'assigned' ? <Button onPress={() => setDlg({ kind: 'assign' })}>Reassign</Button> : null}
      {visit.status === 'assigned' ? <Button onPress={() => setDlg({ kind: 'unassign' })}>Unassign</Button> : null}
      {visit.status === 'unassigned' || visit.status === 'assigned' ? <Button variant="danger" onPress={() => setDlg({ kind: 'cancel' })}>Cancel visit</Button> : null}
      {canRevisit(visit.status, visit.outcome) ? <Button onPress={() => setDlg({ kind: 'revisit' })}>Create revisit</Button> : null}
      {visit.order_id ? <a className={btn} href={`/frontdesk/orders/${visit.order_id}`}>Open order</a> : null}
      {canLabels ? <a className={btn} href={`/lab/orders/${visit.order_id}/labels`}>Print labels</a> : null}
    </Inline>
  ) : undefined;

  const specimenName = (id: string) => humanize(visit.specimens.find((s) => s.specimen_id === id)?.specimen_type_code);

  const tubeCols: ColumnDef<SpecimenRow>[] = [
    { id: 'type', header: 'Specimen type', isRowHeader: true, cell: (s) => humanize(s.specimen_type_code) },
    { id: 'container', header: 'Container', cell: (s) => (s.container_code ? humanize(s.container_code) : DASH) },
    { id: 'lab', header: 'Lab status', cell: (s) => <StatusChip kind="specimen" status={s.status} /> },
    { id: 'at', header: 'Collected at', cell: (s) => at(s.collected_at) },
    {
      id: 'collection', header: 'Collection',
      cell: (s) => {
        const c = collectionStatus(latestOf(visit.collections, s.specimen_id)?.status ?? s.collection_status);
        return c ? <Chip tone={c[0]} label={c[1]} status={c[1]} /> : DASH;
      },
    },
    {
      id: 'scan', header: 'Scan',
      cell: (s) => {
        const m = latestOf(visit.collections, s.specimen_id)?.scan_method ?? s.scan_method;
        if (!m) return DASH;
        if (m === 'typed' && s.barcode_verified === false) return <Chip tone="warning" label="Typed — not verified" status="typed_unverified" />;
        return SCAN_METHOD[m] ?? humanize(m);
      },
    },
  ];

  const holdCols: ColumnDef<Collection>[] = [
    { id: 'tube', header: 'Tube', isRowHeader: true, cell: (c) => specimenName(c.specimen_id) },
    { id: 'by', header: 'Collected by', cell: (c) => c.collected_by?.display_name ?? DASH },
    { id: 'reason', header: 'Reason', cell: (c) => holdReason(c.hold_code) },
    { id: 'act', header: 'Action', cell: (c) => (canAssign ? <Button size="sm" onPress={() => setDlg({ kind: 'review', collection: c })}>Review</Button> : null) },
  ];

  const payCols: ColumnDef<VisitDetail['payments'][number]>[] = [
    { id: 'method', header: 'Method', isRowHeader: true, cell: (p) => humanize(p.method_code) },
    { id: 'amount', header: 'Amount', align: 'end', cell: (p) => <MoneyText value={{ amountPaisa: p.amount.amount_paisa, currency: 'NPR' }} /> },
    { id: 'at', header: 'Captured at', cell: (p) => at(p.captured_at) },
    { id: 'result', header: 'Upload result', cell: (p) => { const [t, l] = paymentOutcome(p.outcome); return <Chip tone={t} label={l} status={p.outcome ?? ''} />; } },
  ];

  const events = [
    ...visit.transitions.map((t) => ({ at: t.at, label: `Status: ${visitStatus(t.to)[1]}`, ...(t.actor_display ? { actor: t.actor_display } : {}) })),
    ...visit.assignments.map((x) => ({ at: x.assigned_at, label: `Assigned to ${x.display_name} for ${x.route_date}`, ...(x.assigned_by_display ? { actor: x.assigned_by_display } : {}) })),
    ...visit.collections.flatMap((c) =>
      c.review ? [{ at: c.review.at ?? c.collected_at ?? '', label: `Tube review: ${c.review.decision} (${lookup(codes.review_reasons, c.review.reason_code)})`, ...(c.review.by_display ? { actor: c.review.by_display } : {}) }] : [],
    ),
  ].filter((e) => e.at).sort((x, y) => Date.parse(x.at) - Date.parse(y.at));

  return (
    <div>
      <PageHeader
        title="Home visit" helpKey="homecollection.visit"
        status={<Inline gap={2}><Chip tone={tone} label={label} status={visit.status} /><Chip tone="neutral" label={kindLabel(visit.kind)} status={visit.kind} /></Inline>}
        actions={actions}
      />
      {canAssign && held.length ? <Banner tone="warning" title={`${held.length} ${held.length === 1 ? 'tube is' : 'tubes are'} on hold and need a review.`} /> : null}
      <Grid columns={2}>
        {canAssign ? (
          <Card title="Patient and address">
            <DescriptionList
              items={[
                { term: 'Name', value: visit.patient_display_name || DASH },
                ...(visit.registration_no ? [{ term: 'Registration no.', value: visit.registration_no }] : []),
                { term: 'Phone', value: <PhoneRow visitId={visit.id} /> },
                { term: 'Address', value: a?.address_text ?? DASH },
                { term: 'Landmark', value: a?.landmark ?? DASH },
                { term: 'Coordinates', value: a?.latitude && a.longitude ? `${a.latitude}, ${a.longitude}` : DASH },
                { term: 'Note', value: visit.note_for_phlebotomist ?? DASH },
              ]}
            />
          </Card>
        ) : null}
        <Card title="Schedule">
          <DescriptionList
            items={[
              {
                term: 'Window',
                value: visit.window_start ? <>{at(visit.window_start)}{visit.window_end ? ` – ${time12(visit.window_end)}` : ''}</> : 'Not scheduled',
              },
              { term: 'Route date', value: visit.route_date ?? DASH },
              { term: 'Phlebotomist', value: visit.phlebotomist?.display_name ?? DASH },
              { term: 'Sequence', value: visit.route_sequence !== undefined ? `Stop ${visit.route_sequence} on the route` : DASH },
              { term: 'Phone updated at', value: visit.last_device_ack_at ? at(visit.last_device_ack_at) : 'Never' },
            ]}
          />
        </Card>
        <Card title="Tubes">
          <DataTable<SpecimenRow> caption="Tubes" columns={tubeCols} rows={visit.specimens} getRowId={(s) => s.specimen_id} density="compact" emptyState={{ title: 'No tubes yet.' }} />
        </Card>
        {held.length ? (
          <Card title="On hold">
            <DataTable<Collection> caption="Tubes on hold" columns={holdCols} rows={held} getRowId={(c) => c.id} density="compact" emptyState={{ title: 'Nothing is on hold.' }} />
          </Card>
        ) : null}
        <Card title="Payments">
          <DataTable<VisitDetail['payments'][number]>
            caption="Payments" columns={payCols} rows={visit.payments} getRowId={(p) => `${p.method_code}:${p.captured_at ?? ''}:${p.amount.amount_paisa}`} density="compact"
            emptyState={{ title: 'No payments taken.' }}
          />
          {canAssign && visit.order_id ? <a className={btn} href={`/frontdesk/orders/${visit.order_id}`}>Open billing</a> : null}
        </Card>
        <Card title="Needs attention">
          {visit.flags.length ? (
            <Stack>
              {visit.flags.map((f) => {
                const [t, l] = flagOf(f.kind);
                const open = f.status === 'open';
                return (
                  <Inline key={f.id} gap={2}>
                    <Chip tone={t} label={l} status={f.kind} />
                    {open ? null : <Chip tone="success" label="Resolved" status="resolved" />}
                    {open ? null : (
                      <span>
                        {lookup(codes.flag_resolutions, f.resolution_code)}
                        {f.resolved_by_display ? ` · ${f.resolved_by_display}` : ''}
                      </span>
                    )}
                    {open && canAssign ? <Button size="sm" onPress={() => setDlg({ kind: 'resolve', flag: f })}>Resolve</Button> : null}
                  </Inline>
                );
              })}
            </Stack>
          ) : (
            <p>Nothing needs attention.</p>
          )}
        </Card>
        <Card title="Timeline">
          <Timeline items={events} />
        </Card>
      </Grid>

      {dlg?.kind === 'schedule' ? <ScheduleDialog key={`${visit.id}:${visit.version}`} visit={visit} boardDate={boardDate} isOpen onClose={close} /> : null}
      {dlg?.kind === 'assign' ? <AssignDialog key={`${visit.id}:${visit.version}`} visit={visit} centreId={visit.centre_id} boardDate={boardDate} isOpen onClose={close} /> : null}
      {dlg?.kind === 'cancel' ? <CancelVisitDialog key={`${visit.id}:${visit.version}`} visit={visit} reasons={codes.visit_cancel_reasons} isOpen onClose={close} /> : null}
      {dlg?.kind === 'unassign' ? <UnassignDialog key={`${visit.id}:${visit.version}`} visit={visit} reasons={codes.unassign_reasons} isOpen onClose={close} /> : null}
      {dlg?.kind === 'revisit' ? (
        <ReasonConfirm
          key={`${visit.id}:${visit.version}`} isOpen onClose={close} tone="default" title="Create a revisit?" confirmLabel="Create revisit"
          codedSet="homecollection.revisit_reasons" reasons={codes.revisit_reasons} doneTitle="Revisit created."
          body={<p>A new visit is made for this patient. It starts unassigned.</p>}
          submit={(code, text, key) => revisitAction(visit.id, visit.version, code, text, key)}
          onDone={(r) => { if (r.id) router.push(`/homecollection/visits/${r.id}`); }}
        />
      ) : null}
      {dlg?.kind === 'resolve' ? (
        <ReasonConfirm
          key={`${dlg.flag.id}:${dlg.flag.version}`} isOpen onClose={close} tone="default" title="Resolve this flag?" confirmLabel="Resolve"
          codedSet="homecollection.flag_resolutions" reasons={codes.flag_resolutions} doneTitle="Flag resolved."
          body={<p>{flagOf(dlg.flag.kind)[1]}</p>}
          submit={(code, text, key) => resolveFlagAction(visit.id, dlg.flag.id, dlg.flag.version, code, text, key)}
        />
      ) : null}
      {dlg?.kind === 'review' ? <ReviewDialog key={`${dlg.collection.id}:${dlg.collection.version}`} collection={dlg.collection} reasons={codes.review_reasons} isOpen onClose={close} /> : null}
    </div>
  );
}
