// Result-side production store (LD-124, 2026-11-12, C5 T-32): the seams of resultEntry (EntryStore + getOrderResults), verify (VerifyStore), approve / amend
// (ApproveStore, AmendStore, ReadinessStore) and history (listResultHistory) over the lab tables. Runs on the caller's ctx.tx only; tenant = the `tenantId`
// argument ($1 of every statement, REQ-SEC-024) and RLS stays the guard. Members already written for the ingest path are reused from service/result-side.store.ts.
// The roll-up publishes lab.specimen.status_changed.v1 through the handler ctx (its events / clock), exactly as the specimen actions do.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { groupTests, specimenDto } from '../mappers/specimen.mapper.js';
import { isUuid, type RepoCtx } from '../repository/base.repo.js';
import { getLabSettings } from '../repository/labSettings.repo.js';
import { listTestsOfSpecimens } from '../repository/specimens.repo.js';
import { evaluationColumns } from '../service/evaluation.service.js';
import type { PortCtx } from '../service/port.shared.js';
import type { AmendRow, ApproveRow, ResultRow, SaveEntryInput } from '../service/result.service.js';
import { entryRow, resultSideStore, rollupOf } from '../service/result-side.store.js';
import { criticalStore } from './critical.store.js';
import { rcOf, sql } from './scope.js';

type Obj = Record<string, any>;
/** What the store needs from the handler ctx: actor, clock and event publisher for the roll-up / ingest members. */
export interface StoreCtx { tenantId: string; requestId?: string; tx: unknown; now(): Date; actor: { type?: string; id: string; membershipId?: string }; events?: unknown; ports?: any }

const uuids = (ids: readonly unknown[]): string[] => [...new Set(ids.filter(isUuid))];
const one = async (tx: unknown, t: string, text: string, v: readonly unknown[] = []): Promise<Obj | undefined> => (await sql(tx, t, text, v))[0];
const notApplicable = (): never => { throw new LimsError('common.internal'); };

async function current(tx: unknown, t: string, ids: readonly unknown[]): Promise<ResultRow[]> {
  const ok = uuids(ids);
  return ok.length ? sql(tx, t, 'SELECT * FROM lab.v_result_current WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id', [ok]) : [];
}

async function lockEntryRows(tx: unknown, t: string, ids: readonly unknown[]) {
  const ok = uuids(ids).sort();   // 02-TRD §3.2 lock order
  if (!ok.length) return [];
  return (await sql(tx, t, `SELECT r.*, o.patient_sex, o.patient_age_days, s.specimen_type_code, s.collected_at FROM lab.results r
      JOIN lab.orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id LEFT JOIN lab.specimens s ON s.tenant_id = r.tenant_id AND s.id = r.specimen_id
      WHERE r.tenant_id = $1 AND r.id = ANY($2::uuid[]) ORDER BY r.id FOR UPDATE OF r`, [ok])).map(entryRow);
}

/** LabOrderDto (lab.yaml): order header, its specimens (SpecimenDto) and order tests. Shared by getOrderResults and getLabOrder. */
export async function labOrderDto(rc: RepoCtx, order: Obj): Promise<Obj> {
  const specimens = await sql(rc.tx, rc.tenantId, `SELECT s.*, o.registration_no FROM lab.specimens s JOIN lab.orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id
      WHERE s.tenant_id = $1 AND s.order_id = $2 ORDER BY s.created_at, s.id`, [order['id']]);
  const tests = groupTests(await listTestsOfSpecimens(rc, specimens.map((s) => s['id'])));
  const ots = await sql(rc.tx, rc.tenantId, 'SELECT * FROM lab.order_tests WHERE tenant_id = $1 AND order_id = $2 ORDER BY order_item_id, test_code, id', [order['id']]);
  return {
    order_id: order['id'], registration_no: order['registration_no'],
    specimens: specimens.map((s) => specimenDto(s, tests.get(s['id']) ?? [])),
    order_tests: ots.map((o) => Object.fromEntries(Object.entries({ id: o['id'], order_item_id: o['order_item_id'], test_id: o['test_id'], test_code: o['test_code'],
      specimen_id: o['specimen_id'], status: o['status'], priority: o['priority'] }).filter(([, v]) => v !== null && v !== undefined))),
  };
}

export function resultsStore(ctx?: StoreCtx) {
  /** PortCtx view of the handler ctx for the shared ingest-path members (string clock as the port path). */
  const port = (): PortCtx => {
    if (!ctx || typeof ctx.now !== 'function' || typeof ctx.actor?.id !== 'string') throw new LimsError('common.internal');   // fail closed: no request ctx
    return { tenantId: ctx.tenantId, requestId: ctx.requestId ?? '', tx: ctx.tx as never, now: () => ctx.now().toISOString(), actor: { type: ctx.actor.type ?? 'user', ...ctx.actor }, ports: ctx.ports };
  };
  const side = () => resultSideStore(port()) as Required<ReturnType<typeof resultSideStore>>;
  const crit = criticalStore();

  return {
    // ---------------------------------------------------------------- reads (T-14 #23 / #16, T-19)
    getResults: (tx: unknown, t: string, ids: readonly string[]) => current(tx, t, ids),

    async getOrderResults(tx: unknown, t: string, a: { orderId: string; departmentId?: string }) {
      if (!isUuid(a.orderId)) return undefined;
      const order = await one(tx, t, 'SELECT * FROM lab.orders WHERE tenant_id = $1 AND id = $2', [a.orderId]);
      if (!order) return undefined;
      const dept = a.departmentId;
      const ots = dept !== undefined && !isUuid(dept) ? [] : await sql(tx, t, `SELECT * FROM lab.order_tests WHERE tenant_id = $1 AND order_id = $2${dept === undefined ? '' : ' AND department_id = $3'}
          ORDER BY order_item_id, test_code, id`, dept === undefined ? [a.orderId] : [a.orderId, dept]);
      const results = await sql(tx, t, 'SELECT * FROM lab.v_result_current WHERE tenant_id = $1 AND order_id = $2 ORDER BY order_test_id, analyte_code, id', [a.orderId]);
      return {
        order: await labOrderDto(await rcOf(tx, t), order), centreId: order['centre_id'] as string,
        items: ots.map((o) => ({ orderItemId: o['order_item_id'], testId: o['test_id'], testCode: o['test_code'], results: results.filter((r) => r['order_test_id'] === o['id']) })),
      };
    },

    /** T-19: approved results of the patient + analyte, newest approval first, latest version values (cur_*). */
    async listResultHistory(tx: unknown, t: string, a: { patientId: string; analyteId: string; limit: number }) {
      if (!isUuid(a.patientId) || !isUuid(a.analyteId) || !Number.isInteger(a.limit) || a.limit < 1 || a.limit > 200) return [];
      return sql(tx, t, `SELECT * FROM lab.v_result_current WHERE tenant_id = $1 AND patient_id = $2 AND analyte_id = $3 AND status = 'approved'
          ORDER BY approved_at DESC, id LIMIT $4`, [a.patientId, a.analyteId, a.limit]);
    },

    // ---------------------------------------------------------------- entry (T-14)
    lockResults: (tx: unknown, t: string, ids: readonly string[]) => lockEntryRows(tx, t, ids),
    deltaInputs: (tx: unknown, t: string, row: any) => side().deltaInputs(tx, t, row),
    listCriticalLog: (tx: unknown, t: string, id: string) => side().listCriticalLog(tx, t, id),
    insertCriticalLog: (tx: unknown, t: string, a: any) => side().insertCriticalLog(tx, t, a),
    markCriticalValueChanged: (tx: unknown, t: string, id: string) => side().markCriticalValueChanged(tx, t, id),
    rollupSpecimen: (_tx: unknown, _t: string, specimenId: string) => rollupOf(port(), specimenId, ctx),

    async saveEntry(tx: unknown, t: string, a: SaveEntryInput): Promise<ResultRow> {
      const rc = await rcOf(tx, t);
      const cols: Obj = { origin: a.origin };
      if (a.manualAbnormal !== undefined) cols['manual_abnormal'] = a.manualAbnormal;
      if (a.commentCodes !== undefined) cols['comment_codes'] = [...a.commentCodes];
      if (a.commentLibVersions !== undefined) cols['comment_lib_versions'] = JSON.stringify(a.commentLibVersions);
      if (a.commentText !== undefined) cols['comment_text'] = a.commentText;
      if (a.value) {
        Object.assign(cols, { status: 'resulted', value_numeric: a.value.numeric ?? null, value_text: a.value.text ?? null, ordinal_code: a.value.ordinalCode ?? null });
        if (a.evaluation && a.transition) { const e = evaluationColumns(a.evaluation, a.transition); e.cols.forEach((k, n) => { cols[k] = e.values[n]; }); }
      }
      const keys = Object.keys(cols);
      const k = keys.length;
      const stamp = a.value ? `, resulted_at = now(), first_resulted_at = COALESCE(first_resulted_at, now())` : '';
      const row = await one(tx, t, `UPDATE lab.results SET ${keys.map((c, n) => `${c} = $${n + 4}`).join(', ')}${stamp}, version = version + 1, updated_at = now(), updated_by = $${k + 4}
          WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`, [a.resultId, a.expectedRowVersion, ...keys.map((c) => cols[c]), rc.actorId]);
      if (!row) throw new LimsError('common.version_conflict');
      if (a.value) {
        await sql(tx, t, `INSERT INTO lab.result_observations (id, tenant_id, centre_id, processing_centre_id, result_id, source, value_numeric, value_text, ordinal_code, unit_code,
            received_at, entered_by_membership_id, created_by) VALUES ($2, $1, $3, $4, $5, 'manual', $6, $7, $8, $9, now(), $10, $11)`,
        [uuidv7(), row['centre_id'], row['processing_centre_id'], a.resultId, a.value.numeric ?? null, a.value.text ?? null, a.value.ordinalCode ?? null, row['unit_code'] ?? null,
          a.enteredByMembershipId ?? null, rc.actorId]);
      }
      return row;
    },

    // T-13 recompute: the formula expressions live in the catalog (CatalogPort), not in lab tables. ponytail: fail closed (500) when an order item HAS calculated
    // analytes, instead of silently skipping their recompute; wire the catalog formula read here when the CatalogPort exposes it to the store.
    async listCalculatedTargets(tx: unknown, t: string, orderItemId: string) {
      if (!isUuid(orderItemId)) return [];
      const n = await one(tx, t, `SELECT count(*)::int AS n FROM lab.results WHERE tenant_id = $1 AND order_item_id = $2 AND calc_status <> 'not_applicable'`, [orderItemId]);
      if (Number(n?.['n'] ?? 0) > 0) throw new LimsError('common.internal');
      return [];
    },
    listInputs: notApplicable as (tx: unknown, t: string, id: string) => Promise<never>,
    inputUnitByCode: notApplicable as (tx: unknown, t: string, id: string) => Promise<never>,
    applyComputed: notApplicable as (tx: unknown, t: string, a: unknown) => Promise<never>,
    amendCalculated: notApplicable as (tx: unknown, t: string, a: unknown) => Promise<never>,

    // ---------------------------------------------------------------- verify / return (T-16)
    lockForVerify: (tx: unknown, t: string, ids: readonly string[]) => side().lockForVerify(tx, t, uuids(ids).sort()),
    verify: (tx: unknown, t: string, a: any) => side().verify(tx, t, a),

    async applyReturn(tx: unknown, t: string, a: { resultId: string; expectedRowVersion: number; reasonCode: string; comment?: string; membershipId?: string; occurredAt: string }) {
      const rc = await rcOf(tx, t);
      const row = await one(tx, t, `UPDATE lab.results SET status = 'resulted', verified_at = NULL, verified_by_membership_id = NULL, version = version + 1, updated_at = now(), updated_by = $4
          WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`, [a.resultId, a.expectedRowVersion, rc.actorId]);
      if (!row) throw new LimsError('common.version_conflict');
      await sql(tx, t, `INSERT INTO lab.verifications (id, tenant_id, centre_id, processing_centre_id, result_id, kind, mode, result_row_version, reason_code, comment, membership_id, occurred_at, created_by)
          VALUES ($2, $1, $3, $4, $5, 'returned', 'manual', $6, $7, $8, $9, $10::timestamptz, $11)`,
      [uuidv7(), row['centre_id'], row['processing_centre_id'], a.resultId, a.expectedRowVersion, a.reasonCode, a.comment ?? null, a.membershipId ?? null, a.occurredAt, rc.actorId]);
      return row;
    },
    returnReasonActive: (tx: unknown, t: string, code: string) => activeCode(tx, t, 'return', code),
    async resolveUnitMismatchException(tx: unknown, t: string, a: { resultId: string; resolverMembershipId?: string; resolution: 'assigned' }) {
      const rc = await rcOf(tx, t);
      await sql(tx, t, `UPDATE lab.ingest_exceptions SET status = 'resolved', resolution = $3, resolved_at = now(), resolved_by_membership_id = $4, version = version + 1, updated_at = now(), updated_by = $5
          WHERE tenant_id = $1 AND result_id = $2 AND reason = 'unit_mismatch' AND status = 'open'`, [a.resultId, a.resolution, a.resolverMembershipId ?? null, rc.actorId]);
    },

    // ---------------------------------------------------------------- approve (T-17)
    async lockForApprove(tx: unknown, t: string, ids: readonly string[]): Promise<ApproveRow[]> {
      const ok = uuids(ids).sort();
      if (!ok.length) return [];
      return (await sql(tx, t, 'SELECT * FROM lab.results WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE', [ok])).map((r) => ({
        resultId: r['id'], rowVersion: Number(r['version']), status: r['status'], onHold: Boolean(r['on_hold']), origin: r['origin'], orderId: r['order_id'], orderItemId: r['order_item_id'],
        specimenId: r['specimen_id'] ?? undefined, testId: r['test_id'], analyteId: r['analyte_id'], departmentId: r['department_id'], centreId: r['centre_id'],
        currentVersionNo: Number(r['current_version_no']), verifiedByMembershipId: r['verified_by_membership_id'] ?? undefined,
      }));
    },

    /** R6: status approved + immutable result_versions v1 (a copy of the row's value / evaluation columns) + lab.approvals (approval, aal2). */
    async approve(tx: unknown, t: string, a: { resultId: string; expectedRowVersion: number; membershipId: string; occurredAt: string }): Promise<ResultRow> {
      const rc = await rcOf(tx, t);
      const row = await one(tx, t, `UPDATE lab.results SET status = 'approved', approved_at = $4::timestamptz, approved_by_membership_id = $5, current_version_no = 1, version = version + 1,
          updated_at = now(), updated_by = $6 WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`, [a.resultId, a.expectedRowVersion, a.occurredAt, a.membershipId, rc.actorId]);
      if (!row) throw new LimsError('common.version_conflict');
      await sql(tx, t, `INSERT INTO lab.result_versions (id, tenant_id, centre_id, processing_centre_id, result_id, version_no, origin, value_numeric, value_text, ordinal_code, unit_code, flag,
            ref_range_id, ref_range_version, ref_low, ref_high, ref_text, range_unavailable_age_unknown, is_critical, delta_status, delta_rule_id, delta_rule_version, delta_prev_result_id,
            delta_prev_value, delta_prev_at, delta_abs, delta_pct, critical_event_id, comment_codes, comment_lib_versions, comment_text, formula_provenance, approved_at, approved_by_membership_id,
            created_by, updated_by)
          SELECT $3, r.tenant_id, r.centre_id, r.processing_centre_id, r.id, 1, r.origin, r.value_numeric, r.value_text, r.ordinal_code, r.unit_code, r.flag, r.ref_range_id, r.ref_range_version,
            r.ref_low, r.ref_high, r.ref_text, r.range_unavailable_age_unknown, r.is_critical, r.delta_status, r.delta_rule_id, r.delta_rule_version, r.delta_prev_result_id, r.delta_prev_value,
            r.delta_prev_at, r.delta_abs, r.delta_pct, r.critical_event_id, r.comment_codes, r.comment_lib_versions, r.comment_text, r.formula_provenance, $4::timestamptz, $5, $6, $6
          FROM lab.results r WHERE r.tenant_id = $1 AND r.id = $2`, [a.resultId, uuidv7(), a.occurredAt, a.membershipId, rc.actorId]);
      await sql(tx, t, `INSERT INTO lab.approvals (id, tenant_id, centre_id, processing_centre_id, result_id, version_no, kind, membership_id, aal, occurred_at, created_by)
          VALUES ($2, $1, $3, $4, $5, 1, 'approval', $6, 'aal2', $7::timestamptz, $8)`, [uuidv7(), row['centre_id'], row['processing_centre_id'], a.resultId, a.membershipId, a.occurredAt, rc.actorId]);
      return (await current(tx, t, [a.resultId]))[0] ?? row;
    },
    async hasUnconfirmedCritical(tx: unknown, t: string, resultId: string) {
      return Boolean(await one(tx, t, `SELECT 1 AS x FROM lab.critical_value_log c WHERE c.tenant_id = $1 AND c.result_id = $2 AND c.status IN ('open','notified')
          AND NOT EXISTS (SELECT 1 FROM lab.critical_notifications n WHERE n.tenant_id = c.tenant_id AND n.critical_event_id = c.id AND n.outcome = 'reached' AND n.read_back_confirmed)`, [resultId]));
    },
    async getLabSettings(tx: unknown, t: string) {
      const s = await getLabSettings(await rcOf(tx, t));
      return { criticalNotificationBlocksApproval: s?.['critical_notification_blocks_approval'] !== false };   // absent row: the safe default (blocks)
    },
    closeOpenCriticalEvents: (tx: unknown, t: string, a: { resultId: string; closedAt: string }) => crit.closeOpenCriticalEvents(tx, t, a),

    // ---------------------------------------------------------------- amend / versions (T-17)
    async lockForAmend(tx: unknown, t: string, ids: readonly string[]): Promise<AmendRow[]> {
      const rows = await lockEntryRows(tx, t, ids);
      const cur = new Map((await current(tx, t, rows.map((r) => r.resultId))).map((r) => [r['id'], r]));
      return rows.map((r) => {
        const c = cur.get(r.resultId) ?? {};
        const pick = (k: string) => (`cur_${k}` in c && c['status'] === 'approved' ? c[`cur_${k}`] : c[k]);
        const v = { numeric: pick('value_numeric'), text: pick('value_text'), ordinalCode: pick('ordinal_code') };
        return { ...r, currentValue: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, String(x)])) };
      });
    },
    amendReasonActive: (tx: unknown, t: string, code: string) => activeCode(tx, t, 'amendment', code),

    /** R7: new result_versions v(n+1) (evaluation bound at INSERT), v(n) superseded, results.current_version_no := n+1, lab.approvals (amendment). Value columns of results untouched. */
    async amendResult(tx: unknown, t: string, a: { resultId: string; expectedRowVersion: number; previousVersionNo: number; newVersionNo: number; value: { numeric?: string; text?: string; ordinalCode?: string };
      evaluation: any; commentCodes?: readonly string[]; commentText?: string; reasonCode: string; reasonText?: string; membershipId: string; occurredAt: string }): Promise<ResultRow> {
      const rc = await rcOf(tx, t);
      const row = await one(tx, t, `UPDATE lab.results SET current_version_no = $4, version = version + 1, updated_at = now(), updated_by = $5
          WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`, [a.resultId, a.expectedRowVersion, a.newVersionNo, rc.actorId]);
      if (!row) throw new LimsError('common.version_conflict');
      const cols: Obj = {
        id: uuidv7(), centre_id: row['centre_id'], processing_centre_id: row['processing_centre_id'], result_id: a.resultId, version_no: a.newVersionNo, origin: row['origin'],
        value_numeric: a.value.numeric ?? null, value_text: a.value.text ?? null, ordinal_code: a.value.ordinalCode ?? null, unit_code: row['unit_code'],
        comment_codes: a.commentCodes === undefined ? null : [...a.commentCodes], comment_text: a.commentText ?? null, approved_at: a.occurredAt, approved_by_membership_id: a.membershipId,
        previous_version_no: a.previousVersionNo, amendment_reason_code: a.reasonCode, amendment_reason_text: a.reasonText ?? null, created_by: rc.actorId, updated_by: rc.actorId,
      };
      const e = evaluationColumns(a.evaluation, 'R7');
      e.cols.forEach((k, n) => { cols[k] = e.values[n]; });
      const keys = Object.keys(cols);
      await sql(tx, t, `INSERT INTO lab.result_versions (tenant_id, ${keys.join(', ')}) VALUES ($1, ${keys.map((_, n) => `$${n + 2}`).join(', ')})`, keys.map((k) => cols[k]));
      await sql(tx, t, `UPDATE lab.result_versions SET superseded_at = $4::timestamptz, superseded_by_version_no = $5, version = version + 1, updated_at = now(), updated_by = $6
          WHERE tenant_id = $1 AND result_id = $2 AND version_no = $3`, [a.resultId, a.previousVersionNo, a.occurredAt, a.newVersionNo, rc.actorId]);
      await sql(tx, t, `INSERT INTO lab.approvals (id, tenant_id, centre_id, processing_centre_id, result_id, version_no, kind, membership_id, aal, occurred_at, created_by)
          VALUES ($2, $1, $3, $4, $5, $6, 'amendment', $7, 'aal2', $8::timestamptz, $9)`,
      [uuidv7(), row['centre_id'], row['processing_centre_id'], a.resultId, a.newVersionNo, a.membershipId, a.occurredAt, rc.actorId]);
      return (await current(tx, t, [a.resultId]))[0] ?? row;
    },
    async listResultVersions(tx: unknown, t: string, resultId: string) {
      if (!isUuid(resultId)) return undefined;
      const r = await one(tx, t, 'SELECT centre_id FROM lab.results WHERE tenant_id = $1 AND id = $2', [resultId]);
      if (!r) return undefined;
      return { centreId: r['centre_id'] as string, versions: await sql(tx, t, 'SELECT * FROM lab.result_versions WHERE tenant_id = $1 AND result_id = $2 ORDER BY version_no', [resultId]) };
    },

    // ---------------------------------------------------------------- readiness (T-17, order.service evaluateOrderReadiness)
    async lockReadiness(tx: unknown, t: string, orderId: string) {
      const rc = await rcOf(tx, t);
      await sql(tx, t, 'INSERT INTO lab.order_readiness (tenant_id, order_id, created_by, updated_by) VALUES ($1, $2, $3, $3) ON CONFLICT (tenant_id, order_id) DO NOTHING', [orderId, rc.actorId]);
      const r = await one(tx, t, 'SELECT * FROM lab.order_readiness WHERE tenant_id = $1 AND order_id = $2 FOR UPDATE', [orderId]);
      if (!r) throw new LimsError('common.internal');
      return { readinessSeq: Number(r['readiness_seq']), lastEmittedHash: r['last_emitted_hash'] ?? undefined, lastCompleteness: r['last_completeness'] ?? undefined, departmentHashes: r['department_hashes'] ?? {} };
    },
    async listReadinessInputs(tx: unknown, t: string, orderId: string) {
      const ots = await sql(tx, t, 'SELECT id, order_item_id, department_id, status FROM lab.order_tests WHERE tenant_id = $1 AND order_id = $2', [orderId]);
      const rs = await sql(tx, t, 'SELECT id, order_test_id, status, is_reportable, current_version_no FROM lab.results WHERE tenant_id = $1 AND order_id = $2', [orderId]);
      return {
        orderTests: ots.map((o) => ({ id: o['id'], orderItemId: o['order_item_id'], departmentId: o['department_id'], status: o['status'] })),
        results: rs.map((r) => ({ id: r['id'], orderTestId: r['order_test_id'], status: r['status'], isReportable: Boolean(r['is_reportable']), currentVersionNo: Number(r['current_version_no']) })),
      };
    },
    async saveReadiness(tx: unknown, t: string, a: { orderId: string; readinessSeq: number; lastEmittedHash: string; lastCompleteness: 'complete' | 'partial'; departmentHashes: Record<string, string>; emittedAt: string }) {
      const rc = await rcOf(tx, t);
      await sql(tx, t, `UPDATE lab.order_readiness SET readiness_seq = $3, last_emitted_hash = $4, last_completeness = $5, department_hashes = $6::jsonb, last_emitted_at = $7::timestamptz,
          version = version + 1, updated_at = now(), updated_by = $8 WHERE tenant_id = $1 AND order_id = $2`,
      [a.orderId, a.readinessSeq, a.lastEmittedHash, a.lastCompleteness, JSON.stringify(a.departmentHashes), a.emittedAt, rc.actorId]);
    },

    // ---------------------------------------------------------------- exception queue (T-23): the result row for an assign
    getResultForAssign: async (tx: unknown, t: string, id: string) => (await lockEntryRows(tx, t, [id]))[0],
  };
}

/** Active entry of a tenant coded set (tenant row shadows the global row of the same code). */
async function activeCode(tx: unknown, t: string, set: 'return' | 'amendment', code: string): Promise<boolean> {
  const [tenant, global] = set === 'return' ? ['lab.cs_return_reasons', 'lab.g_cs_return_reasons'] : ['lab.cs_amendment_reasons', 'lab.g_cs_amendment_reasons'];
  const r = await one(tx, t, `SELECT is_active FROM ${tenant} WHERE tenant_id = $1 AND code = $2
      UNION ALL SELECT g.is_active FROM ${global} g WHERE g.code = $2 AND NOT EXISTS (SELECT 1 FROM ${tenant} o WHERE o.tenant_id = $1 AND o.code = $2) LIMIT 1`, [code]);
  return r?.['is_active'] === true;
}
