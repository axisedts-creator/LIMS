// C9 T-22 field rules, copied from 04-UI-UX §2.6 and contracts/openapi/quality.yaml. Pure: used by the forms (early feedback) AND by the server actions (the real check).
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MATERIAL_CODE = /^[A-Z0-9_-]{2,32}$/;
export const LEVEL_CODE = /^[A-Za-z0-9]{1,16}$/;
/** Printable ASCII, no leading or trailing space (02-TRD #8; same pattern as the API and DB). */
export const LOT_NO = /^[\x21-\x7e](?:[\x20-\x7e]{0,62}[\x21-\x7e])?$/;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export const UNIT = /^[A-Za-z0-9][A-Za-z0-9_./%-]{0,31}$/;
export const KEY = /^[A-Za-z0-9_-]{1,64}$/;
export const DECIMAL = /^\d+(\.\d+)?$/;

/** Read permissions of the C7 / C3 pickers (x-permission in instruments.yaml / catalog.yaml). Without one the picker is a plain id field and no request is made. */
export const PICK = { instruments: 'instruments.instrument.read', tests: 'catalog.test.read' } as const;

export const MSG = {
  duplicate: 'This code is already used.',
  lotNo: 'Use printable characters without spaces at the start or end.',
  expired: 'Expiry date is in the past.',
  required: (what: string) => `${what} is required`,
  uuid: (what: string) => `${what} must be an id like 01a1a98a-ac40-7000-8000-000000000000`,
} as const;

export type Errors = Record<string, string>;
const has = (e: Errors) => Object.keys(e).length > 0;

// ---------------------------------------------------------------- materials, lots
export interface MaterialInput { code: string; name: string; manufacturer?: string; matrix?: string; levels: { level_code: string; display_name: string; sort_order: number }[] }
export function validateMaterial(v: MaterialInput): Errors {
  const e: Errors = {};
  if (!MATERIAL_CODE.test(v.code)) e['code'] = 'Use 2–32 capital letters, digits, "-" or "_".';
  if (v.name.trim().length < 1 || v.name.length > 120) e['name'] = 'Enter a name of 1–120 characters.';
  if ((v.manufacturer?.length ?? 0) > 120) e['manufacturer'] = 'Use at most 120 characters.';
  if ((v.matrix?.length ?? 0) > 60) e['matrix'] = 'Use at most 60 characters.';
  if (v.levels.length < 1 || v.levels.length > 6) e['levels'] = 'Add 1–6 levels.';
  const seen = new Set<string>();
  v.levels.forEach((l, i) => {
    if (!LEVEL_CODE.test(l.level_code)) e[`level.${i}.code`] = 'Use 1–16 letters or digits.';
    else if (seen.has(l.level_code.toLowerCase())) e[`level.${i}.code`] = 'Level codes must be different.';
    seen.add(l.level_code.toLowerCase());
    if (l.display_name.trim().length < 1 || l.display_name.length > 60) e[`level.${i}.name`] = 'Enter a name of 1–60 characters.';
    if (!Number.isInteger(l.sort_order) || l.sort_order < 0 || l.sort_order > 99) e[`level.${i}.sort`] = 'Use a number from 0 to 99.';
  });
  return e;
}

/** Calendar date of "now" in the tenant zone (Asia/Kathmandu, CV §4.8). */
export const todayLocal = (at = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));

export function validateLot(v: { lot_no: string; expires_on: string | undefined }, today = todayLocal()): Errors {
  const e: Errors = {};
  if (!LOT_NO.test(v.lot_no)) e['lot_no'] = MSG.lotNo;
  if (!v.expires_on || !ISO_DATE.test(v.expires_on)) e['expires_on'] = MSG.required('Expiry date');
  else if (v.expires_on < today) e['expires_on'] = MSG.expired; // the server is the authority on "today" (tenant timezone)
  return e;
}

// ---------------------------------------------------------------- id maps
export interface MapInput { instrument_id: string; control_id_raw: string; control_lot_raw?: string; lot_id: string }
export function validateMap(v: { instrument_id: string | undefined; control_id_raw: string; control_lot_raw: string; lot_id: string | undefined }): Errors {
  const e: Errors = {};
  if (!v.instrument_id) e['instrument'] = MSG.required('Instrument');
  else if (!UUID.test(v.instrument_id)) e['instrument'] = MSG.uuid('Instrument ID');
  if (v.control_id_raw.length < 1 || v.control_id_raw.length > 64) e['control_id'] = 'Enter the control id, up to 64 characters.';
  if (v.control_lot_raw.length > 64) e['control_lot'] = 'Use at most 64 characters.';
  if (!v.lot_id) e['lot'] = MSG.required('Lot');
  return e;
}

// ---------------------------------------------------------------- plans
export const N_VALUES = ['2', '3', '4'] as const;
export const meanRules = (n: number): readonly string[] => (n === 3 ? ['6x', '9x'] : ['8x', '10x', '12x']);
export const defaultMeanRule = (n: number) => (n === 3 ? '6x' : '10x');
/** 02-TRD §5.3: the rule set that a plan with N controls per run and this n-x rule evaluates. */
export const ruleSetText = (n: number, meanRule: string) => `1-2s warning; reject on ${(n === 3 ? ['1-3s', '2of3-2s', 'R-4s', '3-1s'] : ['1-3s', '2-2s', 'R-4s', '4-1s']).concat(meanRule).join(', ')}`;

const intIn = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
export function validatePlanParams(p: {
  controls_per_run: number; composition: { level_id: string | undefined; count: number | undefined }[]; mean_rule: string;
  run_window_minutes?: number | undefined; qc_validity_hours?: number | undefined; hold_lookback_hours?: number | undefined;
}): Errors {
  const e: Errors = {};
  const n = p.controls_per_run;
  if (![2, 3, 4].includes(n)) e['n'] = 'Choose 2, 3 or 4 controls per run.';
  if (!meanRules(n).includes(p.mean_rule)) e['mean_rule'] = 'Choose an n-x rule that fits N.';
  const rows = p.composition;
  if (rows.length < 1 || rows.length > 4) e['composition'] = 'Add 1–4 levels.';
  else if (rows.some((r) => !r.level_id)) e['composition'] = 'Choose a level in every row.';
  else if (new Set(rows.map((r) => r.level_id)).size !== rows.length) e['composition'] = 'Each level can be used once.';
  else if (rows.some((r) => !intIn(r.count, 1, 4))) e['composition'] = 'Each count must be between 1 and 4.';
  else if (rows.reduce((s, r) => s + (r.count ?? 0), 0) !== n) e['composition'] = `Counts must add up to N = ${n}`;
  return Object.assign(e, planWindowErrors(p));
}

/** Inclusive limits of the plan time windows (QcPlanParams); shared with the settings default_plan_params (T-24). */
export const PLAN_WINDOWS = { run_window_minutes: [5, 240], qc_validity_hours: [1, 168], hold_lookback_hours: [1, 168] } as const;
/** Range errors of the optional plan time windows; an absent value is not checked here. */
export function planWindowErrors(p: { run_window_minutes?: unknown; qc_validity_hours?: unknown; hold_lookback_hours?: unknown }): Errors {
  const e: Errors = {};
  const W = PLAN_WINDOWS;
  if (p.run_window_minutes !== undefined && !intIn(p.run_window_minutes, ...W.run_window_minutes)) e['run_window'] = 'Run window must be between 5 and 240';
  if (p.qc_validity_hours !== undefined && !intIn(p.qc_validity_hours, ...W.qc_validity_hours)) e['qc_validity'] = 'QC valid for must be between 1 and 168';
  if (p.hold_lookback_hours !== undefined && !intIn(p.hold_lookback_hours, ...W.hold_lookback_hours)) e['hold_lookback'] = 'Hold look-back must be between 1 and 168';
  return e;
}

// ---------------------------------------------------------------- targets
/** Decimal string with at most `decimals` fraction digits (analyte decimals + 2, 02-TRD §7.6). Never parsed to a float. */
export function decimalError(label: string, v: string, decimals: number, positive: boolean): string | undefined {
  if (!DECIMAL.test(v)) return `${label} must be a number like 100.0`;
  if ((v.split('.')[1]?.length ?? 0) > decimals) return `${label} can have at most ${decimals} decimal places`;
  if (positive && !/[1-9]/.test(v)) return `${label} must be greater than zero`;
  return undefined;
}
export function validateTarget(v: { lot_id: string | undefined; mean: string; sd: string; note: string }, decimals: number): Errors {
  const e: Errors = {};
  if (!v.lot_id) e['lot'] = MSG.required('Lot');
  const m = decimalError('Mean', v.mean, decimals, false);
  if (m) e['mean'] = m;
  const s = decimalError('SD', v.sd, decimals, true);
  if (s) e['sd'] = s;
  if (v.note.length > 500) e['note'] = 'Use at most 500 characters.';
  return e;
}

export const DAY = 86_400_000;
export const MAX_PERIOD_DAYS = 92;
/** Tenant zone has no DST (UTC+05:45): a calendar date is converted to an instant with the fixed offset. */
export const startOf = (d: string) => new Date(`${d}T00:00:00+05:45`).toISOString();
export const endOf = (d: string, now = Date.now()) => new Date(Math.min(Date.parse(`${d}T23:59:59.999+05:45`), now)).toISOString();
export function validatePeriod(from: string | undefined, to: string | undefined, now = Date.now()): Errors {
  const e: Errors = {};
  if (!from || !ISO_DATE.test(from)) e['from'] = MSG.required('From date');
  if (!to || !ISO_DATE.test(to)) e['to'] = MSG.required('To date');
  if (has(e)) return e;
  const a = Date.parse(startOf(from!));
  const b = Date.parse(endOf(to!, now));
  if (!(a < b)) e['to'] = 'The end of the period must be after its start.';
  else if (b - a > MAX_PERIOD_DAYS * DAY) e['to'] = `The period can be at most ${MAX_PERIOD_DAYS} days.`;
  return e;
}

/** Sample statistics (n − 1) for the wizard preview only; the server recalculates the real target (02-TRD §7.6). */
export function stats(values: readonly number[]) {
  const n = values.length;
  if (n === 0) return { n: 0 };
  const mean = values.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, sd, cv: mean === 0 ? undefined : (sd / Math.abs(mean)) * 100 };
}
