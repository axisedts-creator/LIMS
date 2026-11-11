'use client';
// 04-UI-UX §2.8 Reporting settings (02-TRD §10.2; reporting.settings.manage). PATCH sends only the changed fields with If-Match + Idempotency-Key.
// Centre contacts are shown with MASKED addresses only.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Switch } from '@lims/ui/components/Switch';
import { useToast } from '@lims/ui/components/Toast';
import { updateSettingsAction } from '../server/actions';
import type { Centre, CentreContact, ReportingSettings } from '../server/types';
import { errorText, hasPerm, humanize, newKey } from './format';
import { NumberInput, rangeError } from './NumberInput';
import { SimpleTable, type Col } from './SimpleTable';

type Draft = Omit<ReportingSettings, 'version'>;
const ORDERS: Record<string, string[]> = { 'whatsapp,sms': ['whatsapp', 'sms'], 'sms,whatsapp': ['sms', 'whatsapp'], whatsapp: ['whatsapp'], sms: ['sms'] };
const ORDER_LABEL: Record<string, string> = { 'whatsapp,sms': 'WhatsApp first, then SMS', 'sms,whatsapp': 'SMS first, then WhatsApp', whatsapp: 'WhatsApp only', sms: 'SMS only' };
const CHANNELS = [['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email']] as const;
const NUMBERS = [
  ['whatsapp_fallback_minutes', 'WhatsApp fallback to SMS (minutes)', 5, 240], ['bulk_release_max', 'Bulk release maximum (reports at once)', 1, 200], ['link_reissue_max_per_day', 'Link reissue limit per day', 0, 5],
] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function ReportingSettingsForm({ settings, contacts, centres, permissions }: { settings: ReportingSettings; contacts: readonly CentreContact[]; centres: readonly Centre[]; permissions: readonly string[] }) {
  const router = useRouter();
  const toast = useToast();
  const canManage = hasPerm(permissions, 'reporting.settings.manage');
  const [base, setBase] = useState(settings);
  const { version, ...initial } = base;
  const [d, setD] = useState<Draft>(() => { const { version: _v, ...rest } = settings; return rest; });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const key = useRef(newKey());
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setD((x) => ({ ...x, [k]: v })); setError(undefined); key.current = newKey(); };
  const toggle = (k: 'referrer_channels' | 'portal_payment_gateways', v: string, on: boolean) => set(k, (on ? [...d[k], v] : d[k].filter((x) => x !== v)) as never);
  const orderKey = d.patient_mobile_channel_order.join(',');
  const centreName = (id: string) => centres.find((c) => c.id === id)?.name ?? id;

  const submit = async () => {
    if (busy) return;
    const bad = NUMBERS.find(([k, label, min, max]) => rangeError(label, d[k], min, max));
    if (bad) { setError(`${bad[1]} must be between ${bad[2]} and ${bad[3]}`); return; }
    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(d) as (keyof Draft)[]) if (!same(d[k], initial[k])) patch[k] = d[k];
    if (Object.keys(patch).length === 0) { toast.show({ tone: 'info', title: 'Nothing has changed.' }); return; }
    setBusy(true);
    try {
      const r = await updateSettingsAction(version, patch as Partial<Draft>, key.current);
      if (r.ok) { setBase(r.data); key.current = newKey(); toast.show({ tone: 'success', title: 'Settings saved.' }); router.refresh(); } else setError(errorText(r.code));
    } finally { setBusy(false); }
  };

  const contactCols: Col<CentreContact>[] = [
    { id: 'centre', header: 'Centre', rowHeader: true, cell: (c) => centreName(c.centre_id) },
    { id: 'channel', header: 'Channel', cell: (c) => humanize(c.channel) },
    { id: 'address', header: 'Address', cell: (c) => c.address_masked },
    { id: 'label', header: 'Label', cell: (c) => c.label ?? '—' },
    { id: 'active', header: 'Active', cell: (c) => (c.is_active ? 'Yes' : 'No') },
  ];
  const ro = !canManage;
  return (
    <section aria-label="Reporting settings">
      <PageHeader title="Reporting settings" helpKey="reporting.settings" />
      <form
        noValidate className="lims-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}
        onKeyDown={(e) => { if (canManage && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.currentTarget.requestSubmit(); } }}
      >
        {error ? <div role="alert"><Banner tone="danger" title="Could not save the settings">{error}</Banner></div> : null}

        <div className="lims-card">
          <h2>Release</h2>
          <RadioGroup<string> label="Release" name="auto_release" value={d.auto_release} isDisabled={ro} onChange={(v) => set('auto_release', v)} options={[{ value: 'when_eligible', label: 'Release automatically when a report is ready' }, { value: 'manual', label: 'Staff release each report' }]} />
          <RadioGroup<string> label="Narrative reports" name="narrative_report_mode" value={d.narrative_report_mode} isDisabled={ro} onChange={(v) => set('narrative_report_mode', v)} options={[{ value: 'separate', label: 'Separate report for each narrative test' }, { value: 'combined', label: 'Combine with the lab report' }]} />
          <Switch label="Print a critical label on reports with critical results" isDisabled={ro} isSelected={d.print_critical_label} onChange={(v) => set('print_critical_label', v)} />
          <NumberInput label={NUMBERS[1][1]} name="bulk_release_max" min={1} max={200} value={d.bulk_release_max} isReadOnly={ro} onChange={(v) => set('bulk_release_max', v as number)} />
        </div>

        <div className="lims-card">
          <h2>Delivery</h2>
          <RadioGroup<string> label="Patient mobile channels" name="patient_mobile_channel_order" value={ORDERS[orderKey] ? orderKey : ''} isDisabled={ro} onChange={(v) => set('patient_mobile_channel_order', ORDERS[v] ?? [])} options={Object.keys(ORDERS).map((k) => ({ value: k, label: ORDER_LABEL[k]! }))} />
          <Switch label="Patient email delivery" isDisabled={ro} isSelected={d.patient_email_enabled} onChange={(v) => set('patient_email_enabled', v)} />
          <Switch label="Send reports to the referrer" isDisabled={ro} isSelected={d.referrer_delivery_enabled} onChange={(v) => set('referrer_delivery_enabled', v)} />
          <fieldset className="lims-fieldset">
            <legend>Referrer channels</legend>
            {CHANNELS.map(([c, label]) => <Checkbox key={c} label={`Referrer: ${label}`} isDisabled={ro} isSelected={d.referrer_channels.includes(c)} onChange={(on) => toggle('referrer_channels', c, on)} />)}
          </fieldset>
          <Switch label="Centre delivery" isDisabled={ro} isSelected={d.centre_delivery_enabled} onChange={(v) => set('centre_delivery_enabled', v)} />
          <Switch label="Critical alert messages to the referrer" isDisabled={ro} isSelected={d.critical_alert_referrer_enabled} onChange={(v) => set('critical_alert_referrer_enabled', v)} />
          <NumberInput label={NUMBERS[0][1]} name="whatsapp_fallback_minutes" min={5} max={240} value={d.whatsapp_fallback_minutes} isReadOnly={ro} onChange={(v) => set('whatsapp_fallback_minutes', v as number)} />
        </div>

        <div className="lims-card">
          <h2>Patient portal</h2>
          <NumberInput label={NUMBERS[2][1]} name="link_reissue_max_per_day" min={0} max={5} value={d.link_reissue_max_per_day} isReadOnly={ro} onChange={(v) => set('link_reissue_max_per_day', v as number)} />
          <Switch label="Send a payment link when a report is held for dues" isDisabled={ro} isSelected={d.dues_link_enabled} onChange={(v) => set('dues_link_enabled', v)} />
          <fieldset className="lims-fieldset">
            <legend>Portal payment gateways</legend>
            <Checkbox label="eSewa" isDisabled={ro} isSelected={d.portal_payment_gateways.includes('esewa')} onChange={(on) => toggle('portal_payment_gateways', 'esewa', on)} />
            <Checkbox label="Khalti" isDisabled={ro} isSelected={d.portal_payment_gateways.includes('khalti')} onChange={(on) => toggle('portal_payment_gateways', 'khalti', on)} />
            <p className="lims-description">Turn on only after online payments are live for your lab.</p>
          </fieldset>
        </div>

        {canManage ? <Button type="submit" variant="primary" shortcut="Ctrl+Enter" isLoading={busy}>Save settings</Button> : null}
      </form>

      <div className="lims-card">
        <h2>Centre contacts</h2>
        <SimpleTable caption="Centre contacts" columns={contactCols} rows={contacts} getRowId={(c) => c.id} empty={{ title: 'No centre contacts yet.' }} />
      </div>
    </section>
  );
}
