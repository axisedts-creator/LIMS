// T-24 submitModuleResult (03-IC §4.5 A1; 02-TRD §6.1; 08 R1, A13 D-7, A17 D-61; PRD AC-17.5, AC-17.6; 07-SECURITY S-21). Runs in the caller's tx (ctx.tx); tenant from ctx only.
// The result row of the item is locked FIRST (02-TRD §3.2), then the idempotency key is read: two concurrent submissions of one key serialise on the row and the second one replays.
// pending/resulted: R2/R3. verified: system R5 (verification kind returned, mode system, reason module_resubmitted) then R3, one tx. approved: amendment R7 (new result_versions row,
// approvals kind amendment, results.current_version_no) — the locked results row keeps its values. Check order: item -> workflow -> replay -> stale -> state-specific (approved: lab.result.amend
// -> amendment required -> reason code -> R1/D-61 guards). Nothing submitted (summary, reason text) is echoed in an error or an event (P3).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { createLabEvents, valueSha256Prefix16 } from '../events/publish.js';
import { first, query } from '../repository/base.repo.js';
import { bad, events, instant, isObj, uuid, rcOf, type Obj, type PortCtx } from './port.shared.js';
import { insertCriticalLogRow, rollupOf } from './result-side.store.js';

export interface ModuleOutput { resultId: string; versionNo: number; status: string; replayed: boolean }
const WORKFLOWS: ReadonlySet<string> = new Set(['microbiology', 'anatomic', 'molecular']);
const KINDS = ['structured', 'narrative', 'ast_panel', 'organism'], PHASES = ['preliminary', 'final'], MODULES = ['micro', 'anatomic'];
const MAX_SUMMARY = 4000, MAX_REASON_TEXT = 500, MAX_KEY = 200;
const invalid = () => new LimsError('lab.module_result_invalid');

interface Parsed {
  orderItemId: string; analyteId?: string; reportPhase: 'preliminary' | 'final'; module: 'micro' | 'anatomic'; entityId: string; versionNo: number; summaryText?: string; flag?: string;
  isCritical: boolean; idempotencyKey: string; amendment?: { reasonCode: string; reasonText?: string };
}

function parse(raw: unknown): Parsed {
  if (!isObj(raw)) throw bad('');
  const ref = raw['payloadRef'];
  if (!isObj(ref)) throw bad('/payloadRef');
  if (typeof ref['module'] !== 'string' || !MODULES.includes(ref['module'])) throw bad('/payloadRef/module');
  const versionNo = ref['versionNo'];
  if (!Number.isInteger(versionNo) || (versionNo as number) < 1 || (versionNo as number) > 2147483647) throw bad('/payloadRef/versionNo');
  const entityId = uuid(ref['entityId'], '/payloadRef/entityId');
  if (typeof raw['kind'] !== 'string' || !KINDS.includes(raw['kind'])) throw bad('/kind');
  if (typeof raw['reportPhase'] !== 'string' || !PHASES.includes(raw['reportPhase'])) throw bad('/reportPhase');
  const key = raw['idempotencyKey'];
  if (typeof key !== 'string' || key.length < 1 || key.length > MAX_KEY || key !== `${ref['module']}:${entityId}:${versionNo}`) throw bad('/idempotencyKey');   // 03-IC A1: `${module}:${entityId}:${versionNo}`
  instant(raw['submittedAt'], '/submittedAt');
  const s = raw['summaryText'];
  if (s !== undefined && (typeof s !== 'string' || s.length > MAX_SUMMARY || s.includes('\u0000'))) throw bad('/summaryText');
  if (raw['flag'] !== undefined && raw['flag'] !== 'N' && raw['flag'] !== 'A') throw bad('/flag');
  if (raw['isCritical'] !== undefined && typeof raw['isCritical'] !== 'boolean') throw bad('/isCritical');
  const a = raw['amendment'];
  let amendment: Parsed['amendment'];
  if (a !== undefined) {
    if (!isObj(a) || typeof a['reasonCode'] !== 'string' || a['reasonCode'].length < 1 || a['reasonCode'].length > 100) throw bad('/amendment/reasonCode');
    if (a['reasonText'] !== undefined && (typeof a['reasonText'] !== 'string' || a['reasonText'].length > MAX_REASON_TEXT || a['reasonText'].includes('\u0000'))) throw bad('/amendment/reasonText');
    amendment = { reasonCode: a['reasonCode'], ...(a['reasonText'] === undefined ? {} : { reasonText: a['reasonText'] }) };
  }
  return {
    orderItemId: uuid(raw['orderItemId'], '/orderItemId'), ...(raw['analyteId'] === undefined ? {} : { analyteId: uuid(raw['analyteId'], '/analyteId') }),
    reportPhase: raw['reportPhase'] as Parsed['reportPhase'], module: ref['module'] as Parsed['module'], entityId, versionNo: versionNo as number,
    ...(s === undefined ? {} : { summaryText: s as string }), ...(raw['flag'] === undefined ? {} : { flag: raw['flag'] as string }), isCritical: raw['isCritical'] === true, idempotencyKey: key,
    ...(amendment === undefined ? {} : { amendment }),
  };
}

export async function submitModuleResult(c: PortCtx, raw: unknown): Promise<ModuleOutput> {
  const i = parse(raw);
  const rc = rcOf(c);
  const tests = await query(rc, 'SELECT workflow_type FROM lab.order_tests WHERE tenant_id = $1 AND order_item_id = $2', [i.orderItemId]);
  if (tests.length === 0) throw new LimsError('common.not_found');   // unknown / other tenant / invisible (P-01)
  if (!tests.some((t) => WORKFLOWS.has(t['workflow_type']))) throw invalid();

  const rows = await query(rc, `SELECT * FROM lab.results WHERE tenant_id = $1 AND order_item_id = $2 AND status <> 'cancelled' AND ($3::uuid IS NULL OR analyte_id = $3) ORDER BY analyte_code, id FOR UPDATE`,
    [i.orderItemId, i.analyteId ?? null]);
  const cands = i.analyteId === undefined && rows.length > 1 ? rows.filter((r) => r['is_reportable'] === true) : rows;   // omitted analyteId: the test's single reportable module analyte
  if (cands.length === 0) throw new LimsError('common.not_found');
  if (cands.length > 1) throw invalid();
  const r: Obj = cands[0]!;

  const done = await first(rc, 'SELECT result_id, output_version_no, output_status FROM lab.module_submissions WHERE tenant_id = $1 AND idempotency_key = $2', [i.idempotencyKey]);
  if (done) return { resultId: done['result_id'], versionNo: Number(done['output_version_no']), status: done['output_status'], replayed: true };

  const approved = r['status'] === 'approved';
  const cur = approved ? await first(rc, 'SELECT * FROM lab.result_versions WHERE tenant_id = $1 AND result_id = $2 AND version_no = $3', [r['id'], r['current_version_no']]) : null;
  const last = cur?.['module_payload_version_no'] ?? r['module_payload_version_no'];
  if (last !== null && last !== undefined && i.versionNo < Number(last)) throw new LimsError('lab.module_result_stale');

  const out = approved ? await amend(c, i, r, cur) : await resubmit(c, i, r);
  await query(rc, `INSERT INTO lab.module_submissions (id, tenant_id, idempotency_key, result_id, payload_module, payload_entity_id, payload_version_no, output_version_no, output_status, created_by)
      VALUES ($2, $1, $3, $4, $5, $6, $7, $8, $9, $10)`, [uuidv7(), i.idempotencyKey, r['id'], i.module, i.entityId, i.versionNo, out.versionNo, out.status, c.actor.id]);
  if (i.isCritical) await critical(c, i, r, out);
  if (!approved && typeof r['specimen_id'] === 'string') await rollupOf(c, r['specimen_id']);   // R2/R3/R5 move the specimen (S6-S8, S15)
  return { resultId: r['id'], versionNo: out.versionNo, status: out.status, replayed: false };
}

/** R2 / R3, and for a verified row the system R5 first (verification cleared). */
async function resubmit(c: PortCtx, i: Parsed, r: Obj): Promise<{ versionNo: number; status: string; rowVersion: number }> {
  const rc = rcOf(c), at = c.now();
  if (r['status'] === 'verified') {
    await query(rc, `INSERT INTO lab.verifications (id, tenant_id, centre_id, processing_centre_id, result_id, kind, mode, result_row_version, reason_code, membership_id, occurred_at, created_by)
        VALUES ($2, $1, $3, $4, $5, 'returned', 'system', $6, 'module_resubmitted', NULL, $7::timestamptz, $8)`, [uuidv7(), r['centre_id'], r['processing_centre_id'], r['id'], r['version'], at, c.actor.id]);
  }
  const u = await first(rc, `UPDATE lab.results SET status = 'resulted', origin = 'module', module_payload_module = $3, module_payload_entity_id = $4, module_payload_version_no = $5, module_report_phase = $6,
        module_summary_text = $7, module_flag = $8, flag = $8, is_critical = $9, verified_at = NULL, verified_by_membership_id = NULL, resulted_at = $10::timestamptz,
        first_resulted_at = COALESCE(first_resulted_at, $10::timestamptz), version = version + 1, updated_at = now(), updated_by = $11
      WHERE tenant_id = $1 AND id = $2 AND version = $12 RETURNING version, current_version_no`,
  [r['id'], i.module, i.entityId, i.versionNo, i.reportPhase, i.summaryText ?? null, i.flag ?? null, i.isCritical, at, c.actor.id, r['version']]);
  if (!u) throw new LimsError('common.version_conflict');
  return { versionNo: Number(u['current_version_no']), status: 'resulted', rowVersion: Number(u['version']) };
}

/** R7 for a module result (08 R1 + D-61 guards). Needs a human with lab.result.amend: the approval rows carry the membership. */
async function amend(c: PortCtx, i: Parsed, r: Obj, cur: Obj | null): Promise<{ versionNo: number; status: string; rowVersion: number }> {
  const rc = rcOf(c);
  try { await c.ports.IdentityPort.assertRole(c, { permission: 'lab.result.amend', centreId: r['centre_id'] }); }
  catch (e) { if ((e as { code?: unknown } | null)?.code === 'auth.forbidden') throw new LimsError('lab.result_locked'); throw e; }   // auth.mfa_required etc. pass through
  const membershipId = c.actor.membershipId;
  if (!membershipId) throw new LimsError('lab.result_locked');
  const a = i.amendment;
  if (!a) throw new LimsError('lab.amendment_reason_required');
  if (!(await first(rc, 'SELECT 1 AS ok FROM lab.v_amendment_reasons WHERE tenant_id = $1 AND code = $2 AND is_active', [a.reasonCode]))) {
    throw new LimsError('common.validation_failed', undefined, [{ path: '/amendment/reasonCode', code: 'common.field_invalid', message: 'Field invalid' }]);
  }
  const replacedPhase = cur?.['module_report_phase'] ?? r['module_report_phase'];
  const micro = i.module === 'micro';
  if (a.reasonCode === 'module_phase_progression' && !(micro && i.reportPhase === 'final' && replacedPhase === 'preliminary')) throw invalid();
  if (a.reasonCode === 'module_preliminary_update' && !(micro && i.reportPhase === 'preliminary' && replacedPhase === 'preliminary')) throw invalid();   // D-61
  if (a.reasonCode === 'supplementary_report' && i.module !== 'anatomic') throw invalid();

  const prev = Number(r['current_version_no']), next = prev + 1, at = c.now();
  await query(rc, `INSERT INTO lab.result_versions (id, tenant_id, centre_id, processing_centre_id, result_id, version_no, origin, flag, is_critical, module_payload_module, module_payload_entity_id,
        module_payload_version_no, module_report_phase, module_summary_text, approved_at, approved_by_membership_id, previous_version_no, amendment_reason_code, amendment_reason_text, created_by, updated_by)
      VALUES ($2, $1, $3, $4, $5, $6, 'module', $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15, $16, $17, $18, $19, $19)`,
  [uuidv7(), r['centre_id'], r['processing_centre_id'], r['id'], next, i.flag ?? null, i.isCritical, i.module, i.entityId, i.versionNo, i.reportPhase, i.summaryText ?? null, at, membershipId, prev,
    a.reasonCode, a.reasonText ?? null, c.actor.id]);
  await query(rc, `UPDATE lab.result_versions SET superseded_at = $4::timestamptz, superseded_by_version_no = $5, version = version + 1, updated_at = now(), updated_by = $6
      WHERE tenant_id = $1 AND result_id = $2 AND version_no = $3`, [r['id'], prev, at, next, c.actor.id]);
  const u = await first(rc, `UPDATE lab.results SET current_version_no = $3, version = version + 1, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND id = $2 AND version = $5 RETURNING version`,
    [r['id'], next, c.actor.id, r['version']]);
  if (!u) throw new LimsError('common.version_conflict');
  await query(rc, `INSERT INTO lab.approvals (id, tenant_id, centre_id, processing_centre_id, result_id, version_no, kind, membership_id, aal, occurred_at, created_by)
      VALUES ($2, $1, $3, $4, $5, $6, 'amendment', $7, 'aal2', $8::timestamptz, $9)`, [uuidv7(), r['centre_id'], r['processing_centre_id'], r['id'], next, membershipId, at, c.actor.id]);
  // 03-IC §3.11: no value, no reason text in the payload (P3)
  await createLabEvents(events as never).resultAmended(c as never, {
    result_id: r['id'], previous_version_no: prev, new_version_no: next, order_id: r['order_id'], order_item_id: r['order_item_id'], test_id: r['test_id'], analyte_id: r['analyte_id'],
    amendment_reason_code: a.reasonCode, amended_at: at, amended_by_membership_id: membershipId,
  }, { resultRowVersion: Number(u['version']) });
  return { versionNo: next, status: 'approved', rowVersion: Number(u['version']) };
}

/** isCritical: critical log + lab.critical_value.detected.v1, direction `abnormal`, for the version this submission produced. The payload reference (not a value) feeds the dedupe hash. */
async function critical(c: PortCtx, i: Parsed, r: Obj, out: { versionNo: number; rowVersion: number }): Promise<void> {
  const rc = rcOf(c), at = c.now();
  const value = { kind: 't' as const, value: i.idempotencyKey };
  const hash = valueSha256Prefix16(value);
  const { criticalEventId } = await insertCriticalLogRow(rc, {
    resultId: r['id'], resultVersionNo: out.versionNo, orderId: r['order_id'], patientId: r['patient_id'], analyteId: r['analyte_id'], centreId: r['centre_id'], direction: 'abnormal',
    valueSha256Prefix16: hash, value: {}, detectedAt: at,
  });
  await createLabEvents(events as never).criticalValueDetected(c as never, {
    critical_event_id: criticalEventId, result_id: r['id'], result_version_no: out.versionNo, order_id: r['order_id'], patient_id: r['patient_id'], centre_id: r['centre_id'],
    analyte_id: r['analyte_id'], direction: 'abnormal', detected_at: at,
  }, { value, resultRowVersion: out.rowVersion + 1 });
}
