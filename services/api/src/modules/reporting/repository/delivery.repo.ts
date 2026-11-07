// reporting.deliveries / g_message_templates / centre_contacts access for the NotificationPort (02-TRD §7.2; 05-SCHEMA §2.8).
// Every tenant-table statement names tenant_id explicitly next to RLS; parameters only.
import type { Tx } from './settings.repo.js';

export interface DeliveryRow { id: string; status: string; failure_code: string | null }
export interface DeliveryInsert {
  id: string; tenantId: string; centreId: string | null; channel: string; purpose: string; templateCode: string | null;
  recipientKind: string; recipientId: string | null; destinationMasked: string | null; destinationSha256: Buffer | null; destinationE164: string | null;
  params: Record<string, string>; idempotencyKey: string; relatedType: string | null; relatedId: string | null;
  reportId: string | null; reportVersionNo: number | null; status: string; failureCode: string | null;
  queuedAt: Date | null; sentAt: Date | null; suppressedAt: Date | null; actorId: string;
}

export async function findDeliveryByKey(tx: Tx, tenantId: string, key: string): Promise<DeliveryRow | undefined> {
  const { rows } = await tx.query(
    `SELECT id, status, failure_code FROM reporting.deliveries WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, key]);
  return rows[0];
}

export async function findActiveMessageTemplate(tx: Tx, code: string): Promise<{ code: string; purpose: string; channels: string[]; params: unknown } | undefined> {
  const { rows } = await tx.query(
    `SELECT code, purpose, channels, params FROM reporting.g_message_templates WHERE code = $1 AND is_active = true`, [code]);
  return rows[0];
}

/** Oldest active contact of the channel (created_at, then id) [CONV] (02-TRD §7.2 step 5; review fix #30). */
export async function oldestActiveCentreContact(tx: Tx, tenantId: string, centreId: string, channel: string): Promise<{ id: string; address: string } | undefined> {
  const { rows } = await tx.query(
    `SELECT id, address FROM reporting.centre_contacts WHERE tenant_id = $1 AND centre_id = $2 AND channel = $3 AND is_active = true ORDER BY created_at, id LIMIT 1`,
    [tenantId, centreId, channel]);
  return rows[0];
}

/** ON CONFLICT (tenant_id, idempotency_key) DO NOTHING: undefined = a concurrent call with the same key won. */
export async function insertDeliveryRow(tx: Tx, d: DeliveryInsert): Promise<DeliveryRow | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO reporting.deliveries (id, tenant_id, centre_id, channel, purpose, template_code, recipient_kind, recipient_id, destination_masked, destination_sha256, destination_e164, params, idempotency_key, related_entity_type, related_entity_id, report_id, report_version_no, status, failure_code, queued_at, sent_at, suppressed_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $23)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id, status, failure_code`,
    [d.id, d.tenantId, d.centreId, d.channel, d.purpose, d.templateCode, d.recipientKind, d.recipientId, d.destinationMasked, d.destinationSha256, d.destinationE164,
      JSON.stringify(d.params), d.idempotencyKey, d.relatedType, d.relatedId, d.reportId, d.reportVersionNo, d.status, d.failureCode,
      d.queuedAt, d.sentAt, d.suppressedAt, d.actorId]);
  return rows[0];
}
