// Field patterns and limits copied verbatim from contracts/openapi/inventory.yaml / 04-UI-UX §3 so the forms reject what the API rejects.
import type { AlertKind, AlertStatus } from '../server/types';

export const ITEM_CODE = String.raw`^[A-Z0-9][A-Z0-9_.\-]{0,31}$`;
export const PACK_CODE = String.raw`^[A-Z0-9_]{1,16}$`;
export const STORE_CODE = String.raw`^[A-Z0-9][A-Z0-9_\-]{0,15}$`; // supplier_code uses the same pattern
export const HS_CODE = String.raw`^[0-9]{4,10}$`;
export const PAN_TEXT = String.raw`^[A-Za-z0-9]{1,20}$`;
export const BARCODE_VALUE = /^[\x21-\x7E]{1,64}$/;

export const CATEGORIES = [
  { value: 'reagent', label: 'Reagent' },
  { value: 'kit', label: 'Kit' },
  { value: 'consumable', label: 'Consumable' },
  { value: 'control', label: 'Control' },
  { value: 'calibrator', label: 'Calibrator' },
  { value: 'other', label: 'Other' },
] as const;
export const STORAGE = [
  { value: 'ambient', label: 'Ambient' },
  { value: 'refrigerated', label: 'Refrigerated' },
  { value: 'frozen', label: 'Frozen' },
  { value: 'other', label: 'Other' },
] as const;
export const STORE_KINDS = [
  { value: 'main', label: 'Main' },
  { value: 'bench', label: 'Bench' },
  { value: 'other', label: 'Other' },
] as const;

// 04-UI-UX §3 S16 kind labels (one per alert_kind enum value, in contract order) and the status words with their tone.
export const ALERT_KIND_LABEL: Record<AlertKind, string> = {
  below_reorder: 'Below reorder level',
  expiry_soon: 'Expiring soon',
  expired_on_hand: 'Expired stock on hand',
  open_stability_exceeded: 'Open container past stability',
  negative_stock: 'Stock below zero',
  unresolved_consumption: 'Waiting consumption',
  expired_lot_in_use: 'Expired lot in use',
  balance_drift: 'Stock record mismatch',
  reconciliation_gap: 'Counts differ from lab',
};
export const ALERT_STATUS_CHIP: Record<AlertStatus, { label: string; tone: 'warning' | 'info' | 'success' }> = {
  open: { label: 'Open', tone: 'warning' },
  acknowledged: { label: 'Acknowledged', tone: 'info' },
  resolved: { label: 'Resolved', tone: 'success' },
};

/** Select sentinel for "no value" on optional coded fields. */
export const NONE: string = 'none';
export const label = (list: readonly { value: string; label: string }[], v: string | undefined) => list.find((x) => x.value === v)?.label ?? v ?? '';

const re = (p: string) => new RegExp(p);
/** Whole-number text within [min, max]; '' is allowed (optional field). Returns an error message or undefined. */
export function intText(label: string, text: string, min: number, max: number): string | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  if (!/^\d{1,6}$/.test(t)) return `${label} must be a whole number between ${min} and ${max}`;
  const n = Number(t);
  return n >= min && n <= max ? undefined : `${label} must be between ${min} and ${max}`;
}
export function patternText(label: string, text: string, pattern: string, hint: string): string | undefined {
  return text === '' || re(pattern).test(text) ? undefined : `${label}: ${hint}`;
}
