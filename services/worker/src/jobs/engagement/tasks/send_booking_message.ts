// Task engagement.send_booking_message (02-TRD §4.8 step 7, §4.9, §8.1 max 8 job_key bmsg:<booking_id>:<kind>, §9 sendSms row; PRD US-EN-12.8; 07-SECURITY REQ-SEC-007/-106; CR-C16-009 as modified by 08 R13).
// Payload {tenant_id, booking_id, kind}; kind 'confirmation' -> engagement.booking_confirmation, 'cancelled' -> engagement.booking_cancelled (purposes booking_confirmation / booking_cancelled).
// Re-read the booking (tenant-scoped). Stale or hostile jobs (bad payload, unknown / other-tenant booking, confirmation for a cancelled booking, cancelled for a live one) are silent no-ops: nothing to retry.
// NotificationPort.sendSms as the system actor, recipient by patientId only, params EXACTLY {lab_name, datetime, booking_no}, idempotencyKey bmsg:<id>:<kind> (so a retry gets the same delivery).
// Any port failure THROWS: the tx rolls back and the queue retries. suppressed_* (consent, contact, channel) is an outcome, not an error.
// In-app: one engagement.notifications row per ACTIVE linked account (kind booking_confirmed | booking_cancelled, no text stored), also when the SMS is suppressed.
// [CONV] transactional message: neither settings.reminders_enabled nor accounts.reminders_opt_out gates it (those are the reminder switches); consent is the port's job.
// [CONV] datetime / lab_name rendering = tasks/send_reminder.ts (tenant timezone 'YYYY-MM-DD HH:mm'; display name stripped to short_text charset); notification row expires after 180 days (TRD §4.9, 05-SCHEMA retention).
import type { TaskHandler } from '../../../core/manifest.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

type Row = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTIFICATION_TTL_MS = 180 * 24 * 3_600_000;
const KINDS = {
  confirmation: { templateCode: 'engagement.booking_confirmation', purpose: 'booking_confirmation', notification: 'booking_confirmed' },
  cancelled: { templateCode: 'engagement.booking_cancelled', purpose: 'booking_cancelled', notification: 'booking_cancelled' },
} as const;
const PORT_SUPPRESSED = new Set(['suppressed_no_consent', 'suppressed_no_contact', 'suppressed_channel_disabled']);
const labParam = (name: unknown) => (typeof name === 'string' ? name.replace(/[^A-Za-z0-9 .,:/()-]/g, '').trim().slice(0, 40) : '') || 'Laboratory';

function formatAt(instant: unknown, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant as string | Date)).map((p) => [p.type, p.value]));
  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}`;
}

export function createSendBookingMessage(): TaskHandler {
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any;
    const tenantId = ctx.tenantId; const bookingId = payload?.['booking_id']; const kind = payload?.['kind'];
    if (typeof tenantId !== 'string' || payload?.['tenant_id'] !== tenantId || typeof bookingId !== 'string' || !UUID.test(bookingId) || typeof kind !== 'string' || !Object.hasOwn(KINDS, kind)) {
      ctx.log?.warn?.({ event: 'send_booking_message_skipped', reason: 'bad_payload' });
      return;
    }
    const k = KINDS[kind as keyof typeof KINDS];
    const tx = ctx.tx;
    const rows = async (sql: string, values: unknown[]): Promise<Row[]> => (await tx.query(sql, values)).rows;

    const booking = (await rows(`SELECT id, patient_id, booking_no, slot_start, status FROM engagement.bookings WHERE tenant_id = $1 AND id = $2`, [tenantId, bookingId]))[0];
    if (!booking || (booking['status'] === 'cancelled') !== (kind === 'cancelled')) { ctx.log?.info?.({ event: 'send_booking_message_noop' }); return; }

    const tenantSettings = await ctx.ports.IdentityPort.getTenantSettings(ctx);
    const tz: string = tenantSettings?.timezone ?? 'UTC';
    const sent = await ctx.ports.NotificationPort.sendSms(ctx, {
      recipient: { kind: 'patient', patientId: booking['patient_id'] },
      templateCode: k.templateCode, purpose: k.purpose,
      params: { lab_name: labParam(tenantSettings?.branding?.displayName), datetime: formatAt(booking['slot_start'], tz), booking_no: String(booking['booking_no']) },
      idempotencyKey: `bmsg:${bookingId}:${kind}`, related: { entityType: 'booking', entityId: bookingId },
    });
    if (sent?.status !== 'queued' && !PORT_SUPPRESSED.has(sent?.status)) throw new Error('send_booking_message: unexpected NotificationPort status');   // fail closed: retry, never swallow an unknown outcome

    const accounts = await rows(
      `SELECT a.id AS account_id FROM engagement.account_patient_links l JOIN engagement.accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
       WHERE l.tenant_id = $1 AND l.patient_id = $2 AND l.status = 'active' AND a.status = 'active' ORDER BY a.id`,
      [tenantId, booking['patient_id']]);
    const expiresAt = new Date(Date.parse(ctx.now()) + NOTIFICATION_TTL_MS).toISOString();
    for (const a of accounts) {
      await tx.query(
        `INSERT INTO engagement.notifications (id, tenant_id, account_id, patient_id, kind, entity_type, entity_id, entity_seq, route_id, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'booking', $6, 0, 'patient_app.booking', $7, $8) ON CONFLICT DO NOTHING`,
        [uuidv7(), tenantId, a['account_id'], booking['patient_id'], k.notification, bookingId, ctx.actor.id, expiresAt]);
    }
  };
}
