// C13.T19 pure display helpers (no UI, safe on server and client). Copy follows 04-UI-UX §6 and 03-APP-FLOW §3.
import type { Money, Patient } from './types';

const SEX: Record<string, string> = { male: 'M', female: 'F', other: 'O', unknown: 'U' };

/** "F 43 y" (04-UI-UX PM-2). Age from age_years, else from birth_on; sex letter alone when neither is known. */
export function sexAge(p: Patient | undefined, today = new Date()): string {
  if (!p) return '';
  const s = SEX[p.sex ?? ''] ?? '';
  let age = typeof p.age_years === 'number' ? p.age_years : undefined;
  if (age === undefined && p.birth_on && /^\d{4}-\d{2}-\d{2}$/.test(p.birth_on)) {
    const [y, m, d] = p.birth_on.split('-').map(Number) as [number, number, number];
    age = today.getUTCFullYear() - y - (today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d) ? 1 : 0);
  }
  return [s, age !== undefined && age >= 0 ? `${age} y` : ''].filter(Boolean).join(' ');
}

/** Test codes, first two then "+N" (04-UI-UX PM-2). */
export function codesText(codes: readonly string[], show = 2): string {
  const head = codes.slice(0, show).join(', ');
  return codes.length > show ? `${head} +${codes.length - show}` : head;
}

/** EDTA_WB -> "EDTA WB" (03-APP-FLOW §5 humanise fallback when no display text is given). */
export const humanise = (code: string | undefined) => (code ? code.replace(/[_-]+/g, ' ').trim() : '');

/** '2026-10' -> "October 2026" (A.D. month name + year, 04-UI-UX PS-1). */
export function monthLabel(ym: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(ym);
  if (!m) return ym;
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)));
}

/** Wire Money (snake_case) -> MoneyText value (camelCase). */
export const money = (m: Money | undefined) => ({ amountPaisa: Number.isFinite(m?.amount_paisa) ? (m!.amount_paisa as number) : 0, currency: 'NPR' as const });

/** "Rs. 1,12,956.78" lakh grouping for places that take a string (StatTile.value). */
export const lakh = (paisa: number) => `Rs. ${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paisa / 100)}`;

/** Page-level "is this a plain string" guard for values the API could in theory send as anything. */
export const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Calendar mode for DateText from PartnerContext.tenant.calendar_display (02-CV §13). */
export function calendarMode(v: string | undefined): 'AD' | 'BS' | 'AD_BS' | 'BS_AD' {
  const k = (v ?? '').toLowerCase();
  return k === 'bs' ? 'BS' : k === 'ad_bs' ? 'AD_BS' : k === 'bs_ad' ? 'BS_AD' : 'AD';
}
