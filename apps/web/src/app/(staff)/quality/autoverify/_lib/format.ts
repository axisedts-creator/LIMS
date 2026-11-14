// C9 T-23 shared labels and small pure helpers (server and client). Plain labels only: reason codes never reach the screen (04-UI-UX §2.9).
import type { QcState, Reason, VersionStatus } from './types';

export const NO_ACCESS = "You don't have access to this page";
export const NOT_SWITCHED_ON = 'The auto-verification module is not switched on for your lab yet.';
export const DASH = '—';
export const PERIOD_MAX_DAYS = 31;

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export const REASON_LABEL: Record<Reason, string> = {
  instrument_flag: 'Instrument flag',
  outside_autoverify_limits: 'Outside auto-verify limits',
  critical: 'Critical',
  delta_failure: 'Delta failure',
  qc_out_of_control: 'QC out of control',
  qc_warning: 'QC warning',
  qc_no_data: 'No QC data',
  manual_origin: 'Manual or calculated result',
  rule_missing: 'No rule',
};
export const REASONS = Object.keys(REASON_LABEL) as Reason[];
export const reasonText = (r: readonly string[]) => (r.length ? r.map((x) => REASON_LABEL[x as Reason] ?? 'Other reason').join(', ') : DASH);

export const STATUS: Record<VersionStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  simulating: { label: 'Simulating', tone: 'info' },
  active: { label: 'Active', tone: 'success' },
  stopped: { label: 'Stopped', tone: 'warning' },
  retired: { label: 'Retired', tone: 'neutral' },
  discarded: { label: 'Discarded', tone: 'neutral' },
};
export const statusOf = (s: string) => STATUS[s as VersionStatus] ?? { label: s, tone: 'neutral' as Tone };

export const DECISION: Record<string, { label: string; tone: Tone }> = { allow: { label: 'Allow', tone: 'success' }, deny: { label: 'Deny', tone: 'warning' } };
export const MODE: Record<string, { label: string; tone: Tone }> = { live: { label: 'Live', tone: 'info' }, shadow: { label: 'Shadow', tone: 'neutral' } };
export const QC: Record<QcState, string> = { in_control: 'In control', warning: 'Warning', out_of_control: 'Out of control', no_qc_data: 'No QC data' };

export const RANGE_FLAG: Record<string, string> = { N: 'N (Normal)', L: 'L (Low)', H: 'H (High)', LL: 'LL (Critical low)', HH: 'HH (Critical high)', A: 'A (Abnormal)' };

export const UUID =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;
export const RULE_KEY = /^[A-Za-z0-9_-]{1,40}$/;
export const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Exact decimal compare of two DecimalStrings (no float rounding): -1, 0, 1. */
export function cmpDecimal(a: string, b: string): number {
  const parse = (s: string) => {
    const neg = s.startsWith('-');
    const [i = '0', f = ''] = (neg ? s.slice(1) : s).split('.');
    return { neg, i, f };
  };
  const [x, y] = [parse(a), parse(b)];
  const scale = Math.max(x.f.length, y.f.length);
  const big = (p: ReturnType<typeof parse>) => (p.neg ? -1n : 1n) * BigInt(p.i + p.f.padEnd(scale, '0'));
  const [p, q] = [big(x), big(y)];
  return p < q ? -1 : p > q ? 1 : 0;
}

/** Link to the C5 order results (route staff.lab.order_results); built from segments so no hand-written C5 path lives in this feature. */
export const orderResultsHref = (orderId: string) => ['', 'lab', 'orders', orderId, 'results'].join('/');
export const versionHref = (id: string) => `/quality/autoverify/${id}`;
export const OVERVIEW_HREF = '/quality/autoverify';
export const DECISIONS_HREF = '/quality/autoverify/decisions';
export const qcRunHref = (id: string) => `/quality/qc-runs/${id}`;

/** Limits as one readable phrase: "3.5 – 5.1", "up to 5.1", "from 3.5". */
export function limitsText(l: { low?: string; high?: string } | undefined) {
  if (!l || (l.low === undefined && l.high === undefined)) return DASH;
  if (l.low !== undefined && l.high !== undefined) return `${l.low} – ${l.high}`;
  return l.low !== undefined ? `from ${l.low}` : `up to ${l.high}`;
}

// ---------------------------------------------------------------- decisions period (Asia/Kathmandu has a fixed +05:45 offset, no DST)
export const DAY = 86_400_000;
const NPT = 20_700_000;
/** Start of the Kathmandu calendar day of `ms`, as a UTC instant. */
export const nptDayStart = (ms: number) => Math.floor((ms + NPT) / DAY) * DAY - NPT;
export const isoMs = (ms: number) => new Date(ms).toISOString();
/** The Kathmandu calendar date (YYYY-MM-DD) of a UTC instant. */
export const nptDate = (iso: string) => new Date(Date.parse(iso) + NPT).toISOString().slice(0, 10);
/** UTC instant of 00:00 Kathmandu time on a YYYY-MM-DD date. */
export const nptMidnight = (date: string) => Date.parse(`${date}T00:00:00.000Z`) - NPT;
