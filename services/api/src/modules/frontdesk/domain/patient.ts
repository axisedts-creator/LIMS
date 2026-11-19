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

// T0B-REGAPI-1 (LD-310): the 249 officially assigned ISO 3166-1 alpha-2 codes. A static list on purpose: Intl.DisplayNames knows ZZ, EU, UN, QO... as regions.
const ISO_ALPHA2 = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK '
  + 'CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN '
  + 'HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP '
  + 'MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ '
  + 'SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));
export const isIsoCountry = (v: unknown): boolean => typeof v === 'string' && ISO_ALPHA2.has(v);
/** Nepal postal codes are exactly 5 digits (e.g. 44600); other countries: free text (LD-310 pick). */
export const isNpPostalCode = (v: string): boolean => /^[0-9]{5}$/.test(v);
