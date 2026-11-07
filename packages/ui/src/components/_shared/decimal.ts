// String-only decimal and money helpers. Values never pass through a float (DecimalString / integer paisa).

export const isDecimal = (s: string): boolean => /^-?\d+(\.\d+)?$/.test(s);

export function fractionDigits(s: string): number {
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/** Compare two decimal strings: -1, 0 or 1. Inputs must pass isDecimal. */
export function cmpDecimal(a: string, b: string): number {
  const neg = (s: string) => s.startsWith('-') && /[1-9]/.test(s);
  const na = neg(a);
  const nb = neg(b);
  if (na !== nb) return na ? -1 : 1;
  const [ai = '', af = ''] = a.replace('-', '').split('.');
  const [bi = '', bf = ''] = b.replace('-', '').split('.');
  const ia = ai.replace(/^0+(?=\d)/, '');
  const ib = bi.replace(/^0+(?=\d)/, '');
  const w = Math.max(af.length, bf.length);
  const ka = ia.padStart(Math.max(ia.length, ib.length), '0') + af.padEnd(w, '0');
  const kb = ib.padStart(Math.max(ia.length, ib.length), '0') + bf.padEnd(w, '0');
  const r = ka === kb ? 0 : ka < kb ? -1 : 1;
  return na ? -r : r;
}

/** Pad a decimal string with trailing zeros up to `decimals`; never rounds or truncates. Non-decimals pass through. */
export function padDecimal(s: string, decimals: number): string {
  if (!isDecimal(s) || decimals <= 0) return s;
  const f = fractionDigits(s);
  if (f >= decimals) return s;
  return (f === 0 ? s + '.' : s) + '0'.repeat(decimals - f);
}

const group = (digits: string, style: 'lakh' | 'international'): string => {
  if (style === 'international' || digits.length <= 3) return digits.replace(/\B(?=(\d{3})+$)/g, ',');
  const head = digits.slice(0, -3);
  return head.replace(/\B(?=(\d{2})+$)/g, ',') + ',' + digits.slice(-3);
};

/** Integer paisa -> "12,34,567.89" (no currency symbol). */
export function formatPaisa(paisa: number, grouping: 'lakh' | 'international' = 'lakh'): string {
  if (!Number.isSafeInteger(paisa)) return String(paisa);
  const neg = paisa < 0;
  const s = String(Math.abs(paisa)).padStart(3, '0');
  return (neg ? '-' : '') + group(s.slice(0, -2), grouping) + '.' + s.slice(-2);
}

/** "1,234.5" -> 123450 paisa; undefined when not a money amount with at most 2 decimals. */
export function parseRupees(text: string): number | undefined {
  const t = text.replace(/,/g, '');
  const m = /^(-?)(\d*)(?:\.(\d{0,2}))?$/.exec(t);
  if (!m || (m[2] === '' && !m[3])) return undefined;
  const v = Number(m[2] || '0') * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(v)) return undefined;
  return m[1] && v !== 0 ? -v : v;
}
