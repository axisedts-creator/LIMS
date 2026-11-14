// Task reporting.apply_provider_events (01-PRD AC-09.3; 02-TRD §4.8, §9; 07-SECURITY T12). Enqueued by the CB1 API handler under withTenantScope (LD-49 (b)), job key pe:<tenant>.
// For each unapplied provider_events row of the tenant (oldest first): find the delivery by (channel_account_id, provider_message_id) in the SAME tenant; none => `unknown_message`;
// same status => `duplicate`; behind / not reachable (read -> delivered, failed|suppressed -> anything) => `backwards`; else move the delivery forward (version + 1) and publish ONE
// reporting.delivery.status_changed.v1. The event row only gets applied_at / delivery_id / ignored_reason. Re-running changes nothing. No log lines (no provider ids, no PHI).
// [CONV] `read` is accepted from sent (WhatsApp may skip `delivered`); `read` on a non-WhatsApp channel is not special-cased (open point in C6-T29-impl.md).
import type { TaskHandler } from '../../../core/manifest.js';
import { findDeliveryOfEvent, markEventApplied, moveDelivery, pendingProviderEvents, type IgnoredReason, type ProviderStatus } from '../../../../../api/src/modules/reporting/repository/provider-events.repo.js';
import { publishTransition } from '../../../../../api/src/modules/reporting/service/delivery.service.js';

const BATCH = 200; const MAX_BATCHES = 50;
const FORWARD: Record<string, readonly string[]> = { sent: ['delivered', 'read', 'failed'], delivered: ['read', 'failed'] };   // everything else is final here

export const applyProviderEvents: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as unknown as Parameters<typeof publishTransition>[0] & { now(): string };
  const tenantId = payload?.['tenant_id'];
  if (typeof tenantId !== 'string' || tenantId !== ctx.tenantId) throw new Error('apply_provider_events: payload tenant does not match the job tenant');
  const tx = ctx.tx as any;
  const actorId = ctx.actor.id;

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const events = await pendingProviderEvents(tx, tenantId, BATCH);
    if (events.length === 0) return;
    for (const e of events) {
      const at = ctx.now();
      const d = await findDeliveryOfEvent(tx, tenantId, e.channel_account_id, e.provider_message_id);
      let reason: IgnoredReason | null = null;
      if (!d) reason = 'unknown_message';
      else if (d['status'] === e.mapped_status) reason = 'duplicate';
      else if (!FORWARD[d['status']]?.includes(e.mapped_status)) reason = 'backwards';
      if (d && reason === null) {
        const to = e.mapped_status as ProviderStatus;
        const v = await moveDelivery(tx, tenantId, d['id'], d['status'], d['version'], to, at, actorId);
        if (v === undefined) throw new Error('apply_provider_events: delivery changed concurrently');   // queue retry re-reads it
        await publishTransition(ctx, d, to, { seq: v, at, attemptNo: d['attempt_no'] ?? 1, ...(to === 'failed' ? { failureCode: 'provider_rejected' } : {}) });
      }
      await markEventApplied(tx, tenantId, e.id, d ? d['id'] : null, reason, at);
    }
    if (events.length < BATCH) return;
  }
};
