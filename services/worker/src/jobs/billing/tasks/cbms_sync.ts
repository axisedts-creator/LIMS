// billing.cbms_sync (02-TRD §9, §10; PRD US-BL-13.1/.2): submit ONE document (invoice, invoice_cancellation or credit_note) through the CbmsClient and record the attempt.
// All logic lives in cbms.service (lock, client call, cbms_submissions row, state). The default client is the recording stub: it never marks a document synced (live is blocked, B6).
// A retryable outcome RESOLVES the task (the attempt record must commit); the periodic billing.cbms_sweep re-queues due pending documents.
// Payload { tenant_id, document_kind, document_id }: it can never widen the tenant scope (REQ-SEC-024); a malformed one runs nothing and is not retried.
import { RecordingStubCbmsClient } from '../../../../../api/src/modules/billing/cbms/RecordingStubCbmsClient.js';
import type { CbmsClient } from '../../../../../api/src/modules/billing/cbms/CbmsClient.js';
import { createCbmsService } from '../../../../../api/src/modules/billing/service/cbms.service.js';
import type { TaskHandler } from '../../../core/manifest.js';

export const CBMS_SYNC = 'billing.cbms_sync';

const KINDS = ['invoice', 'invoice_cancellation', 'credit_note'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `client` is the test seam. */
export function createCbmsSync(deps: { client: CbmsClient }): TaskHandler {
  const service = createCbmsService({ client: deps.client });
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any;
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    if (typeof ctx.tenantId !== 'string' || p['tenant_id'] !== ctx.tenantId || typeof p['document_kind'] !== 'string' || !KINDS.includes(p['document_kind'])
      || typeof p['document_id'] !== 'string' || !UUID.test(p['document_id'])) {
      ctx.log?.warn?.({ event: 'cbms_sync_skipped', reason: 'bad_input' });
      return;
    }
    const r = await service.submit(ctx, { documentKind: p['document_kind'], documentId: p['document_id'] });
    if (r.submitted) ctx.metrics?.inc?.('lims_billing_cbms_submissions_total', { outcome: r.outcome });
    ctx.log?.info?.({ event: 'cbms_sync_done', submitted: r.submitted, outcome: r.submitted ? r.outcome : r.reason });
  };
}

export const cbmsSync: TaskHandler = createCbmsSync({ client: new RecordingStubCbmsClient() });
