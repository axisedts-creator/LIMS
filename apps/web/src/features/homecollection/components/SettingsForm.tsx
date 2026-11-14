'use client';
// 04-UI-UX §2.5 W5 Settings: kit Form sections, Ctrl+Enter or "Save settings" -> server action -> PUT /settings (H19, If-Match = settings version).
// Ranges are TRD §11.2; they are stopped here before anything is sent, and again in write.server.ts. LD-140: kit components only, one primary button.
// Not built yet, so switched off and never sent as true: Capture GPS point (CR-C17-010), SMS to patient on scheduling (CR-C17-014, D-129),
// Second identifier "Date of birth" (CR-C17-003). Payment codes are C4's six seed codes only (08 A19 D-128): the list is closed, a stored code outside it blocks the save.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { Stack } from '@lims/ui/components/Stack';
import { Switch } from '@lims/ui/components/Switch';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { SETTINGS_CHANGED, failText, isSemver } from '../labels';
import { saveSettingsAction } from '../server/actions';
import type { PaymentMethod, SettingsBody, SettingsDto } from '../types';

const PAYMENT_CODES = [
  { value: 'cash', label: 'Cash' }, { value: 'card', label: 'Card' }, { value: 'esewa', label: 'eSewa' },
  { value: 'khalti', label: 'Khalti' }, { value: 'fonepay_qr', label: 'Fonepay QR' }, { value: 'bank_transfer', label: 'Bank transfer' },
] as const;
const MAX_METHODS = 10;
type NumKey = 'sync_interval_seconds' | 'offline_purge_hours' | 'gps_retention_days' | 'handover_overdue_hours' | 'max_visits_per_route' | 'clock_tolerance_seconds';
type Draft = Omit<SettingsBody, NumKey | 'payment_methods'> & { [K in NumKey]: number | undefined };
interface Row extends PaymentMethod { key: number }

const nameOf = (code: string) => PAYMENT_CODES.find((c) => c.value === code)?.label ?? 'this row';

export function SettingsForm({ settings }: { settings: SettingsDto }) {
  const router = useRouter();
  const toast = useToast();
  const busy = useRef(false);
  const version = useRef(settings.version);
  const nextKey = useRef(settings.payment_methods.length);
  const [d, setD] = useState<Draft>(() => {
    const { version: _v, payment_methods: _p, ...rest } = settings; // eslint-disable-line @typescript-eslint/no-unused-vars
    return rest;
  });
  const [rows, setRows] = useState<Row[]>(() => settings.payment_methods.map((p, i) => ({ key: i, ...p })));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [payError, setPayError] = useState('');
  const [banner, setBanner] = useState<{ title: string; reload?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const saved = useRef(false); // true from a successful save until the next edit: a repeated Ctrl+Enter must not send the same values again
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { saved.current = false; setD((s) => ({ ...s, [k]: v })); setErrs((e) => (e[k] ? { ...e, [k]: '' } : e)); };
  const err = (k: string) => (errs[k] ? { error: errs[k] } : {});
  const patch = (key: number, p: Partial<PaymentMethod>) => { saved.current = false; setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r))); setPayError(''); };

  const int = (k: NumKey, label: string, min: number, max: number, description?: string) => (
    <IntegerField label={label} name={k} min={min} max={max} isRequired {...(description ? { description } : {})} {...(d[k] !== undefined ? { value: d[k] } : {})} onChange={(v) => set(k, v)} />
  );

  const submit = async () => {
    if (busy.current || saved.current) return;
    const found: Record<string, string> = {};
    if (!isSemver(d.min_app_version)) found['min_app_version'] = 'Minimum app version must look like 1.10.0.';
    if (d.collection_consent_text_version.trim() === '') found['collection_consent_text_version'] = 'Enter Consent text version';
    if (d.collection_consent_text.trim() === '') found['collection_consent_text'] = 'Enter Consent text';
    let pay = '';
    if (rows.some((r) => !PAYMENT_CODES.some((c) => c.value === r.code))) pay = 'Choose one of the listed payment methods for every row.';
    else if (new Set(rows.map((r) => r.code)).size !== rows.length) pay = 'Each payment method can be used once only.';
    else if (rows.some((r) => r.display.trim() === '')) pay = 'Every payment method needs a label.';
    setErrs(found);
    setPayError(pay);
    const n = (k: NumKey) => d[k];
    if (Object.keys(found).length || pay || ([n('sync_interval_seconds'), n('offline_purge_hours'), n('gps_retention_days'), n('handover_overdue_hours'), n('max_visits_per_route'), n('clock_tolerance_seconds')] as (number | undefined)[]).some((x) => x === undefined)) return;

    busy.current = true;
    setSaving(true);
    setBanner(null);
    try {
      const body = {
        ...d,
        // switched off until the pieces they need exist (CR-C17-010 / CR-C17-014): never sent as true, whatever was stored
        capture_gps: false, notify_patient_on_assign: false,
        payment_methods: rows.map(({ code, display, requires_reference }) => ({ code, display: display.trim(), requires_reference })),
      } as SettingsBody;
      const res = await saveSettingsAction(version.current, body);
      if (!res.ok) { setBanner({ title: failText(res, 'Check the values and try again.', SETTINGS_CHANGED), reload: res.code === 'common.version_conflict' }); return; }
      if (res.version !== undefined) version.current = res.version;
      saved.current = true;
      toast.show({ tone: 'success', title: 'Settings saved.' });
      router.refresh();
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const columns: ColumnDef<Row>[] = [
    {
      id: 'code', header: 'Method', isRowHeader: true,
      cell: (r) => (
        <Select
          label="Code" name={`pm_${r.key}_code`} options={PAYMENT_CODES} value={r.code as (typeof PAYMENT_CODES)[number]['value']}
          onChange={(c) => patch(r.key, { code: c })}
        />
      ),
    },
    { id: 'display', header: 'Label', cell: (r) => <TextField label="Label" name={`pm_${r.key}_display`} maxLength={40} isRequired value={r.display} onChange={(v) => patch(r.key, { display: v })} /> },
    { id: 'ref', header: 'Reference', cell: (r) => <Checkbox label="Reference required" isSelected={r.requires_reference} onChange={(on) => patch(r.key, { requires_reference: on })} /> },
    { id: 'remove', header: 'Remove', cell: (r) => <Button size="sm" variant="ghost" isDisabled={rows.length <= 1} onPress={() => { saved.current = false; setRows((rs) => rs.filter((x) => x.key !== r.key)); setPayError(''); }}>{`Remove ${nameOf(r.code)}`}</Button> },
  ];
  const addMethod = () => {
    saved.current = false;
    const free = PAYMENT_CODES.find((c) => !rows.some((r) => r.code === c.value)) ?? PAYMENT_CODES[0];
    setRows((rs) => [...rs, { key: nextKey.current++, code: free.value, display: free.label, requires_reference: free.value === 'fonepay_qr' || free.value === 'card' || free.value === 'bank_transfer' }]);
    setPayError('');
  };

  return (
    <Form onSubmit={submit}>
      <PageHeader title="Home Collection settings" helpKey="homecollection.settings" actions={<Button type="submit" variant="primary" shortcut="Ctrl+Enter" isLoading={saving}>Save settings</Button>} />
      {banner ? (
        <div role="alert">
          <Banner tone="danger" title={banner.title} {...(banner.reload ? { action: { label: 'Reload', onPress: () => router.refresh() } } : {})} />
        </div>
      ) : null}

      <Card title="Sync & privacy">
        <Stack>
          {int('sync_interval_seconds', 'Sync interval (seconds)', 60, 900)}
          {int('offline_purge_hours', 'Clear phone data after offline (hours)', 4, 24)}
          <Switch label="Capture GPS point" name="capture_gps" isDisabled isSelected={false} />
          <p className="lims-description">Needs the location component (pending)</p>
          {int('gps_retention_days', 'GPS kept for (days)', 7, 365)}
          <Switch label="Allow maps hand-off" name="map_handoff_enabled" isSelected={d.map_handoff_enabled} onChange={(on) => set('map_handoff_enabled', on)} />
          <p className="lims-description">Sends only the visit address (no name, tests or phone) to the phone&apos;s own maps app.</p>
          <TextField label="Minimum app version" name="min_app_version" maxLength={20} value={d.min_app_version} onChange={(v) => set('min_app_version', v)} {...err('min_app_version')} />
        </Stack>
      </Card>

      <Card title="Visit checks">
        <Stack>
          <RadioGroup
            label="Second identifier" name="second_identifier" value={d.second_identifier as 'phone' | 'birth_date'} onChange={(v) => set('second_identifier', v)}
            options={[{ value: 'phone', label: 'Phone number' }, { value: 'birth_date', label: 'Date of birth', isDisabled: true }]}
          />
          <Switch label="Allow typed barcodes" name="manual_barcode_entry_allowed" isSelected={d.manual_barcode_entry_allowed} onChange={(on) => set('manual_barcode_entry_allowed', on)} />
          <TextField label="Consent text version" name="collection_consent_text_version" maxLength={40} isRequired value={d.collection_consent_text_version} onChange={(v) => set('collection_consent_text_version', v)} {...err('collection_consent_text_version')} />
          <TextArea label="Consent text" name="collection_consent_text" maxLength={2000} showCount value={d.collection_consent_text} onChange={(v) => set('collection_consent_text', v)} {...err('collection_consent_text')} />
        </Stack>
      </Card>

      <Card title="Payments">
        <Stack>
          <DataTable<Row> caption="Payment methods" columns={columns} rows={rows} getRowId={(r) => String(r.key)} density="compact" emptyState={{ title: 'No payment methods.' }} />
          {payError ? <div role="alert"><Banner tone="danger" title={payError} /></div> : null}
          <div>
            <Button isDisabled={rows.length >= MAX_METHODS} onPress={addMethod}>Add payment method</Button>
          </div>
        </Stack>
      </Card>

      <Card title="Handover">
        <Stack>
          <Switch label="Confirmation at centre required" name="handover_confirmation_required" isSelected={d.handover_confirmation_required} onChange={(on) => set('handover_confirmation_required', on)} />
          {int('handover_overdue_hours', 'Overdue after (hours)', 1, 24)}
        </Stack>
      </Card>

      <Card title="Routes & messages">
        <Stack>
          {int('max_visits_per_route', 'Max visits per route', 1, 60)}
          <Switch label="SMS to phlebotomist on assignment" name="notify_phlebotomist_on_assign" isSelected={d.notify_phlebotomist_on_assign} onChange={(on) => set('notify_phlebotomist_on_assign', on)} />
          <p className="lims-description">Staff SMS are not sent yet (Phase 1).</p>
          <Switch label="SMS to patient on scheduling" name="notify_patient_on_assign" isDisabled isSelected={false} />
          <p className="lims-description">Needs the scheduling SMS template (pending)</p>
          {int('clock_tolerance_seconds', 'Clock tolerance (seconds)', 60, 3600)}
        </Stack>
      </Card>
    </Form>
  );
}
