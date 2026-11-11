// Patient domain helpers (02-TRD §3.1; US-FD-02.1, 02.2). Pure.
import { LimsError } from '../../../core/errors.js';

/** NFC, lower-case, trim, collapse any Unicode whitespace to one space. */
export function normaliseName(s: string): string {
  return s.normalize('NFC').toLowerCase().normalize('NFC').split(/\s+/u).filter(Boolean).join(' ');
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function parse(d: string): [number, number, number] {
  const m = DATE.exec(d);
  if (!m) throw new LimsError('common.validation_failed', 'date must be YYYY-MM-DD');
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** asOf minus N whole years; Feb 29 -> Feb 28 in a non-leap year. */
export function estimatedBirthOn(ageYears: number, asOf: string): string {
  // ponytail: 150-year cap is a sanity bound, not a spec value; tighten if the PRD names one.
  if (!Number.isInteger(ageYears) || ageYears < 0 || ageYears > 150) throw new LimsError('common.validation_failed', 'age must be an integer 0..150');
  const [y, m, d] = parse(asOf);
  const ty = y - ageYears;
  return `${pad(ty, 4)}-${pad(m)}-${pad(m === 2 && d === 29 && !isLeap(ty) ? 28 : d)}`;
}

/** Whole years between birthOn and asOf, e.g. "43 Years". */
export function ageDisplay(birthOn: string, asOf: string): string {
  const [by, bm, bd] = parse(birthOn);
  const [y, m, d] = parse(asOf);
  const years = y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
  return `${years} Years`;
}

export interface DedupeCandidate {
  readonly fullName: string; readonly birthOn: string; readonly phoneE164?: string | null; readonly anonymised?: boolean;
}

/** Same normalised name, birth year within ±1, same phone when both present; anonymised never matches. */
export function isDuplicateSuspect(a: DedupeCandidate, b: DedupeCandidate): boolean {
  if (a.anonymised || b.anonymised) return false;
  if (normaliseName(a.fullName) !== normaliseName(b.fullName)) return false;
  if (Math.abs(parse(a.birthOn)[0] - parse(b.birthOn)[0]) > 1) return false;
  return !(a.phoneE164 && b.phoneE164 && a.phoneE164 !== b.phoneE164);
}
