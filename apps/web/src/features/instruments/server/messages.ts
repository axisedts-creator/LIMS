// WEB-T05 SCR-09/10 DTOs (contracts/openapi/instruments.yaml MessageSummary, MessageDetail, MessageRun, MessageRecord, MessageRejection) and
// pure validators. [CONV] hand-mirrored like types.ts. Type-only + pure: safe to import from client components.
import { UUID_RE } from './types';

export const MESSAGE_KINDS = ['data', 'incomplete', 'host_query', 'attachment'] as const;
export const LATEST_OUTCOMES = ['parsed', 'shadow', 'quarantined', 'rejected_capability'] as const;
export const REJECTION_REASONS = ['instruments.instrument_unknown', 'instruments.device_mismatch', 'instruments.message_too_large'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type LatestOutcome = (typeof LATEST_OUTCOMES)[number];

// instruments.g_cs_reprocess_reasons seed (05-SCHEMA §seed). Displays are the spec's seeded strings.
export const REPROCESS_REASONS = [
  { code: 'driver_fixed', display: 'Driver fixed' },
  { code: 'mapping_added', display: 'Code mapping added' },
  { code: 'quarantine_reviewed', display: 'Quarantine reviewed' },
  { code: 'barcode_keypad_error', display: 'Barcode typed wrongly at instrument' },
  { code: 'barcode_label_misread', display: 'Barcode label misread' },
  { code: 'instrument_resent_wrong_id', display: 'Instrument sent wrong sample id' },
  { code: 'other', display: 'Other' },
] as const;
export const REPROCESS_REASONS_SET = 'instruments.g_cs_reprocess_reasons';

export const SAMPLE_BARCODE_RE = /^[A-Z0-9]{1,40}$/;
export const MESSAGE_REASON_TEXT_MAX = 300;
export const MAX_RANGE_MS = 31 * 24 * 3600_000;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;

export interface LatestRun { run_no: number; kind: string; outcome: string; patient_records: number; qc_records: number; calibrator_records: number; unmapped_records: number; emitted_events: number }
export interface MessageSummary {
  id: string;
  instrument_id: string;
  instrument_code: string;
  agent_id: string;
  centre_id: string;
  protocol: string;
  message_kind: string;
  received_at: string;
  captured_at?: string;
  size_bytes: number;
  latest_run?: LatestRun;
}
export interface MessageRun {
  id: string;
  run_no: number;
  kind: string;
  driver_code: string;
  driver_version: string;
  outcome: string;
  patient_records: number;
  qc_records: number;
  calibrator_records: number;
  host_query_records: number;
  unmapped_records: number;
  skipped_no_barcode_records: number;
  emitted_events: number;
  skipped_records: number;
  actor_type: string;
  actor_display?: string;
  reason_code?: string;
  created_at: string;
}
export interface MessageRecord {
  id: string;
  run_no: number;
  record_seq: number;
  record_class: string;
  sample_barcode?: string;
  instrument_analyte_code?: string;
  mapping_status: string;
  value_raw?: string;
  unit_raw?: string;
  instrument_flags?: string[];
  result_at?: string;
  emit_status: string;
  event_id?: string;
  port_outcome?: string;
  port_reason_code?: string;
  warnings?: string[];
}
export interface MessageAttachment { attachment_id: string; scan_state: string; mime_type: string; size_bytes: number; original_file_name?: string }
export interface MessageDetailDto extends MessageSummary {
  message_control_id?: string;
  message_key_kind?: string;
  raw_sha256?: string;
  warnings: string[];
  runs: MessageRun[];
  records: MessageRecord[];
  records_expired: boolean;
  attachment?: MessageAttachment;
}
export interface MessageRaw { raw_base64: string; raw_text_escaped: string; raw_sha256: string; size_bytes: number }
export interface MessageRejection { id: string; received_at: string; agent_id: string; claimed_instrument_id: string; agent_message_id: string; reason_code: string; size_bytes: number; raw_sha256: string }
export interface ReprocessResult { run: MessageRun; records: MessageRecord[]; preview?: boolean }
export interface RematchResult { run: MessageRun; record: MessageRecord }
export interface ReasonFields { reasonCode: string; reasonText?: string }

export const isReprocessReason = (c: unknown) => REPROCESS_REASONS.some((r) => r.code === c);
export const isBarcode = (b: unknown): b is string => typeof b === 'string' && SAMPLE_BARCODE_RE.test(b);

/** True when both are ISO timestamps, from ≤ to, span ≤ 31 days. */
export function validRange(from: unknown, to: unknown): boolean {
  if (typeof from !== 'string' || typeof to !== 'string' || !ISO_RE.test(from) || !ISO_RE.test(to)) return false;
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a && b - a <= MAX_RANGE_MS;
}

type Sp = Readonly<Record<string, string | readonly string[] | undefined>>;
const csv = (v: Sp[string]) => (v === undefined ? [] : (typeof v === 'string' ? [v] : v).flatMap((x) => x.split(',')));
const pick = <T extends string>(v: Sp[string], allowed: readonly T[]) => [...new Set(csv(v).filter((x): x is T => (allowed as readonly string[]).includes(x)))];
const uuid = (v: Sp[string]) => { const x = csv(v)[0]; return x && UUID_RE.test(x) ? x : undefined; };
const bool = (v: Sp[string]) => (csv(v)[0] === 'true' ? true : undefined);

/** SCR-09 URL filters (no range). Unknown values are dropped, so tampered input never reaches the API. */
export function parseMessageFilters(sp: Sp): { instrumentId?: string; agentId?: string; centreId?: string; messageKind: MessageKind[]; latestOutcome: LatestOutcome[]; hasUnmapped?: true; hasQc?: true } {
  const instrumentId = uuid(sp['instrument_id']);
  const agentId = uuid(sp['agent_id']);
  const centreId = uuid(sp['centre_id']);
  return {
    ...(instrumentId ? { instrumentId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(centreId ? { centreId } : {}),
    messageKind: pick(sp['message_kind'], MESSAGE_KINDS),
    latestOutcome: pick(sp['latest_outcome'], LATEST_OUTCOMES),
    ...(bool(sp['has_unmapped']) ? { hasUnmapped: true as const } : {}),
    ...(bool(sp['has_qc']) ? { hasQc: true as const } : {}),
  };
}

/** Range from the URL, clamped to 31 days ending at `to`; missing or invalid → the last 24 h (AC-18.1). */
export function parseMessageRange(sp: Sp, now: Date): { receivedAtFrom: string; receivedAtTo: string } {
  const f = csv(sp['received_at_from'])[0];
  const t = csv(sp['received_at_to'])[0];
  const to = t && ISO_RE.test(t) && Number.isFinite(Date.parse(t)) ? Date.parse(t) : now.getTime();
  let from = f && ISO_RE.test(f) && Number.isFinite(Date.parse(f)) ? Date.parse(f) : to - 24 * 3600_000;
  if (from > to) from = to - 24 * 3600_000;
  from = Math.max(from, to - MAX_RANGE_MS);
  return { receivedAtFrom: new Date(from).toISOString(), receivedAtTo: new Date(to).toISOString() };
}
