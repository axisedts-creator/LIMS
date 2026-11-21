'use client';
// SCR-11 doctor detail: edit form + Verify + "Merge into…". Phone and Email (contact fields) are rendered ONLY with
// catalog.referrer.manage — the API omits them otherwise, and this component drops them even if the object carries them (AC-11.4).
// Without manage, or for a merged-away doctor, the form is read-only text inputs.
// T0D-PARTYSET-1 (LD-321): Speciality, Hospital and the National ID number. The API sends the number masked; "Show" asks the server (audited,
// partners.party_id_number.read) and the full value stays in component state. The masked value is never sent back: only a number the user typed.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { updateDoctorAction, verifyDoctorAction } from '../server/catalogActions';
import { PARTY_CODE_RE, emailError, phoneError, type Doctor, type DoctorSummary } from '../server/types';
import { CONFLICT, SaveForm } from './master-ui';
import { DoctorMergeDialog } from './DoctorMergeDialog';
import { useReveal } from '@/features/partners/components/MaskedId';
import { t } from '@/core/i18n/messages';

export const canManageDoctors = (permissions: readonly string[]) => permissions.includes('catalog.referrer.manage');
const COUNCILS = [{ value: 'none', label: 'None' }, { value: 'NMC', label: 'NMC' }, { value: 'Other', label: 'Other' }] as const;
type Optional = 'qualification' | 'registration_council' | 'registration_no' | 'phone_e164' | 'email' | 'notes' | 'speciality' | 'hospital';
const NATIONAL_ID = /^[A-Za-z0-9-]{1,32}$/;

export function DoctorDetail({ doctor, mergeTargets, permissions }: { doctor: Doctor; mergeTargets: readonly DoctorSummary[]; permissions: readonly string[] }) {
  const manage = canManageDoctors(permissions);
  const router = useRouter();
  const toast = useToast();
  const merged = !!doctor.merged_into_id;
  const ro = !manage || merged;
  const [name, setName] = useState(doctor.display_name);
  const [qualification, setQualification] = useState(doctor.qualification ?? '');
  const [council, setCouncil] = useState(doctor.registration_council ?? 'none');
  const [regNo, setRegNo] = useState(doctor.registration_no ?? '');
  const [phone, setPhone] = useState(manage ? (doctor.phone_e164 ?? '') : '');
  const [email, setEmail] = useState(manage ? (doctor.email ?? '') : '');
  const [notes, setNotes] = useState(doctor.notes ?? '');
  const [active, setActive] = useState(doctor.is_active);
  const [phoneErr, setPhoneErr] = useState<string>();
  const [emailErr, setEmailErr] = useState<string>();
  const [speciality, setSpeciality] = useState(doctor.speciality ?? '');
  const [hospital, setHospital] = useState(doctor.hospital ?? '');
  const [nid, setNid] = useState<string>();
  const [nidErr, setNidErr] = useState<string>();
  const [specErr, setSpecErr] = useState<string>();
  const [hospErr, setHospErr] = useState<string>();
  const reveal = useReveal('doctor', doctor.id, 'national_id_number', permissions);
  const inflight = useRef<ReturnType<typeof updateDoctorAction> | undefined>(undefined);
  const [merging, setMerging] = useState(false);
  const [verifyBanner, setVerifyBanner] = useState<string>();
  const [verifying, setVerifying] = useState(false);
  const target = merged ? mergeTargets.find((t) => t.id === doctor.merged_into_id) : undefined;

  const check = () => {
    const p = phoneError(phone.trim());
    const e = emailError(email.trim());
    const n = nid !== undefined && nid.trim() !== '' && !NATIONAL_ID.test(nid.trim()) ? t('partners.idnumber.error.format') : undefined;
    const sp = speciality.trim().length > 120 ? t('partners.idnumber.error.long') : undefined;
    const ho = hospital.trim().length > 200 ? t('partners.idnumber.error.long') : undefined;
    setPhoneErr(p);
    setEmailErr(e);
    setNidErr(n);
    setSpecErr(sp);
    setHospErr(ho);
    return !p && !e && !n && !sp && !ho;
  };
  /** PATCH carries only what changed; an optional field cleared by the user goes into `unset`. */
  const save = () => {
    const body: Record<string, unknown> = {};
    const unset: string[] = [];
    const field = (k: Optional, v: string) => {
      const after = v.trim();
      if (after === (doctor[k] ?? '')) return;
      if (after === '') unset.push(k);
      else body[k] = after;
    };
    if (name.trim() !== doctor.display_name) body['display_name'] = name.trim();
    field('qualification', qualification);
    field('registration_council', council === 'none' ? '' : council);
    field('registration_no', regNo);
    if (manage) {
      field('phone_e164', phone);
      field('email', email);
    }
    field('notes', notes);
    field('speciality', speciality);
    field('hospital', hospital);
    if (nid !== undefined) {
      if (nid.trim() !== '') body['national_id_number'] = nid.trim();
      else if (doctor.national_id_number) unset.push('national_id_number');
    }
    if (active !== doctor.is_active) body['is_active'] = active;
    if (unset.length) body['unset'] = unset;
    // one request at a time: a second Save while one runs gets the same answer (T0D-PARTYSET-1 double submit guard)
    inflight.current ??= updateDoctorAction(doctor.id, doctor.version, body).finally(() => { inflight.current = undefined; });
    return inflight.current;
  };

  const verify = async () => {
    if (verifying) return;
    setVerifying(true);
    setVerifyBanner(undefined);
    try {
      const r = await verifyDoctorAction(doctor.id, doctor.version);
      if (r.ok) {
        toast.show({ tone: 'success', title: 'Doctor verified.' });
        router.refresh();
      } else setVerifyBanner(r.code === 'common.version_conflict' ? CONFLICT : 'Could not verify. Try again.');
    } finally {
      setVerifying(false);
    }
  };

  const fields = (
    <>
      <CodeField label="Doctor code" name="doctor_code" maxLength={20} pattern={PARTY_CODE_RE.source} patternHint="Set when the doctor was created." isReadOnly value={doctor.doctor_code} />
      <TextField label="Display name" name="display_name" maxLength={120} isRequired isReadOnly={ro} value={name} onChange={setName} />
      <TextField label="Qualification" name="qualification" maxLength={120} isReadOnly={ro} value={qualification} onChange={setQualification} />
      {ro ? (
        <TextField label="Registration council" name="registration_council" maxLength={20} isReadOnly value={doctor.registration_council ?? ''} />
      ) : (
        <Select label="Registration council" name="registration_council" options={COUNCILS} value={council} onChange={setCouncil} />
      )}
      <TextField label="Registration no." name="registration_no" maxLength={30} isReadOnly={ro} value={regNo} onChange={setRegNo} />
      {manage ? <TextField label="Phone" name="phone_e164" maxLength={16} inputMode="tel" isReadOnly={ro} description="International format, for example +9779801234567." value={phone} onChange={(v) => { setPhone(v); setPhoneErr(undefined); }} {...(phoneErr ? { error: phoneErr } : {})} /> : null}
      {manage ? <TextField label="Email" name="email" maxLength={254} inputMode="email" isReadOnly={ro} value={email} onChange={(v) => { setEmail(v); setEmailErr(undefined); }} {...(emailErr ? { error: emailErr } : {})} /> : null}
      <TextField label="Speciality" name="speciality" maxLength={300} isReadOnly={ro} value={speciality} onChange={(v) => { setSpeciality(v); setSpecErr(undefined); }} {...(specErr ? { error: specErr } : {})} />
      <TextField label="Hospital" name="hospital" maxLength={300} isReadOnly={ro} value={hospital} onChange={(v) => { setHospital(v); setHospErr(undefined); }} {...(hospErr ? { error: hospErr } : {})} />
      <div className="lims-inline">
        <TextField label={t('partners.idnumber.national_id')} name="national_id_number" maxLength={64} isReadOnly={ro}
          value={nid ?? reveal.full ?? doctor.national_id_number ?? ''} onChange={(v) => { setNid(v); setNidErr(undefined); }} {...(nidErr ? { error: nidErr } : {})} />
        {doctor.national_id_number && nid === undefined ? reveal.button : null}
        {doctor.national_id_number ? reveal.notes : null}
      </div>
      <TextArea label="Notes" name="notes" maxLength={500} isReadOnly={ro} value={notes} onChange={setNotes} />
      {!ro ? <Switch label="Active" isSelected={active} onChange={setActive} /> : null}
      <p>{doctor.price_list_id ? <a className="lims-link" href={`/catalog/price-lists/${doctor.price_list_id}`}>Price list</a> : 'Price list: none assigned (assign it in Price lists).'}</p>
    </>
  );

  return (
    <section aria-label="Doctor">
      <PageHeader
        title={doctor.display_name}
        helpKey="catalog.doctors"
        breadcrumbs={[{ label: 'Catalog', href: '/catalog' }, { label: 'Doctors', href: '/catalog/doctors' }, { label: doctor.doctor_code }]}
        status={
          <>
            <Badge tone={doctor.is_verified ? 'success' : 'warning'}>{doctor.is_verified ? 'Verified' : 'Unverified'}</Badge>
            {doctor.is_active ? null : <Badge tone="neutral">Inactive</Badge>}
          </>
        }
        actions={
          manage && !merged && doctor.is_active ? (
            <>
              {doctor.is_verified ? null : <Button variant="primary" isDisabled={verifying} onPress={() => void verify()}>Verify</Button>}
              <Button onPress={() => setMerging(true)}>Merge into…</Button>
            </>
          ) : null
        }
      />
      {merged ? (
        <p role="note">
          Merged into{' '}
          <a className="lims-link" href={`/catalog/doctors/${doctor.merged_into_id}`}>{target ? `${target.doctor_code} — ${target.display_name}` : 'the doctor it was merged into'}</a>. Past orders keep this doctor.
        </p>
      ) : null}
      {verifyBanner ? <Banner tone="warning" title={verifyBanner} action={{ label: 'Refresh', onPress: () => router.refresh() }} /> : null}
      {ro ? (
        <div className="lims-form">{fields}</div>
      ) : (
        <SaveForm savedText="Doctor saved." keepOpen reloadLabel="Refresh" check={check} onDuplicate={() => undefined} save={save}>
          {fields}
        </SaveForm>
      )}
      {merging ? <DoctorMergeDialog source={{ id: doctor.id, doctor_code: doctor.doctor_code, display_name: doctor.display_name, version: doctor.version }} targets={mergeTargets} onClose={() => setMerging(false)} /> : null}
    </section>
  );
}
