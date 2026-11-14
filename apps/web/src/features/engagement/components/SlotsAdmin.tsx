'use client';
// C16.T-B6 W4 Slot templates & blackouts (04-UI-UX W4; TRD S7–S11; AC-16.1–16.4). Master list + right Drawer per form (LD-140).
// The weekday/time editor is the kit WeekdayTimeRangeEditor (CR-C16-016, LD-146); it does not validate — this form does.
import { useEffect, useRef, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable } from '@lims/ui/components/DataTable';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { DateTimePicker, type DateTimePickerProps } from '@lims/ui/components/DateTimePicker';
import { Drawer } from '@lims/ui/components/Drawer';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { TextArea } from '@lims/ui/components/TextArea';
import { WeekdayTimeRangeEditor, type WeekdayTimeRangeValue } from '@lims/ui/components/WeekdayTimeRangeEditor';
import {
  DAY_MS, KIND_LABEL, KIND_OPTIONS, REASON_LABEL, bookingProblem, dateTime, dmy, num,
  type BlackoutReason, type BookingKind, type Centre, type SlotBlackout, type SlotTemplate,
} from './booking-model';

export interface SlotTemplateBody {
  centre_id: string; booking_kind: BookingKind; weekdays: number[]; start_local: string; end_local: string; slot_minutes: number; capacity: number; effective_from: string; effective_to?: string;
}
export interface SlotBlackoutBody { centre_id: string; booking_kind?: BookingKind; starts_at: string; ends_at: string; reason_code: BlackoutReason; note?: string }
export interface SlotsAdminActions {
  createTemplate(body: SlotTemplateBody): Promise<SlotTemplate & { affected?: { overbooked_slots: number } }>;
  updateTemplate(template: SlotTemplate, body: SlotTemplateBody): Promise<SlotTemplate & { affected?: { overbooked_slots: number } }>;
  deactivateTemplate(template: SlotTemplate): Promise<void>;
  createBlackout(body: SlotBlackoutBody): Promise<SlotBlackout & { affected?: { future_bookings: number } }>;
  deactivateBlackout(blackout: SlotBlackout): Promise<void>;
}
export interface SlotsAdminProps { centres: readonly Centre[]; workingCentreId: string; today: string; templates: readonly SlotTemplate[]; blackouts: readonly SlotBlackout[]; actions: SlotsAdminActions }

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_BLACKOUT_DAYS = 31;
const NOTE_MAX = 200;
/** [CONV] input cap above the real limit so an over-long note is refused with a message instead of being cut by the input. */
const NOTE_INPUT_CAP = 2000;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
type Errors = Record<string, string | undefined>;
type Utc = NonNullable<DateTimePickerProps['value']>;
const fe = (e: Errors, k: string): { error?: string } => (e[k] ? { error: e[k]! } : {});
const activeChip = (on: boolean) => <StatusChip kind="generic" status={on ? 'active' : 'inactive'} tone={on ? 'success' : 'neutral'} label={on ? 'Active' : 'Inactive'} />;
const centreLabel = (c: Centre) => `${c.display_name}${c.is_home_collection ? ' (Home collection)' : ''}`;
const upsert = <T extends { id: string }>(l: readonly T[], x: T) => (l.some((y) => y.id === x.id) ? l.map((y) => (y.id === x.id ? x : y)) : [...l, x]);

/** Pure checks for the template form (AC-16.1). */
export function checkTemplate(v: { weekdays: number[]; start: string; end: string; slot?: number | undefined; capacity?: number | undefined; from?: string | undefined; to?: string | undefined; centre?: string | undefined }): Errors {
  return {
    centre: v.centre ? undefined : 'Choose a centre',
    weekdays: v.weekdays.length ? undefined : 'Choose at least one day',
    time: !HHMM.test(v.start) || !HHMM.test(v.end) ? 'Enter start and end as HH:MM' : v.end <= v.start ? 'End must be after start' : undefined,
    slot: v.slot === undefined || !Number.isInteger(v.slot) || v.slot < 5 || v.slot > 240 || v.slot % 5 !== 0 ? 'Slot length must be between 5 and 240 minutes, in steps of 5' : undefined,
    capacity: v.capacity === undefined || !Number.isInteger(v.capacity) || v.capacity < 1 || v.capacity > 100 ? 'Capacity must be between 1 and 100' : undefined,
    from: v.from ? undefined : 'Enter Effective from',
    to: v.to && v.from && v.to < v.from ? 'Effective to must be on or after Effective from' : undefined,
  };
}

function TemplateForm({ centres, workingCentreId, today, template, actions, onSaved, onClose }: {
  centres: readonly Centre[]; workingCentreId: string; today: string; template?: SlotTemplate | undefined; actions: SlotsAdminActions;
  onSaved: (t: SlotTemplate, overbooked: number) => void; onClose: () => void;
}) {
  const [centre, setCentre] = useState<string | undefined>(template?.centre_id ?? (centres.some((c) => c.id === workingCentreId) ? workingCentreId : centres[0]?.id));
  const [kind, setKind] = useState<BookingKind>(template?.booking_kind ?? 'centre_visit');
  const [range, setRange] = useState<WeekdayTimeRangeValue>({ weekdays: template?.weekdays ?? [1, 2, 3, 4, 5], start: template?.start_local ?? '07:00', end: template?.end_local ?? '11:00' });
  const [slot, setSlot] = useState<number | undefined>(template?.slot_minutes ?? 15);
  const [capacity, setCapacity] = useState<number | undefined>(template?.capacity ?? 3);
  const [from, setFrom] = useState<string | undefined>(template?.effective_from ?? today);
  const [to, setTo] = useState<string | undefined>(template?.effective_to);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    const e = checkTemplate({ ...range, slot, capacity, from, to, centre });
    setErrors(e);
    const bad = Object.values(e).filter(Boolean);
    if (bad.length) { setFailure(`Check the form: ${bad.join('; ')}.`); return; }
    const body: SlotTemplateBody = {
      centre_id: centre!, booking_kind: kind, weekdays: range.weekdays, start_local: range.start, end_local: range.end, slot_minutes: slot!, capacity: capacity!, effective_from: from!,
      ...(to ? { effective_to: to } : {}),
    };
    setBusy(true);
    setFailure(undefined);
    try {
      const { affected, ...saved } = await (template ? actions.updateTemplate(template, body) : actions.createTemplate(body));
      onSaved(saved, affected?.overbooked_slots ?? 0);
    } catch (err) {
      setFailure(bookingProblem(err));
      setBusy(false);
    }
  };
  return (
    <Drawer title={template ? 'Edit slot template' : 'New slot template'} isOpen onClose={onClose}>
      <div className="lims-stack">
        <Select label="Centre" name="centre_id" isRequired options={centres.map((c) => ({ value: c.id, label: centreLabel(c) }))} {...(centre ? { value: centre } : {})} onChange={setCentre} {...fe(errors, 'centre')} />
        <RadioGroup label="Type" name="booking_kind" orientation="horizontal" value={kind} onChange={setKind} options={KIND_OPTIONS} />
        <WeekdayTimeRangeEditor value={range} onChange={setRange} minuteStep={15} />
        {errors['weekdays'] ? <p className="lims-error">{errors['weekdays']}</p> : null}
        {errors['time'] ? <p className="lims-error">{errors['time']}</p> : null}
        <IntegerField label="Slot length (min)" name="slot_minutes" min={5} max={240} step={5} {...(slot !== undefined ? { value: slot } : {})} onChange={setSlot} {...fe(errors, 'slot')} />
        <IntegerField label="Capacity per slot" name="capacity" min={1} max={100} {...(capacity !== undefined ? { value: capacity } : {})} onChange={setCapacity} {...fe(errors, 'capacity')} />
        <DatePicker label="Effective from" name="effective_from" isRequired value={from as IsoDate | undefined} onChange={setFrom} {...fe(errors, 'from')} />
        <DatePicker label="Effective to" name="effective_to" value={to as IsoDate | undefined} onChange={setTo} {...fe(errors, 'to')} />
        {failure ? <p role="alert" className="lims-error">{failure}</p> : null}
        <div className="lims-inline">
          <Button variant="ghost" onPress={onClose}>Cancel</Button>
          <Button variant="primary" isLoading={busy} onPress={() => void save()}>Save</Button>
        </div>
      </div>
    </Drawer>
  );
}

function BlackoutForm({ centres, workingCentreId, actions, onSaved, onClose }: {
  centres: readonly Centre[]; workingCentreId: string; actions: SlotsAdminActions; onSaved: (b: SlotBlackout, affected: number) => void; onClose: () => void;
}) {
  const [centre, setCentre] = useState<string | undefined>(centres.some((c) => c.id === workingCentreId) ? workingCentreId : centres[0]?.id);
  const [kind, setKind] = useState<BookingKind | 'all'>('all');
  const [from, setFrom] = useState<string>();
  const [to, setTo] = useState<string>();
  const [reason, setReason] = useState<BlackoutReason>();
  const note = useRef('');
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    const span = from && to ? Date.parse(to) - Date.parse(from) : 0;
    const e: Errors = {
      centre: centre ? undefined : 'Choose a centre',
      from: from ? undefined : 'Enter From',
      to: !to ? 'Enter To' : from && span <= 0 ? 'To must be after From' : span > MAX_BLACKOUT_DAYS * DAY_MS ? `A blackout can be at most ${MAX_BLACKOUT_DAYS} days` : undefined,
      reason: reason ? undefined : 'Choose a reason',
      note: note.current.length > NOTE_MAX ?`Note must be ${NOTE_MAX} characters or fewer` : undefined,
    };
    setErrors(e);
    const bad = Object.values(e).filter(Boolean);
    if (bad.length) { setFailure(`Check the form: ${bad.join('; ')}.`); return; }
    const body: SlotBlackoutBody = { centre_id: centre!, ...(kind !== 'all' ? { booking_kind: kind } : {}), starts_at: from!, ends_at: to!, reason_code: reason!, ...(note.current.trim() ? { note: note.current.trim() } : {}) };
    setBusy(true);
    setFailure(undefined);
    try {
      const { affected, ...saved } = await actions.createBlackout(body);
      onSaved(saved, affected?.future_bookings ?? 0);
    } catch (err) {
      setFailure(bookingProblem(err));
      setBusy(false);
    }
  };
  return (
    <Drawer title="Add blackout" isOpen onClose={onClose}>
      <div className="lims-stack">
        <Select label="Centre" name="centre_id" isRequired options={centres.map((c) => ({ value: c.id, label: centreLabel(c) }))} {...(centre ? { value: centre } : {})} onChange={setCentre} {...fe(errors, 'centre')} />
        <RadioGroup label="Type" name="booking_kind" orientation="horizontal" value={kind} onChange={setKind} options={[{ value: 'all' as const, label: 'All types' }, ...KIND_OPTIONS]} />
        <DateTimePicker label="From" name="starts_at" isRequired {...(from ? { value: from as Utc } : {})} onChange={(v) => setFrom(v)} {...fe(errors, 'from')} />
        <DateTimePicker label="To" name="ends_at" isRequired {...(to ? { value: to as Utc } : {})} onChange={(v) => setTo(v)} {...fe(errors, 'to')} />
        <Select label="Reason" name="reason_code" isRequired options={(Object.keys(REASON_LABEL) as BlackoutReason[]).map((r) => ({ value: r, label: REASON_LABEL[r] }))} {...(reason ? { value: reason } : {})} onChange={setReason} {...fe(errors, 'reason')} />
        {/* Uncontrolled: typing re-renders only the field, not the whole drawer; the value is read on Save. */}
        <TextArea label="Note" name="note" maxLength={NOTE_INPUT_CAP} showCount={false} description={`Up to ${NOTE_MAX} characters.`} onChange={(v) => { note.current = v; }} {...fe(errors, 'note')} />
        {failure ? <p role="alert" className="lims-error">{failure}</p> : null}
        <div className="lims-inline">
          <Button variant="ghost" onPress={onClose}>Cancel</Button>
          <Button variant="primary" isLoading={busy} onPress={() => void save()}>Save</Button>
        </div>
      </div>
    </Drawer>
  );
}

export function SlotsAdmin({ centres, workingCentreId, today, templates: t0, blackouts: b0, actions }: SlotsAdminProps) {
  const [templates, setTemplates] = useState<readonly SlotTemplate[]>(t0);
  const [blackouts, setBlackouts] = useState<readonly SlotBlackout[]>(b0);
  useEffect(() => setTemplates(t0), [t0]); // fresh rows (new versions) after router.refresh()
  useEffect(() => setBlackouts(b0), [b0]);
  const [form, setForm] = useState<{ kind: 'template'; row?: SlotTemplate } | { kind: 'blackout' } | null>(null);
  const [notice, setNotice] = useState<{ tone: 'warning' | 'info'; text: string } | null>(null);
  const [deactivate, setDeactivate] = useState<{ kind: 'template'; row: SlotTemplate } | { kind: 'blackout'; row: SlotBlackout } | null>(null);
  const [failure, setFailure] = useState<string>();
  const centreName = new Map(centres.map((c) => [c.id, centreLabel(c)]));
  const close = () => setForm(null);

  return (
    <div className="lims-stack">
      {notice ? <Banner tone={notice.tone} title={notice.text} /> : null}
      {failure ? <p role="alert" className="lims-error">{failure}</p> : null}

      <h2 className="lims-section-title">Slot templates</h2>
      <div className="lims-inline"><Button variant="primary" onPress={() => setForm({ kind: 'template' })}>New template</Button></div>
      <DataTable
        caption="Slot templates"
        rows={templates}
        getRowId={(t) => t.id}
        emptyState={{ title: 'No slot templates yet.' }}
        columns={[
          { id: 'centre', header: 'Centre', isRowHeader: true, cell: (t) => centreName.get(t.centre_id) ?? '—' },
          { id: 'type', header: 'Type', cell: (t) => KIND_LABEL[t.booking_kind] ?? t.booking_kind },
          {
            id: 'days', header: 'Days', cell: (t) => (
              <span className="lims-inline">{t.weekdays.map((d) => <StatusChip key={d} kind="generic" status={String(d)} tone="info" size="sm" label={DAYS[d - 1] ?? String(d)} />)}</span>
            ),
          },
          { id: 'hours', header: 'Hours', cell: (t) => `${t.start_local}–${t.end_local}` },
          { id: 'slot', header: 'Slot (min)', align: 'end', cell: (t) => num(t.slot_minutes) },
          { id: 'capacity', header: 'Capacity', align: 'end', cell: (t) => num(t.capacity) },
          { id: 'effective', header: 'Effective', cell: (t) => (t.effective_to ? `${dmy(t.effective_from)} – ${dmy(t.effective_to)}` : `From ${dmy(t.effective_from)}`) },
          { id: 'active', header: 'Active', cell: (t) => activeChip(t.is_active) },
          {
            id: 'actions', header: 'Actions', cell: (t) => (
              <span className="lims-inline">
                <Button size="sm" onPress={() => setForm({ kind: 'template', row: t })}>Edit</Button>
                {t.is_active ? <Button size="sm" variant="ghost" onPress={() => setDeactivate({ kind: 'template', row: t })}>Deactivate</Button> : null}
              </span>
            ),
          },
        ]}
      />

      <h2 className="lims-section-title">Blackouts</h2>
      <div className="lims-inline"><Button onPress={() => setForm({ kind: 'blackout' })}>Add blackout</Button></div>
      <DataTable
        caption="Slot blackouts"
        rows={blackouts}
        getRowId={(b) => b.id}
        emptyState={{ title: 'No blackouts.' }}
        columns={[
          { id: 'centre', header: 'Centre', isRowHeader: true, cell: (b) => centreName.get(b.centre_id) ?? '—' },
          { id: 'type', header: 'Type', cell: (b) => (b.booking_kind ? KIND_LABEL[b.booking_kind] : 'All types') },
          { id: 'period', header: 'Period', cell: (b) => `${dateTime(b.starts_at)} – ${dateTime(b.ends_at)}` },
          { id: 'reason', header: 'Reason', cell: (b) => REASON_LABEL[b.reason_code] ?? b.reason_code },
          { id: 'note', header: 'Note', cell: (b) => b.note || '—' },
          { id: 'active', header: 'Active', cell: (b) => activeChip(b.is_active) },
          { id: 'actions', header: 'Actions', cell: (b) => (b.is_active ? <Button size="sm" variant="ghost" onPress={() => setDeactivate({ kind: 'blackout', row: b })}>Deactivate</Button> : null) },
        ]}
      />

      {form?.kind === 'template' ? (
        <TemplateForm
          centres={centres} workingCentreId={workingCentreId} today={today} template={form.row} actions={actions} onClose={close}
          onSaved={(t, n) => {
            setTemplates((l) => upsert(l, t));
            setNotice(n > 0 ? { tone: 'warning', text: `${n} future slots now have more bookings than capacity. Review them in Bookings.` } : null);
            close();
          }}
        />
      ) : null}
      {form?.kind === 'blackout' ? (
        <BlackoutForm
          centres={centres} workingCentreId={workingCentreId} actions={actions} onClose={close}
          onSaved={(b, n) => {
            setBlackouts((l) => upsert(l, b));
            setNotice({ tone: n > 0 ? 'warning' : 'info', text: `${n} existing bookings fall in this period — they are not cancelled automatically.` });
            close();
          }}
        />
      ) : null}
      <ConfirmDialog
        title={deactivate?.kind === 'blackout' ? 'Deactivate this blackout?' : 'Deactivate this template?'}
        body={<p>{deactivate?.kind === 'blackout' ? 'Slots in this period become bookable again.' : 'No new slots are offered from this template. Existing bookings are kept.'}</p>}
        confirmLabel="Deactivate"
        tone="danger"
        isOpen={!!deactivate}
        onCancel={() => setDeactivate(null)}
        onConfirm={async () => {
          const d = deactivate;
          if (!d) return;
          try {
            if (d.kind === 'template') { await actions.deactivateTemplate(d.row); setTemplates((l) => upsert(l, { ...d.row, is_active: false })); }
            else { await actions.deactivateBlackout(d.row); setBlackouts((l) => upsert(l, { ...d.row, is_active: false })); }
            setFailure(undefined);
          } catch (err) {
            setFailure(bookingProblem(err));
          }
          setDeactivate(null);
        }}
      />
    </div>
  );
}
