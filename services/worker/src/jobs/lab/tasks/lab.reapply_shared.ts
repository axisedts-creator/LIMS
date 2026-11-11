// Shared by lab.reapply_exceptions_for_specimen and lab.reapply_unmapped_exceptions (02-TRD §8; PRD AC-04.5, AC-14.3, AC-14.5; CR-C7-011).
// Each open exception is turned back into an InstrumentResultInput under its stored result key and re-run through the §4.5 pipeline (ingest.service) in the job transaction.
// REQ-SEC-024 / 07-SECURITY P-08: the job's tenant is the only tenant; a payload of another tenant (or a job without one) is refused before any query. REQ-SEC-098: nothing of the record is logged.
import { LimsError } from '../../../../../api/src/core/errors.js';
import { loadLabConfig } from '../../../../../api/src/modules/lab/config.js';
import type { RepoCtx } from '../../../../../api/src/modules/lab/repository/base.repo.js';
import { getSpecimenBarcodeRow, listOpenIngestExceptionRows } from '../../../../../api/src/modules/lab/repository/ingest.repo.js';
import { exceptionToInput, type ExceptionRow } from '../../../../../api/src/modules/lab/service/exception.service.js';
import { reapplyInstrumentResult, sqlIngestStore, type IngestCtx, type IngestStore } from '../../../../../api/src/modules/lab/service/ingest.service.js';
import type { JobContext } from '../../../core/manifest.js';

export const MAX_PER_RUN = 500;   // [CONV] 02-TRD §8
export interface TaskStore extends IngestStore {
  listOpenExceptions(tx: unknown, tenantId: string, q: { reasons: string[]; barcode?: string; limit: number; afterId?: string }): Promise<ExceptionRow[]>;
  getSpecimenBarcode(tx: unknown, tenantId: string, specimenId: string): Promise<string | undefined>;
}

/** The job tenant guard: payload.tenant_id must be the job's tenant. */
export function guardTenant(ctx: JobContext, payloadTenant: unknown): string {
  if (typeof ctx.tenantId !== 'string' || !ctx.tenantId || payloadTenant !== ctx.tenantId) throw new LimsError('common.internal');
  return ctx.tenantId;
}

/** ctx.store when the job wiring supplies the full store (tests, core pipeline); else the SQL store (result-side members come from the core pipeline, fail closed without). */
export function taskStore(ctx: JobContext): TaskStore {
  const given = (ctx as unknown as { store?: Partial<TaskStore> }).store;
  if (given && typeof given.claimKey === 'function' && typeof given.listOpenExceptions === 'function' && typeof given.getSpecimenBarcode === 'function') return given as TaskStore;
  const rc = (tx: unknown, tenantId: string): RepoCtx => ({ tx: tx as RepoCtx['tx'], tenantId, actorId: ctx.actor.id });
  return {
    ...sqlIngestStore(ctx.actor.id, given),
    listOpenExceptions: (tx, t, q) => listOpenIngestExceptionRows(rc(tx, t), q),
    getSpecimenBarcode: (tx, t, id) => getSpecimenBarcodeRow(rc(tx, t), id),
  };
}

/** Re-run every row in order. A technical failure rejects (the job retries, then dead-letters); a record that still cannot be applied simply stays open. */
export async function reapplyRows(ctx: JobContext, store: TaskStore, rows: readonly ExceptionRow[]): Promise<void> {
  const config = (ctx as unknown as { config?: IngestCtx['config'] }).config ?? loadLabConfig();
  const ic = { ...(ctx as unknown as IngestCtx), store, config, now: () => new Date(ctx.now()) };   // JobContext.now() is an ISO string
  for (const row of rows) await reapplyInstrumentResult(ic, exceptionToInput(row), { resultKey: row['result_key'] });
}
