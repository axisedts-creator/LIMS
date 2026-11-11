// T-24 QC hold (03-IC §4.5 holdResultsSince; 02-TRD §6.1; PRD AC-19.4; 01 §2.5). Runs in the caller's tx (ctx.tx); tenant from ctx only.
// Idempotent on (tenant, qcRunId): the INSERT ... ON CONFLICT DO NOTHING is the gate. A concurrent second call waits on the unique index until the first commits and then reads the stored lists,
// so each result is written once. Result rows are locked in id order (02-TRD §3.2). Approved rows are never changed except qc_review_required (lab.enforce_result_lock allows it).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { first, isUuid, query, type RepoCtx } from '../repository/base.repo.js';
import { bad, instant, uuid } from './port.shared.js';

export interface HoldOutput { heldResultIds: string[]; reviewFlaggedResultIds: string[] }
const CODE = /^[A-Za-z0-9_.:^+\-]{1,64}$/;
const MAX_ANALYTES = 100;
const sorted = (v: unknown): string[] => [...((v as string[] | null) ?? [])].sort();

/** `at` falls in an active hold of the (instrument, analyte) pair: new results arrive held (02-TRD §6.1: the hold stays active until released, T-25). */
export const ACTIVE_HOLD_SQL = `SELECT h.id FROM lab.qc_holds h WHERE h.tenant_id = $1 AND h.instrument_id = $2 AND h.status = 'active' AND $3::uuid = ANY(h.analyte_ids) AND h.since <= $4::timestamptz LIMIT 1`;
export async function isOnQcHold(rc: RepoCtx, a: { instrumentId: string; analyteId: string; at: string }): Promise<boolean> {
  return (await first(rc, ACTIVE_HOLD_SQL, [a.instrumentId, a.analyteId, a.at])) !== null;
}

export async function holdResultsSince(rc: RepoCtx, raw: unknown): Promise<HoldOutput> {
  const i = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const instrumentId = uuid(i['instrumentId'], '/instrumentId'), qcRunId = uuid(i['qcRunId'], '/qcRunId'), since = instant(i['since'], '/since');
  const ids = i['analyteIds'];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_ANALYTES || !ids.every((x) => typeof x === 'string' && isUuid(x))) throw bad('/analyteIds');
  const analyteIds = [...new Set((ids as string[]).map((x) => x.toLowerCase()))];
  const reasonCode = i['reasonCode'];
  if (typeof reasonCode !== 'string' || !CODE.test(reasonCode)) throw bad('/reasonCode');

  const holdId = uuidv7();
  const ins = await first(rc, `INSERT INTO lab.qc_holds (id, tenant_id, qc_run_id, instrument_id, analyte_ids, since, reason_code, created_by, updated_by)
      VALUES ($2, $1, $3, $4, $5::uuid[], $6::timestamptz, $7, $8, $8) ON CONFLICT (tenant_id, qc_run_id) DO NOTHING RETURNING id`,
  [holdId, qcRunId, instrumentId, analyteIds, since, reasonCode, rc.actorId]);
  if (!ins) {   // replay: same lists, nothing rewritten
    const row = await first(rc, 'SELECT held_result_ids, review_flagged_result_ids FROM lab.qc_holds WHERE tenant_id = $1 AND qc_run_id = $2', [qcRunId]);
    return { heldResultIds: sorted(row?.['held_result_ids']), reviewFlaggedResultIds: sorted(row?.['review_flagged_result_ids']) };
  }

  // coalesce(instrument_result_time, resulted_at) >= since, same instrument, listed analytes (02-TRD §6.1); pending rows have no value and are not touched
  const mark = (status: string, set: string, extra: unknown[]) => query(rc, `WITH t AS (SELECT id FROM lab.results WHERE tenant_id = $1 AND instrument_id = $2 AND analyte_id = ANY($3::uuid[]) AND status ${status}
        AND coalesce(instrument_result_time, resulted_at) >= $4::timestamptz ORDER BY id FOR UPDATE)
      UPDATE lab.results r SET ${set}, version = r.version + 1, updated_at = now(), updated_by = $5 FROM t WHERE r.tenant_id = $1 AND r.id = t.id RETURNING r.id`,
  [instrumentId, analyteIds, since, rc.actorId, ...extra]);
  const held = (await mark("IN ('resulted','verified')", 'on_hold = true, hold_id = $6', [holdId])).map((r) => r['id'] as string).sort();
  const flagged = (await mark("= 'approved'", 'qc_review_required = true', [])).map((r) => r['id'] as string).sort();
  await query(rc, `UPDATE lab.qc_holds SET held_result_ids = $3::uuid[], review_flagged_result_ids = $4::uuid[], version = version + 1, updated_at = now(), updated_by = $5
      WHERE tenant_id = $1 AND id = $2`, [holdId, held, flagged, rc.actorId]);
  return { heldResultIds: held, reviewFlaggedResultIds: flagged };
}
