'use client';
// S18 Settings (04-UI-UX §3 S18; TRD #26, #27). LD-140 (2026-11-13): kit components only; ONE primary button (Save). With inventory.master.manage this is
// a form, otherwise a read-only DescriptionList. Percent fields are shown as percent and sent as basis points. Save is one PUT with If-Match "<version>".
// Turning automatic consumption on asks for a start time (default now); the server rejects a start older than 1 hour (400 at /consumption_enabled_at).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { DateTimePicker, type DateTimePickerProps } from '@lims/ui/components/DateTimePicker';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Form } from '@lims/ui/components/Form';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { saveSettingsAction } from '../server/actions';
import type { Settings, SettingsUpdate } from '../server/types';
import { Pick, ProblemBanner, yesNo, type Failure } from './shared';

const PATTERN_HINT = 'Patterns can use {yy}, {fy}, {fyl} and {seq:N}, for example PO-{fy}-{seq:5}.';
const VAT_HELP = 'Turn off if your lab can claim purchase VAT back (ask your auditor).';
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
    toast.show({ tone: 'success', title: 'Settings saved' });
    router.refresh();
  };

  return (
    <section aria-label="Settings">
      <PageHeader title="Settings" helpKey="inventory.settings" />
      <Form onSubmit={onSubmit} {...(problem?.errors ? { problem: { errors: problem.errors } } : {})}>
        <Stack>
          <ProblemBanner problem={problem} />
          <Card title="Consumption">
            <Stack gap={3}>
              <Switch
                label="Automatic consumption"
                name="auto_consumption"
                isSelected={autoOn}
                onChange={(on) => {
                  setAutoOn(on);
                  if (on && !startAt) setStartAt(nowIso());
                  if (!on) setStartAt(undefined);
                }}
              />
              {autoOn ? <DateTimePicker label="Start from" name="consumption_enabled_at" {...(startAt ? { value: startAt } : {})} onChange={setStartAt} /> : null}
              <Pick label="Default consumption store" name="default_consumption_store_id" options={stores} value={store} onChange={setStore} />
              <Switch label="Analyser-day rules need activity" name="per_day_requires_activity" isSelected={perDay} onChange={setPerDay} />
            </Stack>
          </Card>
          <Card title="Purchasing">
            <Stack gap={3}>
              <Switch label="VAT included in cost" name="vat_in_cost" isSelected={vat} onChange={setVat} />
              <p className="lims-description">{VAT_HELP}</p>
              <Switch label="Allow approving own PO" name="po_self_approval_allowed" isSelected={selfApprove} onChange={setSelfApprove} />
              <Switch label="Allow receipts without PO" name="grn_without_po_allowed" isSelected={grnNoPo} onChange={setGrnNoPo} />
              <DecimalField label="Over-receipt tolerance %" name="over_receipt_tolerance_bp" decimals={2} min="0" max="50" isRequired {...(tolerance ? { value: tolerance } : {})} onChange={setTolerance} />
            </Stack>
          </Card>
          <Card title="Alerts and counts">
            <Stack gap={3}>
              <DecimalField label="Expiry alert days" name="expiry_alert_days" decimals={0} min="1" max="365" isRequired {...(expiryDays ? { value: expiryDays } : {})} onChange={setExpiryDays} />
              <Switch label="Lock store during count" name="count_locks_store" isSelected={locks} onChange={setLocks} />
              <DecimalField label="Reconciliation alert %" name="reconciliation_gap_alert_bp" decimals={2} min="0" max="100" isRequired {...(recon ? { value: recon } : {})} onChange={setRecon} />
              <DecimalField label="Back-dating limit days" name="backdate_max_days" decimals={0} min="0" max="31" isRequired {...(backdate ? { value: backdate } : {})} onChange={setBackdate} />
            </Stack>
          </Card>
          <Card title="Document numbers">
            <Stack gap={3}>
              <p className="lims-description">{PATTERN_HINT}</p>
              {PATTERNS.map((p) => (
                <TextField key={p.key} label={p.label} name={p.key} maxLength={40} isRequired value={patterns[p.key]} onChange={(v) => setPatterns((cur) => ({ ...cur, [p.key]: v }))} />
              ))}
            </Stack>
          </Card>
          <div>
            <Button type="submit" variant="primary" isLoading={saving}>
              Save
            </Button>
          </div>
        </Stack>
      </Form>
    </section>
  );
}
