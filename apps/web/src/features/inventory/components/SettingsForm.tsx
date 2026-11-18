'use client';
// S18 Settings (04-UI-UX §3 S18; TRD #26, #27). LD-140 (2026-11-13): kit components only; ONE primary button (Save). With inventory.master.manage this is
// a form, otherwise a read-only DescriptionList. Percent fields are shown as percent and sent as basis points. Save is one PUT with If-Match "<version>".
// Turning automatic consumption on asks for a start time (default now); the server rejects a start older than 1 hour (400 at /consumption_enabled_at).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { DateTimePicker, type DateTimePickerProps } from '@lims/ui/components/DateTimePicker';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { SettingsForm as KitSettingsForm } from '@lims/ui/components/SettingsForm';
import { Switch } from '@lims/ui/components/Switch';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { saveSettingsAction } from '../server/actions';
import type { Settings, SettingsUpdate } from '../server/types';
import { Pick, ProblemBanner, yesNo, type Failure } from './shared';

const PATTERN_HINT = 'Patterns can use {yy}, {fy}, {fyl} and {seq:N}, for example PO-{fy}-{seq:5}.';
const VAT_HELP = 'Turn off if your lab can claim purchase VAT back (ask your auditor).';
// T0D-UISETTINGS-1 (LD-353 template 4): the four former cards are the four tabs of the kit SettingsForm.
const TABS = [{ id: 'consumption', label: 'Consumption' }, { id: 'purchasing', label: 'Purchasing' }, { id: 'alerts', label: 'Alerts and counts' }, { id: 'numbers', label: 'Document numbers' }] as const;
const PATTERNS = [
  { key: 'po_no_pattern', label: 'PO number pattern' },
  { key: 'grn_no_pattern', label: 'Receipt number pattern' },
  { key: 'transfer_no_pattern', label: 'Transfer number pattern' },
  { key: 'count_no_pattern', label: 'Count number pattern' },
  { key: 'doc_no_pattern', label: 'Document number pattern' },
] as const;

type Iso = DateTimePickerProps['value']; // the API sends validated IsoUtc strings; the plain-JSON view model carries them as string
const nowIso = () => new Date().toISOString() as NonNullable<Iso>;
const bpToPct =(bp: number) => String(bp / 100);
const pctToBp = (t: string) => Math.round(Number(t) * 100); // 2.3 * 100 = 229.99999999999997, so round

export function SettingsForm({ settings: s, stores, canManage }: { settings: Settings; stores: readonly { value: string; label: string }[]; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [autoOn, setAutoOn] = useState(!!s.consumption_enabled_at);
  const [startAt, setStartAt] = useState<Iso>(s.consumption_enabled_at as Iso);
  const [vat, setVat] = useState(s.vat_in_cost);
  const [selfApprove, setSelfApprove] = useState(s.po_self_approval_allowed);
  const [grnNoPo, setGrnNoPo] = useState(s.grn_without_po_allowed);
  const [tolerance, setTolerance] = useState<string | undefined>(bpToPct(s.over_receipt_tolerance_bp));
  const [expiryDays, setExpiryDays] = useState<string | undefined>(String(s.expiry_alert_days));
  const [store, setStore] = useState(s.default_consumption_store_id);
  const [locks, setLocks] = useState(s.count_locks_store);
  const [perDay, setPerDay] = useState(s.per_day_requires_activity);
  const [recon, setRecon] = useState<string | undefined>(bpToPct(s.reconciliation_gap_alert_bp));
  const [backdate, setBackdate] = useState<string | undefined>(String(s.backdate_max_days));
  const [patterns, setPatterns] = useState<Record<(typeof PATTERNS)[number]['key'], string>>({
    po_no_pattern: s.po_no_pattern, grn_no_pattern: s.grn_no_pattern, transfer_no_pattern: s.transfer_no_pattern, count_no_pattern: s.count_no_pattern, doc_no_pattern: s.doc_no_pattern,
  });
  const [problem, setProblem] = useState<Failure>();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<string>('consumption');
  /** An edit marks the form dirty (the Save bar says so). */
  const d = <T,>(set: (v: T) => void) => (v: T) => { set(v); setDirty(true); };

  if (!canManage) {
    const storeLabel = stores.find((x) => x.value === s.default_consumption_store_id)?.label ?? '—';
    return (
      <section aria-label="Settings">
        <PageHeader title="Settings" helpKey="inventory.settings" />
        <DescriptionList
          columns={2}
          items={[
            { term: 'Automatic consumption', value: s.consumption_enabled_at ? `On, from ${s.consumption_enabled_at.slice(0, 10)}` : 'Off' },
            { term: 'VAT included in cost', value: yesNo(s.vat_in_cost) },
            { term: 'Allow approving own PO', value: yesNo(s.po_self_approval_allowed) },
            { term: 'Allow receipts without PO', value: yesNo(s.grn_without_po_allowed) },
            { term: 'Over-receipt tolerance %', value: bpToPct(s.over_receipt_tolerance_bp) },
            { term: 'Expiry alert days', value: String(s.expiry_alert_days) },
            { term: 'Default consumption store', value: storeLabel },
            { term: 'Lock store during count', value: yesNo(s.count_locks_store) },
            { term: 'Analyser-day rules need activity', value: yesNo(s.per_day_requires_activity) },
            { term: 'Reconciliation alert %', value: bpToPct(s.reconciliation_gap_alert_bp) },
            { term: 'Back-dating limit days', value: String(s.backdate_max_days) },
            ...PATTERNS.map((p) => ({ term: p.label, value: s[p.key] })),
          ]}
        />
      </section>
    );
  }

  const onSubmit = async () => {
    if (tolerance === undefined || expiryDays === undefined || recon === undefined || backdate === undefined) return;
    const update: SettingsUpdate = {
      vat_in_cost: vat,
      po_self_approval_allowed: selfApprove,
      grn_without_po_allowed: grnNoPo,
      over_receipt_tolerance_bp: pctToBp(tolerance),
      expiry_alert_days: Number(expiryDays),
      ...(store ? { default_consumption_store_id: store } : {}),
      count_locks_store: locks,
      per_day_requires_activity: perDay,
      reconciliation_gap_alert_bp: pctToBp(recon),
      backdate_max_days: Number(backdate),
      ...patterns,
    };
    if (autoOn) update.consumption_enabled_at = startAt ?? nowIso();
    setSaving(true);
    setProblem(undefined);
    const r = await saveSettingsAction(s.version, update);
    setSaving(false);
    if (!r.ok) return setProblem(r);
    setDirty(false);
    toast.show({ tone: 'success', title: 'Settings saved' });
    router.refresh();
  };

  return (
    <section aria-label="Settings">
      <PageHeader title="Settings" helpKey="inventory.settings" />
      <ProblemBanner problem={problem} />
      <KitSettingsForm
        tabs={<Tabs aria-label="Inventory settings sections" items={TABS} selectedId={tab} onChange={setTab} />}
        onSave={onSubmit} isSaving={saving} isDirty={dirty} {...(problem?.errors ? { problem: { errors: problem.errors } } : {})}
      >
        {/* Only the selected tab is drawn (values stay in state and are all saved): a hidden section would put its inputs ahead of the visible ones. */}
        {tab === 'consumption' ? (
          <>
            <Switch
              label="Automatic consumption"
              name="auto_consumption"
              isSelected={autoOn}
              onChange={(on) => {
                setAutoOn(on);
                setDirty(true);
                if (on && !startAt) setStartAt(nowIso());
                if (!on) setStartAt(undefined);
              }}
            />
            {/* the start picker is drawn only on its own tab (its value stays in state and is saved); the kit date mask edits on blur, not per key */}
            {autoOn && tab === 'consumption' ? <DateTimePicker label="Start from" name="consumption_enabled_at" {...(startAt ? { value: startAt } : {})} onChange={d(setStartAt)} /> : null}
            <Pick label="Default consumption store" name="default_consumption_store_id" options={stores} value={store} onChange={d(setStore)} />
            <Switch label="Analyser-day rules need activity" name="per_day_requires_activity" isSelected={perDay} onChange={d(setPerDay)} />
          </>
        ) : null}
        {tab === 'purchasing' ? (
          <>
            <Switch label="VAT included in cost" name="vat_in_cost" isSelected={vat} onChange={d(setVat)} />
            <p className="lims-description">{VAT_HELP}</p>
            <Switch label="Allow approving own PO" name="po_self_approval_allowed" isSelected={selfApprove} onChange={d(setSelfApprove)} />
            <Switch label="Allow receipts without PO" name="grn_without_po_allowed" isSelected={grnNoPo} onChange={d(setGrnNoPo)} />
            <DecimalField label="Over-receipt tolerance %" name="over_receipt_tolerance_bp" decimals={2} min="0" max="50" isRequired {...(tolerance ? { value: tolerance } : {})} onChange={d(setTolerance)} />
          </>
        ) : null}
        {tab === 'alerts' ? (
          <>
            <DecimalField label="Expiry alert days" name="expiry_alert_days" decimals={0} min="1" max="365" isRequired {...(expiryDays ? { value: expiryDays } : {})} onChange={d(setExpiryDays)} />
            <Switch label="Lock store during count" name="count_locks_store" isSelected={locks} onChange={d(setLocks)} />
            <DecimalField label="Reconciliation alert %" name="reconciliation_gap_alert_bp" decimals={2} min="0" max="100" isRequired {...(recon ? { value: recon } : {})} onChange={d(setRecon)} />
            <DecimalField label="Back-dating limit days" name="backdate_max_days" decimals={0} min="0" max="31" isRequired {...(backdate ? { value: backdate } : {})} onChange={d(setBackdate)} />
          </>
        ) : null}
        {tab === 'numbers' ? (
          <>
            <p className="lims-description">{PATTERN_HINT}</p>
            {PATTERNS.map((p) => (
              <TextField key={p.key} label={p.label} name={p.key} maxLength={40} isRequired value={patterns[p.key]} onChange={(v) => { setPatterns((cur) => ({ ...cur, [p.key]: v })); setDirty(true); }} />
            ))}
          </>
        ) : null}
      </KitSettingsForm>
    </section>
  );
}
