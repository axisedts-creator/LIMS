// Task engagement.create_notification (LD-180, 2026-11-14, founder go 19:12, CR-C16-T-N1 OPTION A; 05-SCHEMA notifications INSERT is SYS only; 02-TRD §4.9; 07-SECURITY §3).
// Generic in-app notification writer: the API enqueues it inside the request transaction (outbox semantics); this task creates the row as the engagement system actor (ctx.actor).
// Payload EXACTLY {tenant_id, account_id, patient_id (uuid | null), kind, entity_type, entity_id, entity_seq}: no text, no PHI. Any other shape is a silent no-op (nothing to retry), like send_booking_message.
// Tenant = job claims (ctx.tenantId); a payload tenant that differs or is missing is rejected. kind allowlist = enquiry_reply only (LD-180 rule 2).
// Redelivery is harmless: ON CONFLICT ON CONSTRAINT notifications__dedupe__uq DO NOTHING. Rejections log a reason only, never a payload value.
// [CONV] row expires 180 days after creation (as tasks/send_booking_message.ts); route_id stays NULL (05-SCHEMA route check has no enquiry route).
// [CONV] not in TASKS/maxAttempts: 02-TRD §8.1 has no row yet (non-blocking CR .orchestra/cr/T-N1-trd-8.1.md), so the queue default applies.
import type { TaskHandler } from '../../../core/manifest.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

export const CREATE_NOTIFICATION = 'engagement.create_notification';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTIFICATION_TTL_MS = 180 * 24 * 3_600_000;
/** kind -> entity_type it may point at (LD-180: enquiry_reply only; booking kinds are written by their own tasks). */
const KINDS: Readonly<Record<string, string>> = Object.freeze({ enquiry_reply: 'enquiry' });
const KEYS = ['account_id', 'entity_id', 'entity_seq', 'entity_type', 'kind', 'patient_id', 'tenant_id'].join();

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

function valid(p: unknown, tenantId: unknown): p is Record<string, any> {
  if (typeof tenantId !== 'string' || typeof p !== 'object' || p === null || Array.isArray(p)) return false;
  const o = p as Record<string, unknown>;
  if (Object.keys(o).sort().join() !== KEYS) return false;
  return o['tenant_id'] === tenantId && isUuid(o['account_id']) && isUuid(o['entity_id']) && (o['patient_id'] === null || isUuid(o['patient_id']))
    && typeof o['kind'] === 'string' && Object.hasOwn(KINDS, o['kind']) && o['entity_type'] === KINDS[o['kind']]
    && Number.isSafeInteger(o['entity_seq']) && (o['entity_seq'] as number) >= 0;
}

export function createCreateNotification(): TaskHandler {
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any;
    if (!valid(payload, ctx.tenantId)) { ctx.log?.warn?.({ event: 'create_notification_skipped', reason: 'bad_payload' }); return; }
    const expiresAt = new Date(Date.parse(ctx.now()) + NOTIFICATION_TTL_MS).toISOString();
    await ctx.tx.query(
      `INSERT INTO engagement.notifications (id, tenant_id, account_id, patient_id, kind, entity_type, entity_id, entity_seq, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT ON CONSTRAINT notifications__dedupe__uq DO NOTHING`,
      [uuidv7(), ctx.tenantId, payload['account_id'], payload['patient_id'], payload['kind'], payload['entity_type'], payload['entity_id'], payload['entity_seq'], ctx.actor.id, expiresAt]);
  };
}
