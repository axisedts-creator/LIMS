// C5 T-17 shared fixture: in-memory fake store/ports/events for approveResult / bulkApproveResults / amendResult / listResultVersions / evaluateOrderReadiness. Not a test file (no *.test.ts).
// SEAM (spec fixes behaviour, not names) — everything below is what ctx must provide; all store calls are (tx, tenantId, ...), tenant from ctx only (REQ-SEC-024).
// ApproveStore (result.service.ts approveResult / bulkApproveResults):
//   lockForApprove(tx, tenantId, ids)   ids unique + ascending (02-TRD §3.2); VISIBLE rows only: ApproveRow = { resultId, rowVersion, status, onHold, origin, orderId, orderItemId, specimenId?, testId, analyteId,
//                                       departmentId, centreId, currentVersionNo, verifiedByMembershipId? }
//   approve(tx, tenantId, { resultId, expectedRowVersion, membershipId, occurredAt })   -> ResultRow ; R6 UPDATE ... WHERE version = expected (common.version_conflict on a lost race) + lab.approvals row (kind approval,
//                                       aal2) + immutable lab.result_versions v1 copied from the row (02-TRD §4.3) — all inside the store
//   hasUnconfirmedCritical(tx, tenantId, resultId) -> boolean   an open critical event with no notification outcome reached + read_back_confirmed (AC-13.5)
//   getLabSettings(tx, tenantId) -> { criticalNotificationBlocksApproval: boolean }
//   closeOpenCriticalEvents(tx, tenantId, { resultId, closedAt }) -> string[]   (CriticalStore of T-15; R6 closes the events)
//   rollupSpecimen(tx, tenantId, specimenId)                                    (once per distinct specimen, after every approval, ascending; never for specimen-less rows)
// AmendStore (amendResult):
//   lockForAmend(tx, tenantId, ids) -> AmendRow[] = EntryRow of T-14 (resultId, rowVersion, status, orderId, orderItemId, specimenId?, patientId, testId, analyteId, centreId, currentVersionNo, sex, patientAgeDays,
//                                       specimenTypeCode?, collectedAt?, unitCode?, analyte {id, code, resultType, decimals?, ordinalSetValues?, formula?}) + currentValue { numeric?, text?, ordinalCode? } (the current version's value)
//   amendReasonActive(tx, tenantId, code) -> boolean   (lab.v_amendment_reasons, global + tenant shadow)
//   amendResult(tx, tenantId, { resultId, expectedRowVersion, previousVersionNo, newVersionNo, value, evaluation, commentCodes?, commentText?, reasonCode, reasonText?, membershipId, occurredAt }) -> ResultRow
//        = INSERT lab.result_versions v(n+1) (approved at creation, evaluation outputs bound at INSERT only — 02-TRD §4.3, evaluationColumns(…, 'R7')), previous version marked superseded, results.current_version_no := n+1,
//          lab.approvals row kind 'amendment'; the locked results row's value columns are never written. Returned row = the result as read through lab.v_result_current (cur_*, finding C5 #10).
//   plus T-14 EntryStore: deltaInputs, listCriticalLog, insertCriticalLog, markCriticalValueChanged; T-13 ResultStore: listCalculatedTargets, listInputs, inputUnitByCode, applyComputed, amendCalculated.
// listResultVersions(ctx, { resultId }) -> store.listResultVersions(tx, tenantId, resultId) = { centreId, versions: rows (version_no ascending) } | undefined (unknown / invisible);
//        the service checks lab.result.read at centreId (P-02 -> common.not_found) and returns the rows.
// ReadinessStore (order.service.ts evaluateOrderReadiness, called by approve/amend for each distinct order after all writes):
//   lockReadiness(tx, tenantId, orderId) -> { readinessSeq: number; lastEmittedHash?: string; lastCompleteness?: 'complete'|'partial'; departmentHashes: Record<string,string> }  (row locked, defaults when absent)
//   listReadinessInputs(tx, tenantId, orderId) -> { orderTests, results } (shapes of domain/readiness.ts evaluateReadiness)
//   saveReadiness(tx, tenantId, { orderId, readinessSeq, lastEmittedHash, lastCompleteness, departmentHashes, emittedAt })
//   ports.IdentityPort.getTenantSettings(ctx, { keys: ['partialReleaseAllowed'] }) -> { partialReleaseAllowed }
import { LimsError } from '../../../../core/errors.js';

export const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
export const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
export const APPROVER = '01a1b34e-2000-7eee-9d29-d7ca59a102b6';   // ctx.actor.membershipId
export const VERIFIER = '01a1b34e-2000-7eee-9d29-d7ca59a102c7';
export const NOW = new Date('2026-06-15T05:00:00Z');
export const ORDER = '01a1a98a-ac40-7000-8000-0000000c0001', ITEM = '01a1a98a-ac40-7000-8000-0000000b0001', ORDER2 = '01a1a98a-ac40-7000-8000-0000000c0002', ITEM2 = '01a1a98a-ac40-7000-8000-0000000b0002';
export const PATIENT = '01a1a98a-ac40-7000-8000-0000000d0001', CENTRE = '01a1a98a-ac40-7000-8000-00000000a201', DEPT = '01a1a98a-ac40-7000-8000-000000150001';
export const SPEC1 = '01a1a98a-ac40-7000-8000-0000000e0001', SPEC2 = '01a1a98a-ac40-7000-8000-0000000e0002';
export const id = (n: number) => `01a1a98a-ac40-7000-8000-0000000a${n.toString(16).padStart(4, '0')}`;

export const approveRow = (resultId: string, over: Record<string, unknown> = {}) => ({
  resultId, rowVersion: 7, status: 'verified', onHold: false, origin: 'manual', orderId: ORDER, orderItemId: ITEM, specimenId: SPEC1, testId: 't-cbc', analyteId: 'a-HB', departmentId: DEPT,
  centreId: CENTRE, currentVersionNo: 1, verifiedByMembershipId: VERIFIER, ...over,
});
export const amendRow = (resultId: string, over: Record<string, unknown> = {}) => ({
  resultId, rowVersion: 9, status: 'approved', orderId: ORDER, orderItemId: ITEM, specimenId: SPEC1, patientId: PATIENT, testId: 't-cbc', analyteId: 'a-HB', centreId: CENTRE, currentVersionNo: 1,
  sex: 'female', patientAgeDays: 10950, specimenTypeCode: 'EDTA', collectedAt: new Date('2026-06-15T03:00:00Z'), unitCode: 'g/dL',
  analyte: { id: 'a-HB', code: 'HB', resultType: 'numeric', decimals: 1, formula: null }, currentValue: { numeric: '13.4' }, ...over,
});
export const readyInputs = (orderTests: unknown[], results: unknown[]) => ({ orderTests, results });

export interface Opt {
  approveRows?: any[]; amendRows?: any[]; assertRole?: (r: { permission: string; centreId: string }) => Promise<void>;
  approveFails?: Record<string, Error>; unconfirmed?: Record<string, boolean>; blocks?: boolean; amendReasonOk?: boolean; versions?: any[];
  targets?: any[]; inputs?: any[]; units?: Record<string, string>; partialReleaseAllowed?: boolean; readiness?: Record<string, unknown>; readyIn?: Record<string, { orderTests: unknown[]; results: unknown[] }>;
  referenceRange?: any; criticalLimits?: any; lastReadiness?: Record<string, any>; actor?: any;
}

export function make(opt: Opt = {}) {
  const tx = { id: 'tx-1' };
  const log: { fn: string; tenantId: unknown; arg: any; tx: unknown }[] = [];
  const emitted: { type: string; input: any }[] = [];
  const asked: { permission: string; centreId: string }[] = [];
  const rec = (fn: string, t: unknown, tenantId: unknown, arg: any) => log.push({ fn, tenantId, arg, tx: t });
  const aRows = new Map((opt.approveRows ?? []).map((r) => [r.resultId, r]));
  const mRows = new Map((opt.amendRows ?? []).map((r) => [r.resultId, r]));
  const readiness = new Map<string, any>(Object.entries(opt.lastReadiness ?? {}));
  const dto = (src: any, status: string, extra: Record<string, unknown> = {}) => ({
    id: src.resultId, version: src.rowVersion + 1, status, origin: src.origin ?? 'manual', order_id: src.orderId, order_item_id: src.orderItemId, specimen_id: src.specimenId, test_id: src.testId, analyte_id: src.analyteId,
    analyte_code: 'HB', value_numeric: '13.4', flag: 'N', on_hold: false, current_version_no: src.currentVersionNo, ...extra,
  });
  const store = {
    // approve
    async lockForApprove(t: unknown, tenantId: unknown, ids: string[]) { rec('lockForApprove', t, tenantId, ids); return ids.map((i) => aRows.get(i)).filter(Boolean); },
    async approve(t: unknown, tenantId: unknown, a: any) {
      rec('approve', t, tenantId, a);
      if (opt.approveFails?.[a.resultId]) throw opt.approveFails[a.resultId];
      return dto(aRows.get(a.resultId), 'approved', { approved_at: a.occurredAt, approved_by_membership_id: a.membershipId, current_version_no: 1 });
    },
    async hasUnconfirmedCritical(t: unknown, tenantId: unknown, resultId: string) { rec('hasUnconfirmedCritical', t, tenantId, resultId); return opt.unconfirmed?.[resultId] ?? false; },
    async getLabSettings(t: unknown, tenantId: unknown) { rec('getLabSettings', t, tenantId, undefined); return { criticalNotificationBlocksApproval: opt.blocks ?? true }; },
    async closeOpenCriticalEvents(t: unknown, tenantId: unknown, a: any) { rec('closeOpenCriticalEvents', t, tenantId, a); return []; },
    async rollupSpecimen(t: unknown, tenantId: unknown, s: string) { rec('rollupSpecimen', t, tenantId, s); },
    // amend
    async lockForAmend(t: unknown, tenantId: unknown, ids: string[]) { rec('lockForAmend', t, tenantId, ids); return ids.map((i) => mRows.get(i)).filter(Boolean); },
    async amendReasonActive(t: unknown, tenantId: unknown, code: string) { rec('amendReasonActive', t, tenantId, code); return opt.amendReasonOk ?? true; },
    async amendResult(t: unknown, tenantId: unknown, a: any) {
      rec('amendResult', t, tenantId, a);
      return dto(mRows.get(a.resultId), 'approved', { current_version_no: a.newVersionNo, value_numeric: a.value?.numeric ?? null, flag: a.evaluation?.flag ?? null, amendment: { version_no: a.newVersionNo, reason_code: a.reasonCode } });
    },
    async listResultVersions(t: unknown, tenantId: unknown, resultId: string) { rec('listResultVersions', t, tenantId, resultId); return opt.versions ? { centreId: CENTRE, versions: opt.versions } : undefined; },
    // T-14 EntryStore parts used by the amendment evaluation / critical log
    async deltaInputs(t: unknown, tenantId: unknown, row: any) { rec('deltaInputs', t, tenantId, row.resultId); return { candidates: [] }; },
    async listCriticalLog(t: unknown, tenantId: unknown, rid: string) { rec('listCriticalLog', t, tenantId, rid); return []; },
    async insertCriticalLog(t: unknown, tenantId: unknown, a: any) { rec('insertCriticalLog', t, tenantId, a); return { criticalEventId: id(0x900) }; },
    async markCriticalValueChanged(t: unknown, tenantId: unknown, rid: string) { rec('markCriticalValueChanged', t, tenantId, rid); },
    async saveEntry(t: unknown, tenantId: unknown, a: any) { rec('saveEntry', t, tenantId, a); throw new Error('saveEntry must never run for an approved result (locked row)'); },
    async getResults(t: unknown, tenantId: unknown, ids: string[]) { rec('getResults', t, tenantId, ids); return []; },
    // T-13 ResultStore (cascade)
    async listCalculatedTargets(t: unknown, tenantId: unknown, item: string) { rec('listCalculatedTargets', t, tenantId, item); return opt.targets ?? []; },
    async listInputs(t: unknown, tenantId: unknown, item: string) { rec('listInputs', t, tenantId, item); return opt.inputs ?? []; },
    async inputUnitByCode(t: unknown, tenantId: unknown, item: string) { rec('inputUnitByCode', t, tenantId, item); return opt.units ?? {}; },
    async applyComputed(t: unknown, tenantId: unknown, a: any) { rec('applyComputed', t, tenantId, a); },
    async amendCalculated(t: unknown, tenantId: unknown, a: any) { rec('amendCalculated', t, tenantId, a); },
    // readiness
    async lockReadiness(t: unknown, tenantId: unknown, orderId: string) { rec('lockReadiness', t, tenantId, orderId); return readiness.get(orderId) ?? { readinessSeq: 0, departmentHashes: {} }; },
    async listReadinessInputs(t: unknown, tenantId: unknown, orderId: string) { rec('listReadinessInputs', t, tenantId, orderId); return opt.readyIn?.[orderId] ?? { orderTests: [], results: [] }; },
    async saveReadiness(t: unknown, tenantId: unknown, a: any) { rec('saveReadiness', t, tenantId, a); readiness.set(a.orderId, { readinessSeq: a.readinessSeq, lastEmittedHash: a.lastEmittedHash, lastCompleteness: a.lastCompleteness, departmentHashes: a.departmentHashes }); },
  };
  const ctx = {
    tenantId: TENANT, actor: opt.actor ?? { type: 'user', id: ACTOR, membershipId: APPROVER }, tx, now: () => NOW, store, requestId: 'req-1',
    events: { async publish(...a: unknown[]) { emitted.push({ type: a.find((x) => typeof x === 'string') as string, input: a[a.length - 1] }); return { eventId: 'ev', duplicate: false }; } },
    audit: { async access() {} },
    config: { autoverifyHookEnabled: false },
    ports: {
      IdentityPort: {
        async assertRole(_c: unknown, r: any) { asked.push(r); await opt.assertRole?.(r); },
        async getTenantSettings(_c: unknown, i?: any) { rec('getTenantSettings', undefined, TENANT, i); return { partialReleaseAllowed: opt.partialReleaseAllowed ?? false }; },
      },
      CatalogPort: {
        async referenceRangeFor() { return opt.referenceRange ?? { referenceRangeId: id(0x501), version: 3, low: '12.0', high: '16.0', unitCode: 'g/dL' }; },
        async criticalLimitsFor() { return opt.criticalLimits ?? { criticalLimitId: id(0x502), version: 2, low: '7.0', high: '20.0' }; },
      },
    },
  };
  const of = (fn: string) => log.filter((l) => l.fn === fn);
  return {
    ctx: ctx as never, tx, log, emitted, asked, of,
    stored: (fn: string) => of(fn).map((l) => l.arg),
    events: (type: string) => emitted.filter((e) => e.type === type),
    approvedEvents: () => emitted.filter((e) => e.type === 'lab.result.approved.v1'),
    amendedEvents: () => emitted.filter((e) => e.type === 'lab.result.amended.v1'),
    readyEvents: () => emitted.filter((e) => e.type === 'lab.order.ready_for_report.v1'),
  };
}
export const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
export const forbidden = async () => { throw new LimsError('auth.forbidden'); };
export const mfaRequired = async () => { throw new LimsError('auth.mfa_required'); };
