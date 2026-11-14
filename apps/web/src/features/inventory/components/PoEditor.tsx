'use client';
// S6 purchase-order editor (04-UI-UX §3 S6; AC-05.1 server-computed amounts, AC-05.2 approve, AC-05.3 self-approval, AC-05.8 tax code / exempt).
// LD-140 (2026-11-13): kit components only; "Save draft" is the ONE primary of the drawer; no amount is ever computed here —
// net / VAT / totals and the tax rate snapshot ("VAT 13%") come from the server after a save. Without inventory.cost.read there are no price,
// discount or tax fields and the body carries no money (the server applies the item defaults).
// Approve (inventory.po.approve) is disabled while there are unsaved changes; a step-up (auth.mfa_required) keeps the form and the same Idempotency-Key.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Form } from '@lims/ui/components/Form';
import { Inline } from '@lims/ui/components/Inline';
import { MoneyField, type Money } from '@lims/ui/components/MoneyField';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { Stack } from '@lims/ui/components/Stack';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { approvePoAction, createPoAction, lookupBarcodeAction, replacePoAction } from '../server/actions';
import type { CodedValue, Item, ItemSummary, Pack, Po, PoCreate, PoLineIn, Store, SupplierSummary } from '../server/types';
import { cachedDefaults, Choice, EnterNext, EXEMPT, EXEMPT_LABEL, itemDefaults, keepKey, loadSupplierItems, money, newCaches, packsError, plusOne, rs, SCAN_UNKNOWN, ScanBox, searchItems, taxText, useFocusLine, useLineKeys, type ItemDefaults } from './PoShared';
import { fieldMessage, ProblemBanner, useAttemptKey, type Failure } from './shared';

interface Line { key: number; item?: ItemSummary | undefined; packs: readonly Pack[]; packId?: string | undefined; qty?: string | undefined; price?: Money | undefined; discount?: Money | undefined; tax?: string | undefined }
interface State { supplier?: SupplierSummary | undefined; storeId?: string | undefined; expected?: IsoDate | undefined; notes: string; lines: Line[] }
interface Errors { supplier?: string; store?: string; lines: Record<number, { item?: string; pack?: string; qty?: string }> }

let seq = 1;
const blank = (): Line => ({ key: seq++, packs: [] });
const stub = (id: string): ItemSummary => ({ id, item_code: id, name: '', category: 'other', base_uom_code: '', is_lot_tracked: false, requires_expiry: false, is_active: true, version: 1 });

function initial(po: Po | undefined, items: readonly Item[], suppliers: readonly SupplierSummary[]): State {
  if (!po) return { notes: '', lines: [blank()] };
  const supplier = suppliers.find((s) => s.id === po.supplier_id);
  return {
    ...(supplier ? { supplier } : {}),
    storeId: po.store_id,
    ...(po.expected_on ? { expected: po.expected_on as IsoDate } : {}),
    notes: po.notes ?? '',
    lines: po.lines.length
      ? po.lines.map((l) => {
          const full = items.find((i) => i.id === l.item_id);
          const price = money(l.unit_price_paisa);
          const discount = money(l.discount_paisa);
          return { key: seq++, item: full ?? stub(l.item_id), packs: (full?.packs ?? []).filter((p) => p.is_active), packId: l.pack_id, qty: l.qty_packs, ...(price ? { price } : {}), ...(discount ? { discount } : {}), tax: l.is_exempt ? EXEMPT : l.tax_code };
        })
      : [blank()],
  };
}

/** The request body. Only what the user typed: ids, quantity text, unit price and discount in paisa, tax choice. */
function bodyOf(s: State, canCost: boolean): PoCreate {
  return {
    supplier_id: s.supplier?.id ?? '',
    store_id: s.storeId ?? '',
    ...(s.expected ? { expected_on: s.expected } : {}),
    ...(s.notes.trim() ? { notes: s.notes.trim() } : {}),
    lines: s.lines.map((l): PoLineIn => ({
      item_id: l.item?.id ?? '',
      pack_id: l.packId ?? '',
      qty_packs: (l.qty ?? '').trim(),
      ...(canCost && l.price ? { unit_price_paisa: l.price.amountPaisa } : {}),
      ...(canCost && l.discount ? { discount_paisa: l.discount.amountPaisa } : {}),
      ...(canCost && l.tax === EXEMPT ? { is_exempt: true } : canCost && l.tax ? { tax_code: l.tax, is_exempt: false } : {}),
    })),
  };
}

export interface PoEditorProps {
  po?: Po;
  items: readonly Item[];
  suppliers: readonly SupplierSummary[];
  stores: readonly Store[];
  taxCodes: readonly CodedValue[];
  perms: readonly string[];
  onClose: () => void;
}

export function PoEditor(p: PoEditorProps) {
  const router = useRouter();
  const toast = useToast();
  const canCost = p.perms.includes('inventory.cost.read');
  const canApprove = p.perms.includes('inventory.po.approve');
  const root = useRef<HTMLDivElement>(null);
  const focus = useFocusLine(root);
  const [s, setS] = useState<State>(() => initial(p.po, p.items, p.suppliers));
  const [saved, setSaved] = useState<Po | undefined>(p.po);
  const [errors, setErrors] = useState<Errors>({ lines: {} });
  const [problem, setProblem] = useState<Failure>();
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const saveKey = useAttemptKey();
  const approveKey = useAttemptKey();
  const busy = useRef(false);
  const caches = useRef(newCaches());
  const live = useRef(s);
  live.current = s;

  const body = bodyOf(s, canCost);
  const sig = JSON.stringify(body);
  const base = useRef<string | undefined>(p.po ? sig : undefined);
  const dirty = !saved || sig !== base.current;
  const today = new Date().toISOString().slice(0, 10) as IsoDate;

  const patch = (key: number, f: Partial<Line>) => setS((c) => ({ ...c, lines: c.lines.map((l) => (l.key === key ? { ...l, ...f } : l)) }));
  const apply = (key: number, itemId: string, d: ItemDefaults) =>
    setS((c) => ({ ...c, lines: c.lines.map((l) => (l.key === key && l.item?.id === itemId ? { ...l, packs: d.packs, ...(d.packId ? { packId: d.packId } : {}), ...(d.tax ? { tax: d.tax } : {}), ...(d.price && !l.price ? { price: d.price } : {}) } : l)) }));
  const loadDefaults = (key: number, item: ItemSummary) => {
    const now = cachedDefaults(item, live.current.supplier?.id, caches.current, p.taxCodes, canCost);
    if (now) apply(key, item.id, now);
    else void itemDefaults(item, live.current.supplier?.id, caches.current, p.taxCodes, canCost).then((d) => apply(key, item.id, d));
  };
  const pickItem = (key: number, item: ItemSummary | undefined) => {
    patch(key, { item, packs: [], packId: undefined });
    if (item) loadDefaults(key, item);
  };
  const addLine = () => {
    const l = blank();
    setS((c) => ({ ...c, lines: [...c.lines, l] }));
    focus({ key: l.key });
  };
  const removeLine = (key: number) => setS((c) => ({ ...c, lines: c.lines.length <= 1 ? [blank()] : c.lines.filter((l) => l.key !== key) })); // the last line is kept (blank)
  useLineKeys(root, addLine, removeLine);

  const onScan = async (value: string) => {
    const r = await lookupBarcodeAction(value); // the value travels in the POST body only
    if (!r.ok) {
      if (r.status === 404) toast.show({ tone: 'danger', title: SCAN_UNKNOWN });
      else setProblem(r);
      return;
    }
    const item = r.data;
    const cur = live.current.lines;
    const same = cur.find((l) => l.item?.id === item.id);
    if (same) {
      patch(same.key, { qty: plusOne(same.qty) });
      focus({ key: same.key, qty: true });
      return;
    }
    const empty = cur.find((l) => !l.item);
    const key = empty?.key ?? blank().key;
    setS((c) => ({ ...c, lines: empty ? c.lines.map((l) => (l.key === key ? { ...l, item, qty: '1' } : l)) : [...c.lines, { key, item, packs: [], qty: '1' }] }));
    focus({ key, qty: true });
    loadDefaults(key, item);
  };

  const validate = (): Errors => {
    const e: Errors = { lines: {} };
    if (!s.supplier) e.supplier = 'Supplier is required';
    if (!s.storeId) e.store = 'Receiving store is required';
    for (const l of s.lines) {
      const le = { ...(l.item ? {} : { item: 'Item is required' }), ...(l.packId ? {} : { pack: 'Pack is required' }), ...(packsError(l.qty) ? { qty: packsError(l.qty) as string } : {}) };
      if (Object.keys(le).length) e.lines[l.key] = le;
    }
    return e;
  };

  const save = async () => {
    const e = validate();
    setErrors(e);
    if (e.supplier || e.store || Object.keys(e.lines).length) return;
    setProblem(undefined);
    setSaving(true);
    const r = saved ? await replacePoAction(saved.id, saved.version, body) : await createPoAction(body, saveKey.get(sig));
    setSaving(false);
    if (!r.ok) return setProblem(r);
    saveKey.reset();
    base.current = sig;
    setSaved(r.data);
    toast.show({ tone: 'success', title: 'PO saved' });
    router.refresh();
  };

  const approve = async () => {
    if (!saved || busy.current) return;
    busy.current = true;
    setApproving(true);
    const r = await approvePoAction(saved.id, saved.version, approveKey.get('approve'));
    busy.current = false;
    setApproving(false);
    if (!r.ok) {
      setProblem(r); // auth.mfa_required: nothing was saved; the same key is used again on retry
      if (!keepKey(r)) approveKey.reset();
      return;
    }
    approveKey.reset();
    toast.show({ tone: 'success', title: 'PO approved' });
    router.refresh();
    p.onClose();
  };

  const showAmounts = canCost && !!saved && !dirty;
  const storeOptions = p.stores.filter((x) => x.is_active || x.id === s.storeId).map((x) => ({ value: x.id, label: `${x.store_code} — ${x.name}` }));
  const taxOptions = [...p.taxCodes.map((t) => ({ value: t.code, label: t.display })), { value: EXEMPT, label: EXEMPT_LABEL }];

  return (
    <Form onSubmit={save} errorSummary={false}>
      <div ref={root} data-line-editor="">
        <Stack>
          <ProblemBanner problem={problem} />
          <Combobox<SupplierSummary>
            label="Supplier"
            name="supplier_id"
            loadOptions={async (q) => p.suppliers.filter((x) => x.is_active && `${x.supplier_code} ${x.name}`.toLowerCase().includes(q.toLowerCase())).slice(0, 20)}
            getKey={(x) => x.id}
            renderOption={(x) => `${x.supplier_code} — ${x.name}`}
            renderValue={(x) => `${x.supplier_code} — ${x.name}`}
            {...(s.supplier ? { value: s.supplier } : {})}
            {...((errors.supplier ?? fieldMessage(problem, '/supplier_id')) ? { error: (errors.supplier ?? fieldMessage(problem, '/supplier_id')) as string } : {})}
            onChange={(x) => {
              setS((c) => ({ ...c, ...(x ? { supplier: x } : { supplier: undefined }) }));
              if (x) void loadSupplierItems(x.id, caches.current);
            }}
          />
          <Choice label="Receiving store" name="store_id" options={storeOptions} value={s.storeId} error={errors.store ?? fieldMessage(problem, '/store_id')} onChange={(v) => setS((c) => ({ ...c, storeId: v }))} />
          <DatePicker label="Expected on" name="expected_on" min={today} value={s.expected} onChange={(v) => setS((c) => ({ ...c, ...(v ? { expected: v } : { expected: undefined }) }))} />
          <TextArea label="Notes" name="notes" maxLength={1000} value={s.notes} onChange={(v) => setS((c) => ({ ...c, notes: v }))} />
          <ScanBox onValue={(v) => void onScan(v)} />
          {s.lines.map((l, i) => {
            const server = (f: string) => fieldMessage(problem, `/lines/${i}/${f}`);
            const e = errors.lines[l.key];
            const sl = showAmounts ? saved?.lines[i] : undefined;
            const itemErr = e?.item ?? server('item_id');
            const packErr = e?.pack ?? server('pack_id');
            const qtyErr = e?.qty ?? server('qty_packs');
            const taxErr = server('tax_code');
            return (
              <div key={l.key} data-line={l.key}>
                <Stack gap={2}>
                  <Inline gap={2} align="start">
                    <Combobox<ItemSummary>
                      label="Item"
                      name={`item_${l.key}`}
                      loadOptions={(q) => searchItems(q, caches.current)}
                      getKey={(x) => x.id}
                      renderOption={(x) => `${x.item_code} — ${x.name}`}
                      renderValue={(x) => `${x.item_code} — ${x.name}`}
                      {...(l.item ? { value: l.item } : {})}
                      {...(itemErr ? { error: itemErr } : {})}
                      onChange={(x) => pickItem(l.key, x)}
                    />
                    <Choice label="Pack" name={`pack_${l.key}`} options={l.packs.map((x) => ({ value: x.id, label: x.label }))} value={l.packId} error={packErr} onChange={(v) => patch(l.key, { packId: v })} />
                    <EnterNext>
                      <DecimalField label="Qty packs" name={`qty_${l.key}`} decimals={3} {...(l.qty !== undefined ? { value: l.qty } : {})} {...(qtyErr ? { error: qtyErr } : {})} onChange={(v) => patch(l.key, { qty: v })} />
                    </EnterNext>
                    {canCost ? (
                      <>
                        <EnterNext>
                          <MoneyField label="Unit price" name={`price_${l.key}`} {...(l.price ? { value: l.price } : {})} {...(server('unit_price_paisa') ? { error: server('unit_price_paisa') as string } : {})} onChange={(v) => patch(l.key, { price: v })} />
                        </EnterNext>
                        <EnterNext>
                          <MoneyField label="Discount" name={`discount_${l.key}`} {...(l.discount ? { value: l.discount } : {})} {...(server('discount_paisa') ? { error: server('discount_paisa') as string } : {})} onChange={(v) => patch(l.key, { discount: v })} />
                        </EnterNext>
                        <Choice label="Tax" name={`tax_${l.key}`} options={taxOptions} value={l.tax} error={taxErr} onChange={(v) => patch(l.key, { tax: v })} />
                      </>
                    ) : null}
                    <Button variant="ghost" size="sm" onPress={() => removeLine(l.key)}>
                      Delete line
                    </Button>
                  </Inline>
                  {sl && sl.net_paisa !== undefined ? <p>{`Net ${rs(sl.net_paisa)} · ${taxText(sl.is_exempt ? undefined : sl.tax_code, sl.tax_rate_bp, p.taxCodes)} ${rs(sl.vat_paisa ?? 0)} · Total ${rs(sl.line_total_paisa ?? 0)}`}</p> : null}
                </Stack>
              </div>
            );
          })}
          <div>
            <Button shortcut="Alt+L" onPress={addLine}>
              Add line
            </Button>
          </div>
          {showAmounts && saved ? (
            <DescriptionList
              columns={3}
              items={[
                ...(saved.subtotal_paisa !== undefined ? [{ term: 'Subtotal', value: <MoneyText value={{ amountPaisa: saved.subtotal_paisa, currency: 'NPR' }} /> }] : []),
                ...(saved.discount_paisa !== undefined ? [{ term: 'Discount', value: <MoneyText value={{ amountPaisa: saved.discount_paisa, currency: 'NPR' }} /> }] : []),
                ...(saved.net_paisa !== undefined ? [{ term: 'Net', value: <MoneyText value={{ amountPaisa: saved.net_paisa, currency: 'NPR' }} /> }] : []),
                ...(saved.vat_paisa !== undefined ? [{ term: 'VAT', value: <MoneyText value={{ amountPaisa: saved.vat_paisa, currency: 'NPR' }} /> }] : []),
                ...(saved.total_paisa !== undefined ? [{ term: 'Total', value: <MoneyText value={{ amountPaisa: saved.total_paisa, currency: 'NPR' }} /> }] : []),
              ]}
            />
          ) : null}
          <p>Amounts are calculated by the system when you save.</p>
          <Inline gap={2}>
            <Button type="submit" variant="primary" isLoading={saving} shortcut="Ctrl+Enter">
              Save draft
            </Button>
            {saved && canApprove ? (
              <Button isDisabled={dirty || approving} isLoading={approving} onPress={() => void approve()}>
                Approve
              </Button>
            ) : null}
          </Inline>
        </Stack>
      </div>
    </Form>
  );
}
