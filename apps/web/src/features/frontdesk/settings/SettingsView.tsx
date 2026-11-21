'use client';
// 04-UI-UX §8.11 front desk settings (F24 getFrontdeskSettings / updateFrontdeskSettings). LD-255 (FOUNDER): the administrator controls the discount limits here.
// Percent fields show whole or decimal percent and are sent as basis points; NPR is a MoneyField (integer paisa). Writes send If-Match "<version>" through the
// server action (PUT). Nothing invalid is sent: client checks mirror the operation schema, and a server 400 is shown inline on the field it names.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { MoneyField, type Money } from '@lims/ui/components/MoneyField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { SettingsForm as KitSettingsForm } from '@lims/ui/components/SettingsForm';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { saveFrontdeskSettingsAction } from './actions';
import { FIELD_LABEL, SELF_ABOVE_MAX, bpToPercent, panPatternError, percentToBp, type FrontdeskSettings, type FrontdeskSettingsBody } from './model';

export const RELOAD_COPY = 'This record was changed by someone else. Reload to see the latest version.';
export const MFA_COPY = 'This action needs two-step verification. Log in again with your authenticator code.';
const GENERIC = 'Something went wrong. Try again; if it keeps failing, contact support.';
const NOT_ACCEPTED = 'Some values were not accepted. Check the marked fields.';

type Name = keyof FrontdeskSettingsBody;
type Errors = Partial<Record<Name, string>>;
type Banner_ = { kind: 'error'; title: string } | { kind: 'conflict' } | null;
// T0D-UISETTINGS-1 (LD-353 template 4): the two former cards are the two tabs of the kit SettingsForm.
const TABS = [{ id: 'discounts', label: 'Discounts' }, { id: 'registration', label: 'Registration' }] as const;
const DISCOUNT_FIELDS: readonly Name[] = ['discount_self_limit_bp', 'discount_self_limit_paisa', 'discount_absolute_max_bp'];

export function SettingsView({ settings, mfaRequired = false }: { settings?: FrontdeskSettings | undefined; mfaRequired?: boolean }) {
  return (
    // A named region so every part of the page sits inside a landmark (the shell supplies <main>).
    <section aria-label="Front desk settings">
      <PageHeader title="Front desk settings" helpKey="frontdesk.settings" />
      {mfaRequired || !settings ? <div role="alert"><Banner tone="warning" title={MFA_COPY} /></div> : <SettingsForm initial={settings} />}
    </section>
  );
}

function SettingsForm({ initial }: { initial: FrontdeskSettings }) {
  const router = useRouter();
  const [selfPct, setSelfPct] = useState<string | undefined>(bpToPercent(initial.discount_self_limit_bp));
  const [selfNpr, setSelfNpr] = useState<Money | undefined>({ amountPaisa: initial.discount_self_limit_paisa, currency: 'NPR' });
  const [absMax, setAbsMax] = useState<string | undefined>(bpToPercent(initial.discount_absolute_max_bp));
  const [referrer, setReferrer] = useState(initial.require_referrer);
  const [consent, setConsent] = useState(initial.consent_text_version);
  const [sms, setSms] = useState(initial.registration_sms_enabled);
  const [label, setLabel] = useState(initial.label_autoprint);
  const [pan, setPan] = useState(initial.buyer_pan_pattern);
  const [minChars, setMinChars] = useState<number | undefined>(initial.patient_search_min_chars);
  const [version, setVersion] = useState(initial.version);
  const [errors, setErrors] = useState<Errors>({});
  const [banner, setBanner] = useState<Banner_>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<string>('discounts');
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [focus, setFocus] = useState<{ name: Name; n: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focus) root.current?.querySelector<HTMLElement>(`[name="${focus.name}"]`)?.focus();
  }, [focus]);

  /** An edit marks the form dirty and clears the error of the field(s) it touches. */
  const edit = <T,>(set: (v: T) => void, ...names: Name[]) => (v: T) => {
    set(v);
    setDirty(true);
    if (names.length) setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !names.includes(k as Name))));
  };
  const fail = (e: Errors, title: string, first: Name) => {
    setErrors(e);
    setBanner({ kind: 'error', title });
    setTab(DISCOUNT_FIELDS.includes(first) ? 'discounts' : 'registration'); // the named field is on screen before it is focused
    setFocus((f) => ({ name: first, n: (f?.n ?? 0) + 1 }));
  };

  async function submit() {
    setBanner(null);
    setErrors({});
    const selfBp = percentToBp(selfPct ?? '');
    const maxBp = percentToBp(absMax ?? '');
    if (selfBp === undefined || maxBp === undefined || !selfNpr || !Number.isSafeInteger(selfNpr.amountPaisa) || selfNpr.amountPaisa < 0 || minChars === undefined) return;
    if (selfBp > maxBp) return fail({ discount_self_limit_bp: SELF_ABOVE_MAX }, SELF_ABOVE_MAX, 'discount_self_limit_bp');
    const panError = panPatternError(pan);
    if (panError) return fail({ buyer_pan_pattern: panError }, panError, 'buyer_pan_pattern');
    const body: FrontdeskSettingsBody = {
      discount_self_limit_bp: selfBp, discount_self_limit_paisa: selfNpr.amountPaisa, discount_absolute_max_bp: maxBp, require_referrer: referrer,
      consent_text_version: consent, registration_sms_enabled: sms, label_autoprint: label, buyer_pan_pattern: pan, patient_search_min_chars: minChars,
    };
    setSaving(true);
    try {
      const r = await saveFrontdeskSettingsAction(version, body);
      if (r.ok) {
        setVersion(r.settings.version); // the next save sends the version this one returned
        setDirty(false);
        toast.show({ tone: 'success', title: 'Settings saved.' }); // LD-353 template 4: one success toast, no in-page banner
      } else if (r.status === 409) setBanner({ kind: 'conflict' });
      else if (r.status === 403) setBanner({ kind: 'error', title: r.code === 'auth.mfa_required' ? MFA_COPY : 'You do not have permission to change these settings.' });
      else if (r.status === 429) setBanner({ kind: 'error', title: 'Too many requests. Wait a moment and try again.' });
      else if (r.status === 400) {
        const bad = r.paths.filter((p): p is Name => p in FIELD_LABEL);
        if (bad.length) fail(Object.fromEntries(bad.map((p) => [p, `${FIELD_LABEL[p]} was not accepted. Check the value and try again.`])), NOT_ACCEPTED, bad[0]!);
        else setBanner({ kind: 'error', title: NOT_ACCEPTED });
      } else setBanner({ kind: 'error', title: GENERIC });
    } catch {
      setBanner({ kind: 'error', title: GENERIC }); // network failure: the form stays editable
    } finally {
      setSaving(false);
    }
  }

  const err = (n: Name) => (errors[n] ? { error: errors[n] as string } : {});
  const listed = Object.values(errors);
  return (
    <div ref={root}>
      <div role="alert">
        {banner?.kind === 'conflict' ? <Banner tone="danger" title={RELOAD_COPY} action={{ label: 'Reload', onPress: () => router.refresh() }} /> : null}
        {banner?.kind === 'error' ? (
          <Banner tone="danger" title={banner.title}>
            {/* T0D-UIGUARD-1-FRONTDESK (LD-436 R7): no raw ul; the messages keep list semantics. */}
            {listed.length ? <div role="list">{listed.map((m) => <div role="listitem" key={m}>{m}</div>)}</div> : null}
          </Banner>
        ) : null}
      </div>
      <KitSettingsForm
        tabs={<Tabs aria-label="Front desk settings sections" items={TABS} selectedId={tab} onChange={setTab} />}
        onSave={submit} isSaving={saving} isDirty={dirty}
      >
        {/* every section stays mounted (kit Form validates all fields, values survive a tab change); the inactive one is hidden */}
        <div className="lims-settings-section" hidden={tab !== 'discounts'}>
          <DecimalField
            label={FIELD_LABEL.discount_self_limit_bp} name="discount_self_limit_bp" decimals={2} min="0" max="100" isRequired
            description="Discounts up to this percent are applied without approval." {...(selfPct !== undefined ? { value: selfPct } : {})}
            onChange={edit(setSelfPct, 'discount_self_limit_bp')} {...err('discount_self_limit_bp')}
          />
          <MoneyField
            label={FIELD_LABEL.discount_self_limit_paisa} name="discount_self_limit_paisa" isRequired description="0 = the percent limit alone decides."
            {...(selfNpr ? { value: selfNpr } : {})} onChange={edit(setSelfNpr, 'discount_self_limit_paisa')} {...err('discount_self_limit_paisa')}
          />
          <DecimalField
            label={FIELD_LABEL.discount_absolute_max_bp} name="discount_absolute_max_bp" decimals={2} min="0" max="100" isRequired
            description="No discount above this percent can be requested." {...(absMax !== undefined ? { value: absMax } : {})}
            onChange={edit(setAbsMax, 'discount_absolute_max_bp', 'discount_self_limit_bp')} {...err('discount_absolute_max_bp')}
          />
        </div>
        <div className="lims-settings-section" hidden={tab !== 'registration'}>
          <Checkbox label={FIELD_LABEL.require_referrer} name="require_referrer" isSelected={referrer} onChange={edit(setReferrer)} />
          <TextField
            label={FIELD_LABEL.consent_text_version} name="consent_text_version" maxLength={32} isRequired value={consent}
            onChange={edit(setConsent, 'consent_text_version')} {...err('consent_text_version')}
          />
          <Checkbox label={FIELD_LABEL.registration_sms_enabled} name="registration_sms_enabled" isSelected={sms} onChange={edit(setSms)} />
          <Checkbox label={FIELD_LABEL.label_autoprint} name="label_autoprint" isSelected={label} onChange={edit(setLabel)} />
          <TextField
            label={FIELD_LABEL.buyer_pan_pattern} name="buyer_pan_pattern" maxLength={200} isRequired value={pan}
            description="A regular expression the buyer PAN must match, for example ^[0-9]{9}$." onChange={edit(setPan, 'buyer_pan_pattern')} {...err('buyer_pan_pattern')}
          />
          <IntegerField
            label={FIELD_LABEL.patient_search_min_chars} name="patient_search_min_chars" min={1} max={100} isRequired
            {...(minChars !== undefined ? { value: minChars } : {})} onChange={edit(setMinChars, 'patient_search_min_chars')} {...err('patient_search_min_chars')}
          />
        </div>
      </KitSettingsForm>
    </div>
  );
}
