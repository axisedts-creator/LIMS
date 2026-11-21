// T0D-PRICETOOLS-1 (LD-321): integer money helpers of the price list tools (Bulk update preview, Copy to percent, Compare CSV). Paisa end to end, never floats: text is parsed by pattern, results are
// computed in units of 1/10000 paisa and rounded half up exactly as bulkUpdatePriceListDraft does on the server.
export type Rounding = 'none' | 'nearest_rupee' | 'nearest_5' | 'nearest_10';
export const ROUNDINGS: readonly Rounding[] = ['none', 'nearest_rupee', 'nearest_5', 'nearest_10'];

const PERCENT_RE = /^(-?)(\d{1,4})(?:\.(\d{1,2}))?$/;
const AMOUNT_RE = /^(-?)(\d{1,7})(?:\.(\d{1,2}))?$/;
const digits2 = (s: string | undefined) => Number((s ?? '').padEnd(2, '0'));

/** "12.5" -> 1250 basis points; -100 .. 1000 percent with at most 2 decimals, else undefined. */
export function parsePercentBp(text: string): number | undefined {
  const m = PERCENT_RE.exec(text.trim());
  if (!m) return undefined;
  const bp = (Number(m[2]) * 100 + digits2(m[3])) * (m[1] ? -1 : 1);
  return bp >= -10_000 && bp <= 100_000 ? bp || 0 : undefined;
}

/** "-50.25" -> -5025 paisa (signed rupees, at most 7 digits and 2 decimals), else undefined. */
export function parseAmountPaisa(text: string): number | undefined {
  const m = AMOUNT_RE.exec(text.trim());
  if (!m) return undefined;
  return ((Number(m[2]) * 100 + digits2(m[3])) * (m[1] ? -1 : 1)) || 0;
}

/** Signed paisa (or basis points) as "1234.50" / "-0.01": two decimals, integer maths only. */
export function fmt2(n: number): string {
  const a = Math.abs(n);
  const cents = a % 100;
  return `${n < 0 ? '-' : ''}${(a - cents) / 100}.${String(cents).padStart(2, '0')}`;
}

const STEP: Record<Rounding, number> = { none: 1, nearest_rupee: 100, nearest_5: 500, nearest_10: 1000 }; // in paisa
const SCALE = 10_000; // 1 basis point of a paisa

export type Change = { kind: 'percent'; bp: number } | { kind: 'fixed_amount'; paisa: number };

/** The new price in paisa (may be negative: the caller refuses it, as the server does). Half up on the exact value. */
export function applyChange(paisa: number, c: Change, rounding: Rounding): number {
  const exact = c.kind === 'percent' ? paisa * (SCALE + c.bp) : (paisa + c.paisa) * SCALE; // < 2^53 for prices up to 9,999,999.99
  if (exact < 0) return -1;
  const step = STEP[rounding] * SCALE;
  const up = exact + step / 2;
  return (up - (up % step)) / SCALE;
}

/** One CSV cell: text that a spreadsheet would run as a formula gets a leading apostrophe; quotes are doubled. Numbers pass as they are. */
export function csvCell(v: string, isText: boolean): string {
  const s = isText && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Hand a Blob to the browser as a download (anchor + object URL; nothing leaves the page). */
export function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const saveBase64 = (name: string, base64: string) => saveBlob(name, new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: XLSX }));
