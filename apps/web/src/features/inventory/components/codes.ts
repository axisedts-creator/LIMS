// Field patterns and limits copied verbatim from contracts/openapi/inventory.yaml / 04-UI-UX §3 so the forms reject what the API rejects.
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
