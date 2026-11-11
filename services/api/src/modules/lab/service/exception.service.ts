// Ingest exception queue (02-TRD §5.6 #38-#42, §4.5 step 1 replay, §8 task lab.reapply_exceptions_for_specimen, §11 access log; 03-APP-FLOW §1.3;
// PRD AC-04.5, AC-14.3, AC-14.5; 07-SECURITY P-01/P-03/P-07, REQ-SEC-024/096/098; CR-C7-011). Runs in the request transaction (ctx.tx).
// Tenant and actor come from ctx only; every store call is (ctx.tx, ctx.tenantId, ...). A foreign-tenant id is reported as not found (P-01).
// Reapply / assign run the T-22 pipeline (ingest.service.ts) under the exception's own result key; a technical failure propagates (the request rolls back).
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { RepoCtx } from '../repository/base.repo.js';
import { discardIngestExceptionRow, getIngestExceptionRow, isActiveExceptionDiscardReason, listIngestExceptionRows } from '../repository/ingest.repo.js';
import { reapplyInstrumentResult, sqlIngestStore, type IngestCtx, type IngestOutcome, type IngestStore, type InstrumentResultInput } from './ingest.service.js';
import type { EntryRow, ResultRow } from './result.service.js';

export type ExceptionRow = Record<string, any>;
export interface ExceptionListQuery { status: 'open' | 'resolved' | 'discarded'; reasons?: string[]; instrumentId?: string; cursor?: string; limit: number; scopeCentreIds?: string[] }

/** The T-22 IngestStore plus the exception queue members (the SQL store is wired with the core pipeline; a ctx without them fails closed). */
export interface ExceptionStore extends IngestStore {
  listExceptions(tx: unknown, tenantId: string, q: ExceptionListQuery): Promise<{ rows: ExceptionRow[]; nextCursor?: string }>;
  getExceptionRow(tx: unknown, tenantId: string, id: string): Promise<ExceptionRow | undefined>;
  /** SELECT ... FOR UPDATE: every write operation starts here. */
  lockException(tx: unknown, tenantId: string, id: string): Promise<ExceptionRow | undefined>;
  /** The result row (FOR UPDATE, same shape as lockSpecimenResults); undefined for an unknown id or another tenant's. */
  getResultForAssign(tx: unknown, tenantId: string, resultId: string): Promise<EntryRow | undefined>;
  isActiveDiscardReason(tx: unknown, tenantId: string, code: string): Promise<boolean>;
  discardException(tx: unknown, tenantId: string, a: { id: string; reasonCode: string; comment?: string; resolverMembershipId: string; occurredAt: string }): Promise<void>;
}
export interface ExceptionCtx extends Omit<IngestCtx, 'store'> {
  readonly store: ExceptionStore;
  readonly audit: { access(e: Record<string, unknown>): Promise<void> };
}

/** Production store: T-22 SQL store + the exception queries (repository/ingest.repo.ts). getResultForAssign is result-side (core-pipeline store, as T-14/T-16); absent = fail closed. */
export function sqlExceptionStore(actorId: string, resultSide?: Partial<ExceptionStore>): ExceptionStore {
  const rc = (tx: unknown, tenantId: string): RepoCtx => ({ tx: tx as RepoCtx['tx'], tenantId, actorId });
  return {
    ...sqlIngestStore(actorId, resultSide),
    listExceptions: (tx, t, q) => listIngestExceptionRows(rc(tx, t), q),
    getExceptionRow: (tx, t, id) => getIngestExceptionRow(rc(tx, t), id),
    lockException: (tx, t, id) => getIngestExceptionRow(rc(tx, t), id, true),
    isActiveDiscardReason: (tx, t, code) => isActiveExceptionDiscardReason(rc(tx, t), code),
    discardException: (tx, t, a) => discardIngestExceptionRow(rc(tx, t), a),
    async getResultForAssign(tx, t, id) {
      const f = resultSide?.getResultForAssign;
      if (typeof f !== 'function') throw new LimsError('common.internal');
      return f.call(resultSide, tx, t, id);
    },
  };
}

const invalid = (path: string, message: string): LimsError => new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message } as FieldError]);   // never echoes a value (REQ-SEC-098)
const MAX_COMMENT = 300;

export async function listIngestExceptions(ctx: ExceptionCtx, q: ExceptionListQuery): Promise<{ rows: ExceptionRow[]; nextCursor?: string }> {
  // P-02 (T-32): centre scope from IdentityPort.getActor; unknown scope = fail closed (500), never "all centres".
  const id = (ctx as { ports?: { IdentityPort?: { getActor?(c: unknown): Promise<{ centreScope?: { all?: boolean; centreIds?: readonly string[] } }> } } }).ports?.IdentityPort;
  if (typeof id?.getActor !== 'function') throw new LimsError('common.internal');
  const s = (await id.getActor(ctx)).centreScope;
  return ctx.store.listExceptions(ctx.tx, ctx.tenantId, { ...q, ...(s?.all === true ? {} : { scopeCentreIds: [...(s?.centreIds ?? [])] }) });   // tenant-filtered in SQL (P-03); the list DTO carries no raw instrument value
}

/** #39: raw value, flags and unit are P3 data: one `ingest_exception.view` access-log row naming the record, never its content (REQ-SEC-096/098). */
export async function getIngestException(ctx: ExceptionCtx, id: string): Promise<ExceptionRow> {
  const row = await ctx.store.getExceptionRow(ctx.tx, ctx.tenantId, id);
  if (!row) throw new LimsError('common.not_found');
  await atCentre(ctx, 'lab.result.read', row['centre_id']);
  await ctx.audit.access({ action: 'ingest_exception.view', entityType: 'ingest_exception', entityId: id, outcome: 'allowed' });
  return row;
}

/** P-02 (T-32): the caller's role at the object's centre; a centre outside the scope is reported as not found (404), other refusals (mfa, revoked) pass through. */
async function atCentre(ctx: ExceptionCtx, permission: string, centreId: unknown): Promise<void> {
  const id = (ctx as { ports?: { IdentityPort?: { assertRole(c: unknown, r: { permission: string; centreId?: string }): Promise<unknown> } } }).ports?.IdentityPort;
  if (!id) throw new LimsError('common.internal');   // fail closed: no identity port
  try { await id.assertRole(ctx, { permission, ...(typeof centreId === 'string' ? { centreId } : {}) }); }
  catch (e) { throw e instanceof LimsError && e.code === 'auth.forbidden' ? new LimsError('common.not_found') : e; }
}

async function lockOpen(ctx: ExceptionCtx, id: string): Promise<ExceptionRow> {
  const row = await ctx.store.lockException(ctx.tx, ctx.tenantId, id);
  if (!row) throw new LimsError('common.not_found');
  await atCentre(ctx, 'lab.result.enter', row['centre_id']);   // P-02: before any state check, so another centre's exception is indistinguishable from a missing one
  if (row['status'] !== 'open') throw invalid('/status', 'exception is not open');   // resolved / discarded are terminal (03-APP-FLOW §1.3)
  return row;
}
const membership = (ctx: ExceptionCtx): string => {
  const m = ctx.actor.membershipId;
  if (typeof m !== 'string' || !m) throw new LimsError('auth.unauthenticated');
  return m;
};
const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : undefined);

/** exception row (lab.ingest_exceptions columns) -> pipeline input; the stored result_key is kept so the replay closes this very exception. */
export function exceptionToInput(r: ExceptionRow): InstrumentResultInput {
  const o: Record<string, unknown> = {
    instrumentMessageId: r['instrument_message_id'], instrumentId: r['instrument_id'], centreId: r['centre_id'], protocol: r['protocol'] ?? 'astm', sampleBarcode: r['sample_barcode'],
    recordKind: r['record_kind'], instrumentAnalyteCode: r['instrument_analyte_code'], mappingStatus: 'mapped', instrumentFlags: Array.isArray(r['instrument_flags']) ? r['instrument_flags'] : [],
    receivedAt: iso(r['received_at']),
  };
  const opt: [string, string, unknown][] = [
    ['agentId', 'agent_id', r['agent_id']], ['valueRaw', 'value_raw', r['value_raw']], ['valueNumeric', 'value_numeric', r['value_numeric']], ['unitRaw', 'unit_raw', r['unit_raw']],
    ['unitCode', 'unit_code', r['unit_code']], ['instrumentResultTime', 'instrument_result_time', iso(r['instrument_result_time'])], ['isRerun', 'is_rerun', r['is_rerun']],
    ['attachment', 'attachment', r['attachment']],
  ];
  for (const [k, , v] of opt) if (v !== null && v !== undefined) o[k] = v;
  return o as unknown as InstrumentResultInput;
}

export interface ActionOutcome { exception: ExceptionRow; outcome: IngestOutcome; result?: ResultRow }

async function finish(ctx: ExceptionCtx, id: string, fallback: ExceptionRow, outcome: IngestOutcome, result?: ResultRow): Promise<ActionOutcome> {
  const after = (await ctx.store.getExceptionRow(ctx.tx, ctx.tenantId, id)) ?? fallback;   // re-read AFTER the run (status / reason / attempts)
  return { exception: after, outcome, ...(result === undefined ? {} : { result }) };
}

/** #41: re-run §4.5 for the stored record (port path, caller actor). Still failing -> the one open row is refreshed (attempts + 1, reason of the latest attempt, AC-14.3). */
export async function reapplyIngestException(ctx: ExceptionCtx, id: string): Promise<ActionOutcome> {
  const row = await lockOpen(ctx, id);
  const out = await reapplyInstrumentResult(ctx, exceptionToInput(row), { resultKey: row['result_key'] });
  return finish(ctx, id, row, out.outcome);
}

/** #40: same pipeline, target row chosen by the caller (the specimen / barcode match is skipped). The target is read FOR UPDATE under the ctx tenant (P-07). */
export async function assignIngestException(ctx: ExceptionCtx, id: string, a: { resultId: unknown; overrideAnalyte?: unknown }): Promise<ActionOutcome> {
  if (typeof a.resultId !== 'string' || !a.resultId) throw invalid('/result_id', 'result_id is required');
  const row = await lockOpen(ctx, id);
  const target = await ctx.store.getResultForAssign(ctx.tx, ctx.tenantId, a.resultId);
  if (!target) throw new LimsError('common.not_found');
  await atCentre(ctx, 'lab.result.enter', target.centreId);   // P-02 / P-07: the target result's own centre
  const out = await reapplyInstrumentResult(ctx, exceptionToInput(row), { resultKey: row['result_key'], assign: { target, overrideAnalyte: a.overrideAnalyte === true } });
  return finish(ctx, id, row, out.outcome, out.saved);
}

/** #42: terminal; the pipeline is NOT run. The reason must be an active lab.exception_discard_reasons code of this tenant (tenant rows shadow global). */
export async function discardIngestException(ctx: ExceptionCtx, id: string, a: { reasonCode: unknown; comment?: unknown }): Promise<ExceptionRow> {
  if (typeof a.reasonCode !== 'string' || !a.reasonCode || a.reasonCode.length > 64) throw invalid('/reason_code', 'reason_code is required');
  if (a.comment !== undefined && (typeof a.comment !== 'string' || a.comment.length > MAX_COMMENT)) throw invalid('/comment', 'comment must be at most 300 characters');
  const row = await lockOpen(ctx, id);
  if (!(await ctx.store.isActiveDiscardReason(ctx.tx, ctx.tenantId, a.reasonCode))) throw invalid('/reason_code', 'reason_code is not an active discard reason');
  await ctx.store.discardException(ctx.tx, ctx.tenantId, {
    id, reasonCode: a.reasonCode, ...(a.comment === undefined ? {} : { comment: a.comment }), resolverMembershipId: membership(ctx), occurredAt: ctx.now().toISOString(),
  });
  return (await ctx.store.getExceptionRow(ctx.tx, ctx.tenantId, id)) ?? row;
}

/**
 * AC-04.5: called inside the receive transaction (S4, single and bulk): ONE app.enqueue_job on ctx.tx, job_key = specimen_id. A rollback of the receive drops the job.
 * Ids only: the barcode is patient-linked, the task looks it up (02-TRD §8).
 */
export async function enqueueReapplyForSpecimen(ctx: { tx: { query(sql: string, params: unknown[]): Promise<unknown> }; tenantId: string }, specimenId: string): Promise<void> {
  if (typeof ctx?.tenantId !== 'string' || !ctx.tenantId) throw new LimsError('common.internal');
  await ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3, NULL, NULL)', ['lab.reapply_exceptions_for_specimen', JSON.stringify({ tenant_id: ctx.tenantId, specimen_id: specimenId }), specimenId]);
}
