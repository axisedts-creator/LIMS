'use client';
// SCR-07 Instrument detail (04-UI-UX §3): header + state-dependent actions (E27–E31), tabs Overview · Configuration · History.
// Action buttons are a UI hint for the state machine; the API enforces transitions (409 invalid_transition → message + re-read).
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { shortcuts } from '@/core/shortcuts/registry';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DateText } from '@lims/ui/components/DateText';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Dialog } from '@lims/ui/components/Dialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { StatusStepper } from '@lims/ui/components/StatusStepper';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { goLiveInstrumentAction, resumeInstrumentAction, retireInstrumentAction, startInstrumentCommissioningAction, suspendInstrumentAction } from '../server/actions';
import { GO_LIVE_CHECKLIST_KEYS, type ActionResult, type AgentSummary, type Driver, type GoLiveChecklist, type Instrument } from '../server/types';
import { DriverStatusBadge, InstrumentStatePill, PROTOCOL_LABEL, hasPerm } from './labels';
import { InstrumentForm } from './InstrumentForm';

const TABS = [{ id: 'overview', label: 'Overview' }, { id: 'configuration', label: 'Configuration' }, { id: 'history', label: 'History' }] as const;
const CHECK_LABELS: Record<keyof GoLiveChecklist, string> = {
  manual_reference_confirmed: 'The official interface manual for this model and software version is on file',
  sample_comparison_done: 'Patient-sample comparison with the instrument printout is done',
  qc_comparison_done: 'QC values compared',
  mappings_reviewed: 'Code mappings reviewed',
};
// RS-C7 / LD-140: the four existing checks are the steps. [CONV] a fifth step is Current once all four are done (the kit stepper shows nothing Complete without a current step).
const CHECKS_DONE = { id: 'all_done', label: 'All checks done' };
const checkSteps = [...GO_LIVE_CHECKLIST_KEYS.map((k) => ({ id: k as string, label: CHECK_LABELS[k] })), CHECKS_DONE];
const EMPTY_CHECKLIST: GoLiveChecklist = { manual_reference_confirmed: false, sample_comparison_done: false, qc_comparison_done: false, mappings_reviewed: false };
const MFA = 'Confirm with your authenticator to continue';
const NOTE_MIN = 10;
const when = (v: string | undefined) => (v ? <DateText value={v as never} withTime /> : '—');
const txt = (v: string | number | undefined) => (v === undefined ? '—' : String(v));

/** [CONV] texts: the spec gives none for these API problems; the code is always shown so support can quote it. */
function problemText(code: string, what: string): string {
  if (code === 'auth.mfa_required') return MFA;
  if (code === 'instruments.invalid_transition') return `${what}: this action is no longer allowed for the instrument's current state (${code}). The page was refreshed.`;
  if (code === 'instruments.driver_not_available') return `${what}: the instrument's driver is not available or not verified (${code}).`;
  if (code === 'instruments.go_live_checklist_incomplete') return `${what}: the go-live checklist is incomplete (${code}).`;
  if (code === 'common.version_conflict') return `${what}: someone else changed this instrument. Reload to see the latest version (${code}).`;
  return `${what} (${code})`;
}

type Open = 'none' | 'go_live' | 'suspend' | 'retire';

export function InstrumentDetail({ instrument, agents, drivers, permissions }: { instrument: Instrument; agents: readonly Pick<AgentSummary, 'id' | 'agent_code' | 'display_name' | 'status'>[]; drivers: readonly Driver[]; permissions: readonly string[] }) {
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<string>('overview');
  const [open, setOpen] = useState<Open>('none');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false); // one request per click: a double click must not send a second transition
  const doneAt = useRef<number | undefined>(undefined); // instrument version a transition already succeeded on; lifts when the re-read brings a new version
  const canManage = hasPerm(permissions, 'instruments.instrument.manage');
  const i = instrument;
  const driver = drivers.find((d) => d.code === i.driver_code);
  const mappings = `/instruments/instruments/${i.id}/mappings`;

  // SCR-07 Alt+P "Open mappings" (Alt+M is the global focus-main key).
  useEffect(() => shortcuts.register('staff.instruments.instrument', { key: 'Alt+P', description: 'Open mappings', run: () => router.push(mappings) }), [router, mappings]);

  /** Shared by every transition: success → close, toast, re-read; failure → message (in the dialog when one is open). */
  const act = async (f: () => Promise<ActionResult<unknown>>, success: string, failure: string): Promise<string | undefined> => {
    if (inFlight.current || doneAt.current === i.version) return undefined; // a double click, or a repeat before the re-read arrives
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const r = await f();
      if (r.ok) {
        doneAt.current = i.version;
        setOpen('none');
        toast.show({ tone: 'success', title: success });
        router.refresh();
        return undefined;
      }
      if (r.code === 'instruments.invalid_transition' || r.code === 'common.version_conflict') router.refresh(); // stale buttons disappear
      return problemText(r.code, failure);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const direct = async (f: () => Promise<ActionResult<unknown>>, success: string, failure: string) => setError(await act(f, success, failure));

  const actions = canManage ? (
    <>
      {i.state === 'draft' ? <Button variant="primary" isLoading={busy} onPress={() => void direct(() => startInstrumentCommissioningAction(i.id, i.version), 'Commissioning started.', 'Could not start commissioning')}>Start commissioning</Button> : null}
      {i.state === 'commissioning' ? <Button variant="primary" onPress={() => { setError(undefined); setOpen('go_live'); }}>Go live</Button> : null}
      {i.state === 'live' ? <Button onPress={() => { setError(undefined); setOpen('suspend'); }}>Suspend</Button> : null}
      {i.state === 'suspended' ? <Button variant="primary" isLoading={busy} onPress={() => void direct(() => resumeInstrumentAction(i.id, i.version), 'Instrument resumed.', 'Could not resume the instrument')}>Resume</Button> : null}
      {i.state !== 'retired' ? <Button variant="danger" onPress={() => { setError(undefined); setOpen('retire'); }}>Retire</Button> : null}
    </>
  ) : null;

  const st = i.status;
  return (
    <section aria-label={`Instrument ${i.instrument_code}`}>
      <PageHeader
        title={`${i.instrument_code} — ${i.display_name}`}
        helpKey="instruments.instruments"
        breadcrumbs={[{ label: 'Instruments', href: '/instruments/instruments' }, { label: i.instrument_code }]}
        status={<InstrumentStatePill state={i.state} />}
        actions={
          <>
            {actions}
            <a className="lims-link" href={mappings}>Mappings</a>
            <a className="lims-link" href={`/instruments/messages?instrument_id=${i.id}`}>Messages</a>
          </>
        }
      />
      {error && open === 'none' ? (
        <div role="alert">
          <Banner tone={error === MFA ? 'warning' : 'danger'} title={error} />
        </div>
      ) : null}
      <Tabs items={TABS} selectedId={tab} onChange={setTab} aria-label="Instrument sections">
        {tab === 'overview' ? (
          <Stack gap={4}>
          <section aria-label="Commissioning checklist">
            <StatusStepper steps={checkSteps} currentId={checkSteps.find((c) => !(i.go_live_checklist?.[c.id as keyof GoLiveChecklist]))?.id ?? CHECKS_DONE.id} />
          </section>
          <DescriptionList
            columns={3}
            items={[
              { term: 'Link state', value: txt(st?.link_state) },
              { term: 'Last message (server)', value: when(st?.last_message_at) },
              { term: 'Last message (agent)', value: when(st?.last_message_at_agent) },
              { term: 'Last link error', value: txt(st?.last_link_error_code) },
              { term: 'Instrument clock offset', value: st?.instrument_clock_offset_seconds === undefined ? '—' : `${st.instrument_clock_offset_seconds} s` },
              { term: 'Silent since', value: when(st?.silent_since) },
              { term: 'Protocol', value: PROTOCOL_LABEL[i.protocol ?? ''] ?? txt(i.protocol) },
              { term: 'Driver', value: <>{driver?.display_name ?? txt(i.driver_code)} <DriverStatusBadge status={i.driver_status} /></> },
              { term: 'Driver version', value: txt(i.driver_version) },
              { term: 'Manual reference', value: driver?.manual ? `${driver.manual.title}${driver.manual.document_id ? ` (${driver.manual.document_id})` : ''}` : '—' },
              { term: 'Went live', value: i.live_at ? <>{when(i.live_at)} · {txt(i.live_by_display)}</> : '—' },
            ]}
          />
          </Stack>
        ) : tab === 'configuration' ? (
          <InstrumentForm mode="edit" instrument={i} agents={agents} drivers={drivers} permissions={permissions} />
        ) : (
          // [CONV] the audit viewer route needs an audit entry id (staff.admin.audit_entry); the BFF has no audit list for it yet.
          <p>Changes to this instrument are recorded in the audit log (Administration).</p>
        )}
      </Tabs>
      {open === 'go_live' ? <GoLiveDialog driverVerified={i.driver_status === 'verified'} busy={busy} onClose={() => setOpen('none')} onSubmit={(checklist, note) => act(() => goLiveInstrumentAction(i.id, i.version, { checklist, evidence_note: note }), 'The instrument is live.', 'Could not go live')} /> : null}
      {open === 'suspend' ? <ReasonDialog title="Suspend instrument" confirm="Suspend" busy={busy} onClose={() => setOpen('none')} onSubmit={(r) => act(() => suspendInstrumentAction(i.id, i.version, r), 'Instrument suspended.', 'Could not suspend the instrument')} /> : null}
      {open === 'retire' ? <ReasonDialog title="Retire instrument" confirm="Retire" danger note="Deactivate this instrument's code mappings in Mappings." busy={busy} onClose={() => setOpen('none')} onSubmit={(r) => act(() => retireInstrumentAction(i.id, i.version, r), 'Instrument retired.', 'Could not retire the instrument')} /> : null}
    </section>
  );
}

function GoLiveDialog({ driverVerified, busy, onClose, onSubmit }: { driverVerified: boolean; busy: boolean; onClose: () => void; onSubmit: (c: GoLiveChecklist, note: string) => Promise<string | undefined> }) {
  const [checks, setChecks] = useState<GoLiveChecklist>(EMPTY_CHECKLIST);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string>();
  const [localError, setLocalError] = useState<string>();
  const submit = async () => {
    setProblem(undefined);
    const complete = GO_LIVE_CHECKLIST_KEYS.every((k) => checks[k]);
    if (!driverVerified) return;
    if (!complete) { setLocalError('Tick all four checks before going live.'); return; } // [CONV] texts
    if (note.trim().length < NOTE_MIN) { setLocalError(`Write an evidence note of at least ${NOTE_MIN} characters.`); return; }
    setLocalError(undefined);
    setProblem(await onSubmit(checks, note.trim()));
  };
  const shown = problem ?? localError;
  return (
    <Dialog
      title="Go live"
      isOpen
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>Cancel</Button>
          <Button variant="primary" isDisabled={!driverVerified} isLoading={busy} onPress={() => void submit()}>Go live</Button>
        </>
      }
    >
      {!driverVerified ? <Banner tone="danger" title="This driver is not verified against an official manual. The instrument cannot go live." /> : null}
      {problem === MFA ? <Banner tone="warning" title={MFA} /> : null}
      {shown && shown !== MFA ? (
        <div role="alert">
          <Banner tone="danger" title={shown} />
        </div>
      ) : null}
      {GO_LIVE_CHECKLIST_KEYS.map((k) => (
        <Checkbox key={k} label={CHECK_LABELS[k]} name={k} isSelected={checks[k]} onChange={(v) => setChecks((c) => ({ ...c, [k]: v }))} />
      ))}
      <TextArea label="Evidence note" name="evidence_note" maxLength={2000} rows={4} value={note} onChange={setNote} />
    </Dialog>
  );
}

function ReasonDialog({ title, confirm, danger, note, busy, onClose, onSubmit }: { title: string; confirm: string; danger?: boolean; note?: string; busy: boolean; onClose: () => void; onSubmit: (reason: string) => Promise<string | undefined> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const submit = async () => {
    setProblem(undefined);
    const t = reason.trim();
    if (t.length < 3 || t.length > 300) { setError('Write a reason of 3–300 characters.'); return; } // [CONV] text
    setError(undefined);
    setProblem(await onSubmit(t));
  };
  return (
    <Dialog
      title={title}
      isOpen
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} isLoading={busy} onPress={() => void submit()}>{confirm}</Button>
        </>
      }
    >
      {problem ? (
        <div role="alert">
          <Banner tone={problem === MFA ? 'warning' : 'danger'} title={problem} />
        </div>
      ) : null}
      {note ? <p>{note}</p> : null}
      <TextArea label="Reason" name="reason_text" maxLength={300} rows={3} value={reason} onChange={(v) => { setReason(v); setError(undefined); }} {...(error ? { error } : {})} />
    </Dialog>
  );
}
