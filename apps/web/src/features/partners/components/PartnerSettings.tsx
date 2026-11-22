'use client';
// SS-1 Partner settings (02-TRD §10.2): one form, one Save for the whole object. The settings carry no version; the ETag of the GET is the If-Match of the PUT.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { t } from '@/core/i18n/messages';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { SettingsForm } from '@lims/ui/components/SettingsForm';
import { Switch } from '@lims/ui/components/Switch';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { saveSettingsAction } from '../server/actions';
import type { Settings } from '../server/types';
import { errorText } from './common';

type NumKey = 'max_lines_per_manifest' | 'draft_ttl_days' | 'pickup_max_days_ahead' | 'report_download_daily_cap_per_user';
/** T0D-BUILD-2 (LD-447): save codes of updatePartnerSettings in plain words (this screen only; other codes go through errorText) */
const SAVE_ERRORS: Record<string, string> = {
  'partners.setting_out_of_range': 'A value is outside the allowed range. Check the limits shown under each field.',
  'common.precondition_required': 'The page is out of date. Reload the page and try again.',
  'common.validation_failed': 'Some values are invalid. Check the fields and try again.',
};
const MODES =[{ value: 'on_receipt', label: 'When the lab receives the samples' }, { value: 'on_submit', label: 'As soon as the partner submits' }] as const;

export function PartnerSettings({ initial, etag, canManage }: { initial: Settings; etag: string; canManage: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [s, setS] = useState<Settings>(initial);
  // A cleared number field must stay empty (the kit snaps its text back to the prop otherwise); Save is blocked while one is empty (isRequired).
  const [nums, setNums] = useState<Record<NumKey, number | undefined>>({
    max_lines_per_manifest: initial.max_lines_per_manifest, draft_ttl_days: initial.draft_ttl_days, pickup_max_days_ahead: initial.pickup_max_days_ahead, report_download_daily_cap_per_user: initial.report_download_daily_cap_per_user,
  });
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const set = <K extends keyof Settings>(k: K) => (v: Settings[K]) => { setS((o) => ({ ...o, [k]: v })); setDirty(true); };
  const num = (k: NumKey) => (v: number | undefined) => { setNums((o) => ({ ...o, [k]: v })); setDirty(true); };
  const ro = !canManage;

  const save = async () => {
    setBusy(true);
    try {
      const r = await saveSettingsAction({ ...s, ...(nums as Record<NumKey, number>) }, etag);
      // T0D-BUILD-2 (LD-447): a failed save is an error toast; the edit stays on screen
      if (r.ok) { setDirty(false); toast.show({ tone: 'success', title: 'Settings saved.' }); router.refresh(); } else toast.show({ tone: 'danger', title: SAVE_ERRORS[r.code] ?? errorText(r.code, r.status) });
    } finally {
      setBusy(false);
    }
  };

  const fields = (
    <>
        <RadioGroup label="Default order creation" name="default_conversion_mode" options={MODES} value={s.default_conversion_mode} onChange={set('default_conversion_mode')} isReadOnly={ro} />
        <Switch label="Show standard-rate tests to partners" isSelected={s.include_default_price_list} onChange={set('include_default_price_list')} isDisabled={ro} />
        <Switch label="Require confirmed doctors" isSelected={s.require_mapped_referrer} onChange={set('require_mapped_referrer')} isDisabled={ro} />
        <Switch label="Patient access slips" isSelected={s.access_slip_enabled} onChange={set('access_slip_enabled')} isDisabled={ro} />
        <p className="lims-description">Partners can print a slip with a link the patient opens with a code sent to their mobile.</p>
        <IntegerField label="Max samples per manifest" name="max_lines_per_manifest" isRequired min={1} max={200} {...(nums.max_lines_per_manifest !== undefined ? { value: nums.max_lines_per_manifest } : {})} onChange={num('max_lines_per_manifest')} isReadOnly={ro} />
        <IntegerField label="Draft expiry (days)" name="draft_ttl_days" isRequired min={1} max={90} {...(nums.draft_ttl_days !== undefined ? { value: nums.draft_ttl_days } : {})} onChange={num('draft_ttl_days')} isReadOnly={ro} />
        <IntegerField label="Pickup days ahead" name="pickup_max_days_ahead" isRequired min={1} max={30} {...(nums.pickup_max_days_ahead !== undefined ? { value: nums.pickup_max_days_ahead } : {})} onChange={num('pickup_max_days_ahead')} isReadOnly={ro} />
        <IntegerField label="Daily report downloads per user" name="report_download_daily_cap_per_user" isRequired min={50} max={5000} {...(nums.report_download_daily_cap_per_user !== undefined ? { value: nums.report_download_daily_cap_per_user } : {})} onChange={num('report_download_daily_cap_per_user')} isReadOnly={ro} />
        <TextField label="Consent text version" name="consent_text_version" maxLength={32} isRequired value={s.consent_text_version} onChange={set('consent_text_version')} isReadOnly={ro} />
        <TextArea label="Consent statement" name="consent_statement" maxLength={2000} rows={5} isRequired value={s.consent_statement} onChange={set('consent_statement')} isReadOnly={ro} />
    </>
  );

  return (
    <section aria-label="Partner settings">
      <PageHeader title={t('partners.nav.settings')} helpKey="partners.settings" />
      {/* T0D-UISETTINGS-1 (LD-353 template 4): one section, so no tabs; read only shows the values without the Save bar. */}
      {canManage ? (
        <SettingsForm onSave={save} saveLabel="Save settings" isSaving={busy} isDirty={dirty}>{fields}</SettingsForm>
      ) : (
        <div className="lims-settings"><div className="lims-settings-form"><div className="lims-settings-fields">{fields}</div></div></div>
      )}
    </section>
  );
}
