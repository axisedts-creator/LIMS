// reporting.provider_events / deliveries access for the apply task (06-PLAN C6-T29; 05-SCHEMA §2.10). provider_events is append-only (class A): only
// applied_at / delivery_id / ignored_reason ever change, rows are never deleted. Every statement names tenant_id explicitly next to RLS; parameters only.
import type { Tx } from './settings.repo.js';

export type IgnoredReason = 'unknown_message' | 'duplicate' | 'backwards';
export interface PendingEvent { id: string; channel_account_id: string; provider_message_id: string; mapped_status: 'sent' | 'delivered' | 'read' | 'failed' }

/** Unapplied events of the tenant, oldest first. */
export async function pendingProviderEvents(tx: Tx, tenantId: string, limit: number): Promise<PendingEvent[]> {
  const { rows } = await tx.query(
    'SELECT id, channel_account_id, provider_message_id, mapped_status FROM reporting.provider_events WHERE tenant_id = $1 AND applied_at IS NULL ORDER BY received_at, id LIMIT $2',
    [tenantId, limit]);
  return rows as PendingEvent[];
}

/** The delivery an event is about: same tenant AND same channel account (an account's token cannot move another account's deliveries). Locked. */
export async function findDeliveryOfEvent(tx: Tx, tenantId: string, channelAccountId: string, providerMessageId: string): Promise<Record<string, any> | undefined> {
  const { rows } = await tx.query(
    'SELECT id, channel, purpose, recipient_kind, status, report_id, report_version_no, fallback_of_delivery_id, attempt_no, version, created_at FROM reporting.deliveries WHERE tenant_id = $1 AND channel_account_id = $2 AND provider_message_id = $3 FOR UPDATE',
    [tenantId, channelAccountId, providerMessageId]);
  return rows[0];
}

export type ProviderStatus = 'delivered' | 'read' | 'failed';
// One literal statement per target status (no interpolation). Returns the new version; no row = somebody changed the delivery first.
const MOVE: Record<ProviderStatus, string> = {
  delivered: 'UPDATE reporting.deliveries SET status = $3, delivered_at = COALESCE(delivered_at, $4), version = version + 1, updated_at = $4, updated_by = $5 WHERE tenant_id = $1 AND id = $2 AND status = $6 AND version = $7 RETURNING version',
  read: 'UPDATE reporting.deliveries SET status = $3, read_at = COALESCE(read_at, $4), version = version + 1, updated_at = $4, updated_by = $5 WHERE tenant_id = $1 AND id = $2 AND status = $6 AND version = $7 RETURNING version',
  failed: 'UPDATE reporting.deliveries SET status = $3, failed_at = COALESCE(failed_at, $4), failure_code = COALESCE(failure_code, \'provider_rejected\'), version = version + 1, updated_at = $4, updated_by = $5 WHERE tenant_id = $1 AND id = $2 AND status = $6 AND version = $7 RETURNING version',
};
export async function moveDelivery(tx: Tx, tenantId: string, id: string, from: string, version: number, to: ProviderStatus, at: string, actorId: string): Promise<number | undefined> {
  const { rows } = await tx.query(MOVE[to], [tenantId, id, to, at, actorId, from, version]);
  return rows[0]?.['version'];
}

/** Marks the event applied (and why it changed nothing, if so). Guarded by applied_at IS NULL so a concurrent run cannot apply it twice. */
export async function markEventApplied(tx: Tx, tenantId: string, id: string, deliveryId: string | null, ignoredReason: IgnoredReason | null, at: string): Promise<boolean> {
  const { rows } = await tx.query(
    'UPDATE reporting.provider_events SET applied_at = $3, delivery_id = $4, ignored_reason = $5 WHERE tenant_id = $1 AND id = $2 AND applied_at IS NULL RETURNING id',
    [tenantId, id, at, deliveryId, ignoredReason]);
  return rows.length > 0;
}
