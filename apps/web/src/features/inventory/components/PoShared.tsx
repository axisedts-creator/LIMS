'use client';
// Shared pieces of the purchasing (S6) and receiving (S7) screens: line-editor keyboard flows, scan box, status chips, item defaults, money text.
// LD-140 (2026-11-13): kit components and token names only; every status shows tone + icon + word.
// Keyboard (04-UI-UX §2): Alt+L adds a line and focuses its Item field, Ctrl+Delete removes the focused line, Enter in a field moves to the next field, Ctrl+Enter submits (kit Form).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { BarcodeInput } from '@lims/ui/components/BarcodeInput';
import type { Money } from '@lims/ui/components/MoneyField';
import { getItemDetailAction, searchItemsAction, supplierItemsAction } from '../server/actions';
import type { CodedValue, GrnStatus, Item, ItemSummary, Pack, PoStatus, SupplierItem } from '../server/types';
import { Chip, isStepUp, Pick, type Failure } from './shared';

/** Lot numbers and scanned supplier barcodes: visible ASCII only (contract pattern ^[\x21-\x7E]{1,64}$). */
export const LOT_NO = /^[\x21-\x7E]{1,64}$/;
export const SCAN_UNKNOWN = 'This barcode is not linked to an item. Link it from the item page.';
/** Select value for "no tax code, is_exempt: true" (08 A4.1, A17 D-70). */
export const EXEMPT = '__exempt__';
export const EXEMPT_LABEL = 'Exempt (no tax code)';

const GROUP = /\B(?=(\d{2})+(?!\d))/g;
/** "Rs. 12,34,567.89" for sentences (banners, toasts). Cells use the kit MoneyText. */
export function rs(paisa: number): string {
  const a = Math.abs(paisa);
  const whole = String(Math.floor(a / 100));
  const head = whole.slice(0, -3);
  const grouped = head ? `${head.replace(GROUP, ',')},${whole.slice(-3)}` : whole;
  return `${paisa < 0 ? '-' : ''}Rs. ${grouped}.${String(a % 100).padStart(2, '0')}`;
}
export const money = (paisa: number | undefined): Money | undefined => (paisa === undefined ? undefined : { amountPaisa: paisa, currency: 'NPR' });
/** "VAT 13%" from the line's rate snapshot (tax_rate_bp is basis points). */
export const taxText = (code: string | undefined, bp: number | undefined, tax: readonly CodedValue[]) =>
  code ? `${tax.find((t) => t.code === code)?.display ?? code}${bp === undefined ? '' : ` ${String(bp / 100)}%`}` : EXEMPT_LABEL;

/** Open base quantity as packs, 3 decimals, trailing zeros trimmed ("400" open / pack of 400 = "1"). A quantity conversion, not a money amount. */
export function packsOf(baseQty: string, qtyInBase: string | undefined): string {
  const per = Number(qtyInBase);
  return per > 0 ? String(Math.round((Number(baseQty) / per) * 1000) / 1000) : baseQty;
}
/** DecimalStringPacks: > 0, at most 9 integer digits and 3 decimals. */
export function packsError(text: string | undefined): string | undefined {
  const t = (text ?? '').trim();
  if (t === '') return 'Qty packs is required';
  if (!/^\d{1,9}(\.\d{1,3})?$/.test(t) || Number(t) <= 0) return 'Qty packs must be greater than 0, with at most 9 digits and 3 decimals';
  return undefined;
}

export const PO_TONE: Record<PoStatus, { tone: 'neutral' | 'info' | 'success' | 'warning'; label: string }> = {
  draft: { tone: 'neutral', label: 'Draft' },
  approved: { tone: 'info', label: 'Approved' },
  sent: { tone: 'info', label: 'Sent' },
  partially_received: { tone: 'warning', label: 'Partially received' },
  received: { tone: 'success', label: 'Received' },
  closed: { tone: 'neutral', label: 'Closed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
};
export const PoStatusChip = ({ status }: { status: PoStatus }) => <Chip tone={PO_TONE[status]?.tone ?? 'neutral'} label={PO_TONE[status]?.label ?? status} />;
const GRN_TONE: Record<GrnStatus, { tone: 'neutral' | 'success'; label: string }> = { draft: { tone: 'neutral', label: 'Draft' }, posted: { tone: 'success', label: 'Posted' }, cancelled: { tone: 'neutral', label: 'Cancelled' } };
export const GrnStatusChip = ({ status }: { status: GrnStatus }) => <Chip tone={GRN_TONE[status]?.tone ?? 'neutral'} label={GRN_TONE[status]?.label ?? status} />;
export const KIND_LABEL = { purchase: 'Purchase', opening_balance: 'Opening balance' } as const;

/**
 * A select that may show a DEFAULT before the user picks: the default is the placeholder ("Store — Main store"), so the control keeps its
 * label in its accessible name (the kit Select names itself "<value> <label>"). After a pick the chosen value is the real value.
 */
export function Choice({ label, name, options, value, onChange, error, isRequired }: { label: string; name: string; options: readonly { value: string; label: string }[]; value: string | undefined; onChange: (v: string) => void; error?: string | undefined; isRequired?: boolean }) {
  const [picked, setPicked] = useState(false);
  const shown = options.find((o) => o.value === value)?.label;
  return (
    <Pick
      label={label}
      name={name}
      options={options}
      value={picked ? value : undefined}
      {...(!picked && shown ? { placeholder: `${label} — ${shown}` } : {})}
      error={error}
      {...(isRequired ? { isRequired: true } : {})}
      onChange={(v) => {
        setPicked(true);
        onChange(v);
      }}
    />
  );
}

/** Keyboard flows of a line editor, bound to the document while the editor is mounted (a nested dialog on top disables them). */
export function useLineKeys(root: RefObject<HTMLElement | null>, add: () => void, remove: (lineKey: number) => void) {
  const latest = useRef({ add, remove });
  latest.current = { add, remove };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const r = root.current;
      if (!r) return;
      const frame = r.closest('[role="dialog"]') ?? r;
      const a = document.activeElement;
      if (a && a !== document.body && !frame.contains(a)) return;
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyL' || e.key.toLowerCase() === 'l')) {
        e.preventDefault();
        latest.current.add();
      } else if (e.ctrlKey && e.key === 'Delete') {
        const line = a instanceof Element ? a.closest('[data-line]') : null;
        if (line && r.contains(line)) {
          e.preventDefault();
          latest.current.remove(Number(line.getAttribute('data-line')));
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [root]);
}

/** Moves focus to the next field of the editor on Enter (Ctrl+Enter still submits the form). */
export function EnterNext({ children }: { children: ReactNode }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey || !(e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    const fields = [...(e.currentTarget.closest('[data-line-editor]')?.querySelectorAll<HTMLInputElement>('input:not([type="hidden"]):not([disabled]):not([readonly])') ?? [])];
    fields[fields.indexOf(e.target) + 1]?.focus();
  };
  return <div onKeyDown={onKeyDown}>{children}</div>;
}

/** Returns a setter: after the render that follows, focus goes to the Item field (or the Qty field) of that line. */
export function useFocusLine(root: RefObject<HTMLElement | null>) {
  const [req, setReq] = useState<{ key: number; qty?: boolean }>();
  useEffect(() => {
    if (!req) return;
    root.current?.querySelector<HTMLInputElement>(`[data-line="${req.key}"] ${req.qty ? 'input[inputmode="decimal"]' : 'input'}`)?.focus();
    setReq(undefined);
  }, [req, root]);
  return setReq;
}
/** Idempotency-Key policy for lifecycle calls: keep it when the outcome is unknown (5xx) or nothing was done (step-up, then the same call is retried); any other failure gets a new key. */
export const keepKey = (f: Failure) => isStepUp(f) || f.status >= 500;
/** Quantity plus one pack, 3 decimals. */
export const plusOne = (q: string | undefined) => String(Math.round((Number(q || '0') + 1) * 1000) / 1000);

/**
 * "Scan or type barcode" (04-UI-UX §2.4). The value goes to the lookup call's BODY only, never a URL or a log (REQ-SEC-098).
 * The kit upper-cases what it reports; supplier pack barcodes are case-sensitive visible ASCII, so the text as typed is passed on when it differs only in case.
 */
export function ScanBox({ onValue }: { onValue: (v: string) => void }) {
  const typed = useRef<string>('');
  const box = useRef<HTMLDivElement>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (round) box.current?.querySelector('input')?.focus();
  }, [round]);
  return (
    <div
      ref={box}
      onKeyDownCapture={(e) => {
        if ((e.key === 'Enter' || e.key === 'Tab') && e.target instanceof HTMLInputElement) typed.current = e.target.value.trim();
      }}
    >
      <BarcodeInput
        key={round}
        label="Scan or type barcode"
        name="scan"
        pattern={LOT_NO}
        autoFocus={false}
        clearAfterScan
        onScan={(v) => {
          const raw = typed.current;
          typed.current = '';
          // a fresh input per scan: scanning the same pack again is a deliberate "one more pack", not a double read
          setRound((n) => n + 1);
          onValue(raw && raw.toUpperCase() === v ? raw : v);
        }}
      />
    </div>
  );
}

export interface ItemDefaults { packs: Pack[]; packId?: string; tax?: string; price?: Money }
/** Item details and supplier items already fetched by this editor (the search warms the first hits, choosing a supplier warms its items). */
export interface ItemCaches { items: Map<string, Item>; supplier: Map<string, SupplierItem[]> }
export const newCaches = (): ItemCaches => ({ items: new Map(), supplier: new Map() });

/** F-04 step 2: purchase-default pack, last supplier price and tax code once an item is chosen (supplier item first, then the item, then the first tax code). */
function defaultsFrom(full: Item | undefined, sis: readonly SupplierItem[], itemId: string, tax: readonly CodedValue[], canCost: boolean): ItemDefaults {
  const packs = (full?.packs ?? []).filter((p) => p.is_active);
  const mine = sis.filter((s) => s.item_id === itemId);
  const pack = packs.find((p) => mine.some((s) => s.pack_id === p.id)) ?? packs.find((p) => p.is_purchase_default) ?? packs[0];
  const si = mine.find((s) => s.pack_id === pack?.id);
  const code = si?.default_tax_code ?? full?.default_tax_code ?? tax[0]?.code;
  return {
    packs,
    ...(pack ? { packId: pack.id } : {}),
    ...(canCost && code ? { tax: code } : {}),
    ...(canCost && si?.last_unit_price_paisa !== undefined ? { price: { amountPaisa: si.last_unit_price_paisa, currency: 'NPR' as const } } : {}),
  };
}
async function loadItem(id: string, c: ItemCaches): Promise<Item | undefined> {
  const hit = c.items.get(id);
  if (hit) return hit;
  const r = await getItemDetailAction(id);
  if (r.ok) c.items.set(id, r.data);
  return r.ok ? r.data : undefined;
}
export async function loadSupplierItems(supplierId: string, c: ItemCaches): Promise<SupplierItem[]> {
  const hit = c.supplier.get(supplierId);
  if (hit) return hit;
  const r = await supplierItemsAction(supplierId);
  const list = r.ok ? r.data : [];
  c.supplier.set(supplierId, list);
  return list;
}
/** Defaults at once when the item and its supplier items are cached, otherwise undefined (then use itemDefaults). */
export function cachedDefaults(item: ItemSummary, supplierId: string | undefined, c: ItemCaches, tax: readonly CodedValue[], canCost: boolean): ItemDefaults | undefined {
  const full = c.items.get(item.id);
  if (!full || (supplierId && !c.supplier.has(supplierId))) return undefined;
  return defaultsFrom(full, supplierId ? (c.supplier.get(supplierId) ?? []) : [], item.id, tax, canCost);
}
export async function itemDefaults(item: ItemSummary, supplierId: string | undefined, c: ItemCaches, tax: readonly CodedValue[], canCost: boolean): Promise<ItemDefaults> {
  const [full, sis] = await Promise.all([loadItem(item.id, c), supplierId ? loadSupplierItems(supplierId, c) : Promise.resolve([])]);
  return defaultsFrom(full, sis, item.id, tax, canCost);
}
/** Item picker search (active items, code or name prefix); the details of the first hits are fetched with it so a pick applies its defaults without a wait. */
export async function searchItems(q: string, c: ItemCaches): Promise<ItemSummary[]> {
  const r = await searchItemsAction(q);
  const list = r.ok ? r.data : [];
  await Promise.all(list.slice(0, 3).map((i) => loadItem(i.id, c)));
  return list;
}
