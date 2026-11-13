// C16.T-B5 — booking reminders: scheduling at booking create and cancelling at booking cancel, in services/api reminder.service.ts.
// (06-PLAN row T-B5; 02-TRD §4.8 create step 7 + cancel "cancel pending booking reminders", §4.11 row `booking`; 05-SCHEMA reminders; PRD US-EN-25.1-2; REQ-SEC-024 tenant binding, REQ-SEC-080 no echo.)
// done_when: templates per CR-C16-009. tests: booking < 24 h ahead -> no reminder.
// Fails now: createReminderService() has no scheduleBookingReminder / cancelBookingReminders.
//
// SEAMS (spec fixes behaviour, not names): createReminderService() gains two methods, ctx = ReminderCtx {tenantId, actor, tx, now()} (same as list/create/cancel; tenant and actor from ctx only):
//   scheduleBookingReminder(ctx, {bookingId, patientId, slotStart:ISO}) -> the inserted row, or undefined when none is scheduled. Reads engagement.settings.booking_reminder_hours_before (H) in the same tx.
//     Rule (TRD §4.11): schedule only when slot_start - now > H hours (strictly); row {kind 'booking', source 'booking', source_ref_id = bookingId, reason_code NULL, status 'scheduled', due_at = slot_start - H h}.
//     Idempotent on (tenant, kind, source_ref_id, source_ref_seq): a second call for the same booking adds nothing and does not throw. It never sends (the */5 dispatcher + send_reminder do).
//   cancelBookingReminders(ctx, {bookingId}) -> number cancelled: scheduled kind 'booking' reminders of that booking -> cancelled (version + 1); sent / suppressed / failed rows, other bookings, custom / follow_up rows of the patient and other tenants stay.
//   Both throw common.validation_failed (fixed paths /bookingId-style pointers, no echo) for a non-uuid id / non-ISO slot BEFORE any write, auth.unauthenticated without ctx.tx.
// DB = the reminders world (tests/world fake, engagement.reminders INSERT/UPDATE emulation incl. the 05-SCHEMA checks and the partial unique index).
import { describe, expect, it } from 'vitest';
import { ID, PATIENT, TENANT_A, TENANT_B, makeWorld, type World } from '../../__tests__/reminders.world.js';
import { createReminderService } from '../reminder.service.js';

const HOUR = 3_600_000;
const BK1 = ID(0x701), BK2 = ID(0x702);
const at = (w: World, ms: number) => new Date(Date.parse(w.now()) + ms).toISOString();
const sched = (w: World, bookingId: string, slotAheadMs: number, patientId = PATIENT, ctx: any = w.staffCtx()) =>
  createReminderService().scheduleBookingReminder(ctx, { bookingId, patientId, slotStart: at(w, slotAheadMs) });
const bookingRows = (w: World) => w.t['reminders']!.filter((r) => r['kind'] === 'booking');
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'RESOLVED'; };

describe('US-EN-25.1: schedule at booking create (TRD §4.11 row `booking`)', () => {
  it('slot 3 days ahead, H = 24: one scheduled row due at slot_start - 24 h, kind/source booking, source_ref_id = booking, no reason_code, version 1, created by the actor', async () => {
    const w = makeWorld(); const slot = at(w, 72 * HOUR); const r = await createReminderService().scheduleBookingReminder(w.staffCtx(), { bookingId: BK1, patientId: PATIENT, slotStart: slot });
    expect(r).toBeTruthy(); const rows = bookingRows(w); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: TENANT_A, patient_id: PATIENT, kind: 'booking', source: 'booking', source_ref_id: BK1, source_ref_seq: 0, reason_code: null, status: 'scheduled', version: 1, sent_at: null, delivery_id: null, failure_code: null });
    expect(Date.parse(rows[0]!['due_at'])).toBe(Date.parse(slot) - 24 * HOUR);
    expect(rows[0]!['created_by']).toBe(w.staffCtx().actor.id);
  });
  it('H comes from settings.booking_reminder_hours_before (12 and 72 honoured)', async () => {
    for (const h of [12, 72]) {
      const w = makeWorld(); w.setSetting('booking_reminder_hours_before', h); const slot = at(w, 100 * HOUR);
      await createReminderService().scheduleBookingReminder(w.staffCtx(), { bookingId: BK1, patientId: PATIENT, slotStart: slot });
      expect(Date.parse(bookingRows(w)[0]!['due_at'])).toBe(Date.parse(slot) - h * HOUR);
    }
  });
  it('booking created less than H ahead: NO reminder, no write at all (slot in 23 h, 1 min, 1 ms; 23 h 59 m 59.999 s)', async () => {
    for (const ahead of [23 * HOUR, 60_000, 1, 24 * HOUR - 1]) {
      const w = makeWorld(); const r = await sched(w, BK1, ahead);
      expect(r, `ahead ${ahead}`).toBeUndefined(); expect(w.t['reminders']).toEqual([]); expect(w.writes()).toEqual([]);
    }
  });
  it('boundary: exactly H ahead -> none (strictly greater, TRD "slot_start - now > H"); one millisecond more -> a row due 1 ms from now', async () => {
    const w = makeWorld(); expect(await sched(w, BK1, 24 * HOUR)).toBeUndefined(); expect(w.t['reminders']).toEqual([]);
    await sched(w, BK2, 24 * HOUR + 1); expect(bookingRows(w)).toHaveLength(1); expect(Date.parse(bookingRows(w)[0]!['due_at'])).toBe(Date.parse(w.now()) + 1);
  });
  it('H follows the setting for the cut-off too: H = 72 and a slot 48 h ahead -> none; H = 1 and a slot 90 min ahead -> a row', async () => {
    const w = makeWorld(); w.setSetting('booking_reminder_hours_before', 72); expect(await sched(w, BK1, 48 * HOUR)).toBeUndefined();
    w.setSetting('booking_reminder_hours_before', 1); await sched(w, BK2, 90 * 60_000); expect(bookingRows(w)).toHaveLength(1);
  });
  it('uses ctx.now(), not the real clock: the same slot is "ahead enough" or not depending on the fake clock', async () => {
    const w = makeWorld(); const slot = at(w, 30 * HOUR); await createReminderService().scheduleBookingReminder(w.staffCtx(), { bookingId: BK1, patientId: PATIENT, slotStart: slot });
    expect(bookingRows(w)).toHaveLength(1); w.advance(10 * HOUR);                                               // now only 20 h before the slot
    await createReminderService().scheduleBookingReminder(w.staffCtx(), { bookingId: BK2, patientId: PATIENT, slotStart: slot }); expect(bookingRows(w)).toHaveLength(1);
  });
  it('idempotent: scheduling the same booking twice leaves one row and does not throw (partial unique index); two bookings of one patient get two rows', async () => {
    const w = makeWorld(); await sched(w, BK1, 72 * HOUR); await expect(sched(w, BK1, 72 * HOUR)).resolves.not.toThrow(); expect(bookingRows(w)).toHaveLength(1);
    await sched(w, BK2, 96 * HOUR); expect(bookingRows(w)).toHaveLength(2);
  });
  it('never sends: no NotificationPort call and no job is enqueued by scheduling (the dispatcher does that at due_at)', async () => {
    const w = makeWorld(); await sched(w, BK1, 72 * HOUR); expect(w.notif.calls).toEqual([]); expect(w.jobs()).toEqual([]);
  });
  it('tenant comes from ctx only: the row is written for the session tenant and no statement takes a tenant from the input', async () => {
    const w = makeWorld(); await createReminderService().scheduleBookingReminder(w.staffCtx(), { bookingId: BK1, patientId: PATIENT, slotStart: at(w, 72 * HOUR), tenantId: TENANT_B } as any);
    expect(bookingRows(w).map((r) => r['tenant_id'])).toEqual([TENANT_A]);
    for (const s of w.writes()) { expect(s.text).toMatch(/tenant_id/i); expect(s.values).not.toContain(TENANT_B); expect(s.text).not.toContain(BK1); }
  });
  it('hostile input is refused before any write with a fixed, non-echoing error: non-uuid ids, non-ISO / non-UTC slot', async () => {
    const w = makeWorld(); const svc = createReminderService(); const good = at(w, 72 * HOUR);
    const bad: Array<Record<string, unknown>> = [{ bookingId: "x'; DROP TABLE engagement.reminders;--", patientId: PATIENT, slotStart: good }, { bookingId: BK1, patientId: 'nope', slotStart: good },
      { bookingId: BK1, patientId: PATIENT, slotStart: 'tomorrow' }, { bookingId: BK1, patientId: PATIENT, slotStart: '2026-03-04T04:00:00+05:45' }, { bookingId: undefined, patientId: PATIENT, slotStart: good }, { bookingId: BK1, patientId: PATIENT }];
    for (const input of bad) {
      let err: any; try { await svc.scheduleBookingReminder(w.staffCtx(), input as any); } catch (e) { err = e; }
      expect(err?.code, JSON.stringify(input)).toBe('common.validation_failed'); expect(JSON.stringify([err.errors, err.detail, err.message])).not.toMatch(/DROP TABLE|nope|tomorrow/);
    }
    expect(w.writes()).toEqual([]);
  });
  it('no tx on ctx -> auth.unauthenticated, nothing written', async () => {
    const w = makeWorld(); const c = w.staffCtx(); delete c.tx;
    expect(await code(createReminderService().scheduleBookingReminder(c, { bookingId: BK1, patientId: PATIENT, slotStart: at(w, 72 * HOUR) }))).toBe('auth.unauthenticated'); expect(w.t['reminders']).toEqual([]);
  });
  it('the persisted row satisfies the 05-SCHEMA checks and the Reminder schema surface used by the staff list (kind booking has no reason_code)', async () => {
    const w = makeWorld(); await sched(w, BK1, 72 * HOUR);
    const row = bookingRows(w)[0]!; expect(row['reason_code']).toBeNull(); expect(['scheduled']).toContain(row['status']);
  });
});

describe('US-EN-25.2: cancel pending booking reminders at booking cancel (TRD §4.8 cancel)', () => {
  it('scheduled reminder of that booking -> cancelled, version + 1; returns the number cancelled', async () => {
    const w = makeWorld(); await sched(w, BK1, 72 * HOUR); const n = await createReminderService().cancelBookingReminders(w.staffCtx(), { bookingId: BK1 });
    expect(n).toBe(1); expect(bookingRows(w)[0]).toMatchObject({ status: 'cancelled', version: 2, sent_at: null });
  });
  it('after the cancel the dispatcher finds nothing due (status no longer scheduled)', async () => {
    const w = makeWorld(); await sched(w, BK1, 72 * HOUR); await createReminderService().cancelBookingReminders(w.staffCtx(), { bookingId: BK1 });
    expect(bookingRows(w).filter((r) => r['status'] === 'scheduled')).toEqual([]);
  });
  it('only that booking: another booking\'s reminder, a custom reminder and a follow_up of the same patient stay scheduled', async () => {
    const w = makeWorld(); await sched(w, BK1, 72 * HOUR); await sched(w, BK2, 96 * HOUR);
    const custom = w.reminder(); const follow = w.reminder({ kind: 'follow_up', source: 'smart_report', source_ref_id: BK1 });                  // same uuid as the booking on purpose: kind must be part of the match
    expect(await createReminderService().cancelBookingReminders(w.staffCtx(), { bookingId: BK1 })).toBe(1);
    expect(bookingRows(w).map((r) => [r['source_ref_id'], r['status']])).toEqual([[BK1, 'cancelled'], [BK2, 'scheduled']]);
    expect(w.get(custom['id'])['status']).toBe('scheduled'); expect(w.get(follow['id'])['status']).toBe('scheduled');
  });
  it('terminal rows are never rewritten: sent / suppressed / failed booking reminders stay as they are', async () => {
    const w = makeWorld(); const sent = w.reminder({ kind: 'booking', source: 'booking', source_ref_id: BK1, source_ref_seq: 0, reason_code: null, status: 'sent', sent_at: w.now() });
    const sup = w.reminder({ kind: 'booking', source: 'booking', source_ref_id: BK1, source_ref_seq: 1, reason_code: null, status: 'suppressed', failure_code: 'opted_out' });
    const fail = w.reminder({ kind: 'booking', source: 'booking', source_ref_id: BK1, source_ref_seq: 2, reason_code: null, status: 'failed', failure_code: 'common.internal' });
    const before = JSON.stringify([sent, sup, fail]); expect(await createReminderService().cancelBookingReminders(w.staffCtx(), { bookingId: BK1 })).toBe(0);
    expect(JSON.stringify([w.get(sent['id']), w.get(sup['id']), w.get(fail['id'])])).toBe(before);
  });
  it('no reminder for the booking (booking was < 24 h ahead) -> 0, no error; second cancel is a no-op', async () => {
    const w = makeWorld(); const svc = createReminderService(); expect(await svc.cancelBookingReminders(w.staffCtx(), { bookingId: BK1 })).toBe(0);
    await sched(w, BK2, 72 * HOUR); expect(await svc.cancelBookingReminders(w.staffCtx(), { bookingId: BK2 })).toBe(1); expect(await svc.cancelBookingReminders(w.staffCtx(), { bookingId: BK2 })).toBe(0);
    expect(bookingRows(w)[0]!['version']).toBe(2);
  });
  it('tenant isolation: a reminder of another tenant for the same booking id is untouched', async () => {
    const w = makeWorld(); const other = w.reminder({ tenant_id: TENANT_B, kind: 'booking', source: 'booking', source_ref_id: BK1, reason_code: null });
    expect(await createReminderService().cancelBookingReminders(w.staffCtx(), { bookingId: BK1 })).toBe(0); expect(w.get(other['id'])['status']).toBe('scheduled');
    for (const s of w.writes()) expect(s.text).toMatch(/tenant_id/i);
  });
  it('reschedule = cancel old + create new: the old booking\'s reminder is cancelled, the new booking gets its own', async () => {
    const w = makeWorld(); await sched(w, BK1, 72 * HOUR); await createReminderService().cancelBookingReminders(w.staffCtx(), { bookingId: BK1 }); await sched(w, BK2, 120 * HOUR);
    expect(bookingRows(w).map((r) => [r['source_ref_id'], r['status']])).toEqual([[BK1, 'cancelled'], [BK2, 'scheduled']]);
  });
  it('hostile / missing id -> common.validation_failed, no write; no tx -> auth.unauthenticated', async () => {
    const w = makeWorld(); const svc = createReminderService();
    for (const bookingId of ["1' OR '1'='1", 42, undefined, '']) expect(await code(svc.cancelBookingReminders(w.staffCtx(), { bookingId } as any))).toBe('common.validation_failed');
    const c = w.staffCtx(); delete c.tx; expect(await code(svc.cancelBookingReminders(c, { bookingId: BK1 }))).toBe('auth.unauthenticated'); expect(w.writes()).toEqual([]);
  });
});
