'use client';
// W9 Reminders (04-UI-UX §3 W9; US-EN-23). Filters live in the URL (due range ≤ 92 days, status, kind). Create = R2, cancel (scheduled rows only) = R3.
// LD-140 (2026-11-13): packages/ui components and token classes only; no hex colours, pixel radii or inline styles; one primary button per page.
// Message content is fixed by the template (params {lab_name, datetime} only): the form never asks for text, test names or results (REQ-SEC-007/-070).
import { useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { CodedSelect } from '@lims/ui/components/CodedSelect';
import { Combobox } from '@lims/ui/components/Combobox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DateText, type DateTextProps } from '@lims/ui/components/DateText';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { cancelReminderAction, createReminderAction } from './actions';

export interface ReminderRow {
  id: string; patient_id: string; patient_display: string; kind: string; reason_code?: string; source: string;
  due_at: string; status: string; sent_at?: string; failure_code?: string; version: number;
}
export interface ReasonOption { code: string; display: string; isActive: boolean }
export interface PatientOption { id: string; display: string }
export interface RemindersViewProps {
  reminders: readonly ReminderRow[];
  permissions: readonly string[];
  reasons: readonly ReasonOption[];
  searchPatients: (query: string) => Promise<readonly PatientOption[]>;
  nextCursor?: string;
  hasPrevious?: boolean;
}

const MANAGE = 'engagement.reminder.manage';
const MIN_LEAD_MS = 3_600_000; // due_at ≥ now + 1 h
const MAX_RANGE_DAYS = 92;
const STATUS_LABEL: Record<string, [string, 'neutral' | 'info' | 'success' | 'warning' | 'danger']> = {
  scheduled: ['Scheduled', 'info'], sent: ['Sent', 'success'], suppressed: ['Suppressed', 'warning'], cancelled: ['Cancelled', 'neutral'], failed: ['Failed', 'danger'],
};
const KIND_LABEL: Record<string, string> = { custom: 'Manual', follow_up: 'Follow-up', booking: 'Booking' };
// Plain-text Result for the port's suppression codes; the raw code is never shown.
const RESULT_TEXT: Record<string, string> = {
  suppressed_no_consent: 'No SMS consent', suppressed_no_contact: 'No phone number', suppressed_channel_disabled: 'SMS turned off', opted_out: 'Patient opted out',
};
const ERROR_TEXT: Record<string, string> = {
  'engagement.reminder_invalid_transition': 'Reminder cannot change: it was already sent or cancelled.',
  'common.version_conflict': 'Someone else changed this. Reload to see the latest.', // 04-UI-UX §1
};
const resultText = (r: ReminderRow) => (r.status === 'sent' || r.status === 'scheduled' || r.status === 'cancelled' ? '—' : (r.failure_code && RESULT_TEXT[r.failure_code]) || (r.status === 'failed' ? 'Could not send' : 'Not sent'));

// DD/MM/YYYY (typed) -> YYYY-MM-DD, or undefined while incomplete / not a real date.
const parseDmy = (t: string) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t.trim());
  if (!m) return undefined;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().startsWith(iso) ? iso : undefined;
};
const dmy = (iso: string | null) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const ALL = 'all';

export function RemindersView({ reminders, permissions, reasons, searchPatients, nextCursor, hasPrevious }: RemindersViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const canManage = permissions.includes(MANAGE);
  const [creating, setCreating] = useState(false);
  const [target, setTarget] = useState<ReminderRow>();
  const [error, setError] = useState<{ text: string; reload?: boolean }>();
  const reasonName = (c?: string) => (c ? reasons.find((r) => r.code === c)?.display ?? '—' : '—');

  const cancel = async () => {
    if (!target) return;
    const r = await cancelReminderAction(target.id, target.version);
    setTarget(undefined);
    if (r.ok) { setError(undefined); toast.show({ tone: 'success', title: 'Reminder cancelled' }); } else setError({ text: ERROR_TEXT[r.code] ?? 'Could not cancel this reminder. Try again.', reload: r.code === 'common.version_conflict' });
    router.refresh(); // also after a 409: the row is stale
  };

  const columns: ColumnDef<ReminderRow>[] = [
    { id: 'due', header: 'Due', cell: (r) => <DateText value={r.due_at as DateTextProps['value']} withTime /> },
    { id: 'patient', header: 'Patient', isRowHeader: true, cell: (r) => r.patient_display },
    { id: 'kind', header: 'Kind', cell: (r) => KIND_LABEL[r.kind] ?? 'Other' },
    { id: 'reason', header: 'Reason', cell: (r) => reasonName(r.reason_code) },
    { id: 'status', header: 'Status', cell: (r) => { const [label, tone] = STATUS_LABEL[r.status] ?? ['Unknown', 'neutral' as const]; return <StatusChip kind="generic" status={r.status} label={label} tone={tone} />; } },
    { id: 'sent', header: 'Sent at', cell: (r) => (r.sent_at ? <DateText value={r.sent_at as DateTextProps['value']} withTime /> : '—') },
    { id: 'result', header: 'Result', cell: resultText },
    ...(canManage ? [{
      id: 'actions', header: 'Actions',
      cell: (r: ReminderRow) => (r.status === 'scheduled' ? <Button size="sm" variant="ghost" onPress={() => setTarget(r)}>Cancel reminder</Button> : null), // AC-23.4: only scheduled
    }] : []),
  ];

  return (
    <section aria-label="Reminders">
      <PageHeader
        title="Reminders" helpKey="engagement.reminders"
        {...(canManage ? { actions: <Button variant="primary" onPress={() => setCreating(true)}>New reminder</Button> } : {})}
      />
      <Filters />
      {error ? <div role="alert"><Banner tone="danger" title={error.text} {...(error.reload ? { action: { label: 'Reload', onPress: () => router.refresh() } } : {})} /></div> : null}
      <DataTable<ReminderRow>
        columns={columns} rows={reminders} getRowId={(r) => r.id} density="compact" caption="Reminders"
        emptyState={{ title: 'No reminders', body: 'Nothing is scheduled in this date range.' }}
        {...(nextCursor || hasPrevious ? { page: { hasNext: !!nextCursor, hasPrevious: !!hasPrevious, limit: 50, onNext: () => nextCursor && router.push(`${pathname}?${new URLSearchParams([...params.entries()].filter(([k]) => k !== 'cursor').concat([['cursor', nextCursor]])).toString()}`), onPrevious: () => router.back() } } : {})}
      />
      <ConfirmDialog
        title="Cancel this reminder?" body="The patient will not receive this reminder. A sent reminder cannot be cancelled."
        confirmLabel="Cancel reminder" tone="danger" isOpen={!!target} onCancel={() => setTarget(undefined)} onConfirm={cancel}
      />
      {canManage && creating ? <NewReminderDialog reasons={reasons} searchPatients={searchPatients} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); toast.show({ tone: 'success', title: 'Reminder created' }); router.refresh(); }} /> : null}
    </section>
  );
}

// Own component so typing a date does not re-render the table. The URL is the state; typed dates apply once both are complete and valid.
function Filters() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [from, setFrom] = useState(dmy(params.get('due_from')));
  const [to, setTo] = useState(dmy(params.get('due_to')));
  const [rangeError, setRangeError] = useState<string>();
  const applied = useRef(`${params.get('due_from')}|${params.get('due_to')}`); // last range sent to the URL: re-typing the same range must not navigate again
  const go =(set: Record<string, string | undefined>) => {
    const q = new URLSearchParams(params.toString());
    q.delete('cursor');
    for (const [k, v] of Object.entries(set)) (v ? q.set(k, v) : q.delete(k));
    router.replace(`${pathname}${q.size ? `?${q.toString()}` : ''}`);
  };
  const onRange = (f: string, t: string) => {
    const [a, b] = [parseDmy(f), parseDmy(t)];
    if (!a || !b) { setRangeError(undefined); return; }
    if (b < a) { setRangeError('The end date must be on or after the start date.'); return; }
    if ((Date.parse(b) - Date.parse(a)) / 86_400_000 > MAX_RANGE_DAYS - 1) /* 92 calendar days inclusive */ { setRangeError(`Choose a period of at most ${MAX_RANGE_DAYS} days.`); return; }
    setRangeError(undefined);
    if (applied.current === `${a}|${b}`) return;
    applied.current = `${a}|${b}`;
    go({ due_from: a, due_to: b });
  };
  return (
    <>
      <div className="lims-inline" role="search" aria-label="Reminder filters">
        <div role="group" aria-label="Due date range" className="lims-inline">
          <TextField label="From" name="due_from" maxLength={10} inputMode="numeric" description="DD/MM/YYYY" value={from} onChange={(v) => { setFrom(v); onRange(v, to); }} />
          <TextField label="To" name="due_to" maxLength={10} inputMode="numeric" description="DD/MM/YYYY" value={to} onChange={(v) => { setTo(v); onRange(from, v); }} />
        </div>
        <Select label="Status" name="status" value={params.get('status') ?? ALL} onChange={(v) => go({ status: v === ALL ? undefined : v })}
          options={[{ value: ALL, label: 'All' }, ...Object.entries(STATUS_LABEL).map(([value, [label]]) => ({ value, label }))]} />
        <Select label="Kind" name="kind" value={params.get('kind') ?? ALL} onChange={(v) => go({ kind: v === ALL ? undefined : v })}
          options={[{ value: ALL, label: 'All' }, ...Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))]} />
      </div>
      {rangeError ? <p role="alert" className="lims-error">{rangeError}</p> : null}
    </>
  );
}

function NewReminderDialog({ reasons, searchPatients, onClose, onCreated }: { reasons: readonly ReasonOption[]; searchPatients: RemindersViewProps['searchPatients']; onClose: () => void; onCreated: () => void }) {
  const [patient, setPatient] = useState<PatientOption>();
  const [reason, setReason] = useState<string>();
  const [due, setDue] = useState<string>();
  const [errors, setErrors] = useState<{ patient?: string; reason?: string; due?: string; form?: string }>({});
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false); // synchronous guard: a double-click must send one request
  const key = useRef(crypto.randomUUID()); // one Idempotency-Key per open dialog: a retry of the same form is the same request

  const submit = async () => {
    if (inFlight.current) return;
    const e: typeof errors = {};
    if (!patient) e.patient = 'Select a patient.';
    if (!reason) e.reason = 'Select a reason.';
    if (!due) e.due = 'Enter a due date and time.';
    else if (Date.parse(due) < Date.now() + MIN_LEAD_MS) e.due = 'Choose a time at least 1 hour from now.';
    setErrors(e);
    if (e.patient || e.reason || e.due || !patient || !reason || !due) return;
    inFlight.current = true;
    setPending(true);
    try {
      const r = await createReminderAction({ patient_id: patient.id, reason_code: reason, due_at: due }, key.current);
      if (r.ok) { onCreated(); return; }
      setErrors({ form: r.status === 400 || r.status === 422 ? 'Check the details and try again.' : 'Could not create the reminder. Try again.' });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      title="New reminder" isOpen onClose={onClose}
      footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" isLoading={pending} onPress={() => void submit()}>Create reminder</Button></>}
    >
      {errors.form ? <div role="alert"><Banner tone="danger" title={errors.form} /></div> : null}
      <Combobox<PatientOption>
        label="Patient" name="patient" isRequired minChars={2} value={patient} onChange={setPatient} {...(errors.patient ? { error: errors.patient } : {})}
        loadOptions={async (q, signal) => { const r = await searchPatients(q); return signal.aborted ? [] : r; }}
        getKey={(p) => p.id} renderOption={(p) => p.display} renderValue={(p) => p.display}
      />
      <CodedSelect label="Reason" name="reason_code" codedSet="engagement.cs_reminder_reasons" isRequired options={reasons} {...(reason ? { value: reason } : {})} onChange={setReason} {...(errors.reason ? { error: errors.reason } : {})} />
      <DateTimePicker label="Due date and time" name="due_at" isRequired {...(due ? { value: due as never } : {})} onChange={(v) => setDue(v)} {...(errors.due ? { error: errors.due } : {})} />
    </Dialog>
  );
}
