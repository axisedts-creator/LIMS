'use client';
// S7 goods-receipt editor (04-UI-UX §3 S7; AC-06.1 post against a PO lot, AC-06.2 receive the rest later, AC-06.3 over receipt, AC-06.4 server value,
// AC-06.6 PO required, AC-06.7 opening balance only with inventory.stock.adjust + step-up, AC-06.8 replay with the same key, AC-06.9 expired lot).
// LD-140 (2026-11-13): kit components only; "Save draft" is the ONE primary of the drawer. "Post receipt" is disabled until the draft is saved and again after an edit.
// No amount is computed here: totals, line values and the invoice mismatch come from the server. The Idempotency-Key of a post is kept when the outcome is
// unknown or a step-up (auth.mfa_required) interrupted it, so the retry is a replay, not a second post.
import { useRef, useState, type ComponentProps } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import { Form } from '@lims/ui/components/Form';
import { Inline } from '@lims/ui/components/Inline';
import { MoneyField, type Money } from '@lims/ui/components/MoneyField';
import { MoneyText } from '@lims/ui/components/MoneyText';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Stack } from '@lims/ui/components/Stack';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createGrnAction, lookupBarcodeAction, postGrnAction, replaceGrnAction } from '../server/actions';
import type { CodedValue, Grn, GrnDraft, GrnKind, GrnLineIn, Item, ItemSummary, Pack, Po, Store, SupplierSummary } from '../server/types';
import { cachedDefaults, Choice, EnterNext, EXEMPT, EXEMPT_LABEL, itemDefaults, keepKey, KIND_LABEL, loadSupplierItems, LOT_NO, money, newCaches, packsError, packsOf, plusOne, rs, SCAN_UNKNOWN, ScanBox, searchItems, taxText, useFocusLine, useLineKeys, type ItemDefaults } from './PoShared';
import { fieldMessage, ProblemBanner, useAttemptKey, type Failure } from './shared';

export const LOT_MISSING = 'Enter the lot number printed on the pack.';
export const LOT_EXPIRED = 'This lot has already expired. It cannot be received.';
const TZ = 'Asia/Kathmandu';

type IsoUtc = NonNullable<ComponentProps<typeof DateTimePicker>['value']>;
interface Line { key: number; poLineId?: string | undefined; item?: ItemSummary | undefined; packs: readonly Pack[]; packId?: string | undefined; qty?: string | undefined; lotNo: string; expiry?: IsoDate | undefined; mfg?: IsoDate | undefined; price?: Money | undefined; discount?: Money | undefined; tax?: string | undefined; open?: string | undefined }
interface State { kind: GrnKind; storeId?: string | undefined; supplier?: SupplierSummary | undefined; poId?: string | undefined; receivedAt?: IsoUtc | undefined; invNo: string; invOn?: IsoDate | undefined; invTotal?: Money | undefined; notes: string; lines: Line[] }
interface Errors { supplier?: string; store?: string; lines: Record<number, { item?: string; pack?: string; qty?: string; lot?: string; expiry?: string }> }

let seq = 1;
const blank = (): Line => ({ key: seq++, packs: [], lotNo: '' });
const stub = (id: string): ItemSummary => ({ id, item_code: id, name: '', category: 'other', base_uom_code: '', is_lot_tracked: false, requires_expiry: false, is_active: true, version: 1 });
const localDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

function initial(grn: Grn | undefined, po: Po | undefined, items: readonly Item[], suppliers: readonly SupplierSummary[], canCost: boolean): State {
  const packsOfItem = (id: string) => (items.find((i) => i.id === id)?.packs ?? []).filter((x) => x.is_active);
  if (grn) {
    const supplier = suppliers.find((s) => s.id === grn.supplier_id);
    return {
      kind: grn.kind,
      storeId: grn.store_id,
      ...(supplier ? { supplier } : {}),
      ...(grn.po_id ? { poId: grn.po_id } : {}),
      receivedAt: grn.received_at as IsoUtc,
      invNo: grn.supplier_invoice_no ?? '',
      ...(grn.supplier_invoice_on ? { invOn: grn.supplier_invoice_on as IsoDate } : {}),
      ...(money(grn.supplier_invoice_total_paisa) ? { invTotal: money(grn.supplier_invoice_total_paisa) as Money } : {}),
      notes: grn.notes ?? '',
      lines: grn.lines.length
        ? grn.lines.map((l) => ({
            key: seq++, ...(l.po_line_id ? { poLineId: l.po_line_id } : {}), item: items.find((i) => i.id === l.item_id) ?? stub(l.item_id), packs: packsOfItem(l.item_id), packId: l.pack_id, qty: l.qty_packs, lotNo: l.lot_no ?? '',
            ...(l.expiry_on ? { expiry: l.expiry_on as IsoDate } : {}), ...(l.manufactured_on ? { mfg: l.manufactured_on as IsoDate } : {}),
            ...(money(l.unit_price_paisa) ? { price: money(l.unit_price_paisa) as Money } : {}), ...(money(l.discount_paisa) ? { discount: money(l.discount_paisa) as Money } : {}), tax: l.is_exempt ? EXEMPT : l.tax_code,
          }))
        : [blank()],
    };
  }
  if (po) {
    const supplier = suppliers.find((s) => s.id === po.supplier_id);
    const open = po.lines.filter((l) => Number(l.open_qty_base) > 0 && !l.is_closed_short);
    return {
      kind: 'purchase',
      storeId: po.store_id,
      ...(supplier ? { supplier } : {}),
      poId: po.id,
      receivedAt: new Date().toISOString() as IsoUtc,
      invNo: '',
      notes: '',
      lines: open.length
        ? open.map((l) => {
            const full = items.find((i) => i.id === l.item_id);
            const packs = packsOfItem(l.item_id);
            const pack = packs.find((x) => x.id === l.pack_id);
            return {
              key: seq++, poLineId: l.id, item: full ?? stub(l.item_id), packs, packId: l.pack_id, qty: packsOf(l.open_qty_base, pack?.qty_in_base), lotNo: '', open: `${l.open_qty_base} ${full?.base_uom_code ?? ''}`.trim(),
              ...(canCost && money(l.unit_price_paisa) ? { price: money(l.unit_price_paisa) as Money } : {}), ...(canCost && money(l.discount_paisa) ? { discount: money(l.discount_paisa) as Money } : {}), ...(canCost ? { tax: l.is_exempt ? EXEMPT : l.tax_code } : {}),
            };
          })
        : [blank()],
    };
  }
  return { kind: 'purchase', receivedAt: new Date().toISOString() as IsoUtc, invNo: '', notes: '', lines: [blank()] };
}

function bodyOf(s: State, canCost: boolean): GrnDraft {
  const purchase = s.kind === 'purchase';
  return {
    kind: s.kind,
    store_id: s.storeId ?? '',
    ...(purchase && s.supplier ? { supplier_id: s.supplier.id } : {}),
    ...(purchase && s.poId ? { po_id: s.poId } : {}),
    ...(s.receivedAt ? { received_at: s.receivedAt } : {}),
    ...(purchase && s.invNo.trim() ? { supplier_invoice_no: s.invNo.trim() } : {}),
    ...(purchase && s.invOn ? { supplier_invoice_on: s.invOn } : {}),
    ...(purchase && canCost && s.invTotal ? { supplier_invoice_total_paisa: s.invTotal.amountPaisa } : {}),
    ...(s.notes.trim() ? { notes: s.notes.trim() } : {}),
    lines: s.lines.map((l): GrnLineIn => ({
      ...(l.poLineId ? { po_line_id: l.poLineId } : {}),
      item_id: l.item?.id ?? '',
      pack_id: l.packId ?? '',
      qty_packs: (l.qty ?? '').trim(),
      ...(l.lotNo.trim() ? { lot_no: l.lotNo.trim() } : {}),
      ...(l.expiry ? { expiry_on: l.expiry } : {}),
      ...(l.mfg ? { manufactured_on: l.mfg } : {}),
      ...(canCost && l.price ? { unit_price_paisa: l.price.amountPaisa } : {}),
      ...(canCost && l.discount ? { discount_paisa: l.discount.amountPaisa } : {}),
      ...(canCost && l.tax === EXEMPT ? { is_exempt: true } : canCost && l.tax ? { tax_code: l.tax, is_exempt: false } : {}),
    })),
  };
}

export interface GrnEditorProps {
  grn?: Grn;
  prefillPo?: Po;
  items: readonly Item[];
  suppliers: readonly SupplierSummary[];
  stores: readonly Store[];
  taxCodes: readonly CodedValue[];
  perms: readonly string[];
  onPosted: (g: Grn) => void;
  onChanged: () => void;
}

export function GrnEditor(p: GrnEditorProps) {
  const router = useRouter();
  const toast = useToast();
  const canCost = p.perms.includes('inventory.cost.read');
  const canAdjust = p.perms.includes('inventory.stock.adjust');
  const root = useRef<HTMLDivElement>(null);
  const focus = useFocusLine(root);
  const [s, setS] = useState<State>(() => initial(p.grn, p.prefillPo, p.items, p.suppliers, canCost));
  const [saved, setSaved] = useState<Grn | undefined>(p.grn);
  const [errors, setErrors] = useState<Errors>({ lines: {} });
  const [problem, setProblem] = useState<Failure>();
  const [scanCard, setScanCard] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const saveKey = useAttemptKey();
  const postKey = useAttemptKey();
  const caches = useRef(newCaches());
  const live = useRef(s);
  live.current = s;

  const body = bodyOf(s, canCost);
  const sig = JSON.stringify(body);
  const base = useRef<string | undefined>(p.grn ? sig : undefined);
  const dirty = !saved || sig !== base.current;
  const purchase = s.kind === 'purchase';

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
  const removeLine = (key: number) => setS((c) => ({ ...c, lines: c.lines.length <= 1 ? [blank()] : c.lines.filter((l) => l.key !== key) }));
  useLineKeys(root, addLine, removeLine);

  const onScan = async (value: string) => {
    const r = await lookupBarcodeAction(value); // the value travels in the POST body only
    if (!r.ok) {
      setScanCard(r.status === 404 ? SCAN_UNKNOWN : '');
      if (r.status === 404) toast.show({ tone: 'danger', title: SCAN_UNKNOWN });
      else setProblem(r);
      return;
    }
    const item = r.data;
    setScanCard(`${item.item_code} · ${item.name}`); // T0D-UISCAN-1: the last scan result card
    const cur = live.current.lines;
    const same = cur.find((l) => l.item?.id === item.id);
    if (same) {
      patch(same.key, { qty: plusOne(same.qty) });
      focus({ key: same.key, qty: true });
      return;
    }
    const empty = cur.find((l) => !l.item);
    const key = empty?.key ?? blank().key;
    setS((c) => ({ ...c, lines: empty ? c.lines.map((l) => (l.key === key ? { ...l, item, qty: '1' } : l)) : [...c.lines, { key, item, packs: [], lotNo: '', qty: '1' }] }));
    focus({ key, qty: true });
    loadDefaults(key, item);
  };

  const validate = (): Errors => {
    const e: Errors = { lines: {} };
    if (!s.storeId) e.store = 'Store is required';
    if (purchase && !s.supplier) e.supplier = 'Supplier is required';
    const received = s.receivedAt ? localDay(s.receivedAt) : undefined;
    for (const l of s.lines) {
      const lot = l.lotNo.trim();
      const le = {
        ...(l.item ? {} : { item: 'Item is required' }),
        ...(l.packId ? {} : { pack: 'Pack is required' }),
        ...(packsError(l.qty) ? { qty: packsError(l.qty) as string } : {}),
        ...(l.item?.is_lot_tracked && !lot ? { lot: LOT_MISSING } : lot && !LOT_NO.test(lot) ? { lot: 'Lot no. must be 1 to 64 visible characters, without spaces' } : {}),
        ...(l.item?.requires_expiry && !l.expiry ? { expiry: 'Expiry is required' } : l.expiry && received && l.expiry < received ? { expiry: LOT_EXPIRED } : {}),
      };
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
    // PUT body = GrnDraft minus kind, store_id (TRD §5 #52); the full body is only for the create.
    const { kind: _k, store_id: _s, ...replace } = body;
    const r = saved ? await replaceGrnAction(saved.id, saved.version, replace) : await createGrnAction(body, saveKey.get(sig));
    setSaving(false);
    if (!r.ok) return setProblem(r);
    saveKey.reset();
    base.current = sig;
    setSaved(r.data);
    toast.show({ tone: 'success', title: 'Receipt saved as draft' });
    p.onChanged(); // the list behind the drawer refreshes when the drawer closes
  };

  const post = async () => {
    if (!saved) return;
    const r = await postGrnAction(saved.id, saved.version, postKey.get('post'));
    setConfirming(false);
    if (!r.ok) {
      setProblem(r); // auth.mfa_required (opening balance) and 5xx keep the key: the retry is a replay
      if (!keepKey(r)) postKey.reset();
      return;
    }
    postKey.reset();
    const lots = new Set(r.data.lines.filter((l) => l.lot_no).map((l) => l.lot_no)).size || r.data.lines.length;
    toast.show({ tone: 'success', title: `Receipt posted — ${lots} lot${lots === 1 ? '' : 's'}` });
    router.refresh();
    p.onPosted(r.data);
  };

  /** Server messages are shown on the field they point at; the codes with a spec text use that text. */
  const serverLine = (i: number, field: 'qty_packs' | 'expiry_on' | 'lot_no' | 'item_id' | 'pack_id' | 'tax_code') => {
    const m = fieldMessage(problem, `/lines/${i}/${field}`);
    if (!m) return undefined;
    if (field === 'qty_packs' && problem?.code === 'inventory.over_receipt') return s.lines[i]?.open ? `More than ordered (open: ${s.lines[i]?.open}).` : 'More than ordered.';
    if (field === 'expiry_on' && problem?.code === 'inventory.lot_expired') return LOT_EXPIRED;
    return m;
  };
  const mismatch = saved && canCost && saved.supplier_invoice_total_paisa !== undefined && saved.invoice_total_mismatch_paisa ? saved.invoice_total_mismatch_paisa : undefined;
  const showAmounts = canCost && !!saved && !dirty;
  const storeOptions = p.stores.filter((x) => x.is_active || x.id === s.storeId).map((x) => ({ value: x.id, label: `${x.store_code} — ${x.name}` }));
  const taxOptions = [...p.taxCodes.map((t) => ({ value: t.code, label: t.display })), { value: EXEMPT, label: EXEMPT_LABEL }];
  const supplierErr = errors.supplier ?? fieldMessage(problem, '/po_id') ?? fieldMessage(problem, '/supplier_id');

  return (
    <>
    <Form onSubmit={save} errorSummary={false}>
      <div ref={root} data-line-editor="">
        <Stack>
          <ProblemBanner problem={problem} />
          {mismatch !== undefined && saved && saved.supplier_invoice_total_paisa !== undefined ? (
            <Banner tone="warning" title={`Invoice total ${rs(saved.supplier_invoice_total_paisa)} differs from the calculated total ${rs(saved.total_paisa ?? 0)} by ${rs(Math.abs(mismatch))}.`} />
          ) : null}
          {canAdjust && !saved ? (
            <RadioGroup<GrnKind>
              label="Kind"
              name="kind"
              orientation="horizontal"
              options={[{ value: 'purchase', label: KIND_LABEL.purchase }, { value: 'opening_balance', label: KIND_LABEL.opening_balance }]}
              value={s.kind}
              onChange={(v) => setS((c) => ({ ...c, kind: v }))}
            />
          ) : null}
          {saved ? (
            // kind and store_id are fixed once a draft exists (PUT has neither), so Store is read-only text.
            <DescriptionList items={[{ term: 'Store', value: storeOptions.find((o) => o.value === s.storeId)?.label ?? '—' }]} />
          ) : (
            <Choice label="Store" name="store_id" options={storeOptions} value={s.storeId} error={errors.store ?? fieldMessage(problem, '/store_id')} onChange={(v) => setS((c) => ({ ...c, storeId: v }))} />
          )}
          {purchase ? (
            <Combobox<SupplierSummary>
              label="Supplier"
              name="supplier_id"
              loadOptions={async (q) => p.suppliers.filter((x) => x.is_active && `${x.supplier_code} ${x.name}`.toLowerCase().includes(q.toLowerCase())).slice(0, 20)}
              getKey={(x) => x.id}
              renderOption={(x) => `${x.supplier_code} — ${x.name}`}
              renderValue={(x) => `${x.supplier_code} — ${x.name}`}
              {...(s.supplier ? { value: s.supplier } : {})}
              {...(supplierErr ? { error: supplierErr } : {})}
              onChange={(x) => {
                setS((c) => ({ ...c, ...(x ? { supplier: x } : { supplier: undefined }) }));
                if (x) void loadSupplierItems(x.id, caches.current);
              }}
            />
          ) : null}
          <DateTimePicker label="Received at" name="received_at" {...(s.receivedAt ? { value: s.receivedAt } : {})} onChange={(v) => setS((c) => ({ ...c, ...(v ? { receivedAt: v } : { receivedAt: undefined }) }))} />
          {purchase ? (
            <>
              <TextField label="Supplier invoice no." name="supplier_invoice_no" maxLength={64} value={s.invNo} onChange={(v) => setS((c) => ({ ...c, invNo: v }))} />
              <DatePicker label="Invoice date" name="supplier_invoice_on" value={s.invOn} onChange={(v) => setS((c) => ({ ...c, ...(v ? { invOn: v } : { invOn: undefined }) }))} />
              {canCost ? <MoneyField label="Invoice total" name="supplier_invoice_total_paisa" {...(s.invTotal ? { value: s.invTotal } : {})} onChange={(v) => setS((c) => ({ ...c, ...(v ? { invTotal: v } : { invTotal: undefined }) }))} /> : null}
            </>
          ) : null}
          <TextArea label="Notes" name="notes" maxLength={1000} value={s.notes} onChange={(v) => setS((c) => ({ ...c, notes: v }))} />
          <ScanBox onValue={(v) => void onScan(v)} result={scanCard ? <p className="lims-description">{scanCard}</p> : null} />
          {s.lines.map((l, i) => {
            const e = errors.lines[l.key];
            const sl = showAmounts ? saved?.lines[i] : undefined;
            const itemErr = e?.item ?? serverLine(i, 'item_id');
            const packErr = e?.pack ?? serverLine(i, 'pack_id');
            const qtyErr = e?.qty ?? serverLine(i, 'qty_packs');
            const lotErr = e?.lot ?? serverLine(i, 'lot_no');
            const expiryErr = e?.expiry ?? serverLine(i, 'expiry_on');
            const taxErr = serverLine(i, 'tax_code');
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
                    <EnterNext>
                      {/* maxLength 80 > the contract's 64 on purpose: an over-long lot is refused with a message (LOT_NO) instead of being cut silently */}
                      <TextField label="Lot no." name={`lot_${l.key}`} maxLength={80} value={l.lotNo} {...(lotErr ? { error: lotErr } : {})} onChange={(v) => patch(l.key, { lotNo: v })} />
                    </EnterNext>
                    <DatePicker label="Expiry" name={`expiry_${l.key}`} value={l.expiry} {...(expiryErr ? { error: expiryErr } : {})} onChange={(v) => patch(l.key, { expiry: v })} />
                    <DatePicker label="Manufactured" name={`mfg_${l.key}`} value={l.mfg} onChange={(v) => patch(l.key, { mfg: v })} />
                    {canCost ? (
                      <>
                        <EnterNext>
                          <MoneyField label="Unit price" name={`price_${l.key}`} {...(l.price ? { value: l.price } : {})} onChange={(v) => patch(l.key, { price: v })} />
                        </EnterNext>
                        <EnterNext>
                          <MoneyField label="Discount" name={`discount_${l.key}`} {...(l.discount ? { value: l.discount } : {})} onChange={(v) => patch(l.key, { discount: v })} />
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
            <Button isDisabled={dirty} onPress={() => setConfirming(true)}>
              Post receipt
            </Button>
          </Inline>
        </Stack>
      </div>
    </Form>
    <ConfirmDialog
      title="Post receipt"
      body="Post this receipt? Stock will be added and the receipt can no longer be edited."
      confirmLabel="Post receipt"
      isOpen={confirming}
      onCancel={() => setConfirming(false)}
      onConfirm={post}
    />
    </>
  );
}
