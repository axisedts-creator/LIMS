// C12.T-17 shared core of the three `instruments.*.received.v1` consumers (02-TRD §8.1 steps 2, 4-7, §8.2, §8.3, §8.4; 08 A17 D-74, CR-C12-006; 07-SECURITY D-EVT, P-T6, LT-1).
// [CONV] Inbox insert (step 1) and commit/retry (step 8) belong to the C0 wrapper `consumerRun`; nothing here touches it. Any thrown error rolls the whole job transaction back.
// Each consumer reads its own payload fields (D-EVT); this file only holds the fact write, the counters and the switch gate.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { assertZone, ymdIn } from '../../../../../api/src/modules/inventory/domain/tenantTime.js';
import type { FactKind } from '../../../../../api/src/modules/inventory/domain/rules.js';
import { type RepoCtx, query } from '../../../../../api/src/modules/inventory/repository/_base.js';
import { getSettings } from '../../../../../api/src/modules/inventory/repository/settings.repo.js';
import { matchFact, postNeeds, raiseUnresolvedAlert, resolveStore, setFactTotal } from '../../../../../api/src/modules/inventory/service/consumers.service.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** A missing / malformed field the handler uses: thrown BEFORE any write (the job retries, then dead-letters). */
export const reject = (event: string, what: string): never => {
  throw Object.assign(new Error(`${event}: invalid payload field ${what}`), { code: 'common.validation_failed' });
};
export const reqUuid = (event: string, p: Record<string, unknown>, k: string): string => (typeof p[k] === 'string' && UUID.test(p[k] as string) ? (p[k] as string) : reject(event, k));
export const optUuid = (event: string, p: Record<string, unknown>, k: string): string | null => (p[k] === undefined || p[k] === null ? null : reqUuid(event, p, k));
export const reqIso = (event: string, p: Record<string, unknown>, k: string): { iso: string; ms: number } => {
  const v = p[k], ms = typeof v === 'string' && ISO.test(v) ? Date.parse(v) : Number.NaN;
  return Number.isNaN(ms) ? reject(event, k) : { iso: new Date(ms).toISOString(), ms };
};
export const payloadOf = (event: string, e: any): Record<string, unknown> => (e?.payload !== null && typeof e?.payload === 'object' ? e.payload : reject(event, 'payload'));

export interface Job { rc: RepoCtx; ctx: any; tz: string }
/** P-T6 / REQ-SEC-024: an envelope of another tenant writes nothing. Returns null (skip) or the job's repo context + tenant timezone. */
export async function openJob(event: string, e: any, jobCtx: unknown): Promise<Job | null> {
  const ctx = jobCtx as any;
  if (typeof ctx.tenantId !== 'string' || e?.tenant_id !== ctx.tenantId) {
    ctx.log?.warn?.({ event: `${event}_skipped`, reason: 'tenant_mismatch' });
    return null;
  }
  if (typeof e.event_id !== 'string' || !UUID.test(e.event_id)) reject(event, 'event_id');
  return { rc: { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id as string }, ctx, tz: assertZone((await ctx.core.tenant(ctx)).timezone) };
}

/** Step 5: instant, exact (occurrence >= enable time is processed). */
export async function switchIsOn(rc: RepoCtx, atMs: number): Promise<boolean> {
  const enabledAt = (await getSettings(rc))?.['consumption_enabled_at'] ?? null;
  return enabledAt !== null && atMs >= new Date(enabledAt).getTime();
}

/** Step 7 counter: one upsert per (business_date, instrument, test); the unique key is NULLS NOT DISTINCT; the row is created on first use (P-22). */
export const bumpTestCounter = (rc: RepoCtx, a: { businessDate: string; instrumentId: string | null; testId: string; col: 'rerun_events' | 'qc_events' }): Promise<unknown> =>
  query(rc, `INSERT INTO inventory.test_counts_daily (id, tenant_id, business_date, instrument_id, test_id, ${a.col}, created_by, updated_by)
    VALUES ($2::uuid, $1, $3::date, $4::uuid, $5::uuid, 1, $6::uuid, $6::uuid)
    ON CONFLICT (tenant_id, business_date, instrument_id, test_id) DO UPDATE SET ${a.col} = inventory.test_counts_daily.${a.col} + 1, updated_at = now(), updated_by = EXCLUDED.updated_by`,
  [uuidv7(), a.businessDate, a.instrumentId, a.testId, rc.actorId]);

export interface EventFact {
  kind: Extract<FactKind, 'rerun' | 'qc' | 'calibration'>; basisKey: string; eventId: string; eventType: string; instrumentId: string; centreId: string | null;
  testId: string | null; analyteId: string | null; occurredAt: string; businessDate: string; tz: string; nowMs: number;
}
/**
 * TRD §8.1 step 6.1-6.4 for the ONE fact of an instrument event. The row is INSERTed with its FINAL status; the only later UPDATE is the same-status value total.
 * Returns the distinct attributed tests of the matched rules when the fact was newly inserted, null when it already existed.
 */
export async function recordEventFact(rc: RepoCtx, f: EventFact): Promise<string[] | null> {
  const needs = await matchFact(rc, { fact_kind: f.kind, occurred_at: f.occurredAt, instrument_id: f.instrumentId, test_id: f.testId, analyte_id: f.analyteId, multiplier: 1 });
  const tests = [...new Set(needs.map((n) => n.attributed_test_id).filter((t): t is string => t !== null))];
  const storeId = needs.length === 0 ? null : (await resolveStore(rc, { instrument_id: f.instrumentId, centre_id: f.centreId })).store_id; // §8.2 steps 1, 2 (binding, then centre -> branch)
  const status = needs.length === 0 ? 'no_rule' : storeId === null ? 'unresolved' : 'posted';
  const factTest = f.testId ?? (tests.length === 1 ? tests[0]! : null); // QC: the test comes from the matched rule(s); several tests -> NULL, the movements carry each attribution
  const id = uuidv7();
  const ins = await query(rc, `INSERT INTO inventory.consumption_facts (id, tenant_id, fact_kind, basis_key, source, source_event_id, source_event_type, instrument_id, test_id, analyte_id, centre_id,
      occurred_at, business_date, multiplier, store_id, status, rules_applied, value_paisa_total, created_by, updated_by)
    VALUES ($2::uuid, $1, $3, $4, 'event', $5::uuid, $6, $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::timestamptz, $12::date, 1, $13::uuid, $14, $15::integer, 0, $16::uuid, $16::uuid)
    ON CONFLICT (tenant_id, basis_key) DO NOTHING RETURNING id`,
  [id, f.kind, f.basisKey, f.eventId, f.eventType, f.instrumentId, factTest, f.analyteId, f.centreId, f.occurredAt, f.businessDate, storeId, status, needs.length, rc.actorId]);
  if (ins.length === 0) return null; // already there: duplicate / racing twin
  if (status === 'posted') {
    const { rows, total } = await postNeeds(rc, { factId: id, factKind: f.kind, occurredAt: f.occurredAt, businessDate: f.businessDate, storeId: storeId!, instrumentId: f.instrumentId, needs, clock: { tz: f.tz, nowMs: f.nowMs } });
    if (rows.length > 0) await setFactTotal(rc, id, total);
  } else if (status === 'unresolved') await raiseUnresolvedAlert(rc, f.instrumentId); // §8.2 step 6: the job never fails for it
  return tests;
}

export { ymdIn };
