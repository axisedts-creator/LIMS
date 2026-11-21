'use client';
// LD-310 / T0D-REGSCREEN-1: Add client and Add doctor quick add on the registration screen, on the EXISTING catalog APIs
// (createCreditParty / createDoctor, Idempotency-Key). Credit limit, bank details and doctor hospital are not in CreditPartyCreate /
// DoctorCreate: they wait for T0D-REGSCREEN-2 (backend). The server enforces catalog.price_list.manage / catalog.referrer.manage.
import { useRef, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { createCreditPartyAction, createDoctorAction } from '@/features/catalog/server/catalogActions';
import { newKey } from '../forms/draft';
import type { CreditPartySummary, DoctorSummary } from '../server/types';

const KINDS = [
  { value: 'hospital', label: 'Hospital' }, { value: 'company', label: 'Company' }, { value: 'clinic', label: 'Clinic' },
  { value: 'partner_lab', label: 'Partner lab' }, { value: 'insurer', label: 'Insurer' }, { value: 'other', label: 'Other' },
] as const;
type Kind = (typeof KINDS)[number]['value'];
export const KIND_LABEL: Record<string, string> = Object.fromEntries(KINDS.map((k) => [k.value, k.label]));
const failText = (code: string) => (code === 'catalog.code_duplicate' ? 'Code already used' : code === 'auth.forbidden' ? 'You are not allowed to add this here' : 'Could not be saved. Try again.');

/** One key per dialog session: a retry of the same save reuses it (02-CONVENTIONS idempotency). */
function useSave() {
  const key = useRef(newKey());
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string>();
  const run = async <T,>(f: (key: string) => Promise<{ ok: true; data: T } | { ok: false; code: string }>, done: (d: T) => void) => {
    if (busy) return;
    setBusy(true); setFail(undefined);
    try {
      const r = await f(key.current);
      if (r.ok) done(r.data);
      else setFail(failText(r.code));
    } finally { setBusy(false); }
  };
  return { busy, fail, run };
}

export function AddClientDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (p: CreditPartySummary) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('company');
  const [pan, setPan] = useState('');
  const [err, setErr] = useState<string>();
  const s = useSave();
  const save = () => {
    const n = name.trim();
    if (!n) { setErr('Enter a name'); return; }
    setErr(undefined);
    void s.run((key) => createCreditPartyAction({ name: n, kind, allows_credit: true, ...(pan.trim() ? { pan: pan.trim() } : {}) }, key), (d) => onSaved({ id: d.id, name: n, kind }));
  };
  return (
    <Dialog title="Add client" isOpen onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" onPress={save} isLoading={s.busy}>Save client</Button></>}>
      {s.fail ? <div role="alert"><Banner tone="danger" title={s.fail} /></div> : null}
      <TextField label="Client name" name="client_name" maxLength={160} isRequired value={name} onChange={setName} {...(err ? { error: err } : {})} />
      <Select label="Billing type" name="client_kind" value={kind} onChange={setKind} options={KINDS} />
      <TextField label="PAN" name="client_pan" maxLength={20} value={pan} onChange={setPan} />
    </Dialog>
  );
}

export function AddDoctorDialog({ onClose, onSaved }: { onClose: () => void; onSaved: (d: DoctorSummary) => void }) {
  const [name, setName] = useState('');
  const [regNo, setRegNo] = useState('');
  const [err, setErr] = useState<string>();
  const s = useSave();
  const save = () => {
    const n = name.trim();
    if (!n) { setErr('Enter a name'); return; }
    setErr(undefined);
    void s.run((key) => createDoctorAction({ display_name: n, ...(regNo.trim() ? { registration_no: regNo.trim() } : {}), quick_add: true }, key), (d) => onSaved({ id: d.id, display_name: n, is_verified: false }));
  };
  return (
    <Dialog title="Add doctor" isOpen onClose={onClose} size="sm"
      footer={<><Button variant="ghost" onPress={onClose}>Cancel</Button><Button variant="primary" onPress={save} isLoading={s.busy}>Save doctor</Button></>}>
      {s.fail ? <div role="alert"><Banner tone="danger" title={s.fail} /></div> : null}
      <TextField label="Doctor name" name="doctor_name" maxLength={120} isRequired value={name} onChange={setName} {...(err ? { error: err } : {})} />
      <TextField label="Registration number" name="doctor_registration_no" maxLength={30} value={regNo} onChange={setRegNo} />
    </Dialog>
  );
}
