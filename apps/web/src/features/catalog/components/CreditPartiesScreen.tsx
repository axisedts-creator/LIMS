'use client';
// SCR-12 Credit parties & affiliations (04-UI-UX §4). PAN, phone, email and billing address are rendered only with
// catalog.price_list.manage (the API omits them otherwise; the list never shows them anyway). No credit limit, credit days or
// balance exists here (AC-12.3): that is Billing.
import { useRef, useState } from 'react';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { createCreditPartyAction, updateCreditPartyAction } from '../server/catalogActions';
import { PARTY_CODE_RE, emailError, phoneError, type CreditParty, type PartyKind } from '../server/types';
import { DUPLICATE, EditorDialog, MasterTable, StatusBadge, useListShortcuts, type Col } from './master-ui';

const KINDS: readonly { value: PartyKind; label: string }[] = [
  { value: 'hospital', label: 'Hospital' }, { value: 'company', label: 'Company' }, { value: 'clinic', label: 'Clinic' },
  { value: 'partner_lab', label: 'Partner lab' }, { value: 'insurer', label: 'Insurer' }, { value: 'other', label: 'Other' },
];
const kindLabel = (k: PartyKind) => KINDS.find((x) => x.value === k)?.label ?? k;
const canManageParties = (permissions: readonly string[]) => permissions.includes('catalog.price_list.manage');
type Optional = 'pan' | 'contact_phone_e164' | 'contact_email' | 'billing_address';

export function CreditPartiesScreen({ creditParties, permissions }: { creditParties: readonly CreditParty[]; permissions: readonly string[] }) {
  const manage = canManageParties(permissions);
  const [editing, setEditing] = useState<CreditParty | 'new' | null>(null);
  const openNew = manage ? () => setEditing('new') : undefined;
  useListShortcuts(useRef(null), openNew);
  const cols: Col<CreditParty>[] = [
    { header: 'Code', cell: (r) => r.party_code },
    { header: 'Name', cell: (r) => r.name },
    { header: 'Kind', cell: (r) => kindLabel(r.kind) },
    { header: 'Credit allowed', cell: (r) => (r.allows_credit ? 'Yes' : 'No') },
    { header: 'Price list', cell: (r) => (r.price_list_id ? <a className="lims-link" href={`/catalog/price-lists/${r.price_list_id}`}>Open</a> : '—') },
    { header: 'Status', cell: (r) => <StatusBadge active={r.is_active} /> },
  ];
  return (
    <section aria-label="Credit parties">
      <PageHeader title="Credit parties & affiliations" helpKey="catalog.credit_parties" breadcrumbs={[{ label: 'Pricing' }, { label: 'Credit parties' }]} actions={openNew ? <Button variant="primary" onPress={openNew}>New credit party</Button> : null} />
      <p>Credit limits, credit days and monthly statements are managed in Billing.</p>
      <MasterTable caption="Credit parties" cols={cols} rows={creditParties} empty="No credit parties or affiliations yet." emptyAction={openNew ? { label: 'New credit party', onPress: openNew } : undefined} codeOf={(r) => r.party_code} onEdit={manage ? setEditing : undefined} />
      {editing ? <PartyDialog item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

function PartyDialog({ item, onClose }: { item: CreditParty | undefined; onClose: () => void }) {
  const [code, setCode] = useState(item?.party_code ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [kind, setKind] = useState<string>(item?.kind ?? '');
  const [credit, setCredit] = useState(item?.allows_credit ?? true);
  const [pan, setPan] = useState(item?.pan ?? '');
  const [phone, setPhone] = useState(item?.contact_phone_e164 ?? '');
  const [email, setEmail] = useState(item?.contact_email ?? '');
  const [address, setAddress] = useState(item?.billing_address ?? '');
  const [active, setActive] = useState(item?.is_active ?? true);
  const [codeError, setCodeError] = useState<string>();
  const [phoneErr, setPhoneErr] = useState<string>();
  const [emailErr, setEmailErr] = useState<string>();

  const check = () => {
    const p = phoneError(phone.trim());
    const e = emailError(email.trim());
    setPhoneErr(p);
    setEmailErr(e);
    return !p && !e;
  };
  const save = (key: string) => {
    const contact: [Optional, string][] = [['pan', pan], ['contact_phone_e164', phone], ['contact_email', email], ['billing_address', address]];
    if (!item) {
      const body: Record<string, unknown> = { name: name.trim(), kind, allows_credit: credit };
      if (code.trim()) body['party_code'] = code.trim();
      for (const [k, v] of contact) if (v.trim()) body[k] = v.trim();
      return createCreditPartyAction(body, key);
    }
    const body: Record<string, unknown> = {};
    const unset: Optional[] = [];
    if (name.trim() !== item.name) body['name'] = name.trim();
    if (kind !== item.kind) body['kind'] = kind;
    if (credit !== item.allows_credit) body['allows_credit'] = credit;
    if (active !== item.is_active) body['is_active'] = active;
    for (const [k, v] of contact) {
      const after = v.trim();
      if (after === (item[k] ?? '')) continue;
      if (after === '') unset.push(k);
      else body[k] = after;
    }
    if (unset.length) body['unset'] = unset;
    return updateCreditPartyAction(item.id, item.version, body);
  };
  return (
    <EditorDialog title={item ? 'Edit credit party' : 'New credit party'} savedText="Credit party saved." reloadLabel="Refresh" onClose={onClose} onDuplicate={() => setCodeError(DUPLICATE)} check={check} save={save}>
      <CodeField label="Party code" name="party_code" maxLength={20} pattern={PARTY_CODE_RE.source} patternHint="Capital letters, digits, _ and -, up to 20." {...(item ? {} : { description: 'Leave blank to assign one automatically.' })} isReadOnly={!!item} value={code} onChange={(v) => { setCode(v); setCodeError(undefined); }} {...(codeError ? { error: codeError } : {})} />
      <TextField label="Name" name="name" maxLength={160} isRequired value={name} onChange={setName} />
      <Select label="Kind" name="kind" isRequired options={KINDS} value={kind} onChange={setKind} />
      <Switch label="Credit allowed" isSelected={credit} onChange={setCredit} />
      <p className="lims-description">Off = affiliation with its own prices; patients still pay at the counter</p>
      <TextField label="PAN" name="pan" maxLength={20} value={pan} onChange={setPan} />
      <TextField label="Phone" name="contact_phone_e164" maxLength={16} inputMode="tel" description="International format, for example +97714000000." value={phone} onChange={(v) => { setPhone(v); setPhoneErr(undefined); }} {...(phoneErr ? { error: phoneErr } : {})} />
      <TextField label="Email" name="contact_email" maxLength={254} inputMode="email" value={email} onChange={(v) => { setEmail(v); setEmailErr(undefined); }} {...(emailErr ? { error: emailErr } : {})} />
      <TextArea label="Billing address" name="billing_address" maxLength={500} value={address} onChange={setAddress} />
      {item ? <Switch label="Active" isSelected={active} onChange={setActive} /> : null}
    </EditorDialog>
  );
}
