// Instrument ingest + QC + module idempotency: lab.ingest_log, lab.ingest_exceptions, lab.qc_results, lab.qc_holds, lab.module_submissions (05-SCHEMA §1).
// Generic row operations via base.repo (insertRow/getRow/updateRow); named queries are added by the tasks that use them.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { decodeCursor, encodeCursor } from '../mappers/specimen.mapper.js';
import { first, isUuid, limitOf, query, table, type RepoCtx } from './base.repo.js';

export const INGEST_LOG = table('lab.ingest_log', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'result_key', 'first_source', 'first_event_id',
  'last_outcome', 'result_id', 'specimen_id', 'exception_id', 'attempts', 'last_attempt_at', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'], {
  mutable: ['last_outcome', 'result_id', 'specimen_id', 'processing_centre_id', 'exception_id', 'attempts', 'last_attempt_at'],   // = ingest_log__mutable_columns
});
export const INGEST_EXCEPTIONS = table('lab.ingest_exceptions', 'id', ['id', 'tenant_id', 'centre_id', 'processing_centre_id', 'result_key', 'reason', 'status',
  'instrument_id', 'instrument_message_id', 'agent_id', 'protocol', 'sample_barcode', 'record_kind', 'instrument_analyte_code', 'analyte_id', 'test_id', 'value_raw',
  'value_numeric', 'unit_raw', 'unit_code', 'instrument_flags', 'instrument_result_time', 'received_at', 'is_rerun', 'attachment', 'specimen_id', 'result_id',
  'attempts', 'last_attempt_at', 'resolution', 'resolved_at', 'resolved_by_membership_id', 'discard_reason_code', 'comment',
  'version', 'created_at', 'created_by', 'updated_at', 'updated_by']);
/** Append-only (class A). */
export const QC_RESULTS = table('lab.qc_results', 'id', ['id', 'tenant_id', 'centre_id', 'instrument_id', 'instrument_message_id', 'analyte_id', 'instrument_analyte_code',
  'mapping_status', 'control_id_raw', 'control_lot_raw', 'control_level', 'value_raw', 'value_numeric', 'unit_raw', 'unit_code', 'instrument_flags',
  'instrument_result_time', 'received_at', 'source', 'idempotency_key', 'entered_by_membership_id', 'created_at', 'created_by']);
export const QC_HOLDS = table('lab.qc_holds', 'id', ['id', 'tenant_id', 'qc_run_id', 'instrument_id', 'analyte_ids', 'since', 'reason_code', 'status', 'held_result_ids',
  'review_flagged_result_ids', 'released_at', 'released_by_membership_id', 'release_comment', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'],
  { frozen: ['qc_run_id', 'instrument_id'] });

// ---- T-22 named queries of the instrument apply pipeline (02-TRD §4.5; 04 N10 result-level key). Tenant = $1 from the ctx; values are bound, never interpolated.
type Outcome = 'applied' | 'duplicate' | 'unmatched' | 'rejected_state' | 'held' | 'not_applicable';

/** Step 1: INSERT ... ON CONFLICT DO NOTHING; on conflict the stored outcome and the open exception of the key. The placeholder outcome `unmatched` only survives if finishIngestLog is skipped (the pipeline always finishes or rolls back). */
export async function claimIngestKey(rc: RepoCtx, a: { resultKey: string; centreId: string; firstSource: 'event' | 'port'; firstEventId?: string; occurredAt: string }):
  Promise<{ inserted: boolean; logId: string; lastOutcome: Outcome; resultId?: string; specimenId?: string; openExceptionId?: string }> {
  const ins = await first(rc, `INSERT INTO lab.ingest_log (id, tenant_id, centre_id, result_key, first_source, first_event_id, last_outcome, last_attempt_at, created_by, updated_by)
      VALUES ($2, $1, $3, $4, $5, $6, 'unmatched', $7, $8, $8)
      ON CONFLICT (tenant_id, result_key) DO NOTHING RETURNING id`,
  [uuidv7(), a.centreId, a.resultKey, a.firstSource, a.firstEventId ?? null, a.occurredAt, rc.actorId]);
  if (ins) return { inserted: true, logId: ins['id'], lastOutcome: 'unmatched' };
  const row = await first(rc, `SELECT l.id, l.last_outcome, l.result_id, l.specimen_id,
      (SELECT e.id FROM lab.ingest_exceptions e WHERE e.tenant_id = l.tenant_id AND e.result_key = l.result_key AND e.status = 'open') AS open_exception_id
      FROM lab.ingest_log l WHERE l.tenant_id = $1 AND l.result_key = $2 FOR UPDATE OF l`, [a.resultKey]);   // row lock: a concurrent replay waits for the first apply to commit, then re-reads last_outcome (one apply per key, 04 N10)
  if (!row) throw new Error('lab.ingest_log key vanished after conflict');   // no DELETE grant, cannot happen: fail closed
  return {
    inserted: false, logId: row['id'], lastOutcome: row['last_outcome'],
    ...(row['result_id'] ? { resultId: row['result_id'] } : {}), ...(row['specimen_id'] ? { specimenId: row['specimen_id'] } : {}),
    ...(row['open_exception_id'] ? { openExceptionId: row['open_exception_id'] } : {}),
  };
}

export async function finishIngestLog(rc: RepoCtx, logId: string, a: { lastOutcome: Outcome; resultId?: string; specimenId?: string; processingCentreId?: string; exceptionId?: string; occurredAt: string }): Promise<void> {
  const rows = await query(rc, `UPDATE lab.ingest_log SET last_outcome = $3, result_id = COALESCE($4, result_id), specimen_id = COALESCE($5, specimen_id),
      processing_centre_id = COALESCE($6, processing_centre_id), exception_id = COALESCE($7, exception_id), last_attempt_at = $8,
      version = version + 1, updated_at = now(), updated_by = $9
      WHERE tenant_id = $1 AND id = $2 RETURNING id`,
  [logId, a.lastOutcome, a.resultId ?? null, a.specimenId ?? null, a.processingCentreId ?? null, a.exceptionId ?? null, a.occurredAt, rc.actorId]);
  if (!rows[0]) throw new Error('lab.ingest_log row not found');
}

/** Upsert on the open key (ingest_exceptions__tenant_id_key_open__p_uq): a re-run refreshes the one open row, it never adds a second. */
export async function upsertOpenIngestException(rc: RepoCtx, e: Record<string, any>): Promise<{ exceptionId: string }> {
  const row = await first(rc, `INSERT INTO lab.ingest_exceptions (id, tenant_id, centre_id, processing_centre_id, result_key, reason, instrument_id, instrument_message_id, agent_id, protocol,
        sample_barcode, record_kind, instrument_analyte_code, analyte_id, test_id, value_raw, value_numeric, unit_raw, unit_code, instrument_flags, instrument_result_time, received_at, is_rerun,
        attachment, specimen_id, result_id, last_attempt_at, created_by, updated_by)
      VALUES ($2, $1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $28)
      ON CONFLICT (tenant_id, result_key) WHERE status = 'open' DO UPDATE SET reason = EXCLUDED.reason,
        processing_centre_id = COALESCE(EXCLUDED.processing_centre_id, lab.ingest_exceptions.processing_centre_id),
        specimen_id = COALESCE(EXCLUDED.specimen_id, lab.ingest_exceptions.specimen_id), result_id = COALESCE(EXCLUDED.result_id, lab.ingest_exceptions.result_id),
        attempts = lab.ingest_exceptions.attempts + 1, last_attempt_at = EXCLUDED.last_attempt_at, version = lab.ingest_exceptions.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by
      RETURNING id`,
  [uuidv7(), e['centreId'], e['processingCentreId'] ?? null, e['resultKey'], e['reason'], e['instrumentId'], e['instrumentMessageId'], e['agentId'] ?? null, e['protocol'] ?? null,
    e['sampleBarcode'], e['recordKind'], e['instrumentAnalyteCode'], e['analyteId'] ?? null, e['testId'] ?? null, e['valueRaw'] ?? null, e['valueNumeric'] ?? null, e['unitRaw'] ?? null,
    e['unitCode'] ?? null, e['instrumentFlags'] ?? [], e['instrumentResultTime'] ?? null, e['receivedAt'], e['isRerun'] ?? null,
    e['attachment'] === undefined ? null : JSON.stringify(e['attachment']), e['specimenId'] ?? null, e['resultId'] ?? null, e['occurredAt'], rc.actorId]);
  return { exceptionId: (row as Record<string, any>)['id'] };
}

/** Step 12: the open exceptions of the key are resolved as `applied` (ingest_exceptions__closed__ck: resolved_at is set together with the status). */
export async function closeOpenIngestExceptions(rc: RepoCtx, a: { resultKey: string; resolution?: 'applied' | 'assigned'; resolverMembershipId?: string; resultId?: string; occurredAt: string }): Promise<void> {
  // result_id: an unmapped/unknown-barcode exception has none until the replay applies; keep an existing one (T-24 debug)
  await query(rc, `UPDATE lab.ingest_exceptions SET status = 'resolved', resolution = $6, resolved_at = $3, resolved_by_membership_id = $4, result_id = COALESCE($7::uuid, result_id),
      version = version + 1, updated_at = now(), updated_by = $5 WHERE tenant_id = $1 AND result_key = $2 AND status = 'open'`,
  [a.resultKey, a.occurredAt, a.resolverMembershipId ?? null, rc.actorId, a.resolution ?? 'applied', a.resultId ?? null]);
}
// ---- T-23 exception queue queries (02-TRD §5.6 #38-#42). Tenant = $1; filters are bound parameters; the open list is oldest first (stale-age alert, 02-TRD §12).
const EXC_SORT = 'created_at';
/** #38: keyset page (created_at, id) on ingest_exceptions__tenant_id_status__idx; limit + 1 rows are read to detect the next page. */
/** scopeCentreIds: the caller's centres (absent = all); REQ-SEC-017 / P-02 (T-32). */
export async function listIngestExceptionRows(rc: RepoCtx, q: { status: string; reasons?: readonly string[]; instrumentId?: string; cursor?: string; limit: number; scopeCentreIds?: readonly string[] }):
  Promise<{ rows: Record<string, any>[]; nextCursor?: string }> {
  const limit = limitOf(q.limit);
  const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor, EXC_SORT);
  const rows = await query(rc, `SELECT e.*, to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key FROM lab.ingest_exceptions e
      WHERE e.tenant_id = $1 AND e.status = $2 AND ($3::text[] IS NULL OR e.reason = ANY($3)) AND ($4::uuid IS NULL OR e.instrument_id = $4)
        AND ($5::timestamptz IS NULL OR (e.created_at, e.id) > ($5::timestamptz, $6::uuid))
        AND ($8::uuid[] IS NULL OR e.centre_id = ANY($8) OR e.processing_centre_id = ANY($8))
      ORDER BY e.created_at, e.id LIMIT $7`,
  [q.status, q.reasons ?? null, q.instrumentId ?? null, after?.key ?? null, after?.id ?? null, limit + 1, q.scopeCentreIds ? [...q.scopeCentreIds] : null]);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page.map(({ sort_key: _k, ...r }) => r), ...(rows.length > limit && last ? { nextCursor: encodeCursor(EXC_SORT, last['sort_key'], last['id']) } : {}) };
}
export async function getIngestExceptionRow(rc: RepoCtx, id: string, lock = false): Promise<Record<string, any> | undefined> {
  if (!isUuid(id)) return undefined;
  return (await first(rc, `SELECT * FROM lab.ingest_exceptions WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [id])) ?? undefined;   // another tenant's id = no row = 404 (P-01)
}
/** Worker tasks (§8): open exceptions of the given reasons (+ one barcode), id ascending (uuidv7 = creation order) after `afterId`, so a capped run can continue where it stopped. */
export async function listOpenIngestExceptionRows(rc: RepoCtx, q: { reasons: readonly string[]; barcode?: string; limit: number; afterId?: string }): Promise<Record<string, any>[]> {
  return query(rc, `SELECT * FROM lab.ingest_exceptions WHERE tenant_id = $1 AND status = 'open' AND reason = ANY($2::text[]) AND ($3::text IS NULL OR sample_barcode = $3)
      AND ($4::uuid IS NULL OR id > $4::uuid) ORDER BY id LIMIT $5`, [q.reasons, q.barcode ?? null, q.afterId ?? null, limitOf(q.limit)]);
}
export async function getSpecimenBarcodeRow(rc: RepoCtx, specimenId: string): Promise<string | undefined> {
  if (!isUuid(specimenId)) return undefined;
  return ((await first(rc, 'SELECT barcode FROM lab.specimens WHERE tenant_id = $1 AND id = $2', [specimenId])) ?? undefined)?.['barcode'];
}
/** Tenant rows shadow global rows of the same code (05-SCHEMA coded sets). */
export async function isActiveExceptionDiscardReason(rc: RepoCtx, code: string): Promise<boolean> {
  const r = await first(rc, `SELECT COALESCE((SELECT t.is_active FROM lab.cs_exception_discard_reasons t WHERE t.tenant_id = $1 AND t.code = $2),
      (SELECT g.is_active FROM lab.g_cs_exception_discard_reasons g WHERE g.code = $2), false) AS ok`, [code]);
  return r?.['ok'] === true;
}
/** ingest_exceptions__discard__ck: discarded needs discard_reason_code; closed rows need resolved_at (set together). */
export async function discardIngestExceptionRow(rc: RepoCtx, a: { id: string; reasonCode: string; comment?: string; resolverMembershipId: string; occurredAt: string }): Promise<void> {
  const rows = await query(rc, `UPDATE lab.ingest_exceptions SET status = 'discarded', resolution = 'discarded', discard_reason_code = $3, comment = $4, resolved_at = $5,
      resolved_by_membership_id = $6, version = version + 1, updated_at = now(), updated_by = $7 WHERE tenant_id = $1 AND id = $2 AND status = 'open' RETURNING id`,
  [a.id, a.reasonCode, a.comment ?? null, a.occurredAt, a.resolverMembershipId, rc.actorId]);
  if (!rows[0]) throw new LimsError('common.not_found');
}
/** Append-only (class A, A1 idempotency). */
export const MODULE_SUBMISSIONS = table('lab.module_submissions', 'id', ['id', 'tenant_id', 'idempotency_key', 'result_id', 'payload_module', 'payload_entity_id',
  'payload_version_no', 'output_version_no', 'output_status', 'created_at', 'created_by']);
