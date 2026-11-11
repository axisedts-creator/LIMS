// Reference-range / critical-limit band selection (02-TRD §7.3 steps 1–7; 08 A17.1 age unknown). Pure functions, no I/O.
// Rows are the DB columns (05-SCHEMA reference_ranges / critical_limits / *_sets); dates are Date or ISO strings; low/high are decimal STRINGS (scale preserved).
// Age unknown = `ageDays` absent: birthOn is then ignored and only bands with BOTH age bounds absent match. Default timezone Asia/Kathmandu (08 A13 P-15).
type D = Date | string;
type Unit = 'day' | 'week' | 'month' | 'year';

export interface Band {
  id: string; sex: string; sort_order?: number | null; specimen_type_id?: string | null;
  age_low_value?: number | null; age_low_unit?: string | null; age_high_value?: number | null; age_high_unit?: string | null;
  kind?: string; low?: string | null; high?: string | null; normal_codes?: string[] | null; abnormal_codes?: string[] | null; display_text?: string | null;
}
export interface SetLike { status: string; effective_from?: D | null; effective_to?: D | null }
export interface RangeSet extends SetLike { id: string; version_no: number; unit_code?: string | null; method_id?: string | null; bands: Band[] }
export interface AnalyteVersionLike extends SetLike { unit_code?: string | null; method_id?: string | null }
export interface AgeQuery { ageDays?: number; birthOn?: string; at: D; timezone?: string }
export interface BandQuery extends AgeQuery { sex: string; specimenTypeId?: string }
export interface Age { days: number; weeks: number; months: number; years: number }

const TZ = 'Asia/Kathmandu';
const DAYS: Record<Unit, number> = { day: 1, week: 7, month: 30.4375, year: 365.25 };   // [CONV] day-count approximation, also the overlap unit (step 6)
const EFFECTIVE = ['published', 'superseded', 'retired'];
const ms = (d: D) => +new Date(d);

/** Calendar date (y, m, d) of an instant in a timezone. */
function localDate(at: D, timeZone: string): [number, number, number] {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return [Number(p['year']), Number(p['month']), Number(p['day'])];
}

/** Step 3. undefined = age unknown (ageDays absent). */
export function ageOf(q: AgeQuery): Age | undefined {
  const d = q.ageDays;
  if (d === undefined) return undefined;
  const approx: Age = { days: d, weeks: Math.floor(d / 7), months: Math.floor(d / DAYS.month), years: Math.floor(d / DAYS.year) };
  const b = q.birthOn === undefined ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(q.birthOn);
  if (!b) return approx;
  const [y2, m2, d2] = localDate(q.at, q.timezone ?? TZ);
  const [y1, m1, d1] = [Number(b[1]), Number(b[2]), Number(b[3])];
  const days = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
  if (days < 0) return approx;                                    // birthday after the `at` date: the caller's ageDays is all we have
  const months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
  return { days, weeks: Math.floor(days / 7), months, years: Math.floor(months / 12) };
}

/** Step 1 (and the analyte-version lookup of step 2): effective_from <= at < coalesce(effective_to, +inf); published / superseded / retired only. */
export function selectSet<T extends SetLike>(sets: readonly T[], at: D): T | undefined {
  const t = ms(at);
  return sets.filter((s) => EFFECTIVE.includes(s.status) && s.effective_from != null && ms(s.effective_from) <= t && (s.effective_to == null || t < ms(s.effective_to)))
    .sort((a, b) => ms(b.effective_from!) - ms(a.effective_from!))[0];
}

const ageIn = (a: Age, unit: string) => (unit === 'day' ? a.days : unit === 'week' ? a.weeks : unit === 'month' ? a.months : a.years);
const unrestricted = (b: Band) => b.age_low_value == null && b.age_high_value == null;
const score = (b: Band) => (b.specimen_type_id != null ? 2 : 0) + (b.sex !== 'any' ? 1 : 0);

function matches(b: Band, q: BandQuery, age: Age | undefined): boolean {
  if (b.sex !== 'any' && b.sex !== q.sex) return false;
  if (b.specimen_type_id != null && b.specimen_type_id !== q.specimenTypeId) return false;   // a query without a specimen matches only unspecific bands
  if (age === undefined) return unrestricted(b);
  if (b.age_low_value != null && ageIn(age, b.age_low_unit!) < b.age_low_value) return false;
  if (b.age_high_value != null && ageIn(age, b.age_high_unit!) >= b.age_high_value) return false;
  return true;
}

/** Steps 3–5: the winning band (highest specificity; ties by sort_order, then id) or undefined. */
export function selectBand<T extends Band>(bands: readonly T[], q: BandQuery): T | undefined {
  const age = ageOf(q);
  return bands.filter((b) => matches(b, q, age))
    .sort((a, b) => score(b) - score(a) || (a.sort_order ?? 100) - (b.sort_order ?? 100) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

/** Step 6: index pairs [i, j] (i < j) of bands with equal (sex, specimen) whose age intervals [low, high) overlap, compared in days. */
export function findOverlaps(bands: readonly Band[]): Array<[number, number]> {
  const win = (b: Band): [number, number] => [b.age_low_value == null ? 0 : b.age_low_value * DAYS[b.age_low_unit as Unit], b.age_high_value == null ? Infinity : b.age_high_value * DAYS[b.age_high_unit as Unit]];
  const out: Array<[number, number]> = [];
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const a = bands[i]!, b = bands[j]!;
      if (a.sex !== b.sex || (a.specimen_type_id ?? null) !== (b.specimen_type_id ?? null)) continue;
      const [al, ah] = win(a), [bl, bh] = win(b);
      if (al < bh && bl < ah) out.push([i, j]);
    }
  }
  return out;
}

interface Resolve<S> { sets: readonly S[]; versions: readonly AnalyteVersionLike[]; query: BandQuery }
/** Steps 1–2: the set effective at `at`, provided the analyte version effective then carries the same unit / method snapshot (null = null). */
function setFor<S extends RangeSet>({ sets, versions, query }: Resolve<S>): S | undefined {
  const set = selectSet(sets, query.at);
  const v = set && selectSet(versions, query.at);
  if (!set || !v) return undefined;
  return (set.unit_code ?? null) === (v.unit_code ?? null) && (set.method_id ?? null) === (v.method_id ?? null) ? set : undefined;
}
const opt = <K extends string, V>(k: K, v: V | null | undefined) => (v == null ? {} : { [k]: v } as Record<K, V>);

/** Step 7. kind 'text' / 'ordinal' carry display text only — the consumer must not compute a flag from numbers. */
export function resolveReferenceRange(r: Resolve<RangeSet>) {
  const set = setFor(r);
  const b = set && selectBand(set.bands, r.query);
  if (!set || !b) return undefined;
  const numeric = (b.kind ?? 'numeric') === 'numeric';
  const gen = b.low != null && b.high != null ? `${b.low} - ${b.high}` : b.high != null ? `< ${b.high}` : b.low != null ? `> ${b.low}` : undefined;
  return {
    referenceRangeId: b.id, version: set.version_no, kind: b.kind ?? 'numeric', ...opt('unitCode', set.unit_code),
    ...(numeric ? { ...opt('low', b.low), ...opt('high', b.high) } : {}), ...opt('text', b.display_text ?? (numeric ? gen : undefined)), ...opt('normalCodes', b.normal_codes),
  };
}

export function resolveCriticalLimits(r: Resolve<RangeSet>) {
  const set = setFor(r);
  const b = set && selectBand(set.bands, r.query);
  if (!set || !b) return undefined;
  return { criticalLimitId: b.id, version: set.version_no, ...opt('low', b.low), ...opt('high', b.high), ...opt('abnormalCodes', b.abnormal_codes) };
}
