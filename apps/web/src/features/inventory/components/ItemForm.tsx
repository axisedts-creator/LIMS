'use client';
// S2/S3 item form (04-UI-UX §3 S2): create and edit share one form. LD-140: kit fields only, one Save per Drawer.
// Edit sends ONLY changed ItemPatch fields; cleared optional fields go in `unset` (CV §4.2, never null/empty string).
// base_uom_code and item_code are not in ItemPatch, so they are read-only on edit (AC-01.5).
import { useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { Form } from '@lims/ui/components/Form';
import { Select } from '@lims/ui/components/Select';
import { Stack } from '@lims/ui/components/Stack';
import { Switch } from '@lims/ui/components/Switch';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { createItemAction, updateItemAction } from '../server/actions';
import type { ActionResult, Category, CodedValue, Item, ItemCreate, ItemPatch, StorageCondition } from '../server/types';
import { CATEGORIES, HS_CODE, intText, ITEM_CODE, NONE, patternText, STORAGE } from './codes';
import { ProblemBanner, useIdemKey, type Failure } from './shared';

interface S {
  code: string; name: string; category: Category; uom: string; manufacturer: string; catalogue: string; storage: string;
  stability: string; container: string | undefined; hs: string; tax: string; notes: string; lot: boolean; expiry: boolean;
}
const initial = (i: Item | undefined, uom: readonly CodedValue[]): S => ({
  code: i?.item_code ?? '', name: i?.name ?? '', category: i?.category ?? 'reagent', uom: i?.base_uom_code ?? (uom.find((u) => u.code === 'test') ?? uom[0])?.code ?? '',
  manufacturer: i?.manufacturer ?? '', catalogue: i?.catalogue_no ?? '', storage: i?.storage_condition ?? NONE,
  stability: i?.open_stability_days === undefined ? '' : String(i.open_stability_days), container: i?.container_qty_base, hs: i?.hs_code ?? '',
  tax: i?.default_tax_code ?? NONE, notes: i?.notes ?? '', lot: i?.is_lot_tracked ?? true, expiry: i?.requires_expiry ?? true,
});

const LOCK_TEXT = 'Used by packs, rules or stock — create a new item to change the unit';

export function ItemForm({ item, uom, tax, onDone }: { item?: Item; uom: readonly CodedValue[]; tax: readonly CodedValue[]; onDone: () => void }) {
  const [v, setV] = useState<S>(() => initial(item, uom));
  const [own, setOwn] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<Failure>();
  const key = useIdemKey();
  const orig = useRef(item);
  const set = <K extends keyof S>(k: K, x: S[K]) => setV((p) => ({ ...p, [k]: x }));
  const edit = !!item;
  const locked = edit; // ItemPatch has no base_uom_code: the unit never changes after create (AC-01.5)

  const onSubmit = async () => {
    const e: Record<string, string> = {};
    const stab = intText('Open stability (days)', v.stability, 1, 3650);
    if (stab) e['open_stability_days'] = stab;
    const hs = patternText('HS code', v.hs, HS_CODE, 'use 4 to 10 digits');
    if (hs) e['hs_code'] = hs;
    setOwn(e);
    if (Object.keys(e).length) return;
    setProblem(undefined);
    const expiry = v.lot ? v.expiry : false;
    const opt = {
      manufacturer: v.manufacturer.trim(), catalogue_no: v.catalogue.trim(), hs_code: v.hs.trim(), notes: v.notes.trim(),
    };
    let r: ActionResult<true>;
    if (!item) {
      const body: ItemCreate = {
        item_code: v.code, name: v.name.trim(), category: v.category, base_uom_code: v.uom, is_lot_tracked: v.lot, requires_expiry: expiry,
        ...(opt.manufacturer ? { manufacturer: opt.manufacturer } : {}),
        ...(opt.catalogue_no ? { catalogue_no: opt.catalogue_no } : {}),
        ...(v.storage !== NONE ? { storage_condition: v.storage as StorageCondition } : {}),
        ...(v.stability.trim() ? { open_stability_days: Number(v.stability) } : {}),
        ...(v.container ? { container_qty_base: v.container } : {}),
        ...(opt.hs_code ? { hs_code: opt.hs_code } : {}),
        ...(v.tax !== NONE ? { default_tax_code: v.tax } : {}),
        ...(opt.notes ? { notes: opt.notes } : {}),
      };
      r = await createItemAction(body, key.get());
    } else {
      const o = orig.current!;
      const patch: ItemPatch = {};
      const unset: string[] = [];
      const text = (field: 'manufacturer' | 'catalogue_no' | 'hs_code' | 'notes', now: string) => {
        if (now === (o[field] ?? '')) return;
        if (now) patch[field] = now;
        else unset.push(field);
      };
      if (v.name.trim() !== o.name) patch.name = v.name.trim();
      if (v.category !== o.category) patch.category = v.category;
      text('manufacturer', opt.manufacturer);
      text('catalogue_no', opt.catalogue_no);
      text('hs_code', opt.hs_code);
      text('notes', opt.notes);
      if (v.storage !== (o.storage_condition ?? NONE)) (v.storage === NONE ? unset.push('storage_condition') : (patch.storage_condition = v.storage as StorageCondition));
      if (v.stability.trim() !== (o.open_stability_days === undefined ? '' : String(o.open_stability_days))) (v.stability.trim() ? (patch.open_stability_days = Number(v.stability)) : unset.push('open_stability_days'));
      if ((v.container ?? '') !== (o.container_qty_base ?? '')) (v.container ? (patch.container_qty_base = v.container) : unset.push('container_qty_base'));
      if (v.tax !== (o.default_tax_code ?? NONE)) (v.tax === NONE ? unset.push('default_tax_code') : (patch.default_tax_code = v.tax));
      if (v.lot !== o.is_lot_tracked) patch.is_lot_tracked = v.lot;
      if (expiry !== o.requires_expiry) patch.requires_expiry = expiry;
      if (unset.length) patch.unset = unset;
      if (Object.keys(patch).length === 0) return onDone();
      r = await updateItemAction(o.id, o.version, patch);
    }
    if (!r.ok) return setProblem(r);
    key.reset();
    onDone();
  };

  return (
    <Form onSubmit={onSubmit} {...(problem?.errors ? { problem: { errors: problem.errors } } : {})}>
      <Stack>
        <ProblemBanner problem={problem} />
        <CodeField label="Code" name="item_code" maxLength={32} pattern={ITEM_CODE} patternHint="Letters A–Z, digits, _ . - (start with a letter or digit)" isRequired isReadOnly={edit} value={v.code} onChange={(x) => set('code', x)} />
        <TextField label="Name" name="name" maxLength={200} isRequired value={v.name} onChange={(x) => set('name', x)} />
        <Select label="Category" name="category" isRequired options={CATEGORIES} value={v.category} onChange={(x) => set('category', x as Category)} />
        <Select
          label="Base unit"
          name="base_uom_code"
          isRequired
          isDisabled={locked}
          options={uom.map((u) => ({ value: u.code, label: u.display }))}
          value={v.uom}
          onChange={(x) => set('uom', x)}
          {...(edit ? { description: item.packs.length > 0 ? LOCK_TEXT : 'The unit is fixed once the item exists' } : {})}
        />
        <TextField label="Manufacturer" name="manufacturer" maxLength={120} value={v.manufacturer} onChange={(x) => set('manufacturer', x)} />
        <TextField label="Catalogue no." name="catalogue_no" maxLength={64} value={v.catalogue} onChange={(x) => set('catalogue', x)} />
        <Select label="Storage condition" name="storage_condition" options={[{ value: NONE, label: 'Not set' }, ...STORAGE]} value={v.storage} onChange={(x) => set('storage', x)} />
        <TextField label="Open stability (days)" name="open_stability_days" maxLength={4} inputMode="numeric" value={v.stability} onChange={(x) => set('stability', x)} {...(own['open_stability_days'] ? { error: own['open_stability_days'] } : {})} />
        <DecimalField label="Container size" name="container_qty_base" decimals={6} min="0.000001" max="999999999999" {...(v.container !== undefined ? { value: v.container } : {})} onChange={(x) => set('container', x)} />
        <TextField label="HS code" name="hs_code" maxLength={10} inputMode="numeric" value={v.hs} onChange={(x) => set('hs', x)} {...(own['hs_code'] ? { error: own['hs_code'] } : {})} />
        <Select label="Default tax code" name="default_tax_code" options={[{ value: NONE, label: 'Not set' }, ...tax.map((t) => ({ value: t.code, label: t.display }))]} value={v.tax} onChange={(x) => set('tax', x)} />
        <TextArea label="Notes" name="notes" maxLength={1000} value={v.notes} onChange={(x) => set('notes', x)} />
        <Switch label="Track lots" name="is_lot_tracked" isSelected={v.lot} onChange={(x) => set('lot', x)} />
        <Switch label="Expiry required" name="requires_expiry" isSelected={v.lot ? v.expiry : false} isDisabled={!v.lot} onChange={(x) => set('expiry', x)} />
        <Button type="submit" variant="primary">
          Save
        </Button>
      </Stack>
    </Form>
  );
}
