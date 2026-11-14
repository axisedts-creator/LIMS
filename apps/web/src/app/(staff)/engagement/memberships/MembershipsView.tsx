'use client';
// W10 Memberships (04-UI-UX §3 W10, §2.4 BarcodeInput; US-EN-17.1, 17.2, 17.4). Tabs: "Lookup & enrol" (scan a card, cancel it, enrol a patient) and "Plans" (master list + right Drawer).
// LD-140 (2026-11-13): packages/ui components and token classes only; no hex colours, pixel radii or inline styles; one primary button per page section.
// The card token is a secret (07-SECURITY): it is typed/scanned into the lookup and never displayed, stored or logged; the server action strips it from results.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { BarcodeInput } from '@lims/ui/components/BarcodeInput';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Combobox } from '@lims/ui/components/Combobox';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Dialog } from '@lims/ui/components/Dialog';
import { Drawer } from '@lims/ui/components/Drawer';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { cancelMembershipAction, createPlanAction, enrolAction, lookupCardAction, updatePlanAction, type ActionResult, type CardView } from './actions';

export interface PlanRow { id: string; code: string; display_name: string; description?: string; price_list_id: string; validity_days: number; is_active: boolean; version: number }
export interface PriceListOption { id: string; display: string }
export interface PatientOption { id: string; display: string }
export interface MembershipsViewProps {
  plans: readonly PlanRow[];
  priceLists: readonly PriceListOption[];
  permissions: readonly string[];
  searchPatients: (query: string) => Promise<readonly PatientOption[]>;
}

const READ = 'engagement.membership.read';
const ENROL = 'engagement.membership.enrol';
const MANAGE = 'engagement.membership_plan.manage';
const TZ = 'Asia/Kathmandu'; // [CONV] 05-SCHEMA P-15: the only v1 tenant timezone
const NOTICE = { version: 'Someone else changed this. Reload to see the latest.' }; // 04-UI-UX §1
const CARD_STATUS: Record<string, [string, 'success' | 'neutral' | 'warning']> = { active: ['Active', 'success'], cancelled: ['Cancelled', 'neutral'], expired: ['Expired', 'warning'] };
const REASONS = [{ value: 'patient_request', label: 'Patient request' }, { value: 'staff_error', label: 'Staff error' }, { value: 'other', label: 'Other' }];

const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); // YYYY-MM-DD
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dmy = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const parseDmy = (t: string) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t.trim());
  if (!m) return undefined;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().startsWith(iso) ? iso : undefined;
};
type Notice = { text: string; tone: 'danger' | 'warning' | 'neutral'; reload?: boolean };

export function MembershipsView({ plans, priceLists, permissions, searchPatients }: MembershipsViewProps) {
  const [tab, setTab] = useState('lookup');
  const canManage = permissions.includes(MANAGE);
  return (
    <section aria-label="Memberships">
      <PageHeader title="Memberships" helpKey="engagement.memberships" />
      <Tabs aria-label="Membership sections" items={[{ id: 'lookup', label: 'Lookup & enrol' }, { id: 'plans', label: 'Plans' }]} selectedId={tab} onChange={setTab}>
        {tab === 'lookup'
          ? <LookupPanel plans={plans} canRead={permissions.includes(READ)} canEnrol={permissions.includes(ENROL)} searchPatients={searchPatients} />
          : <PlansPanel plans={plans} priceLists={priceLists} canManage={canManage} />}
      </Tabs>
    </section>
  );
}

// ---------------------------------------------------------------- Lookup & enrol
function LookupPanel({ plans, canRead, canEnrol, searchPatients }: { plans: readonly PlanRow[]; canRead: boolean; canEnrol: boolean; searchPatients: MembershipsViewProps['searchPatients'] }) {
  const router = useRouter();
  const toast = useToast();
  const [card, setCard] = useState<CardView>();
  const [notice, setNotice] = useState<Notice>();
  const [cancelling, setCancelling] = useState(false);

  const onScan = async (value: string) => {
    setNotice(undefined);
    const r = await lookupCardAction(value);
    if (r.ok) { setCard(r.data); return; }
    setCard(undefined);
    setNotice(r.status === 404 ? { text: 'No membership found for this card', tone: 'warning' }
      : r.status === 403 ? { text: 'You are not allowed to look up membership cards.', tone: 'danger' } : { text: 'Could not look up this card. Try again.', tone: 'danger' });
  };

  return (
    <div className="lims-stack">
      {notice ? <div role="alert"><Banner tone={notice.tone} title={notice.text} {...(notice.reload ? { action: { label: 'Reload', onPress: () => router.refresh() } } : {})} /></div> : null}
      {canRead ? <BarcodeInput label="Scan or type a membership card" name="membership_card" pattern={/^[0-9A-Z]{26}$|^MB[0-9]{8}$/} minScanLength={10} onScan={(v) => void onScan(v)} /> : null}
      {card ? (
        <section aria-label="Membership card">
          <Card title={card.plan_display_name}>
            <DescriptionList items={[
              { term: 'Card number', value: card.card_no },
              { term: 'Valid from', value: dmy(card.valid_from) },
              { term: 'Valid to', value: dmy(card.valid_to) },
              { term: 'Status', value: <StatusChip kind="generic" status={card.status} label={(CARD_STATUS[card.status] ?? [card.status])[0]} tone={(CARD_STATUS[card.status] ?? ['', 'neutral'])[1] as 'neutral'} /> },
            ]} />
            {canEnrol && card.status === 'active' ? <Button variant="secondary" onPress={() => setCancelling(true)}>Cancel membership</Button> : null}
          </Card>
        </section>
      ) : null}
      {canEnrol ? <EnrolForm plans={plans} searchPatients={searchPatients} onEnrolled={(c) => { setCard(c); setNotice(undefined); toast.show({ tone: 'success', title: 'Patient enrolled' }); }} /> : null}
      {card && cancelling ? (
        <CancelDialog
          card={card} onClose={() => setCancelling(false)}
          onDone={(r) => {
            setCancelling(false);
            if (r.ok) { setCard(r.data); setNotice(undefined); toast.show({ tone: 'success', title: 'Membership cancelled' }); return; }
            setNotice(r.code === 'common.version_conflict' ? { text: NOTICE.version, tone: 'danger', reload: true } : { text: 'Could not cancel this membership. Try again.', tone: 'danger' });
          }}
        />
      ) : null}
    </div>
  );
}

function CancelDialog({ card, onClose, onDone }: { card: CardView; onClose: () => void; onDone: (r: ActionResult<CardView>) => void }) {
  const [reason, setReason] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current) return;
    if (!reason) { setError('Select a reason.'); return; }
    inFlight.current = true;
    setPending(true);
    try { onDone(await cancelMembershipAction(card.id, card.version, reason)); } finally { inFlight.current = false; setPending(false); }
  };
  return (
    <Dialog
      title="Cancel this membership?" isOpen onClose={onClose}
      footer={<><Button variant="ghost" onPress={onClose}>Keep membership</Button><Button variant="danger" isLoading={pending} onPress={() => void submit()}>Cancel membership</Button></>}
    >
      <p>The card stops working at once. The patient can be enrolled again afterwards.</p>
      <Select label="Reason" name="reason_code" isRequired options={REASONS} {...(reason ? { value: reason } : {})} onChange={(v) => { setReason(v); setError(undefined); }} {...(error ? { error } : {})} />
    </Dialog>
  );
}

function EnrolForm({ plans, searchPatients, onEnrolled }: { plans: readonly PlanRow[]; searchPatients: MembershipsViewProps['searchPatients']; onEnrolled: (c: CardView) => void }) {
  const [round, setRound] = useState(0); // remount the uncontrolled kit fields after a successful enrolment
  const [patient, setPatient] = useState<PatientOption>();
  const [plan, setPlan] = useState<string>();
  const [from, setFrom] = useState(() => dmy(ymd(new Date())));
  const [errors, setErrors] = useState<{ patient?: string; plan?: string; from?: string }>({});
  const [banner, setBanner] = useState<string>();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false); // synchronous guard: a double-click must send one request
  const key = useRef(crypto.randomUUID()); // one Idempotency-Key per form fill: a retry of the same form is the same request

  const submit = async () => {
    if (inFlight.current) return;
    const today = ymd(new Date());
    const iso = parseDmy(from);
    const e: typeof errors = {};
    if (!patient) e.patient = 'Select a patient.';
    if (!plan) e.plan = 'Select a plan.';
    if (!iso || iso < today || iso > addDays(today, 30)) e.from = 'Choose a date from today up to 30 days ahead (DD/MM/YYYY).';
    setErrors(e);
    setBanner(undefined);
    if (e.patient || e.plan || e.from || !patient || !plan || !iso) return;
    inFlight.current = true;
    setPending(true);
    try {
      const r = await enrolAction({ patient_id: patient.id, plan_id: plan, valid_from: iso }, key.current);
      if (r.ok) {
        onEnrolled(r.data);
        key.current = crypto.randomUUID();
        setPatient(undefined); setPlan(undefined); setFrom(dmy(today)); setRound((n) => n + 1);
        return;
      }
      if (r.status >= 400 && r.status < 500) key.current = crypto.randomUUID(); // rejected: nothing was created, a changed form is a new request
      setBanner(r.code === 'engagement.membership_overlap' ? 'This patient already has an active membership'
        : r.code === 'engagement.plan_inactive' ? 'This plan is no longer active'
        : r.status === 403 ? 'You are not allowed to enrol patients.' : r.status === 400 || r.status === 404 ? 'Check the details and try again.' : 'Could not enrol the patient. Try again.');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <Card title="Enrol a patient">
      {banner ? <div role="alert"><Banner tone="danger" title={banner} /></div> : null}
      <div key={round} className="lims-stack">
        <Combobox<PatientOption>
          label="Patient" name="patient" isRequired minChars={2} {...(patient ? { value: patient } : {})} onChange={setPatient} {...(errors.patient ? { error: errors.patient } : {})}
          loadOptions={async (q, signal) => { const r = await searchPatients(q); return signal.aborted ? [] : r; }}
          getKey={(p) => p.id} renderOption={(p) => p.display} renderValue={(p) => p.display}
        />
        <Select
          label="Plan" name="plan_id" isRequired options={plans.filter((p) => p.is_active).map((p) => ({ value: p.id, label: p.display_name }))}
          {...(plan ? { value: plan } : {})} onChange={setPlan} {...(errors.plan ? { error: errors.plan } : {})}
        />
        <TextField label="Valid from" name="valid_from" isRequired maxLength={10} inputMode="numeric" description="DD/MM/YYYY" value={from} onChange={setFrom} {...(errors.from ? { error: errors.from } : {})} />
      </div>
      <Button variant="primary" isLoading={pending} onPress={() => void submit()}>Enrol patient</Button>
    </Card>
  );
}

// ---------------------------------------------------------------- Plans
function PlansPanel({ plans, priceLists, canManage }: { plans: readonly PlanRow[]; priceLists: readonly PriceListOption[]; canManage: boolean }) {
  const [editing, setEditing] = useState<PlanRow | 'new'>();
  const listName = (id: string) => priceLists.find((l) => l.id === id)?.display ?? '—';
  const columns: ColumnDef<PlanRow>[] = [
    { id: 'code', header: 'Code', isRowHeader: true, cell: (p) => p.code },
    { id: 'name', header: 'Name', cell: (p) => p.display_name },
    { id: 'validity', header: 'Validity (days)', cell: (p) => String(p.validity_days) },
    { id: 'list', header: 'Price list', cell: (p) => listName(p.price_list_id) },
    { id: 'status', header: 'Status', cell: (p) => <StatusChip kind="generic" status={p.is_active ? 'active' : 'inactive'} label={p.is_active ? 'Active' : 'Inactive'} tone={p.is_active ? 'success' : 'neutral'} /> },
    ...(canManage ? [{ id: 'actions', header: 'Actions', cell: (p: PlanRow) => <Button size="sm" variant="ghost" onPress={() => setEditing(p)}>{`Edit ${p.code}`}</Button> }] : []),
  ];
  return (
    <div className="lims-stack">
      {canManage ? <div className="lims-inline"><Button variant="primary" onPress={() => setEditing('new')}>New plan</Button></div> : null}
      <DataTable<PlanRow>
        columns={columns} rows={plans} getRowId={(p) => p.id} density="compact" caption="Membership plans"
        emptyState={{ title: 'No membership plans', body: 'Create a plan to start enrolling patients.' }}
      />
      {canManage && editing ? <PlanDrawer plan={editing === 'new' ? undefined : editing} priceLists={priceLists} onClose={() => setEditing(undefined)} /> : null}
    </div>
  );
}

const FIELD_TEXT: Record<string, string> = { '/price_list_id': 'This list is not available. Choose another.', '/code': 'Code is already in use or invalid.' };

function PlanDrawer({ plan, priceLists, onClose }: { plan: PlanRow | undefined; priceLists: readonly PriceListOption[]; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [code, setCode] = useState(plan?.code ?? '');
  const [name, setName] = useState(plan?.display_name ?? '');
  const [description, setDescription] = useState(plan?.description ?? '');
  const [priceList, setPriceList] = useState<string | undefined>(plan?.price_list_id);
  const [validity, setValidity] = useState(plan ? String(plan.validity_days) : '365');
  const [active, setActive] = useState(plan?.is_active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ text: string; reload?: boolean }>();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const key = useRef(crypto.randomUUID()); // one Idempotency-Key per open drawer (create only)

  const submit = async () => {
    if (inFlight.current) return;
    const e: Record<string, string> = {};
    if (code.trim() === '') e['code'] = 'Code is required.';
    else if (!/^[A-Z0-9_]{2,20}$/.test(code)) e['code'] = 'Code must be 2 to 20 uppercase letters, digits or underscores.';
    if (name.trim() === '') e['name'] = 'Name is required.';
    if (!priceList) e['priceList'] = 'Price list is required.';
    const days = /^\d{1,4}$/.test(validity.trim()) ? Number(validity.trim()) : NaN;
    if (validity.trim() === '') e['validity'] = 'Validity is required.';
    else if (!(days >= 30 && days <= 1095)) e['validity'] = 'Validity must be a whole number between 30 and 1095.';
    setErrors(e);
    setBanner(undefined);
    if (Object.keys(e).length > 0 || !priceList) return;
    const input = { code, display_name: name, ...(description.trim() ? { description } : {}), price_list_id: priceList, validity_days: days, is_active: active };
    inFlight.current = true;
    setPending(true);
    try {
      const r = plan ? await updatePlanAction(plan.id, plan.version, input) : await createPlanAction(input, key.current);
      if (r.ok) { toast.show({ tone: 'success', title: plan ? 'Plan updated' : 'Plan created' }); router.refresh(); onClose(); return; }
      if (r.status >= 400 && r.status < 500) key.current = crypto.randomUUID(); // rejected: nothing was created
      const field = (r.fields ?? []).find((f) => FIELD_TEXT[f]);
      if (field) setErrors({ [field === '/code' ? 'code' : 'priceList']: FIELD_TEXT[field]! });
      setBanner(r.code === 'auth.mfa_required' ? { text: 'Confirm your identity with a second factor, then try again.' }
        : r.status === 403 ? { text: 'You are not allowed to change membership plans.' }
        : r.code === 'common.version_conflict' ? { text: NOTICE.version, reload: true }
        : r.status === 400 ? { text: 'Check the details and try again.' } : { text: 'Could not save the plan. Try again.' });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <Drawer title={plan ? 'Edit plan' : 'New plan'} isOpen onClose={onClose}>
      {banner ? <div role="alert"><Banner tone="danger" title={banner.text} {...(banner.reload ? { action: { label: 'Reload', onPress: () => router.refresh() } } : {})} /></div> : null}
      <TextField label="Code" name="code" isRequired maxLength={20} value={code} onChange={setCode} {...(errors['code'] ? { error: errors['code'] } : {})} />
      <TextField label="Name" name="display_name" isRequired maxLength={60} value={name} onChange={setName} {...(errors['name'] ? { error: errors['name'] } : {})} />
      <TextArea label="Description" name="description" maxLength={300} value={description} onChange={setDescription} />
      <Select
        label="Price list" name="price_list_id" isRequired options={priceLists.map((l) => ({ value: l.id, label: l.display }))}
        {...(priceList ? { value: priceList } : {})} onChange={setPriceList} {...(errors['priceList'] ? { error: errors['priceList'] } : {})}
      />
      <TextField label="Validity days" name="validity_days" isRequired maxLength={4} inputMode="numeric" value={validity} onChange={setValidity} {...(errors['validity'] ? { error: errors['validity'] } : {})} />
      <Checkbox label="Active" isSelected={active} onChange={setActive} />
      <Button variant="primary" isLoading={pending} onPress={() => void submit()}>Save</Button>
    </Drawer>
  );
}
