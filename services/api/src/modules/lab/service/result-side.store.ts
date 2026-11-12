// T-24 result-side SQL store of the instrument ingest pipeline (02-TRD §4.5 steps 4-12; 03-IC §10.1/§10.2; 08 A13 D-10, A17.1) — the members `sqlIngestStore` delegates ("core-pipeline store" of T-14/T-16/T-22).
// Every statement binds tenant_id = ctx tenant ($1) and the actor from the closure; UPDATEs of lab.results use `WHERE version = expected` (a lost race = common.version_conflict).
// Specimen roll-up and S4 reuse specimen.service `step` / `emitStatus` (one mechanic for every specimen transition). Runs in ctx.tx only.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import type { DeltaCandidate, DeltaRule } from '../domain/delta.js';
import { rollupSpecimen as rollupStatuses } from '../domain/rollup.js';
import { getActiveDeltaRule } from '../repository/deltaRules.repo.js';
import { getLabSettings } from '../repository/labSettings.repo.js';
import { first, query, type RepoCtx, type RepoTx } from '../repository/base.repo.js';
import { copyProcessingToExistingMaterialTests, startTestsOfSpecimen } from '../repository/orderTests.repo.js';
import { copyProcessingToExistingMaterialResults, copyProcessingToResultsOfSpecimen } from '../repository/results.repo.js';
import { evaluationColumns } from './evaluation.service.js';
import type { IngestStore } from './ingest.service.js';
import { isOnQcHold } from './qc.service.js';
import { labCtx, rcOf, type Obj, type PortCtx } from './port.shared.js';
import type { CriticalLogInput, EntryRow, VerifyRow } from './result.service.js';
import { emitStatus, step } from './specimen.service.js';

const SPECIMEN_STAMP: Readonly<Record<string, string>> = { in_process: 'in_process_at', resulted: 'first_resulted_at', verified: 'first_verified_at', approved: 'all_approved_at' };

/** Specimen status = min over its non-cancelled results (domain/rollup.ts); one S-transition + one lab.specimen.status_changed.v1 per status passed through. Locks the specimen after its results (02-TRD §3.2). */
export async function rollupOf(c: PortCtx, specimenId: string, sc: any = labCtx(c)): Promise<void> {   // sc: a handler ctx (its own events / Date clock) when called from a request (LD-124)
  const rc = rcOf(c);
  const s = await first(rc, 'SELECT * FROM lab.specimens WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [specimenId]);
  if (!s) return;
  const statuses = (await query(rc, 'SELECT status FROM lab.results WHERE tenant_id = $1 AND specimen_id = $2', [specimenId])).map((r) => r['status']);
  const at = new Date(sc.now()).toISOString();
  let cur: Obj = s;
  for (const to of rollupStatuses(s['status'], statuses)) {
    const col = SPECIMEN_STAMP[to];
    const { updated } = await step(sc, cur, Number(cur['version']), to, col && cur[col] == null ? { [col]: at } : {}, at);
    await emitStatus(sc, updated, cur['status'], to, at);
    cur = updated;
  }
}

/** lab.critical_value_log row (id = critical_event_id) + results.critical_event_id. Dedupe is (result, version, value hash): callers check criticalAction first. */
export async function insertCriticalLogRow(rc: RepoCtx, a: CriticalLogInput): Promise<{ criticalEventId: string }> {
  const id = uuidv7();
  await query(rc, `INSERT INTO lab.critical_value_log (id, tenant_id, centre_id, result_id, result_version_no, order_id, patient_id, analyte_id, referrer_id, direction, value_sha256_prefix16,
        value_numeric, value_text, ordinal_code, critical_limit_id, critical_limit_version, detected_at, created_by, updated_by)
      VALUES ($2, $1, $3, $4, $5, $6, $7, $8, (SELECT o.referrer_id FROM lab.orders o WHERE o.tenant_id = $1 AND o.id = $6), $9, $10, $11, $12, $13, $14, $15, $16::timestamptz, $17, $17)`,
  [id, a.centreId, a.resultId, a.resultVersionNo, a.orderId, a.patientId, a.analyteId, a.direction, a.valueSha256Prefix16, a.value.numeric ?? null, a.value.text ?? null,
    a.value.ordinalCode ?? null, a.criticalLimitId ?? null, a.criticalLimitVersion ?? null, a.detectedAt, rc.actorId]);
  await query(rc, `UPDATE lab.results SET critical_event_id = $3, version = version + 1, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND id = $2 AND status <> 'approved'`, [a.resultId, id, rc.actorId]);
  return { criticalEventId: id };
}

export const entryRow = (r: Obj): EntryRow => ({
  resultId: r['id'], rowVersion: Number(r['version']), status: r['status'], orderId: r['order_id'], orderItemId: r['order_item_id'], specimenId: r['specimen_id'] ?? undefined, patientId: r['patient_id'],
  testId: r['test_id'], analyteId: r['analyte_id'], centreId: r['centre_id'], currentVersionNo: Number(r['current_version_no']), sex: r['patient_sex'] ?? 'unknown', patientAgeDays: r['patient_age_days'] ?? null,
  ...(r['specimen_type_code'] ? { specimenTypeCode: r['specimen_type_code'] } : {}), ...(r['collected_at'] ? { collectedAt: new Date(r['collected_at']) } : {}), ...(r['unit_code'] ? { unitCode: r['unit_code'] } : {}),
  departmentId: r['department_id'],
  // the catalog (not lab tables) owns formulas and decimals: a calculated analyte is recognised by its calc_status, reporting decimals are not enforced on a device value (ingest.service)
  analyte: { id: r['analyte_id'], code: r['analyte_code'], resultType: r['result_type'], formula: r['calc_status'] === 'not_applicable' ? null : { expression: '' } },
});

/** the members of IngestStore that are not ingest-table SQL; `sqlIngestStore(actorId, resultSideStore(c))` is the production store of the port path */
export function resultSideStore(c: PortCtx): Partial<IngestStore> {
  const rc = (tx: unknown, tenantId: string): RepoCtx => ({ tx: tx as RepoTx, tenantId, actorId: c.actor.id });
  return {
    async lockSpecimenResults(tx, t, specimenId) {
      return (await query(rc(tx, t), `SELECT r.*, o.patient_sex, o.patient_age_days, s.specimen_type_code, s.collected_at FROM lab.results r
          JOIN lab.orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id LEFT JOIN lab.specimens s ON s.tenant_id = r.tenant_id AND s.id = r.specimen_id
          WHERE r.tenant_id = $1 AND r.specimen_id = $2 AND r.status <> 'cancelled' ORDER BY r.id FOR UPDATE OF r`, [specimenId])).map(entryRow);
    },

    /** S4 as system (03-IC §10.1): same effects as the receive action (specimen.service move), processing centre = the instrument's centre. */
    async receiveSpecimen(tx, t, a) {
      const r = rc(tx, t), sc = labCtx(c);
      const row = await first(r, 'SELECT * FROM lab.specimens WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [a.specimenId]);
      const branch = await first(r, 'SELECT branch_id FROM core.collection_centres WHERE tenant_id = $1 AND id = $2', [a.processingCentreId]);
      if (!row || !branch) throw new LimsError('common.internal');
      const p = { centreId: a.processingCentreId, branchId: branch['branch_id'] as string };
      const { updated } = await step(sc, row, Number(row['version']), 'received', { received_at: a.occurredAt, processing_centre_id: p.centreId, processing_branch_id: p.branchId }, a.occurredAt);
      await startTestsOfSpecimen(r, a.specimenId, { ...p, receivedAt: a.occurredAt });
      await copyProcessingToResultsOfSpecimen(r, a.specimenId, p);
      await copyProcessingToExistingMaterialTests(r, row['order_id'], p);
      await copyProcessingToExistingMaterialResults(r, row['order_id'], p);
      await emitStatus(sc, updated, row['status'], 'received', a.occurredAt);
    },

    isOnQcHold: (tx, t, a) => isOnQcHold(rc(tx, t), a),

    /** R2 (pending -> resulted) / R3 (resulted -> resulted): the value, the evaluation outputs, hold, unit flag; plus the append-only observation row. */
    async saveInstrumentResult(tx, t, a) {
      const r = rc(tx, t);
      const v = a.value;
      const cols: Record<string, unknown> = {
        status: 'resulted', origin: 'instrument', value_numeric: v.numeric ?? null, value_text: v.text ?? null, ordinal_code: v.ordinalCode ?? null, instrument_id: a.instrumentId,
        instrument_flags: [...a.instrumentFlags], instrument_result_time: a.instrumentResultTime ?? null, on_hold: a.onHold, unit_mismatch: a.unitMismatch, resulted_at: a.receivedAt,
        ...(a.unitCode === undefined ? {} : { unit_code: a.unitCode }),
      };
      if (a.evaluation) { const e = evaluationColumns(a.evaluation, a.transition); e.cols.forEach((k, n) => { cols[k] = e.values[n]; }); }
      const keys = Object.keys(cols);
      const set = keys.map((k, n) => `${k} = $${n + 4}`).join(', ');
      const k = keys.length;
      const row = await first(r, `UPDATE lab.results r SET ${set}, first_resulted_at = COALESCE(r.first_resulted_at, $${k + 4}::timestamptz), version = r.version + 1, updated_at = now(), updated_by = $${k + 5},
          hold_id = CASE WHEN $${k + 6}::boolean THEN (SELECT h.id FROM lab.qc_holds h WHERE h.tenant_id = r.tenant_id AND h.instrument_id = $${k + 7} AND h.status = 'active'
                                                        AND r.analyte_id = ANY(h.analyte_ids) AND h.since <= $${k + 8}::timestamptz LIMIT 1) ELSE r.hold_id END
        WHERE r.tenant_id = $1 AND r.id = $2 AND r.version = $3 RETURNING r.*`,
      [a.resultId, a.expectedRowVersion, ...keys.map((x) => cols[x]), a.receivedAt, r.actorId, a.onHold, a.instrumentId, a.instrumentResultTime ?? a.receivedAt]);
      if (!row) throw new LimsError('common.version_conflict');
      await query(r, `INSERT INTO lab.result_observations (id, tenant_id, centre_id, processing_centre_id, result_id, source, value_numeric, value_text, ordinal_code, unit_code, value_raw, unit_raw,
            instrument_id, instrument_message_id, instrument_flags, instrument_result_time, received_at, is_rerun, created_by)
          VALUES ($2, $1, $3, $4, $5, 'instrument', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz, $16::timestamptz, $17, $18)`,
      [uuidv7(), row['centre_id'], row['processing_centre_id'], a.resultId, v.numeric ?? null, v.text ?? null, v.ordinalCode ?? null, a.unitCode ?? null, a.valueRaw ?? null, a.unitRaw ?? null,
        a.instrumentId, a.instrumentMessageId, [...a.rawInstrumentFlags], a.instrumentResultTime ?? null, a.receivedAt, a.isRerun, r.actorId]);
      return row;
    },

    async insertAttachment(tx, t, a) {
      await query(rc(tx, t), `INSERT INTO lab.result_attachments (id, tenant_id, centre_id, processing_centre_id, result_id, bucket, object_path, sha256, mime_type, created_by)
          SELECT $2::uuid, r.tenant_id, r.centre_id, r.processing_centre_id, r.id, $4::text, $5::text, $6::text, $7::text, $8::uuid FROM lab.results r WHERE r.tenant_id = $1 AND r.id = $3
          ON CONFLICT (tenant_id, result_id, sha256) DO NOTHING`, [uuidv7(), a.resultId, a.bucket, a.objectPath, a.sha256, a.mimeType, c.actor.id]);
    },

    async deltaInputs(tx, t, row) {
      const r = rc(tx, t);
      const settings = await getLabSettings(r);
      const rule = settings?.['delta_check_enabled'] === false ? null : await getActiveDeltaRule(r, row.analyteId);
      if (!rule) return { candidates: [] };
      const prev = await query(r, `SELECT c.id, c.cur_value_numeric AS value, c.cur_unit_code AS unit_code, c.cur_approved_at AS approved_at FROM lab.v_result_current c
          WHERE c.tenant_id = $1 AND c.patient_id = $2 AND c.analyte_id = $3 AND c.status = 'approved' AND c.cur_value_numeric IS NOT NULL AND c.id <> $4
          ORDER BY c.cur_approved_at DESC LIMIT 10`, [row.patientId, row.analyteId, row.resultId]);
      const delta: DeltaRule = {
        ruleId: rule['rule_id'], ruleVersion: Number(rule['rule_version']), windowSeconds: Number(rule['window_seconds']),
        ...(rule['abs_threshold'] == null ? {} : { absThreshold: String(rule['abs_threshold']) }), ...(rule['pct_threshold'] == null ? {} : { pctThreshold: String(rule['pct_threshold']) }),
      };
      const candidates: DeltaCandidate[] = prev.map((p) => ({ resultId: p['id'], value: String(p['value']), ...(p['unit_code'] ? { unitCode: p['unit_code'] } : {}), approvedAt: new Date(p['approved_at']) }));
      return { rule: delta, candidates };
    },

    async listCriticalLog(tx, t, resultId) {
      return (await query(rc(tx, t), 'SELECT value_sha256_prefix16, status FROM lab.critical_value_log WHERE tenant_id = $1 AND result_id = $2', [resultId]))
        .map((x) => ({ valueSha256Prefix16: x['value_sha256_prefix16'], status: x['status'] }));
    },
    insertCriticalLog: (tx, t, a) => insertCriticalLogRow(rc(tx, t), a),
    async markCriticalValueChanged(tx, t, resultId) {
      await query(rc(tx, t), `UPDATE lab.critical_value_log SET value_changed_after_detection = true, version = version + 1, updated_at = now(), updated_by = $3
          WHERE tenant_id = $1 AND result_id = $2 AND status <> 'closed'`, [resultId, c.actor.id]);
    },

    // ---- auto-verify hook (LIMS_LAB_AUTOVERIFY_HOOK_ENABLED, CR-C9-004): only reached when the flag is on
    async lockForVerify(tx, t, ids) {
      return (await query(rc(tx, t), 'SELECT * FROM lab.results WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE', [ids])).map((r): VerifyRow => ({
        resultId: r['id'], rowVersion: Number(r['version']), status: r['status'], onHold: r['on_hold'], unitMismatch: r['unit_mismatch'], deltaStatus: r['delta_status'], isCritical: r['is_critical'],
        instrumentFlags: r['instrument_flags'] ?? [], origin: r['origin'], rangeUnavailableAgeUnknown: r['range_unavailable_age_unknown'], orderId: r['order_id'], orderItemId: r['order_item_id'],
        specimenId: r['specimen_id'] ?? undefined, testId: r['test_id'], analyteId: r['analyte_id'], departmentId: r['department_id'], instrumentId: r['instrument_id'] ?? undefined, centreId: r['centre_id'],
        currentVersionNo: Number(r['current_version_no']), flag: r['flag'] ?? undefined, valueNumeric: r['value_numeric'] ?? undefined, resultedAt: new Date(r['resulted_at']),
      }));
    },
    async verify(tx, t, a) {
      const r = rc(tx, t);
      const row = await first(r, `UPDATE lab.results SET status = 'verified', verified_at = $4::timestamptz, verified_by_membership_id = $5, version = version + 1, updated_at = now(), updated_by = $6
          WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`, [a.resultId, a.expectedRowVersion, a.occurredAt, a.membershipId ?? null, r.actorId]);
      if (!row) throw new LimsError('common.version_conflict');
      await query(r, `INSERT INTO lab.verifications (id, tenant_id, centre_id, processing_centre_id, result_id, kind, mode, result_row_version, acknowledged_flags, membership_id, autoverify_rule_set_version, occurred_at, created_by)
          VALUES ($2, $1, $3, $4, $5, 'verified', $6, $7, $8, $9, $10, $11::timestamptz, $12)`,
      [uuidv7(), row['centre_id'], row['processing_centre_id'], a.resultId, a.mode, a.expectedRowVersion, [...a.acknowledgedFlags], a.membershipId ?? null, a.ruleSetVersion ?? null, a.occurredAt, r.actorId]);
      return row;
    },
    rollupSpecimen: (_tx, _t, specimenId) => rollupOf(c, specimenId),
  };
}
