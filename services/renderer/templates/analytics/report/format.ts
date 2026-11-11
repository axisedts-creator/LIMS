// Cell formatting for analytics.report (02-TRD §10.2 step 6a): paisa -> lakh grouping with 2 decimals, seconds -> duration, bp -> one-decimal percent.
// Integer arithmetic only (no float maths on money). Pure; every function throws a data-free Error on a non-integer input (-> HTTP 422).
const intOf = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Error('analytics.report: numeric cell must be an integer');
  return v;
};

/** 1234567 -> "12,34,567" (last three digits, then groups of two). */
const lakh = (digits: string): string => {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${head},${digits.slice(-3)}`;
};

export const fmtCount = (v: unknown): string => String(intOf(v));

export const fmtPaisa = (v: unknown): string => {
  const n = intOf(v);
  const a = Math.abs(n);
  const paise = String(a % 100).padStart(2, '0');
  return `${n < 0 ? '-' : ''}${lakh(String(Math.floor(a / 100)))}.${paise}`;
};

/** < 48 h: "<h> h <m> min" (hours omitted when 0); >= 48 h: "<d> d <h> h". Seconds below a minute are dropped. */
export const fmtSeconds = (v: unknown): string => {
  const n = intOf(v);
  const a = Math.abs(n);
  const minutes = Math.floor(a / 60);
  const hours = Math.floor(minutes / 60);
  const body = hours >= 48 ? `${Math.floor(hours / 24)} d ${hours % 24} h` : hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
  return n < 0 ? `-${body}` : body;
};

/** Basis points -> percent with one decimal, half-up on the tenth: 1234 -> "12.3%", 7 -> "0.1%". */
export const fmtBp = (v: unknown): string => {
  const n = intOf(v);
  const tenths = Math.floor((Math.abs(n) + 5) / 10);
  return `${n < 0 && tenths > 0 ? '-' : ''}${Math.floor(tenths / 10)}.${tenths % 10}%`;
};
