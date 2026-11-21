'use client';
// T0D-PARTYSET-1 (LD-321, LD-353 template 4 SETTINGS): the Commercial settings tab of a party (ElabAssist per client settings). ONE component for the
// partner and the credit party detail. Six compact groups; percent is shown from integer basis points and typed as percent (two decimals at most),
// days are whole numbers 0 to 365. Save sends ONLY the changed fields (PUT setPartyCommercialSetting): no If-Match on the first save of a default
// row, If-Match "<version>" afterwards; clearing the lab number scheme sends unset. Interest per day is a statement line only (LD-321: never posted).
// Without partners.party_setting.manage every control is disabled and Save points at the visible reason.
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import type { PartyCommercialSetting } from '../server/partyset.server';
import { setPartyCommercialSettingAction } from '../server/partysetActions';
import { LoadFailed, Notice } from './common';
import { hundredths, parseBp } from './PartysetCommon';
import { failure, useOnce } from './SalesCommon';

export const SETTING_READ = 'partners.party_setting.read';
const SETTING_MANAGE = 'partners.party_setting.manage';

type S = PartyCommercialSetting;
const BOOLS = ['auto_release_reports', 'whatsapp_enabled', 'insurance_enabled', 'print_exception', 'auto_block_overdue'] as const;
const DAYS = ['invoice_payment_days', 'invoice_warning_days', 'invoice_blocking_days'] as const;
const BPS = ['interest_bp_per_day', 'commission_bp', 'tds_bp'] as const;
const PICKS = ['billing_cycle', 'priority', 'header_footer_mode'] as const;
const FIELDS = [...BOOLS, ...DAYS, ...BPS, ...PICKS, 'lab_number_scheme_code'] as const;
type Field = (typeof FIELDS)[number];
const SCHEME = /^[A-Z0-9_-]{1,20}$/;

const CYCLES = ['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly'].map((v) => ({ value: v, label: t(`partners.partyset.cycle.${v}`) }));
const PRIORITIES = ['P1', 'P2', 'P3', 'P4', 'P5'].map((v) => ({ value: v, label: v }));
const HF = ['with', 'without', 'both'].map((v) => ({ value: v, label: t(`partners.partyset.hf.${v}`) }));

const toForm = (s: S): Record<Field, string | boolean> => ({
  ...Object.fromEntries(BOOLS.map((k) => [k, s[k]])),
  ...Object.fromEntries(DAYS.map((k) => [k, String(s[k])])),
  ...Object.fromEntries(BPS.map((k) => [k, hundredths(s[k])])),
  ...Object.fromEntries(PICKS.map((k) => [k, s[k]])),
  lab_number_scheme_code: s.lab_number_scheme_code ?? '',
}) as Record<Field, string | boolean>;

/** The changed fields as the contract wants them (integers), or the field errors. */
function diff(s: S, v: Record<Field, string | boolean>): { body: Record<string, unknown>; errors: Record<string, string> } {
  const body: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const k of BOOLS) if (v[k] !== s[k]) body[k] = v[k];
  for (const k of DAYS) {
    const txt = (v[k] as string).trim();
    const n = /^\d{1,3}$/.test(txt) ? Number(txt) : NaN;
    if (!(n >= 0 && n <= 365)) errors[k] = t('partners.partyset.error.days');
    else if (n !== s[k]) body[k] = n;
  }
  for (const k of BPS) {
    const n = parseBp(v[k] as string);
    if (n === undefined) errors[k] = t('partners.partyset.error.percent');
    else if (n !== s[k]) body[k] = n;
  }
  for (const k of PICKS) if (v[k] !== s[k]) body[k] = v[k];
  const code = (v['lab_number_scheme_code'] as string).trim();
  if (code === '') { if (s.lab_number_scheme_code) body['unset'] = ['lab_number_scheme_code']; }
  else if (!SCHEME.test(code)) errors['lab_number_scheme_code'] = t('partners.partyset.error.code');
  else if (code !== s.lab_number_scheme_code) body['lab_number_scheme_code'] = code;
  return { body, errors };
}

function Form({ setting, manage }: { setting: S; manage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const reasonId = useId();
  const once = useOnce();
  const [v, setV] = useState(() => toForm(setting));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<'conflict' | string | null>(null);
  const [busy, setBusy] = useState(false);
  const ro = !manage;

  const set = (k: Field) => (x: string | boolean) => { setV((o) => ({ ...o, [k]: x })); setErrors((e) => ({ ...e, [k]: '' })); };
  const err = (k: Field) => (errors[k] ? { error: errors[k] } : {});
  const sw = (k: (typeof BOOLS)[number], key: string) => <Switch label={t(key)} name={k} isSelected={v[k] as boolean} onChange={set(k)} {...(ro ? { isDisabled: true } : {})} />;
  const txt = (k: Field, key: string, extra: { description?: string; inputMode?: 'numeric' | 'decimal' | 'text' } = {}) => (
    <TextField label={t(key)} name={k} maxLength={k === 'lab_number_scheme_code' ? 40 : 10} value={v[k] as string} onChange={set(k)} isReadOnly={ro} {...extra} {...err(k)} />
  );
  const pick = (k: (typeof PICKS)[number], key: string, options: { value: string; label: string }[]) => (
    <Select label={t(key)} name={k} options={options} value={v[k] as string} onChange={set(k)} {...(ro ? { isDisabled: true } : {})} {...err(k)} />
  );

  const save = () => once(async () => {
    if (!manage) return;
    const d = diff(setting, v);
    setErrors(d.errors);
    setBanner(null);
    if (Object.keys(d.errors).length || Object.keys(d.body).length === 0) return;
    setBusy(true);
    try {
      const r = await setPartyCommercialSettingAction(setting.party_kind, setting.party_id, setting.is_default ? undefined : setting.version, d.body);
      if (r.ok) {
        toast.show({ tone: 'success', title: t('partners.partyset.saved') });
        router.refresh();
        return;
      }
      if (r.code === 'common.version_conflict') return setBanner('conflict');
      const f = failure(r, FIELDS);
      setErrors(f.fields);
      if (f.text) setBanner(f.text);
    } finally {
      setBusy(false);
    }
  });

  return (
    <div className="lims-stack">
      {setting.is_default ? <p role="note" className="lims-description">{t('partners.partyset.defaults')}</p> : null}
      {banner === 'conflict' ? (
        <div role="alert"><Banner tone="warning" title={t('partners.partyset.conflict')} action={{ label: t('partners.partyset.refresh'), onPress: () => router.refresh() }} /></div>
      ) : banner ? <Notice text={banner} /> : null}
      <div className="lims-grid lims-grid-2">
        <fieldset className="lims-fieldset lims-stack">
          <legend className="lims-label">{t('partners.partyset.group.reports')}</legend>
          {sw('auto_release_reports', 'partners.partyset.field.auto_release')}
          {txt('lab_number_scheme_code', 'partners.partyset.field.lab_number_scheme', { description: t('partners.partyset.scheme_hint') })}
        </fieldset>
        <fieldset className="lims-fieldset lims-stack">
          <legend className="lims-label">{t('partners.partyset.group.messaging')}</legend>
          {sw('whatsapp_enabled', 'partners.partyset.field.whatsapp')}
        </fieldset>
        <fieldset className="lims-fieldset lims-stack">
          <legend className="lims-label">{t('partners.partyset.group.billing')}</legend>
          {pick('billing_cycle', 'partners.partyset.field.billing_cycle', CYCLES)}
          {sw('insurance_enabled', 'partners.partyset.field.insurance')}
          {txt('invoice_payment_days', 'partners.partyset.field.payment_days', { inputMode: 'numeric' })}
          {txt('invoice_warning_days', 'partners.partyset.field.warning_days', { inputMode: 'numeric' })}
          {txt('invoice_blocking_days', 'partners.partyset.field.blocking_days', { inputMode: 'numeric' })}
          {sw('auto_block_overdue', 'partners.partyset.field.auto_block')}
        </fieldset>
        <fieldset className="lims-fieldset lims-stack">
          <legend className="lims-label">{t('partners.partyset.group.interest')}</legend>
          {txt('interest_bp_per_day', 'partners.partyset.field.interest', { inputMode: 'decimal', description: t('partners.partyset.interest_hint') })}
          {pick('priority', 'partners.partyset.field.priority', PRIORITIES)}
        </fieldset>
        <fieldset className="lims-fieldset lims-stack">
          <legend className="lims-label">{t('partners.partyset.group.commission')}</legend>
          {txt('commission_bp', 'partners.partyset.field.commission', { inputMode: 'decimal' })}
          {txt('tds_bp', 'partners.partyset.field.tds', { inputMode: 'decimal' })}
        </fieldset>
        <fieldset className="lims-fieldset lims-stack">
          <legend className="lims-label">{t('partners.partyset.group.print')}</legend>
          {sw('print_exception', 'partners.partyset.field.print_exception')}
          {pick('header_footer_mode', 'partners.partyset.field.header_footer', HF)}
        </fieldset>
      </div>
      <div className="lims-inline lims-sticky-footer">
        {manage ? (
          <Button variant="primary" isLoading={busy} onPress={() => void save()}>{t('partners.partyset.save')}</Button>
        ) : (
          <>
            <Button variant="primary" isDisabled ref={(el) => el?.setAttribute('aria-describedby', reasonId)}>{t('partners.partyset.save')}</Button>
            <p id={reasonId} className="lims-description">{t('partners.partyset.reason.manage')}</p>
          </>
        )}
      </div>
    </div>
  );
}

/** `setting` null = the read failed (a banner in this tab only). The form remounts when the saved row changes (after a refresh). */
export function CommercialSettings({ setting, permissions }: { setting: S | null; permissions: readonly string[] }) {
  if (!setting) return <LoadFailed title={t('partners.partyset.load_failed')} />;
  return <Form key={`${setting.version}-${String(setting.is_default)}`} setting={setting} manage={permissions.includes(SETTING_MANAGE)} />;
}
