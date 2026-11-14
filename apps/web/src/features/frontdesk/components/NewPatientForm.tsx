'use client';
// 04-UI-UX §3.2 A2: inline new-patient form (Alt+N opens, Esc returns to search). It only collects and validates the demographics + consents;
// the patient is created inside F9 (`patient.new_patient`), in the same transaction as the order (02-TRD F9).
import { useState, type KeyboardEvent } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import type { NewPatientDraft } from '../server/types';

const SEXES = [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }, { value: 'unknown', label: 'Unknown' }] as const;
const PHONE_LOCAL = /^\d{10}$/, PHONE_E164 = /^\+[1-9][0-9]{7,14}$/, EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 10-digit local number → +977…; E.164 is kept (04-UI-UX §3.2 A2). */
const toE164 = (v: string) => (PHONE_LOCAL.test(v) ? `+977${v}` : v);

export function NewPatientForm({ consentTextVersion, onUse, onCancel }: { consentTextVersion: string; onUse: (p: NewPatientDraft) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [sex, setSex] = useState<string>();
  const [dob, setDob] = useState<IsoDate>();
  const [age, setAge] = useState<{ years?: number; months?: number; days?: number }>({});
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [c, setC] = useState({ processing: false, sms: false, whatsapp: false, email: false, share_with_referrer: false });
  const [err, setErr] = useState<Record<string, string>>({});
  const setAgePart = (k: 'years' | 'months' | 'days', v: number | undefined) => setAge((a) => { const n = { ...a }; if (v === undefined) delete n[k]; else n[k] = v; return n; });

  const submit = () => {
    const e: Record<string, string> = {};
    const n = name.trim();
    if (n.length < 1 || n.length > 200) e['name'] = 'Enter the full name (1–200 characters)';
    if (!sex) e['sex'] = 'Choose a sex';
    const hasAge = age.years !== undefined || age.months !== undefined || age.days !== undefined;
    if (!dob && !hasAge) e['dob'] = 'Enter a date of birth or an age';
    if (dob && hasAge) e['dob'] = 'Enter either a date of birth or an age, not both';
    if (mobile && !(PHONE_LOCAL.test(mobile) || PHONE_E164.test(mobile))) e['mobile'] = 'Enter 10 digits or +country code and number';
    if (email && !EMAIL.test(email)) e['email'] = 'Enter a valid email address';
    if (!c.processing) e['consent'] = 'Consent to processing is required';
    setErr(e);
    if (Object.keys(e).length) return;
    onUse({
      full_name: n, sex: sex as string,
      ...(dob ? { birth_on: dob } : { age: { years: age.years ?? 0, months: age.months ?? 0, days: age.days ?? 0 } }),
      ...(mobile ? { phone_e164: toE164(mobile) } : {}), ...(email ? { email } : {}), ...(address.trim() ? { address_text: address.trim() } : {}),
      consents: { ...c, consent_text_version: consentTextVersion },
    });
  };
  const onKeyDown = (ev: KeyboardEvent<HTMLElement>) => { if (ev.key === 'Escape') { ev.stopPropagation(); onCancel(); } };

  return (
    <div role="group" aria-label="New patient" onKeyDown={onKeyDown} style={{ display: 'grid', gap: 8 }}>
      <TextField label="Full name" name="full_name" maxLength={200} isRequired value={name} onChange={setName} {...(err['name'] ? { error: err['name'] } : {})} />
      <RadioGroup label="Sex" name="sex" isRequired orientation="horizontal" options={SEXES} {...(sex ? { value: sex } : {})} onChange={setSex} {...(err['sex'] ? { error: err['sex'] } : {})} />
      <DatePicker label="Date of birth" name="birth_on" value={dob} onChange={setDob} {...(err['dob'] ? { error: err['dob'] } : {})} />
      <div style={{ display: 'flex', gap: 8 }}>
        <IntegerField label="Age years" name="age_years" min={0} max={150} {...(age.years !== undefined ? { value: age.years } : {})} onChange={(v) => setAgePart('years', v)} />
        <IntegerField label="Age months" name="age_months" min={0} max={11} {...(age.months !== undefined ? { value: age.months } : {})} onChange={(v) => setAgePart('months', v)} />
        <IntegerField label="Age days" name="age_days" min={0} max={31} {...(age.days !== undefined ? { value: age.days } : {})} onChange={(v) => setAgePart('days', v)} />
      </div>
      <TextField label="Mobile" name="mobile" maxLength={16} inputMode="tel" value={mobile} onChange={setMobile} {...(err['mobile'] ? { error: err['mobile'] } : {})} />
      <TextField label="Email" name="email" maxLength={254} inputMode="email" value={email} onChange={setEmail} {...(err['email'] ? { error: err['email'] } : {})} />
      <TextArea label="Address" name="address" maxLength={300} rows={2} value={address} onChange={setAddress} />
      <fieldset style={{ border: 0, padding: 0 }}>
        <legend>Consents</legend>
        <Checkbox label="Processing of my data for testing (required)" isSelected={c.processing} onChange={(v) => setC((x) => ({ ...x, processing: v }))} {...(err['consent'] ? { description: err['consent'] } : {})} />
        <Checkbox label="SMS" isSelected={c.sms} onChange={(v) => setC((x) => ({ ...x, sms: v }))} />
        <Checkbox label="WhatsApp" isSelected={c.whatsapp} onChange={(v) => setC((x) => ({ ...x, whatsapp: v }))} />
        <Checkbox label="Email messages" isSelected={c.email} onChange={(v) => setC((x) => ({ ...x, email: v }))} />
        <Checkbox label="Share report with referring doctor" isSelected={c.share_with_referrer} onChange={(v) => setC((x) => ({ ...x, share_with_referrer: v }))} />
      </fieldset>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" onPress={submit}>Use this new patient</Button>
        <Button variant="ghost" onPress={onCancel} shortcut="Esc">Back to search</Button>
      </div>
    </div>
  );
}
