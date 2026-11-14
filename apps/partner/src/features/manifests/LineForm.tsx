'use client';
// C13.T19 PM-2 line form (04-UI-UX PM-2 field table; 02-TRD §5.1 limits). Rendered inside a Drawer; Ctrl+Enter = "Save sample" (kit Form).
// LD-140 (2026-11-13): @lims/ui components only. The patient's name / phone live only in this component's state and the POST body; never in a URL, storage or a log.
import { useEffect, useState } from 'react';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Combobox } from '@lims/ui/components/Combobox';
import { DatePicker } from '@lims/ui/components/DatePicker';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Stack } from '@lims/ui/components/Stack';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import type { ManifestLine } from '../common/types';
import { listReferrersAction, searchOrderablesAction, type FieldIssue, type OrderableOption } from './actions';

const D102 = 'Shown to the receiving lab staff; not part of the lab order or the report';
const REF = /^[A-Za-z0-9_./-]{1,40}$/;
const E164 = /^\+[1-9][0-9]{7,14}$/;

/** UI normalises a 10-digit Nepali mobile by prefixing +977 (04-UI-UX PM-2 DECISION); the server validates E.164 only. */
export function normalisePhone(raw: string): string {
  const s = raw.replace(/[\s()-]/g, '');
  return /^9\d{9}$/.test(s) ? `+977${s}` : s;
}

export interface LineDraft {
  partner_sample_ref: string; full_name: string; sex: string; dob_mode: 'dob' | 'age'; birth_on: string | undefined; age_years: number | undefined; phone: string;
  tests: OrderableOption[]; priority: string; referrer: { id: string; display_name: string } | undefined; collected_at: string | undefined; clinical_note: string;
  agreed: boolean; sms: boolean; whatsapp: boolean; email: boolean; share: boolean;
}
export const blankLine = (): LineDraft => ({
  partner_sample_ref: '', full_name: '', sex: '', dob_mode: 'dob', birth_on: undefined, age_years: undefined, phone: '', tests: [], priority: 'routine', referrer: undefined, collected_at: undefined,
  clinical_note: '', agreed: false, sms: false, whatsapp: false, email: false, share: false,
});
export function draftOf(l: ManifestLine): LineDraft {
  return {
    ...blankLine(),
    partner_sample_ref: l.partner_sample_ref ?? '', full_name: l.patient.full_name, sex: l.patient.sex ?? '',
    dob_mode: l.patient.birth_on ? 'dob' : l.patient.age_years !== undefined ? 'age' : 'dob', birth_on: l.patient.birth_on, age_years: l.patient.age_years, phone: l.patient.phone_e164 ?? '',
    tests: l.orderables.map((o) => ({ orderable_id: o.orderable_id ?? '', kind: o.kind ?? 'test', code: o.code, name: o.name ?? o.code })),
    priority: l.priority === 'urgent' ? 'urgent' : 'routine', referrer: l.referrer ?? undefined, collected_at: l.collected_at, clinical_note: l.clinical_note ?? '',
    agreed: true, sms: !!l.consents?.sms, whatsapp: !!l.consents?.whatsapp, email: !!l.consents?.email, share: !!l.consents?.share_with_referrer, // an existing line already carries a recorded consent
  };
}

/** Client-side checks that mirror the spec limits; the API validates again. Returns issues keyed by field name. */
export function validateLine(d: LineDraft, today = new Date().toISOString().slice(0, 10)): FieldIssue[] {
  const out: FieldIssue[] = [];
  const add = (path: string, message: string) => out.push({ path, message });
  if (d.partner_sample_ref && !REF.test(d.partner_sample_ref)) add('/partner_sample_ref', 'Use letters, digits and _ . / - only (up to 40).');
  if (d.full_name.trim().length < 1 || d.full_name.length > 120) add('/full_name', 'Enter the patient name (up to 120 characters).');
  if (!d.sex) add('/sex', 'Choose the sex.');
  if (d.dob_mode === 'dob') {
    if (!d.birth_on) add('/birth_on', 'Enter the date of birth.');
    else if (d.birth_on < '1900-01-01' || d.birth_on > today) add('/birth_on', 'Date of birth must be between 1900 and today.');
  } else if (d.age_years === undefined || d.age_years < 0 || d.age_years > 130) add('/age_years', 'Enter an age between 0 and 130.');
  if (d.phone && !E164.test(normalisePhone(d.phone))) add('/phone', 'Enter the number with country code, for example +9779800000000.');
  if (d.tests.length < 1) add('/tests', 'Choose at least one test.');
  if (d.tests.length > 30) add('/tests', 'Up to 30 tests per sample.');
  if (!d.agreed) add('/agreed', 'Confirm that the patient agreed.');
  return out;
}

/** ManifestLineInput (02-TRD M5): exactly one of birth_on / age_years; consents opt-in. */
export function lineInput(d: LineDraft) {
  const phone = normalisePhone(d.phone);
  return {
    ...(d.partner_sample_ref ? { partner_sample_ref: d.partner_sample_ref } : {}),
    patient: {
      full_name: d.full_name.trim(), sex: d.sex,
      ...(d.dob_mode === 'dob' ? { birth_on: d.birth_on } : { age_years: d.age_years }),
      ...(phone ? { phone_e164: phone } : {}),
    },
    consents: { sms: d.sms, whatsapp: d.whatsapp, email: d.email, share_with_referrer: d.share },
    orderable_ids: d.tests.map((t) => t.orderable_id), priority: d.priority,
    ...(d.referrer ? { referrer_id: d.referrer.id } : {}),
    ...(d.collected_at ? { collected_at: d.collected_at } : {}),
    ...(d.clinical_note ? { clinical_note: d.clinical_note } : {}),
  };
}

export interface LineFormProps {
  initial: LineDraft;
  consentStatement: string;
  issues: FieldIssue[];
  isSaving: boolean;
  onDirty: () => void;
  onSave: (d: LineDraft) => void;
  onCancel: () => void;
}

export function LineForm({ initial, consentStatement, issues, isSaving, onDirty, onSave, onCancel }: LineFormProps) {
  const [d, setD] = useState<LineDraft>(initial);
  const [local, setLocal] = useState<FieldIssue[]>([]);
  const [referrers, setReferrers] = useState<{ id: string; display_name: string }[]>([]);
  const set = <K extends keyof LineDraft>(k: K, v: LineDraft[K]) => { setD((p) => ({ ...p, [k]: v })); onDirty(); };
  useEffect(() => { void listReferrersAction().then(setReferrers); }, []);
  const err = (name: string) => [...local, ...issues].find((i) => i.path === `/${name}`)?.message;
  const field = (name: string) => { const m = err(name); return m ? { error: m } : {}; };
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  return (
    <Form
      onSubmit={() => {
        const found = validateLine(d, tomorrow);
        setLocal(found);
        if (found.length === 0) onSave(d);
      }}
      problem={{ errors: [...local, ...issues].map((i) => ({ message: i.message, ...(i.path ? { path: i.path } : {}) })) }}
    >
      <Stack gap={4}>
        <TextField label="Your sample reference" name="partner_sample_ref" maxLength={40} value={d.partner_sample_ref} onChange={(v) => set('partner_sample_ref', v)} {...field('partner_sample_ref')} />
        <TextField label="Patient full name" name="full_name" maxLength={120} isRequired value={d.full_name} onChange={(v) => set('full_name', v)} {...field('full_name')} />
        <RadioGroup
          label="Sex" name="sex" isRequired orientation="horizontal" value={d.sex} onChange={(v) => set('sex', v)} {...field('sex')}
          options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }, { value: 'unknown', label: 'Unknown' }]}
        />
        <RadioGroup
          label="Date of birth or age" name="dob_mode" orientation="horizontal" value={d.dob_mode} onChange={(v) => set('dob_mode', v)}
          options={[{ value: 'dob', label: 'Date of birth' }, { value: 'age', label: 'Age in years' }]}
        />
        {d.dob_mode === 'dob' ? (
          <DatePicker label="Date of birth" name="birth_on" min={'1900-01-01' as never} value={d.birth_on as never} onChange={(v) => set('birth_on', v)} {...field('birth_on')} />
        ) : (
          <IntegerField label="Age in years" name="age_years" min={0} max={130} {...(d.age_years !== undefined ? { value: d.age_years } : {})} onChange={(v) => set('age_years', v)} {...field('age_years')} />
        )}
        <TextField label="Patient mobile" name="phone" maxLength={16} inputMode="tel" prefix="+977" description="Optional. Used only if the patient asks for a report slip." value={d.phone} onChange={(v) => set('phone', v)} {...field('phone')} />
        <Combobox<OrderableOption>
          label="Tests" name="tests" minChars={1} debounceMs={150} {...field('tests')}
          loadOptions={(q) => searchOrderablesAction(q)}
          getKey={(o) => o.orderable_id}
          renderValue={(o) => `${o.code} — ${o.name}`}
          renderOption={(o) => <>{o.code} — {o.name}{o.amount_paisa !== undefined ? <> — <MoneyText value={{ amountPaisa: o.amount_paisa, currency: 'NPR' }} /></> : null}</>}
          onChange={(o) => { if (o && !d.tests.some((t) => t.orderable_id === o.orderable_id)) set('tests', [...d.tests, o]); }}
        />
        <div aria-label="Selected tests">
          {d.tests.map((t) => (
            <span key={t.orderable_id}>
              <Badge>{t.code}</Badge>
              <Button size="sm" variant="ghost" onPress={() => set('tests', d.tests.filter((x) => x.orderable_id !== t.orderable_id))}>{`Remove ${t.code}`}</Button>
            </span>
          ))}
        </div>
        <RadioGroup label="Priority" name="priority" orientation="horizontal" value={d.priority} onChange={(v) => set('priority', v)} options={[{ value: 'routine', label: 'Routine' }, { value: 'urgent', label: 'Urgent' }]} />
        <Combobox<{ id: string; display_name: string }>
          label="Referring doctor" name="referrer" minChars={0}
          {...(d.referrer ? { value: d.referrer } : {})}
          loadOptions={(q) => Promise.resolve(referrers.filter((r) => r.display_name.toLowerCase().includes(q.toLowerCase())).slice(0, 20))}
          getKey={(r) => r.id} renderValue={(r) => r.display_name} renderOption={(r) => r.display_name}
          onChange={(r) => set('referrer', r)}
        />
        <DateTimePicker label="Collected at" name="collected_at" minuteStep={5} description={D102} value={d.collected_at as never} onChange={(v) => set('collected_at', v)} />
        <TextArea label="Clinical note" name="clinical_note" maxLength={300} description={D102} value={d.clinical_note} onChange={(v) => set('clinical_note', v)} />
        <Card title="Consent">
          <p>{consentStatement}</p>
        </Card>
        <Checkbox label="The patient agreed to the statement above" name="agreed" isSelected={d.agreed} onChange={(v) => set('agreed', v)} />
        {err('agreed') ? <p role="alert">{err('agreed')}</p> : null}
        <Checkbox label="May receive SMS" name="sms" isSelected={d.sms} onChange={(v) => set('sms', v)} />
        <Checkbox label="May receive WhatsApp" name="whatsapp" isSelected={d.whatsapp} onChange={(v) => set('whatsapp', v)} />
        <Checkbox label="May receive e-mail" name="email" isSelected={d.email} onChange={(v) => set('email', v)} />
        <Checkbox label="May share results with the referring doctor" name="share" isSelected={d.share} onChange={(v) => set('share', v)} />
        <div className="partner-card-actions">
          <Button type="submit" variant="secondary" isLoading={isSaving} shortcut="Ctrl+Enter">Save sample</Button>
          <Button variant="ghost" onPress={onCancel}>Cancel</Button>
        </div>
      </Stack>
    </Form>
  );
}
