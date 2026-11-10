// FD-T12: order flags raised by the frontdesk consumers (02-TRD §3.1, §8.2; 08 A13 D-6, A2.12). Everything runs in ctx.tx (the job tx); no transaction, no connection of its own.
// The flag is the unit of work: a flag is inserted-if-absent (the partial unique indexes make a redelivery, and the rejected + status_changed pair, one row - D-6);
// the recollection SMS is a best-effort side effect that never fails or rolls back the flag (TRD §6.4).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { createCoreRepo } from '../../../core/core-repo/index.js';
import { upsertOrderFlag } from '../repository/flags.repo.js';
import { listConsentsByPatient } from '../repository/consents.repo.js';
import { getOrderById } from '../repository/orders.repo.js';
import { getPatientById } from '../repository/patients.repo.js';
import type { Tx } from '../repository/shared.repo.js';

type Obj = Record<string, any>;
export interface FlagCtx { readonly tenantId: string; readonly tx: Tx; readonly log?: any; readonly ports?: Record<string, any> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const core = createCoreRepo({} as never);

/** The stored order of THIS tenant for an event-supplied id; null for a malformed or unknown id (the event is a hint, never a key into another tenant). */
export async function orderForEvent(c: FlagCtx, orderId: unknown): Promise<Obj | null> {
  return typeof orderId === 'string' && UUID.test(orderId) ? getOrderById(c.tx, c.tenantId, orderId) : null;
}

/** open recollection_required flag for the specimen; the centre comes from the stored order, never from the event. Idempotent. */
export async function raiseRecollectionFlag(c: FlagCtx, order: Obj, specimenId: string, sourceEventId?: string): Promise<void> {
  await upsertOrderFlag(c.tx, c.tenantId, { id: uuidv7(), centre_id: order['centre_id'], order_id: order['id'], kind: 'recollection_required', specimen_id: specimenId,
    ...(sourceEventId ? { source_event_id: sourceEventId } : {}) });
}

/** open booking_cancelled_after_registration flag (one per order); the order itself is never touched (08 A2.12). Idempotent. */
export async function raiseBookingCancelledFlag(c: FlagCtx, order: Obj): Promise<void> {
  await upsertOrderFlag(c.tx, c.tenantId, { id: uuidv7(), centre_id: order['centre_id'], order_id: order['id'], kind: 'booking_cancelled_after_registration' });
}

/**
 * recollection_request SMS (TRD §8.2): params exactly {lab_name, centre_phone}; the key is per specimen so the port dedupes every redelivery.
 * C4 decides tenant channel + consent (as registration does); the port decides the rest. Never throws.
 */
export async function sendRecollectionSms(c: FlagCtx & { ports: Record<string, any> }, order: Obj, specimenId: string): Promise<void> {
  try {
    const { IdentityPort: identity, NotificationPort: notify } = c.ports;
    if (!identity || !notify) return;
    const tenant = (await identity.getTenantSettings(c, { keys: ['branding', 'channels'] })) ?? {};
    if (tenant.channels?.smsEnabled !== true) return;
    const patient = await getPatientById(c.tx, c.tenantId, order['patient_id']);
    if (!patient || patient['anonymised_at'] != null || !patient['phone_e164']) return;
    if ((await listConsentsByPatient(c.tx, c.tenantId, patient['id']))[0]?.['sms'] !== true) return;
    const phone = (await core.centre(c as never, { centreId: order['centre_id'] })).phoneDisplay;
    if (!phone) return;                                    // nothing true to put in the message: the flag stays the work item
    await notify.sendSms(c, { recipient: { kind: 'patient', patientId: patient['id'] }, templateCode: 'frontdesk.recollection_request', purpose: 'recollection_request',
      params: { lab_name: String(tenant.branding?.displayName ?? ''), centre_phone: phone }, idempotencyKey: `${specimenId}:recollection_sms`,
      related: { entityType: 'specimen', entityId: specimenId } });
  } catch (e) {
    c.log?.warn?.({ code: String((e as { code?: unknown } | null)?.code ?? 'unknown'), specimen_id: specimenId }, 'recollection sms not attempted');
  }
}
