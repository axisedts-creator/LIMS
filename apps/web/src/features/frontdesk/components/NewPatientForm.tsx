'use client';
// 04-UI-UX §3.2 A2: inline new-patient form (Alt+N opens, Esc returns to search). It only collects and validates the demographics + consents;
// the patient is created inside F9 (`patient.new_patient`), in the same transaction as the order (02-TRD F9).
// LD-310 / T0D-REGSCREEN-2 (T0C-REGPARITY-1 NewPatient keys): title, external patient id, nationality, Government ID (Nepal types, LD-310 (b): India only
// Aadhaar / ABHA / Health ID are NOT built), structured address (free text: no master data endpoint exists), profile photo, lab custom fields.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { Dialog } from '@lims/ui/components/Dialog';
import { FileUpload } from '@lims/ui/components/FileUpload';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { opt } from '../forms/draft';
import type { CustomFieldDefinition, NewPatientDraft, PatientSummary } from '../server/types';
import './frontdesk.css';

const SEXES = [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }, { value: 'unknown', label: 'Unknown' }] as const;
const PHONE_LOCAL = /^\d{10}$/, PHONE_E164 = /^\+[1-9][0-9]{7,14}$/, EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The 19 ElabAssist titles (NewPatient.title enum, LD-310). */
const TITLES = ['Mr', 'Mrs', 'Miss', 'Ms', 'Master', 'Baby', 'Baby of', 'Dr', 'Prof', 'Capt', 'Col', 'Major', 'Sri', 'Smt', 'Kumari', 'Late', 'Sister', 'Reverend', 'Other']
  .map((label) => ({ value: label.toLowerCase().replace(/ /g, '_'), label }));
/** NewPatient.government_id_type (LD-310 (b) Nepal types). */
const GOV_TYPES = [{ value: 'citizenship', label: 'Citizenship' }, { value: 'national_id', label: 'National ID' }, { value: 'passport', label: 'Passport' },
  { value: 'driving_licence', label: 'Driving licence' }, { value: 'voter_id', label: 'Voter ID' }, { value: 'other', label: 'Other' }];
/** ISO 3166-1 alpha-2; ponytail: the countries a Nepal lab front desk meets most, add more when a lab asks. */
const COUNTRIES = [['NP', 'Nepal'], ['IN', 'India'], ['BD', 'Bangladesh'], ['BT', 'Bhutan'], ['CN', 'China'], ['LK', 'Sri Lanka'], ['PK', 'Pakistan'], ['MM', 'Myanmar'], ['TH', 'Thailand'],
  ['MY', 'Malaysia'], ['JP', 'Japan'], ['KR', 'South Korea'], ['AE', 'United Arab Emirates'], ['QA', 'Qatar'], ['SA', 'Saudi Arabia'], ['GB', 'United Kingdom'], ['US', 'United States'],
  ['AU', 'Australia'], ['CA', 'Canada'], ['DE', 'Germany'], ['FR', 'France']].map(([value, label]) => ({ value: value!, label: label! }));
/** An empty-looking placeholder: the kit trigger is named "<value> <label>", so a blank value keeps the name starting with the label (not "Select an item"). */
const BLANK = ' ';
const PHOTO_TYPES =['image/png', 'image/jpeg'] as const;
const PHOTO_MAX = 2 * 1024 * 1024;
/** 10-digit local number → +977…; E.164 is kept (04-UI-UX §3.2 A2). */
const toE164 = (v: string) => (PHONE_LOCAL.test(v) ? `+977${v}` : v);
const ADDRESS = [['province', 'Province', 100], ['district', 'District', 100], ['municipality', 'Municipality', 150], ['ward', 'Ward', 20], ['tole', 'Tole', 150], ['postal_code', 'Postal code', 20]] as const;
type AddrKey = (typeof ADDRESS)[number][0];

/** LD-310 / T0D-REGSCREEN-1: the masked mobile (e.g. 98xxxxxx42) fits a typed number when every unmasked digit matches. */
export const fitsMasked = (masked: string | undefined, mobile: string) => {
  const m = (masked ?? '').replace(/[^\dx]/gi, '');
  const d = mobile.replace(/\D/g, '').slice(-m.length);
  return m.length > 0 && d.length === m.length && [...m].every((c, i) => c.toLowerCase() === 'x' || c === d[i]);
};

export function NewPatientForm({ consentTextVersion, onUse, onCancel, findExisting, onUseExisting, customFields = [], uploadPhoto }: {
  consentTextVersion: string; onUse: (p: NewPatientDraft) => void; onCancel: () => void;
  /** LD-310 / T0D-REGSCREEN-1 existing patient notice: called only once a name AND a full mobile are typed (no PHI sent for half a form). */
  findExisting?: (mobile: string) => Promise<readonly PatientSummary[]>; onUseExisting?: (p: PatientSummary) => void;
  /** ACTIVE lab custom field definitions (GET /v1/frontdesk/custom-field-definitions); none = no section. */
  customFields?: readonly CustomFieldDefinition[];
  /** Uploads the profile photo (uploadTrf: centre_id, no order_id) and returns the attachment id, or undefined when it failed. */
  uploadPhoto?: (f: File) => Promise<string | undefined>;
}) {
  const [name, setName] = useState('');
  const [sex, setSex] = useState<string>();
  const [dob, setDob] = useState<IsoDate>();
  const [age, setAge] = useState<{ years?: number; months?: number; days?: number }>({});
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [title, setTitle] = useState<string>();
  const [extId, setExtId] = useState('');
  const [nationality, setNationality] = useState<string>();
  const [govType, setGovType] = useState<string>();
  const [govNo, setGovNo] = useState(''); // sensitive: state only (never logged, stored or put in a draft)
  const [addr, setAddr] = useState<Partial<Record<AddrKey, string>>>({});
  const [photoId, setPhotoId] = useState<string>();
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [c, setC] = useState({ processing: false, sms: false, whatsapp: false, email: false, share_with_referrer: false });
  const [err, setErr] = useState<Record<string, string>>({});
  const [existing, setExisting] = useState<PatientSummary>();
  const photoPending = useRef<Promise<unknown>>(Promise.resolve());
  const defs = [...customFields].filter((d) => d.is_active).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  useEffect(() => {
    const n = name.trim().toLowerCase();
    setExisting(undefined);
    if (!findExisting || !n || !(PHONE_LOCAL.test(mobile) || PHONE_E164.test(mobile))) return;
    let live = true;
    const t = setTimeout(() => {
      void findExisting(mobile).then((hits) => { if (live) setExisting(hits.find((p) => p.full_name.trim().toLowerCase() === n && fitsMasked(p.phone_masked, mobile))); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [name, mobile, findExisting]);
  const setAgePart = (k: 'years' | 'months' | 'days', v: number | undefined) => setAge((a) => { const n = { ...a }; if (v === undefined) delete n[k]; else n[k] = v; return n; });
  const pickPhoto = (files: readonly File[]) => {
    const f = files[0];
    setPhotoId(undefined);
    if (!f || !uploadPhoto) return;
    photoPending.current = uploadPhoto(f).then((id) => setPhotoId(id));
  };

  const submit = async () => {
    const e: Record<string, string> = {};
    const n = name.trim();
    if (n.length < 1 || n.length > 200) e['name'] = 'Enter the full name (1–200 characters)';
    if (!sex) e['sex'] = 'Choose a sex';
    const hasAge = age.years !== undefined || age.months !== undefined || age.days !== undefined;
    if (!dob && !hasAge) e['dob'] = 'Enter a date of birth or an age';
    if (dob && hasAge) e['dob'] = 'Enter either a date of birth or an age, not both';
    if (mobile && !(PHONE_LOCAL.test(mobile) || PHONE_E164.test(mobile))) e['mobile'] = 'Enter 10 digits or +country code and number';
    if (email && !EMAIL.test(email)) e['email'] = 'Enter a valid email address';
    if (govType && !govNo.trim()) e['govNo'] = 'Enter the Government ID number';
    if (!govType && govNo.trim()) e['govType'] = 'Choose the Government ID type';
    if (nationality === 'NP' && addr.postal_code?.trim() && !/^\d{5}$/.test(addr.postal_code.trim())) e['postal'] = 'A Nepal postal code has 5 digits';
    for (const d of defs) {
      const v = custom[d.field_key]?.trim() ?? '';
      if (d.required && !v) e[`cf_${d.field_key}`] = `Enter ${d.label}`;
      else if (v && d.field_type === 'number' && !Number.isFinite(Number(v))) e[`cf_${d.field_key}`] = `${d.label} must be a number`;
    }
    if (!c.processing) e['consent'] = 'Consent to processing is required';
    setErr(e);
    if (Object.keys(e).length) return;
    await photoPending.current; // a photo still uploading joins this patient
    const cf = defs.flatMap((d) => (custom[d.field_key]?.trim() ? [{ code: d.field_key, value: custom[d.field_key]!.trim() }] : []));
    onUse({
      full_name: n, sex: sex as string,
      ...(dob ? { birth_on: dob } : { age: { years: age.years ?? 0, months: age.months ?? 0, days: age.days ?? 0 } }),
      ...(mobile ? { phone_e164: toE164(mobile) } : {}), ...(email ? { email } : {}), ...opt('address_text', address),
      ...(title ? { title } : {}), ...opt('external_patient_id', extId), ...(nationality ? { nationality } : {}),
      ...(govType && govNo.trim() ? { government_id_type: govType, government_id_number: govNo.trim() } : {}),
      ...opt('address_province', addr.province), ...opt('address_district', addr.district), ...opt('address_municipality', addr.municipality),
      ...opt('address_ward', addr.ward), ...opt('address_tole', addr.tole), ...opt('address_postal_code', addr.postal_code),
      ...(photoId ? { profile_photo_attachment_id: photoId } : {}), ...(cf.length ? { custom_fields: cf } : {}),
      consents: { ...c, consent_text_version: consentTextVersion },
    });
  };
  const onKeyDown = (ev: KeyboardEvent<HTMLElement>) => { if (ev.key === 'Escape') { ev.stopPropagation(); onCancel(); } };
  const ef = (k: string) => (err[k] ? { error: err[k] } : {});

  return (
    <div role="group" aria-label="New patient" onKeyDown={onKeyDown} className="lims-reg-section">
      <div className="lims-reg-pair">
        <Select label="Title" name="title" options={TITLES} {...(title ? { value: title } : {})} onChange={setTitle} placeholder={BLANK} />
        <div className="lims-reg-grow"><TextField label="Full name" name="full_name" maxLength={200} isRequired value={name} onChange={setName} {...ef('name')} /></div>
      </div>
      <RadioGroup label="Sex" name="sex" isRequired orientation="horizontal" options={SEXES} {...(sex ? { value: sex } : {})} onChange={setSex} {...ef('sex')} />
      {/* RS-C4 / LD-140: both fields stay (the rule is "either, not both", so one control would change validation); they are grouped as one. */}
      <fieldset className="lims-reg-fieldset">
        <legend>Age or date of birth</legend>
        <DatePicker label="Date of birth" name="birth_on" value={dob} onChange={setDob} {...ef('dob')} />
        <div className="lims-reg-pair">
          <IntegerField label="Age years" name="age_years" min={0} max={150} {...(age.years !== undefined ? { value: age.years } : {})} onChange={(v) => setAgePart('years', v)} />
          <IntegerField label="Age months" name="age_months" min={0} max={11} {...(age.months !== undefined ? { value: age.months } : {})} onChange={(v) => setAgePart('months', v)} />
          <IntegerField label="Age days" name="age_days" min={0} max={31} {...(age.days !== undefined ? { value: age.days } : {})} onChange={(v) => setAgePart('days', v)} />
        </div>
      </fieldset>
      <TextField label="Mobile" name="mobile" maxLength={16} inputMode="tel" value={mobile} onChange={setMobile} {...ef('mobile')} />
      <div role="status" aria-live="polite">
        {existing ? (
          <div className="lims-reg-notice">
            <p className="lims-reg-hint">Possible existing patient: <strong>{existing.patient_code}</strong> {existing.full_name} · {existing.age_display}{existing.phone_masked ? ` · ${existing.phone_masked}` : ''}</p>
            {onUseExisting ? <Button variant="secondary" onPress={() => onUseExisting(existing)}>Use existing<VisuallyHidden> patient</VisuallyHidden></Button> : null}
          </div>
        ) : null}
      </div>
      <TextField label="Email" name="email" maxLength={254} inputMode="email" value={email} onChange={setEmail} {...ef('email')} />
      <div className="lims-reg-pair">
        <TextField label="External patient ID" name="external_patient_id" maxLength={64} value={extId} onChange={setExtId} />
        <Select label="Nationality" name="nationality" options={COUNTRIES} {...(nationality ? { value: nationality } : {})} onChange={setNationality} placeholder={BLANK} />
      </div>
      <div className="lims-reg-pair">
        <Select label="Government ID type" name="government_id_type" options={GOV_TYPES} {...(govType ? { value: govType } : {})} onChange={setGovType} placeholder={BLANK} {...ef('govType')} />
        {/* LD-310 (b): masked on screen, no autofill, never logged or kept in the browser */}
        <TextField label="Government ID number" name="government_id_number" maxLength={64} autoComplete="off" value={govNo} onChange={setGovNo} {...ef('govNo')} {...{ inputProps: { type: 'password' } }} />
      </div>
      <fieldset className="lims-reg-fieldset">
        <legend>Address</legend>
        <div className="lims-reg-grid2">
          {ADDRESS.map(([k, label, max]) => (
            <TextField key={k} label={label} name={`address_${k}`} maxLength={max} value={addr[k] ?? ''} onChange={(v) => setAddr((a) => ({ ...a, [k]: v }))} {...(k === 'postal_code' ? ef('postal') : {})} />
          ))}
        </div>
        <TextArea label="Address" name="address" maxLength={300} rows={1} showCount={false} value={address} onChange={setAddress} />
      </fieldset>
      <div className="lims-reg-pair">
        <FileUpload label="Profile photo" name="profile_photo" accept={PHOTO_TYPES} maxBytes={PHOTO_MAX} onSelect={pickPhoto} description={photoId ? 'Photo attached' : 'PNG or JPEG, at most 2 MB'} />
        <PhotoCapture onCapture={(f) => pickPhoto([f])} />
      </div>
      {defs.length ? (
        <fieldset className="lims-reg-fieldset">
          <legend>Additional fields</legend>
          <div className="lims-reg-grid2">
            {defs.map((d) => {
              const common = { label: d.label, name: `cf_${d.field_key}`, ...(d.required ? { isRequired: true } : {}), ...ef(`cf_${d.field_key}`) };
              const set = (v: string | undefined) => setCustom((x) => ({ ...x, [d.field_key]: v ?? '' }));
              const v = custom[d.field_key];
              return d.field_type === 'choice' ? <Select key={d.id} {...common} options={(d.choices ?? []).map((x) => ({ value: x, label: x }))} {...(v ? { value: v } : {})} onChange={set} placeholder={BLANK} />
                : d.field_type === 'date' ? <DatePicker key={d.id} {...common} value={(v || undefined) as IsoDate | undefined} onChange={set} />
                : <TextField key={d.id} {...common} maxLength={500} {...(d.field_type === 'number' ? { inputMode: 'decimal' as const } : {})} value={v ?? ''} onChange={set} />;
            })}
          </div>
        </fieldset>
      ) : null}
      <fieldset className="lims-reg-fieldset">
        <legend>Consents</legend>
        <Checkbox label="Processing of my data for testing (required)" isSelected={c.processing} onChange={(v) => setC((x) => ({ ...x, processing: v }))} {...(err['consent'] ? { description: err['consent'] } : {})} />
        <Checkbox label="SMS" isSelected={c.sms} onChange={(v) => setC((x) => ({ ...x, sms: v }))} />
        <Checkbox label="WhatsApp" isSelected={c.whatsapp} onChange={(v) => setC((x) => ({ ...x, whatsapp: v }))} />
        <Checkbox label="Email messages" isSelected={c.email} onChange={(v) => setC((x) => ({ ...x, email: v }))} />
        <Checkbox label="Share report with referring doctor" isSelected={c.share_with_referrer} onChange={(v) => setC((x) => ({ ...x, share_with_referrer: v }))} />
      </fieldset>
      <div className="lims-reg-pair">
        <Button variant="secondary" onPress={() => void submit()}>Use this new patient</Button>
        <Button variant="ghost" onPress={onCancel} shortcut="Esc">Back to search</Button>
      </div>
    </div>
  );
}

/** Camera capture (getUserMedia) into a JPEG file; disabled where the browser has no camera API. The frame is never kept after the dialog closes. */
function PhotoCapture({ onCapture }: { onCapture: (f: File) => void }) {
  const [canUse, setCanUse] = useState(false);
  const [open, setOpen] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  useEffect(() => { setCanUse(typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'); }, []);
  const stop = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; setOpen(false); };
  useEffect(() => stop, []);
  const start = async () => {
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: true });
      setOpen(true);
      setTimeout(() => { if (video.current && stream.current) { video.current.srcObject = stream.current; void video.current.play(); } }, 0);
    } catch { stop(); }
  };
  const take = () => {
    const v = video.current;
    if (!v) return;
    const cv = document.createElement('canvas');
    cv.width = v.videoWidth; cv.height = v.videoHeight;
    cv.getContext('2d')?.drawImage(v, 0, 0);
    cv.toBlob((b) => { if (b) onCapture(new File([b], 'photo.jpg', { type: 'image/jpeg' })); stop(); }, 'image/jpeg', 0.85);
  };
  return (
    <>
      <Button variant="ghost" isDisabled={!canUse} onPress={() => void start()}>Capture photo</Button>
      <Dialog title="Capture photo" isOpen={open} onClose={stop} size="sm" footer={<Button variant="primary" onPress={take}>Take photo</Button>}>
        <video ref={video} className="lims-reg-video" muted playsInline />
      </Dialog>
    </>
  );
}
