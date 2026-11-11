// 02-TRD §3.2: the ONLY importer of the raw B.S. library (04 D13, AC-0A-3.4).
import DateConverter from '@remotemerge/nepali-date-converter';

export type Ymd = { year: number; month: number; day: number };

const pad = (n: number, w: number): string => String(n).padStart(w, '0');
const text = (y: number, m: number, d: number): string => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;

/** B.S. -> A.D., or null when the library rejects the input (bad day or outside its table). */
export function rawBsToAd(y: number, m: number, d: number): Ymd | null {
  try {
    const r = new DateConverter(text(y, m, d)).toAd();
    return { year: r.year, month: r.month, day: r.date };
  } catch {
    return null;
  }
}

/** A.D. -> B.S., or null when outside the library's table. */
export function rawAdToBs(y: number, m: number, d: number): Ymd | null {
  try {
    const r = new DateConverter(text(y, m, d)).toBs();
    return { year: r.year, month: r.month, day: r.date };
  } catch {
    return null;
  }
}
