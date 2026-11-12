// Isolate (§2.2 I1–I4) and instrument-record (§2.4 IR1–IR6) state tables. Pure: no I/O.
import { LimsError } from '../../../core/errors.js';

export const ISOLATE_STATUSES = ['identified', 'pending_id', 'withdrawn'] as const;
export type IsolateStatus = (typeof ISOLATE_STATUSES)[number];
export const RECORD_STATUSES = ['pending_match', 'needs_mapping', 'conflict', 'late_after_final', 'applied', 'ignored'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];
export type RecordTrigger = 'consume' | 'assign' | 'apply' | 'ignore';
export type RecordResolution = 'use_instrument' | 'keep_existing';

const isoInvalid = (): never => { throw new LimsError('micro.isolate_invalid_transition'); };

/** I1: isolates exist only once plates exist and the culture is not closed. */
export function initialIsolateStatus(i: { cultureStatus: string; organismId?: string | null }): 'identified' | 'pending_id' {
  if (i.cultureStatus === 'final_submitted') throw new LimsError('micro.report_final_locked');
  if (!['incubating', 'growth_detected', 'amending'].includes(i.cultureStatus)) throw new LimsError('micro.culture_invalid_transition');
  return i.organismId ? 'identified' : 'pending_id';
}

/** I2 identify (pending_id), I3 re-identify (identified), I4 withdraw (pending_id|identified). withdrawn is terminal. */
export function nextIsolateStatus(from: IsolateStatus, action: 'identify' | 'withdraw'): IsolateStatus {
  if (from !== 'pending_id' && from !== 'identified') return isoInvalid();
  if (action === 'identify') return 'identified';
  if (action === 'withdraw') return 'withdrawn';
  return isoInvalid();
}

export function assertAstPanelAssignable(status: IsolateStatus): void {
  if (status !== 'identified') isoInvalid();
}

// Allowed record edges as "from|to|trigger|resolution" keys (from '' = new record, resolution '' = none).
const key = (f: string, t: string, tr: string, r = ''): string => `${f}|${t}|${tr}|${r}`;
const EDGES = new Set<string>([
  ...RECORD_STATUSES.map((t) => key('', t, 'consume')), // IR1
  ...(['applied', 'needs_mapping', 'conflict', 'late_after_final'] as const).map((t) => key('pending_match', t, 'assign')), // IR2
  ...(['needs_mapping', 'late_after_final', 'pending_match'] as const).flatMap((f) => (['applied', 'conflict', 'needs_mapping'] as const).map((t) => key(f, t, 'apply'))), // IR3
  ...(['apply', 'assign'] as const).flatMap((tr) => [key('conflict', 'applied', tr, 'use_instrument'), key('conflict', 'ignored', tr, 'keep_existing')]), // IR4, IR5
  ...(['pending_match', 'needs_mapping', 'conflict', 'late_after_final'] as const).map((f) => key(f, 'ignored', 'ignore')), // IR6
]);

export function canRecordTransition(from: RecordStatus | null, to: RecordStatus, trigger: RecordTrigger, resolution?: RecordResolution): boolean {
  return EDGES.has(key(from ?? '', to, trigger, resolution ?? ''));
}

export function assertRecordTransition(from: RecordStatus | null, to: RecordStatus, trigger: RecordTrigger, resolution?: RecordResolution): void {
  if (!canRecordTransition(from, to, trigger, resolution)) throw new LimsError('micro.instrument_record_conflict');
}
