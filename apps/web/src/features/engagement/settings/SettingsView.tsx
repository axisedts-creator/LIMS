'use client';
// C16 W12 engagement settings (T1 getEngagementSettings / T2 updateEngagementSettings). LD-255 (FOUNDER): the administrator controls booking, reminder and
// membership settings here. One form, one full-body PUT with If-Match "<version>" through the server action. Nothing invalid is sent: client checks mirror
// EngagementSettingsInput, and a server 400/422 is shown inline on the field it names. Fields the API omits stay omitted (nothing is invented).
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { saveEngagementSettingsAction } from './actions';
import {
  CONSENT_VERSION_ERROR, GATEWAYS, INTS, LABEL, PREFIX_ERROR, SWITCHES, VERSION_ERROR, VERSION_RE, parsePrefixes,
  type EngagementSettings, type EngagementSettingsBody, type IntKey,
} from './model';

export const RELOAD_COPY = 'This record was changed by someone else. Reload to see the latest version.';
export const MFA_COPY = 'This action needs two-step verification. Log in again with your authenticator code.';
const GENERIC = 'Something went wrong. Try again; if it keeps failing, contact support.';
const NOT_ACCEPTED = 'Some values were not accepted. Check the marked fields.';

type Name = keyof EngagementSettingsBody;
type Errors = Partial<Record<Name, string>>;
type Banner_ = { kind: 'error'; title: string } | { kind: 'conflict' } | null;
type Centre = { value: string; label: string };

const ALL_INTS = [...INTS.app, ...INTS.booking, ...INTS.reminder];
const FIELD_LABEL: Partial<Record<string, string>> = {
  ...LABEL, ...Object.fromEntries(SWITCHES), ...Object.fromEntries(ALL_INTS.map((i) => [i.key, i.label])),
};

export function SettingsView({ settings, centres = [], mfaRequired = false }: { settings?: EngagementSettings | undefined; centres?: Centre[]; mfaRequired?: boolean }) {
  return (
    // A named region so every part of the page sits inside a landmark (the shell supplies <main>).
    <section aria-label="Engagement settings">
      <PageHeader title="Engagement settings" helpKey="engagement.settings" />
      {mfaRequired || !settings ? <div role="alert"><Banner tone="warning" title={MFA_COPY} /></div> : <SettingsForm initial={settings} centres={centres} />}
    </section>
  );
}

function SettingsForm({ initial, centres }: { initial: EngagementSettings; centres: Centre[] }) {
  const router = useRouter();
  const [flags, setFlags] = useState(() => Object.fromEntries(SWITCHES.map(([k]) => [k, initial[k]])) as Record<(typeof SWITCHES)[number][0], boolean>);
  const [ints, setInts] = useState(() => Object.fromEntries(ALL_INTS.map(({ key }) => [key, initial[key]])) as Record<IntKey, number | undefined>);
  const [prefixes, setPrefixes] = useState(initial.allowed_phone_prefixes.join(', '));
  const [android, setAndroid] = useState(initial.min_app_version_android);
  const [ios, setIos] = useState(initial.min_app_version_ios);
  const [gateways, setGateways] = useState(initial.app_gateways);
  const [phone, setPhone] = useState(initial.support_phone ?? '');
  const [consent, setConsent] = useState(initial.app_consent_text ?? '');
  const [consentVersion, setConsentVersion] = useState(initial.app_consent_text_version ?? '');
  const [disclaimer, setDisclaimer] = useState(initial.smart_report_disclaimer_text ?? '');
  const [centre, setCentre] = useState(initial.home_collection_centre_id);
  const [version, setVersion] = useState(initial.version);
  const [errors, setErrors] = useState<Errors>({});
  const [banner, setBanner] = useState<Banner_>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [focus, setFocus] = useState<{ name: Name; n: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focus) root.current?.querySelector<HTMLElement>(`[name="${focus.name}"]`)?.focus();
  }, [focus]);

  /** An edit clears the saved status and the error of the field(s) it touches. */
  const edit = <T,>(set: (v: T) => void, ...names: Name[]) => (v: T) => {
    set(v);
    setSaved(false);
    if (names.length) setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !names.includes(k as Name))));
  };
  const fail = (e: Errors, title: string, first: Name) => {
    setErrors(e);
    setBanner({ kind: 'error', title });
    setFocus((f) => ({ name: first, n: (f?.n ?? 0) + 1 }));
  };

  async function submit() {
    setBanner(null);
    setSaved(false);
    setErrors({});
    const missing = ALL_INTS.find((i) => ints[i.key] === undefined);
    if (missing) return fail({ [missing.key]: `${missing.label} must be a whole number from ${missing.min} to ${missing.max}.` }, NOT_ACCEPTED, missing.key);
    const list = parsePrefixes(prefixes);
    if (!list) return fail({ allowed_phone_prefixes: PREFIX_ERROR }, PREFIX_ERROR, 'allowed_phone_prefixes');
    if (!VERSION_RE.test(android)) return fail({ min_app_version_android: VERSION_ERROR(LABEL.min_app_version_android) }, VERSION_ERROR(LABEL.min_app_version_android), 'min_app_version_android');
    if (!VERSION_RE.test(ios)) return fail({ min_app_version_ios: VERSION_ERROR(LABEL.min_app_version_ios) }, VERSION_ERROR(LABEL.min_app_version_ios), 'min_app_version_ios');
    // W12: changing the consent text requires a new version label.
    if (consent !== (initial.app_consent_text ?? '') && consentVersion === (initial.app_consent_text_version ?? '')) {
      return fail({ app_consent_text_version: CONSENT_VERSION_ERROR }, CONSENT_VERSION_ERROR, 'app_consent_text_version');
    }
    const body = {
      ...flags, ...(ints as Record<IntKey, number>), allowed_phone_prefixes: list, min_app_version_android: android, min_app_version_ios: ios, app_gateways: gateways,
      ...(centre ? { home_collection_centre_id: centre } : {}), ...(phone ? { support_phone: phone } : {}), ...(consent ? { app_consent_text: consent } : {}),
      ...(consentVersion ? { app_consent_text_version: consentVersion } : {}), ...(disclaimer ? { smart_report_disclaimer_text: disclaimer } : {}),
    } satisfies EngagementSettingsBody;
    setSaving(true);
    try {
      const r = await saveEngagementSettingsAction(version, body);
      if (r.ok) {
        setVersion(r.settings.version); // the next save sends the version this one returned
        setSaved(true);
      } else if (r.status === 409) setBanner({ kind: 'conflict' });
      else if (r.status === 403) setBanner({ kind: 'error', title: r.code === 'auth.mfa_required' ? MFA_COPY : 'You do not have permission to change these settings.' });
      else if (r.status === 429) setBanner({ kind: 'error', title: 'Too many requests. Wait a moment and try again.' });
      else if (r.status === 400 || r.status === 422) {
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
  const numbers = (group: keyof typeof INTS) =>
    INTS[group].map((i) => (
      <IntegerField
        key={i.key} label={i.label} name={i.key} min={i.min} max={i.max} {...(i.note ? { description: i.note } : {})}
        {...(ints[i.key] !== undefined ? { value: ints[i.key] as number } : {})} onChange={edit((v: number | undefined) => setInts((s) => ({ ...s, [i.key]: v })), i.key)} {...err(i.key)}
      />
    ));
  const centreOptions = centre && !centres.some((c) => c.value === centre) ? [...centres, { value: centre, label: centre }] : centres;
  return (
    <div ref={root}>
      <div role="alert">
        {banner?.kind === 'conflict' ? <Banner tone="danger" title={RELOAD_COPY} action={{ label: 'Reload', onPress: () => router.refresh() }} /> : null}
        {banner?.kind === 'error' ? (
          <Banner tone="danger" title={banner.title}>
            {listed.length ? <ul>{listed.map((m) => <li key={m}>{m}</li>)}</ul> : null}
          </Banner>
        ) : null}
      </div>
      <div role="status">{saved ? <Banner tone="success" title="Settings saved." /> : null}</div>
      <Form onSubmit={submit}>
        <Card title="Features">
          {SWITCHES.map(([k, label]) => <Switch key={k} label={label} name={k} isSelected={flags[k]} onChange={edit((v: boolean) => setFlags((s) => ({ ...s, [k]: v })))} />)}
        </Card>
        <Card title="Patient app">
          <TextField
            label={LABEL.allowed_phone_prefixes} name="allowed_phone_prefixes" value={prefixes} description="Up to 5 prefixes separated by commas, for example +977, +91."
            onChange={edit(setPrefixes, 'allowed_phone_prefixes')} {...err('allowed_phone_prefixes')}
          />
          <TextField label={LABEL.min_app_version_android} name="min_app_version_android" value={android} maxLength={14} onChange={edit(setAndroid, 'min_app_version_android')} {...err('min_app_version_android')} />
          <TextField label={LABEL.min_app_version_ios} name="min_app_version_ios" value={ios} maxLength={14} onChange={edit(setIos, 'min_app_version_ios')} {...err('min_app_version_ios')} />
          <div role="group" aria-label={LABEL.app_gateways}>
            {GATEWAYS.map(([g, label]) => (
              <Checkbox
                key={g} label={label} name={`app_gateways_${g}`} isSelected={gateways.includes(g)}
                onChange={edit((on: boolean) => setGateways((s) => (on ? [...s.filter((x) => x !== g), g] : s.filter((x) => x !== g))), 'app_gateways')}
              />
            ))}
          </div>
          <TextField label={LABEL.support_phone} name="support_phone" value={phone} maxLength={40} onChange={edit(setPhone, 'support_phone')} {...err('support_phone')} />
          <TextArea label={LABEL.app_consent_text} name="app_consent_text" value={consent} maxLength={4000} rows={6} onChange={edit(setConsent, 'app_consent_text')} {...err('app_consent_text')} />
          <TextField
            label={LABEL.app_consent_text_version} name="app_consent_text_version" value={consentVersion} maxLength={32}
            description="Change this label whenever the consent text changes." onChange={edit(setConsentVersion, 'app_consent_text_version')} {...err('app_consent_text_version')}
          />
          <TextArea
            label={LABEL.smart_report_disclaimer_text} name="smart_report_disclaimer_text" value={disclaimer} maxLength={1000}
            onChange={edit(setDisclaimer, 'smart_report_disclaimer_text')} {...err('smart_report_disclaimer_text')}
          />
          {centreOptions.length ? <Select label={LABEL.home_collection_centre_id} name="home_collection_centre_id" options={centreOptions} {...(centre ? { value: centre } : {})} onChange={edit(setCentre, 'home_collection_centre_id')} /> : null}
          {numbers('app')}
        </Card>
        <Card title="Booking limits">{numbers('booking')}</Card>
        <Card title="Reminders and queue">{numbers('reminder')}</Card>
        <Button variant="primary" type="submit" isDisabled={saving} shortcut="Ctrl+Enter">Save</Button>
      </Form>
    </div>
  );
}
