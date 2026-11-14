'use client';
// 04-UI-UX §4.2.7 Addendum editor (R8 create, R9 update, R10 sign): a Drawer with Kind, Text (required, <= 8000), the COMPLETED stain orders as Checkboxes, an optional link to a billed
// add-on item that has no result yet (AC-10.5), [Save] and, for people with anatomic.case.signout, [Sign addendum] (attestation, aal2 step-up handled by the page). A signed addendum is
// read-only and is never opened here. Text is text, never HTML (REQ-SEC-088). LD-140 (2026-11-13, binding): kit components only; the drawer has no primary button (the page's one lives elsewhere).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Dialog } from '@lims/ui/components/Dialog';
import { Drawer } from '@lims/ui/components/Drawer';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { createAddendumAction, signAddendumAction, updateAddendumAction } from '../../server/actions.report';
import type { Addendum, AddendumKind } from '../../server/report.types';
import type { CaseDetail } from '../../server/types';
import { newKey, partName, type Fail } from '../common';

export const ADDENDUM_KINDS: readonly { value: AddendumKind; label: string }[] = [
  { value: 'ihc', label: 'IHC' }, { value: 'special_stain', label: 'Special stain' }, { value: 'molecular', label: 'Molecular' }, { value: 'other', label: 'Other' },
];
const NO_LINK = 'none';

export function AddendumDrawer({ detail, addendum, canSign, isOpen, onClose, onFail, onMfa }: {
  detail: CaseDetail; addendum: Addendum | undefined; canSign: boolean; isOpen: boolean; onClose: () => void; onFail: (f: Fail) => void; onMfa: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [kind, setKind] = useState<AddendumKind | undefined>(addendum?.kind);
  const [text, setText] = useState(addendum?.text ?? '');
  const [stains, setStains] = useState<string[]>(addendum?.stain_order_ids ?? []);
  const [link, setLink] = useState<string>(addendum?.addon_case_item_id ?? NO_LINK);
  const [errors, setErrors] = useState<{ kind?: string; text?: string }>({});
  const [attesting, setAttesting] = useState(false);
  const [attested, setAttested] = useState(false);
  const [missing, setMissing] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [current, setCurrent] = useState(addendum);

  const completed = detail.stain_orders.filter((o) => o.status === 'completed');
  // AC-10.5: add-on items that still have no result (an already linked item stays selectable).
  const addons = detail.items.filter((i) => i.role === 'addon' && i.is_active && (i.lab_status === 'pending' || i.case_item_id === addendum?.addon_case_item_id));

  const valid = () => {
    const e = { ...(kind ? {} : { kind: 'Kind is required' }), ...(text.trim() ? {} : { text: 'Text is required' }) };
    setErrors(e);
    return !e.kind && !e.text && kind !== undefined;
  };
  const input = () => ({ kind: kind!, text, stain_order_ids: stains, ...(link !== NO_LINK ? { addon_case_item_id: link } : {}) });
  const fail = (f: Fail) => (f.code === 'auth.mfa_required' ? onMfa() : onFail(f));

  /** R8 / R9. Returns the saved addendum (its new version feeds the sign call), or undefined after a failure (already shown). */
  // The last saved row: a sign that fails after a save retries R9 with the new version instead of creating a second draft (R8) or sending a stale If-Match.
  const save = async (onlyIfChanged = false): Promise<Addendum | undefined> => {
    const same = current && kind === current.kind && text === current.text && link === (current.addon_case_item_id ?? NO_LINK) && stains.length === current.stain_order_ids.length && stains.every((x) => current.stain_order_ids.includes(x));
    if (onlyIfChanged && same) return current; // signing an unchanged draft uses its own version (If-Match)
    const r = current ? await updateAddendumAction(current.id, current.version, input()) : await createAddendumAction(detail.id, input(), newKey());
    if (r.ok) {
      setCurrent(r.data);
      return r.data;
    }
    fail(r);
    return undefined;
  };

  const onSave = async () => {
    if (busy.current || !valid()) return;
    busy.current = true;
    setPending(true);
    try {
      if (await save()) {
        toast.show({ tone: 'success', title: 'Addendum saved' });
        onClose();
        router.refresh();
      }
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const onSign = async () => {
    if (busy.current) return;
    if (!attested) return setMissing(true);
    busy.current = true;
    setPending(true);
    try {
      const saved = await save(true);
      if (!saved) return setAttesting(false);
      const r = await signAddendumAction(saved.id, saved.version, newKey());
      setAttesting(false);
      if (r.ok) {
        toast.show({ tone: 'success', title: `Addendum signed as version ${r.data.report_version.version_no}. Sent to lab verification.` });
        onClose();
        router.refresh();
      } else fail(r);
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  return (
    <>
      <Drawer title={addendum ? 'Edit addendum' : 'Add addendum'} isOpen={isOpen} onClose={onClose}>
        <Select<AddendumKind> label="Kind" name="kind" options={ADDENDUM_KINDS} {...(kind ? { value: kind } : {})} {...(errors.kind ? { error: errors.kind } : {})} onChange={(k) => { setKind(k); setErrors(({ text: t }) => (t ? { text: t } : {})); }} />
        <TextArea label="Text" name="text" rows={8} maxLength={8000} showCount value={text} {...(errors.text ? { error: errors.text } : {})} onChange={(v) => setText(v)} />
        <fieldset className="lims-field">
          <legend className="lims-label">Completed stains to include</legend>
          {completed.length === 0 ? <p className="lims-description">No completed stains on this case.</p> : null}
          {completed.map((o) => (
            <Checkbox key={o.id} label={`${o.stain_display} on ${o.block_label ?? partName(detail.parts, o.part_id)}`} name={`stain_${o.id}`} isSelected={stains.includes(o.id)} onChange={(c) => setStains(c ? [...stains, o.id] : stains.filter((x) => x !== o.id))} />
          ))}
        </fieldset>
        <Select<string>
          label="Link to billed add-on item"
          name="addon_case_item_id"
          options={[{ value: NO_LINK, label: 'No link' }, ...addons.map((i) => ({ value: i.case_item_id, label: i.test_name }))]}
          value={link}
          onChange={setLink}
        />
        <div>
          <Button isLoading={pending} onPress={() => void onSave()}>Save</Button>
          {canSign ? <Button variant="secondary" isDisabled={pending} onPress={() => { if (valid()) { setAttested(false); setMissing(false); setAttesting(true); } }}>Sign addendum</Button> : null}
        </div>
      </Drawer>
      <Dialog
        title="Sign addendum"
        size="sm"
        isOpen={attesting}
        onClose={() => setAttesting(false)}
        footer={
          <>
            <Button variant="ghost" onPress={() => setAttesting(false)} isDisabled={pending}>Cancel</Button>
            <Button variant="primary" isLoading={pending} onPress={() => void onSign()}>Sign addendum</Button>
          </>
        }
      >
        <p>Signing creates a new report version and sends it to lab verification.</p>
        <Checkbox label="I have reviewed this addendum" name="attest" description="Required before you can sign." isSelected={attested} onChange={(v) => { setAttested(v); setMissing(false); }} />
        {missing ? <p className="lims-error">Tick the box to confirm you have reviewed the addendum.</p> : null}
      </Dialog>
    </>
  );
}
