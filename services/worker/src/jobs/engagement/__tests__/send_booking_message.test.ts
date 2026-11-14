// C16.T-B5 — worker side: task `engagement.send_booking_message` (confirmation / cancellation SMS + in-app notification) and the booking reminder window end to end.
// (06-PLAN row T-B5; 02-TRD §4.8 step 7, §4.9, §4.11, §8.1, §9 sendSms row; PRD US-EN-12.8, US-EN-25.1-2; 07-SECURITY REQ-SEC-007/-106, §7 rules 2+4; CR-C16-009 as modified by 08 R13.)
// done_when: templates per CR-C16-009. tests: NotificationPort spy; booking < 24 h ahead -> no reminder (the scheduling side is in service/__tests__/reminder.booking.test.ts).
// Fails now: manifest entry engagement.send_booking_message is the T-01 fail-closed stub and tasks/send_booking_message.ts does not exist.
//
// SEAMS (spec fixes behaviour, not file/function names; same convention as tasks/send_reminder.ts):
//   jobs/engagement/tasks/send_booking_message.ts exports createSendBookingMessage() -> TaskHandler. Payload {tenant_id, booking_id, kind}; job_key bmsg:<booking_id>:<kind> (TRD §8.1), max attempts 8.
//   ASSUMED (spec silent): kind ∈ 'confirmation' | 'cancelled' ('confirmation' is fixed by TRD §4.8 step 7; the cancel value mirrors template engagement.booking_cancelled / event .cancelled.v1).
//   Task re-reads the booking tenant-scoped (engagement.bookings), then NotificationPort.sendSms as the system actor, recipient by patientId only, params EXACTLY {lab_name, datetime, booking_no}
//   (lab_name = IdentityPort.getTenantSettings().branding.displayName; datetime = slot_start in the tenant timezone as 'YYYY-MM-DD HH:mm', the [CONV] of tasks/send_reminder.ts).
//   confirmation -> template engagement.booking_confirmation / purpose booking_confirmation; cancelled -> engagement.booking_cancelled / purpose booking_cancelled (08 R13).
//   In-app: one engagement.notifications row per ACTIVE linked account, kind booking_confirmed | booking_cancelled, entity booking, route patient_app.booking; also when the SMS is suppressed.
//   ASSUMED: transactional, so neither settings.reminders_enabled nor accounts.reminders_opt_out (reminder switches) gates it; consent is the port's job (suppressed_* is not an error, nothing to retry).
//   ASSUMED: a stale job is a silent no-op: 'confirmation' for a booking that is now cancelled, 'cancelled' for one that is not cancelled, unknown / other-tenant booking.
//   Any port failure THROWS (tx rolls back, queue retries with the same idempotency key and gets the same delivery).
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';
import { createReminderService } from '../../../../../api/src/modules/engagement/service/reminder.service.js';
import { ID, LAB_NAME, PATIENT, ACCOUNT_1, ACCOUNT_2, TENANT_A, TENANT_B, makeWorld, type World } from '../../../../../api/src/modules/engagement/__tests__/reminders.world.js';

const TASK = 'engagement.send_booking_message';
const HOUR = 3_600_000;
const SLOT = '2026-03-02T05:00:00.000Z'; // 10:45 Asia/Kathmandu (UTC+05:45)
const load = async () => (await import('../tasks/send_booking_message.js')).createSendBookingMessage() as (p: any, c: any) => Promise<void>;

async function setup(opts: { remindersEnabled?: boolean } = {}) {
  const w = makeWorld(opts); const task = await load();
  const run = (bookingId: unknown, kind: unknown = 'confirmation', over: Record<string, any> = {}, payload: Record<string, any> = {}) =>
    w.runTask(task, { tenant_id: TENANT_A, booking_id: bookingId, kind, ...payload }, over);
  return { w, run };
}
const paramsOf = (w: World, i = 0) => w.notif.calls[i]!.input['params'] as Record<string, string>;

describe('manifest: send_booking_message is implemented (TRD §8.1)', () => {
  it('registered, max 8 attempts, no longer the fail-closed stub, manifest still validates', async () => {
    expect(() => validateManifests([manifest])).not.toThrow();
    expect(typeof manifest.tasks?.[TASK]).toBe('function'); expect(manifest.maxAttempts?.[TASK]).toBe(8);
    const { w } = await setup();
    await expect(manifest.tasks![TASK]!({ tenant_id: TENANT_A, booking_id: ID(0xdead), kind: 'confirmation' } as any, w.jobCtx())).resolves.toBeUndefined();   // unknown booking -> quiet no-op, not "not implemented"
  });
});

describe('US-EN-12.8: confirmation SMS via NotificationPort (consent-gated, params {lab_name, datetime, booking_no})', () => {
  it('template engagement.booking_confirmation, purpose booking_confirmation, system actor, recipient by patientId only, key bmsg:<id>:confirmation, related booking', async () => {
    const { w, run } = await setup(); const b = w.booking({ slot_start: SLOT }); await run(b['id']);
    expect(w.notif.calls).toHaveLength(1); const c = w.notif.calls[0]!;
    expect(c.method).toBe('sendSms'); expect(c.actor).toBe('system');
    expect(c.input).toMatchObject({ templateCode: 'engagement.booking_confirmation', purpose: 'booking_confirmation', idempotencyKey: `bmsg:${b['id']}:confirmation`, related: { entityType: 'booking', entityId: b['id'] } });
    expect(c.input['recipient']).toEqual({ kind: 'patient', patientId: PATIENT });
    expect(Object.keys(paramsOf(w)).sort()).toEqual(['booking_no', 'datetime', 'lab_name']);                    // exactly: REQ-SEC-007, 07-SECURITY §7.4
    expect(paramsOf(w)).toEqual({ lab_name: LAB_NAME, datetime: '2026-03-02 10:45', booking_no: 'BK2600001' });
  });
  it('cancellation: template engagement.booking_cancelled, purpose booking_cancelled (08 R13), key bmsg:<id>:cancelled, same three params', async () => {
    const { w, run } = await setup(); const b = w.booking({ slot_start: SLOT, status: 'cancelled' }); await run(b['id'], 'cancelled');
    expect(w.notif.calls).toHaveLength(1);
    expect(w.notif.calls[0]!.input).toMatchObject({ templateCode: 'engagement.booking_cancelled', purpose: 'booking_cancelled', idempotencyKey: `bmsg:${b['id']}:cancelled`, related: { entityType: 'booking', entityId: b['id'] } });
    expect(paramsOf(w)).toEqual({ lab_name: LAB_NAME, datetime: '2026-03-02 10:45', booking_no: 'BK2600001' });
  });
  it('the two messages of one booking use different idempotency keys (a cancel never replays the confirmation delivery)', async () => {
    const { w, run } = await setup(); const b = w.booking({ slot_start: SLOT }); await run(b['id']); b['status'] = 'cancelled'; await run(b['id'], 'cancelled');
    expect(w.notif.calls.map((c) => c.input['idempotencyKey'])).toEqual([`bmsg:${b['id']}:confirmation`, `bmsg:${b['id']}:cancelled`]); expect(new Set(w.notif.byKey.values()).size).toBe(2);
  });
  it('no PHI: no contact data, test names or patient name anywhere in the port input', async () => {
    const { w, run } = await setup(); const b = w.booking({ slot_start: SLOT }); await run(b['id']);
    expect(JSON.stringify(w.notif.calls[0]!.input)).not.toMatch(/\+977\d{6,}|Test Patient|Complete Blood Count|HbA1c|phone|name_en/i);
  });
  it('lab_name falls back to a safe value and never breaks the send when the branding name has odd characters', async () => {
    const { w, run } = await setup(); (w.identity as any).getTenantSettings = async () => ({ timezone: 'Asia/Kathmandu', branding: { displayName: '<b>Lab</b>\u0000 "Évry" & Sons' } });
    const b = w.booking({ slot_start: SLOT }); await run(b['id']);
    expect(paramsOf(w)['lab_name']).toMatch(/^[A-Za-z0-9 .,:/()-]{1,40}$/);
  });
});

describe('consent / suppression: port status is not an error', () => {
  for (const s of ['suppressed_no_consent', 'suppressed_no_contact', 'suppressed_channel_disabled'] as const) {
    it(`port status ${s}: task completes (no retry), exactly one port call, in-app notification still created`, async () => {
      const { w, run } = await setup(); w.account(ACCOUNT_1); w.link(ACCOUNT_1); w.notif.status = s; const b = w.booking({ slot_start: SLOT });
      await expect(run(b['id'])).resolves.toBeUndefined(); expect(w.notif.calls).toHaveLength(1);
      expect(w.notificationsOf(ACCOUNT_1).map((n) => n['kind'])).toEqual(['booking_confirmed']);
    });
  }
  it('ASSUMED transactional: reminders_enabled=false and a reminders_opt_out account do not stop the confirmation SMS', async () => {
    const { w, run } = await setup({ remindersEnabled: false }); w.account(ACCOUNT_1, { reminders_opt_out: true }); w.link(ACCOUNT_1); const b = w.booking({ slot_start: SLOT });
    await run(b['id']); expect(w.notif.calls).toHaveLength(1); expect(w.notificationsOf(ACCOUNT_1)).toHaveLength(1);
  });
});

describe('in-app notification (TRD §4.9): booking_confirmed / booking_cancelled, no text stored', () => {
  it('confirmation -> one row per ACTIVE linked account (revoked link none); fields: kind, entity booking, route patient_app.booking, expiry in the future', async () => {
    const { w, run } = await setup(); w.account(ACCOUNT_1); w.account(ACCOUNT_2); w.link(ACCOUNT_1); w.link(ACCOUNT_2, PATIENT, { status: 'revoked' }); const b = w.booking({ slot_start: SLOT }); await run(b['id']);
    expect(w.notificationsOf(ACCOUNT_2)).toEqual([]); const n = w.notificationsOf(ACCOUNT_1); expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ kind: 'booking_confirmed', account_id: ACCOUNT_1, patient_id: PATIENT, entity_type: 'booking', entity_id: b['id'], route_id: 'patient_app.booking' });
    expect(Date.parse(n[0]!['expires_at'])).toBe(Date.parse(w.now()) + 180 * 24 * 3_600_000);   // 180 days: TRD §4.9, 05-SCHEMA retention (review T-B5-review.md #2)
    expect(Object.keys(n[0]!).sort()).toEqual(expect.not.arrayContaining(['body', 'text', 'message', 'title', 'booking_no', 'params']));   // notifications store no text (07-SECURITY §7.4, REQ-SEC-106)
    expect(JSON.stringify(n[0])).not.toContain('BK2600001');
  });
  it('cancellation -> kind booking_cancelled; no link at all -> SMS still goes out, no rows, no error', async () => {
    const { w, run } = await setup(); w.account(ACCOUNT_1); w.link(ACCOUNT_1); const b = w.booking({ slot_start: SLOT, status: 'cancelled' }); await run(b['id'], 'cancelled');
    expect(w.notificationsOf(ACCOUNT_1).map((n) => n['kind'])).toEqual(['booking_cancelled']);
    const w2 = await setup(); const b2 = w2.w.booking({ slot_start: SLOT }); await w2.run(b2['id']); expect(w2.w.notif.calls).toHaveLength(1); expect(w2.w.t['notifications']).toEqual([]);
  });
});

describe('stale / hostile jobs are silent no-ops (no retry storm)', () => {
  it('ASSUMED: confirmation for a booking that is already cancelled, and cancelled for one that is not: nothing sent, nothing written', async () => {
    const { w, run } = await setup(); w.account(ACCOUNT_1); w.link(ACCOUNT_1);
    const gone = w.booking({ slot_start: SLOT, status: 'cancelled' }); const live = w.booking({ slot_start: SLOT, booking_no: 'BK2600002' }); const before = w.writes().length;
    await run(gone['id'], 'confirmation'); await run(live['id'], 'cancelled');
    expect(w.notif.calls).toEqual([]); expect(w.t['notifications']).toEqual([]); expect(w.writes().length).toBe(before);
  });
  it('booking of another tenant under this tenant\'s claims: not found -> no port call, no write', async () => {
    const { w, run } = await setup(); const b = w.booking({ tenant_id: TENANT_B, slot_start: SLOT }); await run(b['id']);
    expect(w.notif.calls).toEqual([]); expect(w.writes()).toEqual([]);
  });
  it('payload tenant_id different from the job tenant, unknown id, malformed id, unknown kind, missing keys: resolve quietly, nothing sent, nothing written', async () => {
    const { w, run } = await setup(); const b = w.booking({ slot_start: SLOT });
    await expect(run(b['id'], 'confirmation', {}, { tenant_id: TENANT_B })).resolves.toBeUndefined();
    for (const [id, kind] of [[ID(0xdead), 'confirmation'], ["x'; DROP TABLE engagement.bookings;--", 'confirmation'], [b['id'], 'refund'], [b['id'], 'CONFIRMATION'], [42, 'confirmation'], [undefined, 'confirmation']] as const)
      await expect(run(id, kind)).resolves.toBeUndefined();
    // missing kind: bypass run()'s default-parameter so the payload really has no kind (ruling T-B5-ruling.md)
    await expect(w.runTask(await load(), { tenant_id: TENANT_A, booking_id: b['id'] } as any, {})).resolves.toBeUndefined();
    await expect(w.runTask(await load(), { tenant_id: TENANT_A, booking_id: b['id'], kind: undefined } as any, {})).resolves.toBeUndefined();
    await expect(w.runTask(await load(), {} as any)).resolves.toBeUndefined();
    expect(w.notif.calls).toEqual([]); expect(w.writes()).toEqual([]);
  });
});

describe('replay / retry: same delivery, never a second SMS (idempotencyKey bmsg:<id>:<kind>)', () => {
  it('crash after the provider call (tx rolled back): the retry reuses the key, gets the SAME delivery, creates the notification once', async () => {
    const { w, run } = await setup(); w.account(ACCOUNT_1); w.link(ACCOUNT_1); const b = w.booking({ slot_start: SLOT }); w.notif.crashAfterRecordOnce = true;
    await expect(run(b['id'])).rejects.toThrow(); expect(w.notificationsOf(ACCOUNT_1)).toEqual([]);
    await run(b['id']);
    expect(w.notif.calls.map((c) => c.input['idempotencyKey'])).toEqual([`bmsg:${b['id']}:confirmation`, `bmsg:${b['id']}:confirmation`]); expect(new Set(w.notif.byKey.values()).size).toBe(1);
    expect(w.notificationsOf(ACCOUNT_1)).toHaveLength(1);
  });
  it('duplicate job after success: still one delivery, one notification', async () => {
    const { w, run } = await setup(); w.account(ACCOUNT_1); w.link(ACCOUNT_1); const b = w.booking({ slot_start: SLOT }); await run(b['id']); await run(b['id']);
    expect(new Set(w.notif.byKey.values()).size).toBe(1); expect(w.notificationsOf(ACCOUNT_1)).toHaveLength(1);
  });
  it('port failure / unknown template: the task THROWS (queue retry or dead letter), no notification half-written; the next retry succeeds', async () => {
    const { w, run } = await setup(); w.account(ACCOUNT_1); w.link(ACCOUNT_1); const b = w.booking({ slot_start: SLOT });
    w.notif.failNext = new Error('provider down'); await expect(run(b['id'])).rejects.toThrow();
    w.notif.failNext = Object.assign(new Error('x'), { code: 'reporting.notification_template_unknown' }); await expect(run(b['id'])).rejects.toThrow();
    expect(w.t['notifications']).toEqual([]); await run(b['id']); expect(w.notificationsOf(ACCOUNT_1)).toHaveLength(1);
  });
});

describe('REQ-SEC-024 / 07-SECURITY §7.2: tenant-bound statements, no booking number or contact data in logs', () => {
  it('every statement on engagement.* binds tenant_id; no id is interpolated into SQL text', async () => {
    const { w, run } = await setup(); w.account(ACCOUNT_1); w.link(ACCOUNT_1); const b = w.booking({ slot_start: SLOT }); await run(b['id']);
    for (const s of w.stmts.filter((x) => /engagement\./i.test(x.text))) { expect(s.text).toMatch(/tenant_id/i); expect(s.text).not.toContain(String(b['id'])); }
  });
  it('log output of success, no-op and failure paths never contains the booking number, phone-like or token-like data', async () => {
    const { w, run } = await setup(); const lines: string[] = []; const sink = (...a: unknown[]) => { lines.push(JSON.stringify(a)); };
    const log = { info: sink, warn: sink, error: sink, debug: sink }; const b = w.booking({ slot_start: SLOT });
    await run(b['id'], 'confirmation', { log }); await run(ID(0xdead), 'confirmation', { log }); await run(b['id'], 'refund', { log });
    w.notif.failNext = new Error('provider down +9779812345678 BK2600001'); await run(b['id'], 'confirmation', { log }).catch(() => {});
    expect(lines.join('\n')).not.toMatch(/BK26\d{6}|\+977\d{6,}/);
  });
});

// --------------------------------------------------------------------------------------------------------------------------------------------------------------
// US-EN-25.1 / 25.2 end to end with the real dispatcher + send_reminder (T-R1) and the new scheduling / cancel functions of the API reminder service.
describe('US-EN-25.1/25.2: booking reminder is sent once, in the window 24 h .. 23 h before slot_start; cancelled -> never', () => {
  const dispatch = async () => (await import('../tasks/dispatch_due_reminders.js')).createDispatchDueReminders() as (p: any, c: any) => Promise<void>;
  const sendReminder = async () => (await import('../tasks/send_reminder.js')).createSendReminder() as (p: any, c: any) => Promise<void>;
  async function world(slotAheadMs: number) {
    const w = makeWorld(); w.account(ACCOUNT_1); w.link(ACCOUNT_1);
    const slot = new Date(Date.parse(w.now()) + slotAheadMs).toISOString(); const b = w.booking({ slot_start: slot });
    const svc = createReminderService(); const ctx = w.staffCtx({ ports: w.ports });
    return { w, b, slot, svc, ctx, cron: async () => w.runTask(await dispatch(), { tenant_id: TENANT_A }), send: async (id: string) => w.runTask(await sendReminder(), { tenant_id: TENANT_A, reminder_id: id }) };
  }
  it('slot in 3 days: nothing before due_at (slot - 24 h); at due_at the dispatcher enqueues rem:<id>; the task sends ONE booking_reminder with {lab_name, datetime, booking_no}', async () => {
    const { w, b, slot, svc, ctx, cron, send } = await world(72 * HOUR);
    await svc.scheduleBookingReminder(ctx, { bookingId: b['id'], patientId: PATIENT, slotStart: slot });
    const rem = w.t['reminders']!.find((r) => r['kind'] === 'booking')!; expect(rem).toBeTruthy(); expect(rem['due_at']).toBe(new Date(Date.parse(slot) - 24 * HOUR).toISOString());
    w.advance(48 * HOUR - 1); await cron(); expect(w.jobs('engagement.send_reminder')).toEqual([]);
    w.advance(1); await cron(); expect(w.jobs('engagement.send_reminder')).toHaveLength(1); expect(w.jobs('engagement.send_reminder')[0]).toMatchObject({ jobKey: `rem:${rem['id']}` });
    await send(rem['id']); await send(rem['id']);                                                                   // duplicate delivery of the job: still one SMS call that counts
    const sentAt = Date.parse(w.get(rem['id'])['sent_at']); expect(sentAt).toBeGreaterThanOrEqual(Date.parse(slot) - 24 * HOUR); expect(sentAt).toBeLessThanOrEqual(Date.parse(slot) - 23 * HOUR);
    expect(w.notif.calls).toHaveLength(1); expect(w.notif.calls[0]!.input).toMatchObject({ templateCode: 'engagement.booking_reminder', purpose: 'booking_reminder', related: { entityType: 'booking', entityId: b['id'] } });
    expect(Object.keys(paramsOf(w)).sort()).toEqual(['booking_no', 'datetime', 'lab_name']); expect(w.get(rem['id'])['status']).toBe('sent');
  });
  it('booking created less than 24 h ahead: no reminder row, nothing for the dispatcher, no SMS', async () => {
    const { w, b, slot, svc, ctx, cron } = await world(23 * HOUR);
    await svc.scheduleBookingReminder(ctx, { bookingId: b['id'], patientId: PATIENT, slotStart: slot });
    expect(w.t['reminders']).toEqual([]); w.advance(30 * HOUR); await cron(); expect(w.jobs('engagement.send_reminder')).toEqual([]); expect(w.notif.calls).toEqual([]);
  });
  it('25.2 cancelled before the send: the reminder is cancelled, the dispatcher skips it and a send job that was already queued sends nothing', async () => {
    const { w, b, slot, svc, ctx, cron, send } = await world(72 * HOUR);
    await svc.scheduleBookingReminder(ctx, { bookingId: b['id'], patientId: PATIENT, slotStart: slot });
    const rem = w.t['reminders']!.find((r) => r['kind'] === 'booking')!; w.advance(48 * HOUR); await cron(); expect(w.jobs('engagement.send_reminder')).toHaveLength(1);   // already queued
    await svc.cancelBookingReminders(ctx, { bookingId: b['id'] }); b['status'] = 'cancelled';
    await send(rem['id']); await cron();
    expect(w.notif.calls).toEqual([]); expect(w.get(rem['id'])['status']).toBe('cancelled'); expect(w.jobs('engagement.send_reminder')).toHaveLength(1);
  });
});
