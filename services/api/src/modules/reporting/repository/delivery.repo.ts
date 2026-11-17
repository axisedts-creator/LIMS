// reporting.deliveries / delivery_attempts / portal_links (delivery side) / channel_accounts / message_template_texts / centre_contacts access
// (02-TRD §4.8, §7.2; 05-SCHEMA §2.8). Every tenant-table statement names tenant_id explicitly next to RLS; parameters only.
import type { Tx } from './settings.repo.js';

export interface DeliveryRow { id: string; status: string; failure_code: string | null }
export type FullDelivery = Record<string, any>;
export interface DeliveryInsert {
  id: string; tenantId: string; centreId: string | null; channel: string; purpose: string; templateCode: string | null;
  recipientKind: string; recipientId: string | null; destinationMasked: string | null; destinationSha256: Buffer | null; destinationE164: string | null;
  params: Record<string, string>; idempotencyKey: string; relatedType: string | null; relatedId: string | null;
  reportId: string | null; reportVersionNo: number | null; status: string; failureCode: string | null;
  queuedAt: Date | null; sentAt: Date | null; suppressedAt: Date | null; actorId: string;
  deferredLink?: Record<string, unknown> | null; fallbackOfDeliveryId?: string | null;
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

export async function findCentreContact(tx: Tx, tenantId: string, id: string): Promise<{ id: string; centre_id: string; channel: string; address: string; is_active: boolean } | undefined> {
  const { rows } = await tx.query(`SELECT id, centre_id, channel, address, is_active FROM reporting.centre_contacts WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows[0];
}

export async function listActiveCentreContacts(tx: Tx, tenantId: string, centreId: string): Promise<Array<{ id: string; channel: string; address: string }>> {
  const { rows } = await tx.query(
    `SELECT id, channel, address FROM reporting.centre_contacts WHERE tenant_id = $1 AND centre_id = $2 AND is_active = true ORDER BY created_at, id`, [tenantId, centreId]);
  return rows;
}

export async function findReferrerDisabledChannels(tx: Tx, tenantId: string, referrerId: string): Promise<string[]> {
  const { rows } = await tx.query(`SELECT disabled_channels FROM reporting.referrer_preferences WHERE tenant_id = $1 AND referrer_id = $2`, [tenantId, referrerId]);
  return Array.isArray(rows[0]?.disabled_channels) ? rows[0].disabled_channels : [];
}

/** ON CONFLICT (tenant_id, idempotency_key) DO NOTHING: undefined = a concurrent call with the same key won. */
export async function insertDeliveryRow(tx: Tx, d: DeliveryInsert): Promise<DeliveryRow | undefined> {
  const { rows } = await tx.query(
    `INSERT INTO reporting.deliveries (id, tenant_id, centre_id, channel, purpose, template_code, recipient_kind, recipient_id, destination_masked, destination_sha256, destination_e164, params, idempotency_key, related_entity_type, related_entity_id, report_id, report_version_no, status, failure_code, queued_at, sent_at, suppressed_at, created_by, updated_by, deferred_link, fallback_of_delivery_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $23, $24::jsonb, $25)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id, status, failure_code`,
    [d.id, d.tenantId, d.centreId, d.channel, d.purpose, d.templateCode, d.recipientKind, d.recipientId, d.destinationMasked, d.destinationSha256, d.destinationE164,
      JSON.stringify(d.params), d.idempotencyKey, d.relatedType, d.relatedId, d.reportId, d.reportVersionNo, d.status, d.failureCode,
      d.queuedAt, d.sentAt, d.suppressedAt, d.actorId, d.deferredLink ? JSON.stringify(d.deferredLink) : null, d.fallbackOfDeliveryId ?? null]);
  return rows[0];
}

// ------------------------------------------------------------------------------------------------ reads (D1, D2, send task)
export async function findDelivery(tx: Tx, tenantId: string, id: string, lock = false): Promise<FullDelivery | undefined> {
  const sql = lock
    ? `SELECT id, centre_id, channel, purpose, template_code, recipient_kind, recipient_id, destination_masked, destination_sha256, destination_e164, params, language, idempotency_key, related_entity_type, related_entity_id, report_id, report_version_no, deferred_link, link_id, status, failure_code, attempt_no, channel_account_id, provider_kind, provider_message_id, fallback_of_delivery_id, fallback_check_at, queued_at, sent_at, delivered_at, read_at, failed_at, suppressed_at, version, created_at FROM reporting.deliveries WHERE tenant_id = $1 AND id = $2 FOR UPDATE`
    : `SELECT id, centre_id, channel, purpose, template_code, recipient_kind, recipient_id, destination_masked, destination_sha256, destination_e164, params, language, idempotency_key, related_entity_type, related_entity_id, report_id, report_version_no, deferred_link, link_id, status, failure_code, attempt_no, channel_account_id, provider_kind, provider_message_id, fallback_of_delivery_id, fallback_check_at, queued_at, sent_at, delivered_at, read_at, failed_at, suppressed_at, version, created_at FROM reporting.deliveries WHERE tenant_id = $1 AND id = $2`;
  const { rows } = await tx.query(sql, [tenantId, id]);
  return rows[0];
}

export interface DeliveryFilter { status?: string; channel?: string; purpose?: string; recipientKind?: string; reportId?: string; from?: string; to?: string; afterCreatedAt?: string; afterId?: string }
/** Newest first; keyset (created_at, id) descending. The cursor predicate is written as two OR-groups: (c < k OR c = k) AND (c < k OR id < i). */
export async function listDeliveries(tx: Tx, tenantId: string, f: DeliveryFilter, limit: number): Promise<FullDelivery[]> {
  const { rows } = await tx.query(
    `SELECT id, channel, purpose, recipient_kind, destination_masked, template_code, report_id, report_version_no, status, failure_code, attempt_no, fallback_of_delivery_id, queued_at, sent_at, delivered_at, read_at, failed_at, created_at
     FROM reporting.deliveries
     WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR channel = $3) AND ($4::text IS NULL OR purpose = $4)
       AND ($5::text IS NULL OR recipient_kind = $5) AND ($6::uuid IS NULL OR report_id = $6) AND ($7::timestamptz IS NULL OR created_at >= $7) AND ($8::timestamptz IS NULL OR created_at <= $8)
       AND ($9::timestamptz IS NULL OR created_at < $9 OR created_at = $9) AND ($9::timestamptz IS NULL OR created_at < $9 OR id < $10)
     ORDER BY created_at DESC, id DESC LIMIT $11`,
    [tenantId, f.status ?? null, f.channel ?? null, f.purpose ?? null, f.recipientKind ?? null, f.reportId ?? null, f.from ?? null, f.to ?? null, f.afterCreatedAt ?? null, f.afterId ?? null, limit]);
  return rows;
}

/** R18: critical_value_alert rows of the window (index deliveries__tenant_id_purpose_created_at__idx). No params / destination columns. Centre scope = RLS. */
export async function listCriticalAlertDeliveries(tx: Tx, tenantId: string, since: string, centreId: string | null): Promise<Array<Record<string, any>>> {
  const { rows } = await tx.query(
    `SELECT id, centre_id, recipient_kind, recipient_id, status, failure_code, related_entity_id, report_id, created_at
     FROM reporting.deliveries
     WHERE tenant_id = $1 AND purpose = 'critical_value_alert' AND related_entity_type = 'critical_event' AND created_at >= $2 AND ($3::uuid IS NULL OR centre_id = $3)`,
    [tenantId, since, centreId]);
  return rows;
}

/** R18: order id + registration no. of the alerts' reports (snapshot columns only). */
export async function findReportRefs(tx: Tx, tenantId: string, ids: string[]): Promise<Array<{ id: string; order_id: string; registration_no: string }>> {
  const { rows } = await tx.query(`SELECT id, order_id, registration_no FROM reporting.reports WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, ids]);
  return rows;
}

export async function listAttempts(tx: Tx, tenantId: string, deliveryId: string): Promise<Array<Record<string, any>>> {
  const { rows } = await tx.query(
    `SELECT attempt_no, started_at, finished_at, outcome, error_code FROM reporting.delivery_attempts WHERE tenant_id = $1 AND delivery_id = $2 ORDER BY attempt_no`, [tenantId, deliveryId]);
  return rows;
}

export async function latestAttemptNo(tx: Tx, tenantId: string, deliveryId: string): Promise<number> {
  const { rows } = await tx.query(
    `SELECT attempt_no FROM reporting.delivery_attempts WHERE tenant_id = $1 AND delivery_id = $2 ORDER BY attempt_no DESC LIMIT 1`, [tenantId, deliveryId]);
  return rows[0]?.attempt_no ?? 0;
}

export async function findFallbackOf(tx: Tx, tenantId: string, deliveryId: string): Promise<{ id: string } | undefined> {
  const { rows } = await tx.query(`SELECT id FROM reporting.deliveries WHERE tenant_id = $1 AND fallback_of_delivery_id = $2`, [tenantId, deliveryId]);
  return rows[0];
}

// ------------------------------------------------------------------------------------------------ report context
export async function findReportMeta(tx: Tx, tenantId: string, reportId: string): Promise<{ id: string; centre_id: string; patient_id: string; referrer_id: string | null } | undefined> {
  const { rows } = await tx.query(`SELECT id, centre_id, patient_id, referrer_id FROM reporting.reports WHERE tenant_id = $1 AND id = $2`, [tenantId, reportId]);
  return rows[0];
}

/** The order's `laboratory` report (UNIQUE tenant_id, order_id, family). */
export async function findLabReportOfOrder(tx: Tx, tenantId: string, orderId: string): Promise<{ id: string } | undefined> {
  const { rows } = await tx.query(`SELECT id FROM reporting.reports WHERE tenant_id = $1 AND order_id = $2 AND family = 'laboratory'`, [tenantId, orderId]);
  return rows[0];
}

export async function findReleasedVersion(tx: Tx, tenantId: string, reportId: string): Promise<{ id: string; version_no: number } | undefined> {
  const { rows } = await tx.query(`SELECT id, version_no FROM reporting.report_versions WHERE tenant_id = $1 AND report_id = $2 AND status = 'released'`, [tenantId, reportId]);
  return rows[0];
}

export async function findVersion(tx: Tx, tenantId: string, versionId: string): Promise<{ id: string; report_id: string; version_no: number; status: string; audiences: string[] | null } | undefined> {
  const { rows } = await tx.query(`SELECT id, report_id, version_no, status, audiences FROM reporting.report_versions WHERE tenant_id = $1 AND id = $2`, [tenantId, versionId]);
  return rows[0];
}

export async function findQrSnapshot(tx: Tx, tenantId: string, reportId: string): Promise<{ lab_name_snapshot: string; patient_display_snapshot: string } | undefined> {
  const { rows } = await tx.query(
    `SELECT lab_name_snapshot, patient_display_snapshot FROM reporting.qr_tokens WHERE tenant_id = $1 AND report_id = $2 ORDER BY issued_at DESC LIMIT 1`, [tenantId, reportId]);
  return rows[0];
}

// ------------------------------------------------------------------------------------------------ send task
export async function findActiveChannelAccount(tx: Tx, tenantId: string, channel: string): Promise<{ id: string; provider_kind: string; sender_id: string | null; secret_ref: string } | undefined> {
  const { rows } = await tx.query(
    `SELECT id, provider_kind, sender_id, secret_ref FROM reporting.channel_accounts WHERE tenant_id = $1 AND channel = $2 AND is_active = true`, [tenantId, channel]);
  return rows[0];
}

export async function findTemplateText(tx: Tx, tenantId: string, code: string, channel: string, language: string): Promise<Record<string, any> | undefined> {
  const { rows } = await tx.query(
    `SELECT body_text, subject_text, provider_template_name, provider_template_language, provider_variable_order, approval_status FROM reporting.message_template_texts WHERE tenant_id = $1 AND template_code = $2 AND channel = $3 AND language = $4`,
    [tenantId, code, channel, language]);
  return rows[0];
}

/** Optimistic claim of a queued delivery: bumps the version and records the attempt number; zero rows = another run won. */
export async function claimDelivery(tx: Tx, tenantId: string, id: string, version: number, attemptNo: number, at: string, actorId: string): Promise<boolean> {
  const { rows } = await tx.query(
    `UPDATE reporting.deliveries SET attempt_no = $4, version = version + 1, updated_at = $5, updated_by = $6 WHERE tenant_id = $1 AND id = $2 AND status = 'queued' AND version = $3 RETURNING version`,
    [tenantId, id, version, attemptNo, at, actorId]);
  return rows.length > 0;
}

export interface Transition {
  status: 'sent' | 'failed' | 'suppressed'; failureCode?: string | null; at: string; actorId: string;
  channelAccountId?: string | null; providerKind?: string | null; providerMessageId?: string | null; linkId?: string | null; fallbackCheckAt?: string | null;
  destinationMasked?: string | null; destinationSha256?: Buffer | null;
}
/** queued -> sent | failed | suppressed. Terminal-ish: scrubs params.url / params.otp_code and destination_e164 (05-SCHEMA scrub-only trigger). Returns the new version. */
export async function transitionDelivery(tx: Tx, tenantId: string, id: string, t: Transition): Promise<number | undefined> {
  const { rows } = await tx.query(
    `UPDATE reporting.deliveries SET status = $3, failure_code = COALESCE($4, failure_code),
       sent_at = COALESCE($5, sent_at), failed_at = $6, suppressed_at = COALESCE($7, suppressed_at),
       channel_account_id = $8, provider_kind = $9, provider_message_id = $10,
       link_id = COALESCE($11, link_id), fallback_check_at = $12,
       destination_masked = COALESCE(destination_masked, $13), destination_sha256 = COALESCE(destination_sha256, $14),
       params = params - 'url' - 'otp_code', destination_e164 = NULL, version = version + 1, updated_at = $15, updated_by = $16
     WHERE tenant_id = $1 AND id = $2 AND status = 'queued' RETURNING version`,
    [tenantId, id, t.status, t.failureCode ?? null, t.status === 'sent' ? t.at : null, t.status === 'failed' ? t.at : null, t.status === 'suppressed' ? t.at : null,
      t.channelAccountId ?? null, t.providerKind ?? null, t.providerMessageId ?? null, t.linkId ?? null, t.fallbackCheckAt ?? null,
      t.destinationMasked ?? null, t.destinationSha256 ?? null, t.at, t.actorId]);
  return rows[0]?.version;
}

export async function insertAttempt(tx: Tx, a: { id: string; tenantId: string; deliveryId: string; attemptNo: number; startedAt: string; finishedAt: string; outcome: string; errorCode: string | null; actorId: string }): Promise<void> {
  await tx.query(
    `INSERT INTO reporting.delivery_attempts (id, tenant_id, delivery_id, attempt_no, started_at, finished_at, outcome, error_code, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [a.id, a.tenantId, a.deliveryId, a.attemptNo, a.startedAt, a.finishedAt, a.outcome, a.errorCode, a.actorId]);
}

// ------------------------------------------------------------------------------------------------ deferred links
export async function revokeDeliveryLinks(tx: Tx, tenantId: string, deliveryId: string, reason: string, at: string, actorId: string): Promise<void> {
  await tx.query(
    `UPDATE reporting.portal_links SET revoked_at = $3, revoke_reason_code = $4, revoked_by = $5, version = version + 1, updated_at = $3, updated_by = $5
     WHERE tenant_id = $1 AND delivery_id = $2 AND revoked_at IS NULL`, [tenantId, deliveryId, at, reason, actorId]);
}

export async function insertPortalLink(tx: Tx, l: {
  id: string; tenantId: string; centreId: string; reportId: string; boundVersionNo: number; channel: string; recipientKind: string; destinationMasked: string | null;
  destinationSha256: Buffer | null; patientDisplay: string; tokenSha256: Uint8Array; expiresAt: string; deliveryId: string; purpose: string; actorId: string;
}): Promise<void> {
  await tx.query(
    `INSERT INTO reporting.portal_links (id, tenant_id, centre_id, report_id, bound_version_no, channel, recipient_kind, destination_masked, destination_sha256, patient_display_snapshot, token_sha256, expires_at, delivery_id, purpose, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15)`,
    [l.id, l.tenantId, l.centreId, l.reportId, l.boundVersionNo, l.channel, l.recipientKind, l.destinationMasked, l.destinationSha256, l.patientDisplay, Buffer.from(l.tokenSha256), l.expiresAt, l.deliveryId, l.purpose, l.actorId]);
}
