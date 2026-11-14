// C12.T-16 consumer `lab.result.verified.v1` (02-TRD §8.1 steps 2-7 + table row, §8.2 steps 1/5/6, §8.3, §8.4; PRD AC-12.1..12.7, AC-12.9; 07-SECURITY D-EVT, P-T6, LT-1; 08 A17 D-73).
// [CONV] TRD §8.1 step 1 (inbox insert) and step 8 (commit / retry) belong to the C0 wrapper core/consumer.ts `consumerRun`: it owns inventory.event_inbox, so this handler never touches it.
// Data minimisation (D-EVT): only result_id, order_item_id, test_id, analyte_id, department_id, instrument_id?, processing_branch_id?, verified_at are read; everything else in the payload is ignored.
// Any thrown error rolls the whole job transaction back and the worker retries (CV §7.5); a missing/malformed required field throws BEFORE any write.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { analyteBasisKey, testBasisKey } from '../../../../../api/src/modules/inventory/domain/basis.js';
import { assertZone, ymdIn } from '../../../../../api/src/modules/inventory/domain/tenantTime.js';
import { type RepoCtx, query } from '../../../../../api/src/modules/inventory/repository/_base.js';
import { getSettings } from '../../../../../api/src/modules/inventory/repository/settings.repo.js';
import { type FactKey, matchFact, postNeeds, raiseUnresolvedAlert, resolveStore, setFactTotal } from '../../../../../api/src/modules/inventory/service/consumers.service.js';
import type { ConsumerHandler } from '../../../core/manifest.js';

const EVENT = 'lab.result.verified.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

interface Verified {
  resultId: string; orderItemId: string; testId: string; analyteId: string; departmentId: string; instrumentId: string | null; processingBranchId: string | null; verifiedAt: string; atMs: number;
}

const reject = (what: string): never => {
  throw Object.assign(new Error(`${EVENT}: invalid payload field ${what}`), { code: 'common.validation_failed' });
};
const reqUuid = (p: Record<string, unknown>, k: string): string => (typeof p[k] === 'string' && UUID.test(p[k] as string) ? (p[k] as string) : reject(k));
const optUuid = (p: Record<string, unknown>, k: string): string | null => (p[k] === undefined || p[k] === null ? null : reqUuid(p, k));

function readPayload(event: any): Verified {
  const p = event?.payload;
  if (p === null || typeof p !== 'object') return reject('payload');
  const at = p['verified_at'];
  const atMs = typeof at === 'string' && ISO.test(at) ? Date.parse(at) : NaN;
  if (Number.isNaN(atMs)) reject('verified_at');
  return {
    resultId: reqUuid(p, 'result_id'), orderItemId: reqUuid(p, 'order_item_id'), testId: reqUuid(p, 'test_id'), analyteId: reqUuid(p, 'analyte_id'), departmentId: reqUuid(p, 'department_id'),
    instrumentId: optUuid(p, 'instrument_id'), processingBranchId: optUuid(p, 'processing_branch_id'), verifiedAt: new Date(atMs).toISOString(), atMs,
  };
}

/** Step 3 / step 7: one upsert per counter (P-22: the row is created on first use); the unique key is NULLS NOT DISTINCT so a missing instrument is one row. */
const bumpCounter = (rc: RepoCtx, v: Verified, businessDate: string, col: 'verified_result_events' | 'tests_counted'): Promise<unknown> =>
  query(rc, `INSERT INTO inventory.test_counts_daily (id, tenant_id, business_date, instrument_id, test_id, ${col}, created_by, updated_by)
    VALUES ($2::uuid, $1, $3::date, $4::uuid, $5::uuid, 1, $6::uuid, $6::uuid)
    ON CONFLICT (tenant_id, business_date, instrument_id, test_id) DO UPDATE SET ${col} = inventory.test_counts_daily.${col} + 1, updated_at = now(), updated_by = EXCLUDED.updated_by`,
  [uuidv7(), businessDate, v.instrumentId, v.testId, rc.actorId]);

/**
 * TRD §8.1 step 6.1-6.4 for ONE candidate fact. Returns true when the fact row was newly inserted.
 * The row is INSERTed with its FINAL status (never UPDATEd afterwards except the same-status value_paisa_total).
 */
async function recordFact(rc: RepoCtx, v: Verified, e: { eventId: string }, a: { kind: 'test' | 'analyte'; basisKey: string; businessDate: string; clock: { tz: string; nowMs: number } }): Promise<boolean> {
  const key: FactKey = { fact_kind: a.kind, occurred_at: v.verifiedAt, instrument_id: v.instrumentId, test_id: v.testId, analyte_id: a.kind === 'analyte' ? v.analyteId : null, multiplier: 1 };
  const needs = await matchFact(rc, key);
  if (a.kind === 'analyte' && needs.length === 0) return false; // fact (b) exists only when a per_analyte rule matches (TRD §8.1 table)
  const storeId = needs.length === 0 ? null : (await resolveStore(rc, { instrument_id: v.instrumentId, processing_branch_id: v.processingBranchId })).store_id; // only with a matched rule (§8.2)
  const status = needs.length === 0 ? 'no_rule' : storeId === null ? 'unresolved' : 'posted';
  const id = uuidv7();
  const ins = await query(rc, `INSERT INTO inventory.consumption_facts (id, tenant_id, fact_kind, basis_key, source, source_event_id, source_event_type, instrument_id, test_id, analyte_id, department_id,
      processing_branch_id, occurred_at, business_date, multiplier, store_id, status, rules_applied, value_paisa_total, created_by, updated_by)
    VALUES ($2::uuid, $1, $3, $4, 'event', $5::uuid, $6, $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::timestamptz, $13::date, 1, $14::uuid, $15, $16::integer, 0, $17::uuid, $17::uuid)
    ON CONFLICT (tenant_id, basis_key) DO NOTHING RETURNING id`,
  [id, a.kind, a.basisKey, e.eventId, EVENT, v.instrumentId, v.testId, a.kind === 'analyte' ? v.analyteId : null, v.departmentId, v.processingBranchId, v.verifiedAt, a.businessDate, storeId, status, needs.length, rc.actorId]);
  if (ins.length === 0) return false; // the fact already exists: nothing more for it (re-verification, duplicate, racing twin)
  if (status === 'posted') {
    const { rows, total } = await postNeeds(rc, { factId: id, factKind: a.kind, occurredAt: v.verifiedAt, businessDate: a.businessDate, storeId: storeId!, instrumentId: v.instrumentId, needs, clock: a.clock });
    if (rows.length > 0) await setFactTotal(rc, id, total);
  } else if (status === 'unresolved') await raiseUnresolvedAlert(rc, v.instrumentId); // §8.2 step 6; the job never fails for it (AC-12.9)
  return true;
}

export const onResultVerified: ConsumerHandler = async (event, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || event?.tenant_id !== tenantId) { // P-T6 / REQ-SEC-024: never write for a tenant other than the job's
    ctx.log?.warn?.({ event: 'lab_result_verified_skipped', reason: 'tenant_mismatch' });
    return;
  }
  const v = readPayload(event);
  if (typeof event.event_id !== 'string' || !UUID.test(event.event_id)) reject('event_id');
  const rc: RepoCtx = { tx: ctx.tx, tenantId, actorId: ctx.actor.id as string };
  const tz = assertZone((await ctx.core.tenant(ctx)).timezone);
  const businessDate = ymdIn(v.atMs, tz); // step 2

  await bumpCounter(rc, v, businessDate, 'verified_result_events'); // step 3: every non-duplicate event, before the switch gate (D-73)

  const enabledAt = (await getSettings(rc))?.['consumption_enabled_at'] ?? null; // step 5: instant, exact (occurrence >= enable time is processed)
  if (enabledAt === null || v.atMs < new Date(enabledAt).getTime()) return;

  const clock = { tz, nowMs: Date.parse(ctx.now()) };
  const e = { eventId: event.event_id as string };
  // step 6: facts (a) and (b) are independent, (b) is attempted whether or not (a) was new (AC-12.2)
  const testNew = await recordFact(rc, v, e, { kind: 'test', basisKey: testBasisKey(v.orderItemId, v.testId), businessDate, clock });
  await recordFact(rc, v, e, { kind: 'analyte', basisKey: analyteBasisKey(v.resultId), businessDate, clock });
  if (testNew) await bumpCounter(rc, v, businessDate, 'tests_counted'); // step 7: only for a newly inserted test fact
};
