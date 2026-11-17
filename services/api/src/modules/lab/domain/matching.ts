// Pure decision table of the instrument apply pipeline (02-TRD §4.5 steps 2, 4-10; 03-IC §3.14; 04 N10; 08 A13 D-10, CR-C5-008; 07-SECURITY S-07, REQ-SEC-121). No I/O, no clock.
// The pipeline (service/ingest.service.ts) does the reads/writes; this module only decides.
import { LimsError } from '../../../core/errors.js';

export type RecordKind = 'quantitative' | 'qualitative' | 'ordinal' | 'text' | 'organism_id' | 'ast' | 'attachment';
/** ingest_exceptions.reason (05-SCHEMA ingest_exceptions__reason__ck). */
export type IngestReason = 'unmapped_code' | 'unknown_barcode' | 'specimen_rejected' | 'specimen_not_received' | 'analyte_not_ordered' | 'result_locked' | 'result_already_verified' | 'unit_mismatch' | 'attachment_tenant_mismatch';

/** 04 N10: `instrument_id:sample_barcode:instrument_analyte_code:(instrument_result_time|'none')`. Contains the barcode (P2): never log it. */
export function resultKey(i: { instrumentId: string; sampleBarcode: string; instrumentAnalyteCode: string; instrumentResultTime?: string | undefined }): string {
  return `${i.instrumentId}:${i.sampleBarcode}:${i.instrumentAnalyteCode}:${i.instrumentResultTime ?? 'none'}`;
}

/** Step 2: organism_id / ast belong to C10; C5 only logs them as not_applicable. */
export function classifyRecord(kind: RecordKind): 'apply' | 'not_applicable' {
  return kind === 'organism_id' || kind === 'ast' ? 'not_applicable' : 'apply';
}

export interface MatchSpecimen { status: string; isActive: boolean }
export interface MatchResult { resultId: string; analyteId: string; testId: string; status: string }
export interface MatchInput { specimen?: MatchSpecimen | undefined; autoReceive: boolean; analyteId: string; testId?: string | undefined; results: readonly MatchResult[] }
export type MatchDecision =
  | { outcome: 'apply'; resultId: string; receive: boolean }
  | { outcome: 'unmatched' | 'rejected_state'; exception: IngestReason; reasonCode?: 'result_locked'; receive?: true; resultId?: string };

const DEAD_SPECIMEN = new Set(['rejected', 'recollection_ordered', 'discarded']);   // step 5
const AWAITING_RECEIPT = new Set(['collected', 'in_transit']);                       // step 6 (S4 source states)

/** Steps 4-9. `receive: true` = the pipeline must perform S4 as system first (step 6 with ingest_auto_receive). */
export function decideMatch(i: MatchInput): MatchDecision {
  const sp = i.specimen;
  if (!sp) return { outcome: 'unmatched', exception: 'unknown_barcode' };                                                  // step 4
  if (DEAD_SPECIMEN.has(sp.status) || !sp.isActive) return { outcome: 'rejected_state', exception: 'specimen_rejected' };  // step 5
  let receive = false;
  if (sp.status === 'ordered') return { outcome: 'unmatched', exception: 'specimen_not_received' };                         // step 6: S4 from `ordered` is forbidden (03-IC §10.1)
  if (AWAITING_RECEIPT.has(sp.status)) {
    if (!i.autoReceive) return { outcome: 'unmatched', exception: 'specimen_not_received' };
    receive = true;
  }
  // step 7: a cancelled row never counts, even if the store handed one over. Deterministic target: lowest result id.
  const live = i.results.filter((r) => r.status !== 'cancelled' && r.analyteId === i.analyteId).sort((a, b) => (a.resultId < b.resultId ? -1 : a.resultId > b.resultId ? 1 : 0));
  const preferred = i.testId === undefined ? [] : live.filter((r) => r.testId === i.testId);
  const target = (preferred.length ? preferred : live)[0];
  if (!target) return { outcome: 'unmatched', exception: 'analyte_not_ordered', ...(receive ? { receive: true as const } : {}) };
  if (target.status === 'approved') return { outcome: 'rejected_state', exception: 'result_locked', reasonCode: 'result_locked', resultId: target.resultId, ...(receive ? { receive: true as const } : {}) };   // step 8, never an error (CR-C5-008)
  if (target.status === 'verified') return { outcome: 'unmatched', exception: 'result_already_verified', resultId: target.resultId, ...(receive ? { receive: true as const } : {}) };           // step 9
  if (target.status !== 'pending' && target.status !== 'resulted') throw new LimsError('common.internal');   // unknown status: fail closed
  return { outcome: 'apply', resultId: target.resultId, receive };
}

export interface UnitInput {
  unitRaw?: string | undefined; unitCode?: string | undefined; analyteUnitCode?: string | undefined;
  unitConversion?: { fromUnitRaw: string; toUnitCode: string; factor: string } | undefined;
}
export interface UnitDecision { valueFactor?: string; storedUnitCode?: string; unitMismatch: boolean }

/** Step 10 (08 A13 D-10; same on both paths). Conversion wins when unit_raw matches fromUnitRaw; else a unit differing from the analyte's is a mismatch (value kept as received). */
export function decideUnit(i: UnitInput): UnitDecision {
  const c = i.unitConversion;
  if (c && i.unitRaw !== undefined && i.unitRaw === c.fromUnitRaw) {
    return { valueFactor: c.factor, storedUnitCode: c.toUnitCode, unitMismatch: i.analyteUnitCode !== undefined && c.toUnitCode !== i.analyteUnitCode };
  }
  const received = i.unitCode || i.unitRaw || undefined;   // '' = no unit
  const mismatch = received !== undefined && i.analyteUnitCode !== undefined && received !== i.analyteUnitCode;
  return { ...(i.unitCode ? { storedUnitCode: i.unitCode } : {}), unitMismatch: mismatch };
}

/** REQ-SEC-121: the first path segment must equal the tenant id exactly; no traversal, no empty/backslash/control segments. */
export function attachmentTenantOk(objectPath: string, tenantId: string): boolean {
  if (typeof objectPath !== 'string' || typeof tenantId !== 'string' || !tenantId || !objectPath) return false;
  if (/[\\\u0000-\u001f]/.test(objectPath)) return false;
  const seg = objectPath.split('/');
  if (seg.length < 2 || seg[0] !== tenantId) return false;
  return seg.every((s) => s !== '' && s !== '.' && s !== '..');
}
