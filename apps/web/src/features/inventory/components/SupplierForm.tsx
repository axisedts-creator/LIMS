'use client';
// S5 supplier form (04-UI-UX §3 S5). Contact fields are personal data (07 §5, REQ-SEC-098): they go only into the request body,
// never a URL, toast, router call or log. Create omits empty optionals; edit sends ONLY changed fields and puts cleared ones in `unset`.
// LD-140: kit components only; one Save per Drawer.
import { useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { Form } from '@lims/ui/components/Form';
import { Stack } from '@lims/ui/components/Stack';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { createSupplierAction, updateSupplierAction } from '../server/actions';
import type { ActionResult, Supplier, SupplierCreate, SupplierPatch } from '../server/types';
import { intText, PAN_TEXT, patternText, STORE_CODE } from './codes';
import { ProblemBanner, useIdemKey, type Failure } from './shared';

interface S { code: string; name: string; pan: string; contact: string; phone: string; email: string; address: string; terms: string; notes: string }
const initial = (s?: Supplier): S => ({
  code: s?.supplier_code ?? '', name: s?.name ?? '', pan: s?.pan_text ?? '', contact: s?.contact_name ?? '', phone: s?.phone_display ?? '', email: s?.email ?? '',
  address: s?.address_text ?? '', terms: s?.payment_terms_days === undefined ? '' : String(s.payment_terms_days), notes: s?.notes ?? '',
});
const TEXT_FIELDS = [
  ['pan_text', 'pan'], ['contact_name', 'contact'], ['phone_display', 'phone'], ['email', 'email'], ['address_text', 'address'], ['notes', 'notes'],
] as const;

export function SupplierForm({ supplier, onDone }: { supplier?: Supplier; onDone: () => void }) {
  const [v, setV] = useState<S>(() => initial(supplier));
  const [own, setOwn] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<Failure>();
  const key = useIdemKey();
  const orig = useRef(supplier);
  const set = (k: keyof S) => (x: string) => setV((p) => ({ ...p, [k]: x }));

  const onSubmit = async () => {
    const e: Record<string, string> = {};
    const pan = patternText('PAN / VAT no.', v.pan, PAN_TEXT, 'letters and digits only, up to 20');
    if (pan) e['pan_text'] = pan;
    const terms = intText('Payment terms', v.terms, 0, 365);
    if (terms) e['payment_terms_days'] = terms;
    setOwn(e);
    if (Object.keys(e).length) return;
    setProblem(undefined);
    const o = orig.current;
    let r: ActionResult<true>;
    if (!o) {
      const body: SupplierCreate = { supplier_code: v.code, name: v.name.trim() };
      for (const [field, k] of TEXT_FIELDS) if (v[k].trim()) body[field] = v[k].trim();
      if (v.terms.trim()) body.payment_terms_days = Number(v.terms);
      r = await createSupplierAction(body, key.get());
    } else {
      const patch: SupplierPatch = {};
      const unset: string[] = [];
      if (v.name.trim() !== o.name) patch.name = v.name.trim();
      for (const [field, k] of TEXT_FIELDS) {
        const now = v[k].trim();
        if (now === (o[field] ?? '')) continue;
        if (now) patch[field] = now;
        else unset.push(field);
      }
      if (v.terms.trim() !== (o.payment_terms_days === undefined ? '' : String(o.payment_terms_days))) {
        if (v.terms.trim()) patch.payment_terms_days = Number(v.terms);
        else unset.push('payment_terms_days');
      }
      if (unset.length) patch.unset = unset;
      if (Object.keys(patch).length === 0) return onDone();
      r = await updateSupplierAction(o.id, o.version, patch);
    }
    if (!r.ok) return setProblem(r);
    key.reset();
    onDone();
  };

  return (
    <Form onSubmit={onSubmit} {...(problem?.errors ? { problem: { errors: problem.errors } } : {})}>
      <Stack>
        <ProblemBanner problem={problem} />
        <CodeField label="Code" name="supplier_code" maxLength={16} pattern={STORE_CODE} patternHint="Letters A–Z, digits, _ - (start with a letter or digit, up to 16)" isRequired isReadOnly={!!supplier} value={v.code} onChange={set('code')} />
        <TextField label="Name" name="name" maxLength={200} isRequired value={v.name} onChange={set('name')} />
        <TextField label="PAN / VAT no. (as on supplier invoice)" name="pan_text" maxLength={20} value={v.pan} onChange={set('pan')} {...(own['pan_text'] ? { error: own['pan_text'] } : {})} />
        <TextField label="Contact name" name="contact_name" maxLength={120} autoComplete="off" value={v.contact} onChange={set('contact')} />
        <TextField label="Phone" name="phone_display" maxLength={40} inputMode="tel" autoComplete="off" value={v.phone} onChange={set('phone')} />
        <TextField label="Email" name="email" maxLength={254} inputMode="email" autoComplete="off" value={v.email} onChange={set('email')} />
        <TextArea label="Address" name="address_text" maxLength={500} value={v.address} onChange={set('address')} />
        <TextField label="Payment terms (days)" name="payment_terms_days" maxLength={3} inputMode="numeric" value={v.terms} onChange={set('terms')} {...(own['payment_terms_days'] ? { error: own['payment_terms_days'] } : {})} />
        <TextArea label="Notes" name="notes" maxLength={1000} value={v.notes} onChange={set('notes')} />
        <Button type="submit" variant="primary">
          Save
        </Button>
      </Stack>
    </Form>
  );
}
