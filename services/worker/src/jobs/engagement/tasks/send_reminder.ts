// Task engagement.send_reminder (02-TRD §4.11, §8.1 max 8, §9 sendSms row; PRD US-EN-23.1-4; 07-SECURITY REQ-SEC-007/-070). Job key rem:<id>.
// Re-read the reminder (tenant-scoped, FOR UPDATE): anything but `scheduled` (sent, cancelled, unknown, other tenant) is a silent no-op, so duplicates and races send nothing.
// reminders_enabled=false (or no settings row) -> suppressed / reminders_disabled. Opt-out of ANY active-linked account -> suppressed / opted_out, no SMS.
// Else NotificationPort.sendSms as the system actor, recipient by patientId only, params EXACTLY {lab_name, datetime} (+ booking_no for booking reminders; 04 R6),
// idempotencyKey rem:<id>: queued -> sent (+ sent_at, delivery_id); suppressed_* -> suppressed with the port status as failure_code.
// Any port failure THROWS: the tx rolls back, the reminder stays `scheduled`, the queue retries with the same key and gets the same delivery (replayed).
// In-app: one engagement.notifications row per ACTIVE linked account, also when the SMS is suppressed or opted out (AC-23.3); none without a link.
// [CONV] datetime is rendered in the tenant timezone as YYYY-MM-DD (reminders) or YYYY-MM-DD HH:mm (bookings); the A.D./B.S. calendar switch is not applied here.
// [CONV] feature off (reminders_enabled=false) writes no in-app rows; the notification row expires after 30 days.
import type { TaskHandler } from '../../../core/manifest.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

type Row = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTIFICATION_TTL_MS = 30 * 24 * 3_600_000;
const PORT_SUPPRESSED = new Set(['suppressed_no_consent', 'suppressed_no_contact', 'suppressed_channel_disabled']);
/** short_text template param (<= 40 of [A-Za-z0-9 .,:/()-]): strip, clip, never fail the send on a fancy lab name. */
const labParam = (name: unknown) => (typeof name === 'string' ? name.replace(/[^A-Za-z0-9 .,:/()-]/g, '').trim().slice(0, 40) : '') || 'Laboratory';

function formatAt(instant: unknown, timeZone: string, withTime: boolean): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant as string | Date)).map((p) => [p.type, p.value]));
  const date = `${parts['year']}-${parts['month']}-${parts['day']}`;
  return withTime ? `${date} ${parts['hour']}:${parts['minute']}` : date;
}

export function createSendReminder(): TaskHandler {
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any;
    const tenantId = ctx.tenantId; const reminderId = payload?.['reminder_id'];
    if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId || typeof reminderId !== 'string' || !UUID.test(reminderId)) {
      ctx.log?.warn?.({ event: 'send_reminder_skipped', reason: 'bad_payload' });
      return;
    }
    const tx = ctx.tx;
    const rows = async (sql: string, values: unknown[]): Promise<Row[]> => (await tx.query(sql, values)).rows;
    const now: string = ctx.now(); const actorId: string = ctx.actor.id;

    const rem = (await rows(`SELECT id, patient_id, kind, source_ref_id, due_at, status FROM engagement.reminders WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, reminderId]))[0];
    if (!rem || rem['status'] !== 'scheduled') { ctx.log?.info?.({ event: 'send_reminder_noop' }); return; }
    const isBooking = rem['kind'] === 'booking';

    const finish = async (status: 'sent' | 'suppressed' | 'failed', a: { deliveryId?: string; failureCode?: string }) => {
      await tx.query(
        `UPDATE engagement.reminders SET status = $3, sent_at = $4, delivery_id = $5, failure_code = $6, version = version + 1, updated_at = $7, updated_by = $8
         WHERE tenant_id = $1 AND id = $2 AND status = 'scheduled'`,
        [tenantId, reminderId, status, status === 'sent' ? now : null, a.deliveryId ?? null, a.failureCode ?? null, now, actorId]);
    };

    const settings = (await rows(`SELECT reminders_enabled FROM engagement.settings WHERE tenant_id = $1`, [tenantId]))[0];
    if (settings?.['reminders_enabled'] !== true) { await finish('suppressed', { failureCode: 'reminders_disabled' }); return; }

    // One row per ACTIVE link of the patient (revoked / suspended links and deleted accounts never match).
    const accounts = await rows(
      `SELECT a.id AS account_id, a.reminders_opt_out FROM engagement.account_patient_links l JOIN engagement.accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
       WHERE l.tenant_id = $1 AND l.patient_id = $2 AND l.status = 'active' AND a.status = 'active' ORDER BY a.id`,
      [tenantId, rem['patient_id']]);

    let booking: Row | undefined;
    if (isBooking) {
      booking = (await rows(`SELECT id, booking_no, slot_start, status FROM engagement.bookings WHERE tenant_id = $1 AND id = $2`, [tenantId, rem['source_ref_id']]))[0];
    }

    if (isBooking && booking?.['status'] !== 'confirmed') {
      await finish('suppressed', { failureCode: booking ? 'booking_inactive' : 'booking_not_found' });   // nothing to remind about: no SMS (the in-app hook has no booking to point at)
      return;
    }
    if (accounts.some((a) => a['reminders_opt_out'] === true)) {
      await finish('suppressed', { failureCode: 'opted_out' });
    } else {
      const tenantSettings = await ctx.ports.IdentityPort.getTenantSettings(ctx);
      const tz: string = tenantSettings?.timezone ?? 'UTC';
      const params: Record<string, string> = { lab_name: labParam(tenantSettings?.branding?.displayName), datetime: isBooking ? formatAt(booking!['slot_start'], tz, true) : formatAt(rem['due_at'], tz, false) };
      if (isBooking) params['booking_no'] = String(booking!['booking_no']);
      let failure: unknown;
      try {
        const sent = await ctx.ports.NotificationPort.sendSms(ctx, {
          recipient: { kind: 'patient', patientId: rem['patient_id'] },
          templateCode: isBooking ? 'engagement.booking_reminder' : 'engagement.follow_up_reminder',
          purpose: isBooking ? 'booking_reminder' : 'follow_up_reminder',
          params, idempotencyKey: `rem:${reminderId}`,
          ...(isBooking ? { related: { entityType: 'booking', entityId: booking!['id'] } } : {}),
        });
        if (sent?.status === 'queued') await finish('sent', { deliveryId: sent.deliveryId });
        else if (PORT_SUPPRESSED.has(sent?.status)) await finish('suppressed', { failureCode: sent.status });
        else throw new Error('send_reminder: unexpected NotificationPort status');   // fail closed: retry, never record an unknown outcome
      } catch (e) { failure = e; }
      if (failure !== undefined) {
        // 03-APP-FLOW reminder states: scheduled -> failed (port error after retries). Earlier attempts throw (tx rolls back, queue retries).
        if (!(ctx.attempt >= ctx.maxAttempts)) throw failure;
        const code = (failure as { code?: unknown })?.code;
        await finish('failed', { failureCode: typeof code === 'string' && /^[a-z_.]{1,64}$/.test(code) ? code : 'common.internal' });
        return;
      }
    }

    for (const a of accounts) {
      await tx.query(
        `INSERT INTO engagement.notifications (id, tenant_id, account_id, patient_id, kind, entity_type, entity_id, entity_seq, route_id, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'reminder', $6, 0, $7, $8, $9) ON CONFLICT DO NOTHING`,
        [uuidv7(), tenantId, a['account_id'], rem['patient_id'],
          isBooking ? 'booking_reminder' : 'follow_up_reminder', reminderId, isBooking ? 'patient_app.booking' : null, actorId, new Date(Date.parse(now) + NOTIFICATION_TTL_MS).toISOString()]);
    }
  };
}
