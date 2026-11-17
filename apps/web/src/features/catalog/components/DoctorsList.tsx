'use client';
// SCR-11 Doctors list (04-UI-UX §4). Verified / Status / Source filters travel as URL params (the page re-fetches); the search box
// POSTs to /doctors/search so a name never appears in a URL (D-C3-06). Summaries carry no phone/email, so the list shows none.
// Columns Source and Price list from the spec are not in DoctorSummary [CONV: omitted].
import { useRef, useState, type FormEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { createDoctorAction, searchDoctorsAction } from '../server/catalogActions';
import { PARTY_CODE_RE, emailError, phoneError, type DoctorSummary } from '../server/types';
import { DUPLICATE, EditorDialog, MasterTable, StatusBadge, useListShortcuts, type Col } from './master-ui';
import { canManageDoctors } from './DoctorDetail';

const COUNCILS = [{ value: 'none', label: 'None' }, { value: 'NMC', label: 'NMC' }, { value: 'Other', label: 'Other' }] as const;

export function DoctorsList({ doctors, permissions }: { doctors: readonly DoctorSummary[]; permissions: readonly string[] }) {
  const manage = canManageDoctors(permissions);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<readonly DoctorSummary[] | null>(null);
  const [searchError, setSearchError] = useState(false);
  const [dupes, setDupes] = useState<readonly DoctorSummary[]>([]);
  const openNew = manage ? () => setCreating(true) : undefined;
  useListShortcuts(useRef(null), openNew);

  const setParam = (name: string, value: string) => {
    const p = new URLSearchParams(params.toString());
    if (value === 'all') p.delete(name);
    else p.set(name, value);
    const s = p.toString();
    router.replace(s ? `${pathname}?${s}` : pathname);
  };
  const verified = params.get('is_verified') === 'true' ? 'true' : params.get('is_verified') === 'false' ? 'false' : 'all';
  const active = params.get('is_active') === 'true' ? 'true' : params.get('is_active') === 'false' ? 'false' : 'all';
  const source = ['back_office', 'quick_add', 'import'].includes(params.get('source') ?? '') ? params.get('source')! : 'all';

  const search = async (e: FormEvent) => {
    e.preventDefault();
    setSearchError(false);
    if (!q.trim()) return setResults(null);
    const r = await searchDoctorsAction(q.trim());
    if (r.ok) setResults(r.data);
    else setSearchError(true);
  };

  const rows = results ?? doctors;
  const cols: Col<DoctorSummary>[] = [
    { header: 'Code', cell: (r) => <a className="lims-link" href={`/catalog/doctors/${r.id}`}>{r.doctor_code}</a> },
    { header: 'Name', cell: (r) => r.display_name },
    { header: 'Qualification', cell: (r) => r.qualification ?? '—' },
    { header: 'Verified', cell: (r) => <Badge tone={r.is_verified ? 'success' : 'warning'}>{r.is_verified ? 'Verified' : 'Unverified'}</Badge> },
    { header: 'Status', cell: (r) => <StatusBadge active={r.is_active} /> },
  ];
  return (
    <section aria-label="Doctors">
      <PageHeader
        title="Doctors"
        helpKey="catalog.doctors"
        breadcrumbs={[{ label: 'Catalog', href: '/catalog' }, { label: 'Doctors' }]}
        actions={
          <>
            <a className="lims-link" href="/catalog/doctors/verify">Verify queue</a>
            {openNew ? <Button variant="primary" onPress={openNew}>New doctor</Button> : null}
          </>
        }
      />
      {dupes.length ? (
        <div role="status">
          <Banner tone="warning" title="Possible duplicate: a doctor with the same name already exists. The new doctor was saved.">
            <ul>
              {dupes.map((d) => (
                <li key={d.id}>
                  <a className="lims-link" href={`/catalog/doctors/${d.id}`}>{`${d.doctor_code} — ${d.display_name}`}</a>
                </li>
              ))}
            </ul>
          </Banner>
        </div>
      ) : null}
      <form role="search" className="lims-filter-bar" onSubmit={(e) => void search(e)}>
        <label className="lims-label" htmlFor="doctor-search">Search doctors</label>
        <input id="doctor-search" className="lims-input" type="search" maxLength={64} autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit">Search</Button>
        {results ? <Button variant="ghost" onPress={() => { setResults(null); setQ(''); }}>Clear search</Button> : null}
      </form>
      {searchError ? <div role="alert"><Banner tone="danger" title="The search could not be run. Try again." /></div> : null}
      <div className="lims-filter-bar">
        <RadioGroup label="Verified" name="is_verified" orientation="horizontal" value={verified} onChange={(v) => setParam('is_verified', v)} options={[{ value: 'all', label: 'All' }, { value: 'true', label: 'Verified' }, { value: 'false', label: 'Unverified' }]} />
        <RadioGroup label="Status" name="is_active" orientation="horizontal" value={active} onChange={(v) => setParam('is_active', v)} options={[{ value: 'all', label: 'All' }, { value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} />
        <RadioGroup label="Source" name="source" orientation="horizontal" value={source} onChange={(v) => setParam('source', v)} options={[{ value: 'all', label: 'All' }, { value: 'back_office', label: 'Back office' }, { value: 'quick_add', label: 'Quick add' }, { value: 'import', label: 'Import' }]} />
      </div>
      <MasterTable caption="Doctors" cols={cols} rows={rows} empty="No doctors yet." emptyAction={openNew ? { label: 'New doctor', onPress: openNew } : undefined} codeOf={(r) => r.doctor_code} />
      {creating ? <DoctorDialog onClose={() => setCreating(false)} onDuplicates={setDupes} /> : null}
    </section>
  );
}

/** Back-office create (AC-11.1): is_verified / source / quick_add are server-side; a blank code is auto-assigned. */
function DoctorDialog({ onClose, onDuplicates }: { onClose: () => void; onDuplicates: (d: readonly DoctorSummary[]) => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [qualification, setQualification] = useState('');
  const [council, setCouncil] = useState<string>('none');
  const [regNo, setRegNo] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [codeError, setCodeError] = useState<string>();
  const [phoneErr, setPhoneErr] = useState<string>();
  const [emailErr, setEmailErr] = useState<string>();
  const filled = (k: string, v: string) => (v.trim() ? { [k]: v.trim() } : {});
  return (
    <EditorDialog
      title="New doctor"
      savedText="Doctor saved."
      reloadLabel="Refresh"
      onClose={onClose}
      onDuplicate={() => setCodeError(DUPLICATE)}
      check={() => {
        const p = phoneError(phone.trim());
        const e = emailError(email.trim());
        setPhoneErr(p);
        setEmailErr(e);
        return !p && !e;
      }}
      onSaved={(d) => onDuplicates((d as { possible_duplicate_of?: DoctorSummary[] }).possible_duplicate_of ?? [])}
      save={(key) =>
        createDoctorAction(
          { ...filled('doctor_code', code), display_name: name.trim(), ...filled('qualification', qualification), ...(council !== 'none' ? { registration_council: council } : {}), ...filled('registration_no', regNo), ...filled('phone_e164', phone), ...filled('email', email), ...filled('notes', notes) },
          key,
        )
      }
    >
      <CodeField label="Doctor code" name="doctor_code" maxLength={20} pattern={PARTY_CODE_RE.source} patternHint="Capital letters, digits, _ and -, up to 20." description="Leave blank to assign one automatically." value={code} onChange={(v) => { setCode(v); setCodeError(undefined); }} {...(codeError ? { error: codeError } : {})} />
      <TextField label="Display name" name="display_name" maxLength={120} isRequired value={name} onChange={setName} />
      <TextField label="Qualification" name="qualification" maxLength={120} value={qualification} onChange={setQualification} />
      <Select label="Registration council" name="registration_council" options={COUNCILS} value={council} onChange={setCouncil} />
      <TextField label="Registration no." name="registration_no" maxLength={30} value={regNo} onChange={setRegNo} />
      <TextField label="Phone" name="phone_e164" maxLength={16} inputMode="tel" description="International format, for example +9779801234567." value={phone} onChange={(v) => { setPhone(v); setPhoneErr(undefined); }} {...(phoneErr ? { error: phoneErr } : {})} />
      <TextField label="Email" name="email" maxLength={254} inputMode="email" value={email} onChange={(v) => { setEmail(v); setEmailErr(undefined); }} {...(emailErr ? { error: emailErr } : {})} />
      <TextArea label="Notes" name="notes" maxLength={500} value={notes} onChange={setNotes} />
    </EditorDialog>
  );
}
