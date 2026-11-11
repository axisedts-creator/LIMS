// C5.T-20 — pure helpers of the result grid (04-UI-UX §3.6): cell text, value validation, per-row error copy, LD-25 downtime validation. No React, no network.
import { FLAGS, type ResultFlag } from '@lims/ui/components/FlagBadge';
import type { AckFlag, GridResult } from '../../server/types';

export interface AnalyteInfo { name: string; decimals?: number; value_type: 'numeric' | 'ordinal' | 'text' }
export type AnalyteMap = Readonly<Record<string, AnalyteInfo>>;

export const AGE_UNKNOWN = 'Age unknown — reference range and critical check not applied'; // 08 A17.1
export const DEFAULT_DECIMALS = 6;                 // ponytail: ResultDto has no decimals (SPEC GAP); catalog decimals arrive through the `analytes` prop
export const DOWNTIME_DEFAULT_MAX_HOURS = 72;      // LD-25 default of tenant setting downtime_backentry_max_hours
export const DOWNTIME_REF_MAX = 32;                // LD-25

// ponytail: copy of the kit's _shared/time formatDateTime (not exported from @lims/ui): CV display 'DD/MM/YYYY hh:mm AM', time zone Asia/Kathmandu.
const FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
export function formatDateTime(iso: string | undefined): string {
  const d = iso ? new Date(iso) : undefined;
  if (!d || Number.isNaN(d.getTime())) return '—';
  const p: Record<string, string> = {};
  for (const x of FMT.formatToParts(d)) p[x.type] = x.value;
  return `${p['day']}/${p['month']}/${p['year']} ${p['hour']}:${p['minute']} ${(p['dayPeriod'] ?? '').toUpperCase()}`.trim();
}

export const valueOf =(r: GridResult) => r.value_numeric ?? r.value_text ?? r.ordinal_code ?? '';
export const isCalculated = (r: GridResult) => r.origin === 'calculated';
/** Editable while pending/resulted and not calculated; verified (return first), approved (amend) and cancelled are read-only. */
export const isEditable = (r: GridResult) => !isCalculated(r) && (r.status === 'pending' || r.status === 'resulted');

export const nameOf = (r: GridResult, a: AnalyteMap) => a[r.analyte_id]?.name ?? r.analyte_code;

export function statusLabel(r: GridResult): string {
  const base = r.status === 'approved' ? `Approved v${r.current_version_no}` : r.status[0]!.toUpperCase() + r.status.slice(1);
  return [base, r.on_hold ? 'On QC hold' : '', r.qc_review_required ? 'QC review' : ''].filter(Boolean).join(' · ');
}
export const flagText = (f?: string) => (f && f !== 'N' && Object.hasOwn(FLAGS, f) ? FLAGS[f as ResultFlag][1] : '');

export function rangeText(r: GridResult): string {
  if (r.range_unavailable_age_unknown) return AGE_UNKNOWN;
  const s = r.reference_range_snapshot;
  if (!s) return '';
  if (s.text) return s.text;
  return s.low && s.high ? `${s.low} – ${s.high}` : s.low ? `≥ ${s.low}` : s.high ? `≤ ${s.high}` : '';
}

/** "Δ +1.2 vs 4.0 (3 d ago)" when the delta check failed; "No previous" when there is nothing to compare with. */
export function deltaText(r: GridResult, now = Date.now()): string {
  const d = r.delta;
  if (!d || d.status === 'none') return 'No previous';
  if (d.status !== 'fail') return '';
  const cur = Number(valueOf(r)), prev = Number(d.prev_value);
  const sign = Number.isFinite(cur) && Number.isFinite(prev) && cur < prev ? '−' : '+';
  const ago = d.prev_at && Number.isFinite(Date.parse(d.prev_at)) ? ` (${Math.max(0, Math.round((now - Date.parse(d.prev_at)) / 86_400_000))} d ago)` : '';
  return `Δ ${sign}${(d.abs ?? '').replace(/^-/, '')} vs ${d.prev_value ?? '—'}${ago}`;
}

/** Calculated rows: "Waiting for: HDL" / "Not calculated: tg_over_400" (never a 0). */
export function calcText(r: GridResult): string {
  if (!isCalculated(r) || !r.calc) return '';
  const { status, reason = '' } = r.calc;
  if (status === 'waiting_for_inputs') return `Waiting for: ${reason.replace(/^missing_input:/, '').split(',').join(', ')}`;
  if (status === 'not_computable') return `Not calculated: ${reason}`;
  return '';
}
/** Provenance (expression + inputs with values) as plain text for the tooltip; unparseable → ''. */
export function provenanceText(r: GridResult): string {
  if (!r.calc?.provenance) return '';
  try {
    const p = JSON.parse(r.calc.provenance) as { expression?: unknown; inputs?: Record<string, unknown> };
    const inputs = Object.entries(p.inputs ?? {}).map(([k, v]) => `${k} = ${String(v)}`).join(', ');
    return [typeof p.expression === 'string' ? p.expression : '', inputs ? `(${inputs})` : ''].filter(Boolean).join(' ');
  } catch { return ''; }
}

/** Client side of AC-08.3 (the server validates again): null = fine, else the inline copy of 04-UI-UX §3.6. */
export function validateValue(text: string, info: AnalyteInfo | undefined): string | null {
  const t = info?.value_type ?? 'numeric';
  if (t === 'text') return text.length > 2000 ? 'Text is limited to 2,000 characters.' : null;
  if (t === 'ordinal') return /^[A-Z0-9_+-]{1,16}$/.test(text) ? null : 'Choose one of the listed values.';
  const dec = info?.decimals ?? DEFAULT_DECIMALS;
  const m = /^-?\d{1,18}(?:\.(\d+))?$/.exec(text);
  return m && (m[1]?.length ?? 0) <= dec ? null : `Enter a number with up to ${dec} decimals.`;
}
/** The one value field of a bulk-enter entry / amend body for this analyte. */
export function valueField(text: string, info: AnalyteInfo | undefined): { value_numeric: string } | { ordinal_code: string } | { value_text: string } {
  const t = info?.value_type ?? 'numeric';
  return t === 'text' ? { value_text: text } : t === 'ordinal' ? { ordinal_code: text } : { value_numeric: text };
}

/** Per-row bulk-enter outcome → readable text (raw codes are never shown). */
export function enterError(code: string | undefined, info: AnalyteInfo | undefined): string {
  switch (code) {
    case 'common.version_conflict': return 'Changed by someone else — reload this row';
    case 'lab.result_value_invalid': return validateValue('!', info) ?? 'Enter a valid value.';
    case 'lab.result_locked': return 'Approved results can only be changed by amendment.';
    case 'lab.result_invalid_transition': return 'This result can no longer be edited.';
    case 'common.not_found': return 'Result not found.';
    default: return 'Could not save this result.';
  }
}
/** Whole-action failures for return / amend / verify / approve (copy for the approve codes is verbatim from §3.6). */
export function actionError(code: string | undefined): string {
  switch (code) {
    case 'common.version_conflict': return 'Changed by someone else — reload this row';
    case 'lab.amend_requires_pathologist': return 'Only a pathologist can amend a result.';
    case 'lab.amendment_reason_required': return 'Choose a reason for the amendment.';
    case 'lab.result_value_invalid': return 'The value is not valid for this analyte.';
    case 'lab.result_invalid_transition': return 'This result is no longer in the right state.';
    case 'lab.flag_ack_required': return 'Acknowledge the flags before verifying.';
    case 'lab.self_approval_forbidden': return 'You verified this result. Another pathologist must approve it.';
    case 'lab.critical_ack_required': return 'Record the critical-value notification before approving.';
    case 'lab.result_on_hold': return 'This result is on hold.';
    case 'auth.mfa_required': return 'This needs a second check. Verify your identity, then try again.';
    case 'auth.forbidden': return 'You do not have permission for this.';
    case 'common.not_found': return 'Result not found.';
    default: return 'Something went wrong. Try again.';
  }
}

/** Flags a result needs acknowledged before verify (mirrors result.service `needed()`, same rule as the verification queue). */
export function neededFlags(r: GridResult): AckFlag[] {
  const f: AckFlag[] = [];
  if (r.delta?.status === 'fail') f.push('delta');
  if (r.critical.is_critical) f.push('critical');
  if (r.unit_mismatch) f.push('unit_mismatch');
  if (r.instrument_flags?.length) f.push('instrument_flag');
  return f;
}
export const ACK_LABEL: Record<AckFlag, string> = {
  delta: 'I have reviewed the delta', critical: 'I have reviewed the critical value', unit_mismatch: 'I have reviewed the unit mismatch', instrument_flag: 'I have reviewed the instrument flag',
};

/** LD-25 (2026-11-07): back-entry needs occurred_at (<= now, >= now - max hours) and downtime_ref (1..32). `at` is a datetime-local string (browser time zone). */
export function validateDowntime(at: string, ref: string, maxHours: number, now = Date.now()): { at?: string; ref?: string; occurredAt?: string } {
  const out: { at?: string; ref?: string; occurredAt?: string } = {};
  const t = at ? new Date(at).getTime() : Number.NaN;
  if (!at || Number.isNaN(t)) out.at = 'Enter the original time from the paper form.';
  else if (t > now) out.at = 'The original time cannot be in the future.';
  else if (t < now - maxHours * 3_600_000) out.at = `The original time is more than ${maxHours} hours ago and cannot be back-entered.`;
  else out.occurredAt = new Date(t).toISOString();
  if (!ref.trim()) out.ref = 'Enter the paper form serial.';
  else if (ref.length > DOWNTIME_REF_MAX) out.ref = `The paper form serial is limited to ${DOWNTIME_REF_MAX} characters.`;
  return out;
}
