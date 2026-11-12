// C16.T-R1 — worker side of reminders: cron `engagement.dispatch_due_reminders`, task `engagement.send_reminder`, opt-out, in-app notification hook.
// (06-PLAN row T-R1; 02-TRD §4.11, §8.1, §8.2, §9 sendSms row; PRD US-EN-23.1-4; 07-SECURITY REQ-SEC-007/-070 + reminders row of the abuse table; CR-C16-009.)
// done_when: suppression statuses recorded. tests: worker integration with fake clock; NotificationPort spy: params exactly {lab_name, datetime}; cancelled -> no call; replay -> same delivery.
// Fails now: tasks/send_reminder.ts and tasks/dispatch_due_reminders.ts do not exist (manifest entries are T-01 fail-closed stubs, no cron row).
//
// SEAMS (spec fixes behaviour, not file/function names; same convention as jobs/reporting tasks):
//   jobs/engagement/tasks/send_reminder.ts exports createSendReminder() -> TaskHandler;  tasks/dispatch_due_reminders.ts exports createDispatchDueReminders() -> TaskHandler.
//   ctx = worker JobContext + ports {NotificationPort, IdentityPort} (system actor, tx, now()). Payload of send_reminder {tenant_id, reminder_id}; of the cron {tenant_id}.
//   DB through ctx.tx.query: engagement.reminders / settings / accounts + account_patient_links / notifications / bookings (fake: answers by statement type, see reminders.world.ts).
//   Dispatcher: `SELECT ... FROM engagement.reminders WHERE status='scheduled' AND due_at <= <cutoff> ... LIMIT 500 FOR UPDATE SKIP LOCKED` (cutoff = a bound ISO/Date value or now()),
//   then `SELECT app.enqueue_job('engagement.send_reminder', payload, 'rem:<id>', ...)` per row (identifier $1, payload $2, job_key $3). It never calls NotificationPort.
//   Task: re-reads the row (tenant-scoped); only status 'scheduled' is processed (anything else = silent no-op, never an error); lab_name = IdentityPort.getTenantSettings(...).branding.displayName;
//   sendSms({recipient:{kind:'patient',patientId}, templateCode, purpose, params, idempotencyKey:'rem:<id>', related? (booking only)}); queued -> status sent + sent_at + delivery_id;
//   suppressed_* -> status suppressed, failure_code = the port status; opted_out / reminders_enabled=false -> suppressed without a port call; transient port error -> task THROWS, row stays scheduled.
//   In-app: one engagement.notifications row per ACTIVE linked account (kind 'follow_up_reminder' | 'booking_reminder'), also when the SMS is suppressed/opted out (AC-23.3); none when no link exists.
//   ASSUMED (spec silent): reminders_enabled=false (the default!) -> status 'suppressed' with some failure_code, no SMS; a missing settings row = disabled.
//   NOTE for the writer: packages/fakes NotificationPort fake has no `engagement.follow_up_reminder` / `engagement.booking_reminder` template yet (CR-C16-009 seeds): add them to the fake's defaults when wiring.
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';
import { ID, LAB_NAME, PATIENT, ACCOUNT_1, ACCOUNT_2, TENANT_A, TENANT_B, makeWorld, type World } from '../../../../../api/src/modules/engagement/__tests__/reminders.world.js';

const send = async () => (await import('../tasks/send_reminder.js')).createSendReminder() as (p: any, c: any) => Promise<void>;
const dispatch = async () => (await import('../tasks/dispatch_due_reminders.js')).createDispatchDueReminders() as (p: any, c: any) => Promise<void>;
const HOUR = 3_600_000;

async function setup(opts: { remindersEnabled?: boolean } = {}) {
  const w = makeWorld(opts); const sendTask = await send(); const dispatchTask = await dispatch();
  const run = (id: string, over: Record<string, any> = {}) => w.runTask(sendTask, { tenant_id: TENANT_A, reminder_id: id }, over);
  const cron = (over: Record<string, any> = {}) => w.runTask(dispatchTask, { tenant_id: TENANT_A }, over);
  return { w, run, cron };
}
const paramsOf = (w: World, i = 0) => w.notif.calls[i]!.input['params'] as Record<string, string>;

describe('manifest: cron row + implemented tasks (TRD §8.1, §8.2)', () => {
  it('engagement.dispatch_due_reminders is a registered task with a per_tenant */5 cron row; manifest still validates', () => {
    expect(() => validateManifests([manifest])).not.toThrow();
    expect(typeof manifest.tasks?.['engagement.dispatch_due_reminders']).toBe('function');
    const row = manifest.crontab?.find((c) => c.identifier === 'engagement.dispatch_due_reminders');
    expect(row).toMatchObject({ schedule: '*/5 * * * *', tenantScope: 'per_tenant' });
  });
  it('send_reminder keeps maxAttempts 8 and is no longer the fail-closed stub', async () => {
    expect(manifest.maxAttempts?.['engagement.send_reminder']).toBe(8);
    const { w } = await setup(); const r = w.reminder({ status: 'cancelled' });
    await expect(manifest.tasks!['engagement.send_reminder']!({ tenant_id: TENANT_A, reminder_id: r['id'] } as any, w.jobCtx())).resolves.toBeUndefined();   // cancelled -> quiet no-op, not "not implemented"
  });
});

describe('dispatcher engagement.dispatch_due_reminders (TRD §4.11)', () => {
  it('fake clock: a reminder is enqueued only once due_at has arrived; job_key rem:<id>; the dispatcher itself never sends', async () => {
    const { w, cron } = await setup(); const r = w.reminder({ due_at: new Date(Date.parse(w.now()) + HOUR).toISOString() });
    await cron(); expect(w.jobs('engagement.send_reminder')).toEqual([]);
    w.advance(HOUR - 1); await cron(); expect(w.jobs('engagement.send_reminder')).toEqual([]);
    w.advance(1); await cron();
    const jobs = w.jobs('engagement.send_reminder'); expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ jobKey: `rem:${r['id']}`, payload: { reminder_id: r['id'], tenant_id: TENANT_A } });
    expect(w.notif.calls).toEqual([]); expect(w.get(r['id'])['status']).toBe('scheduled');         // sending is the task's job
  });
  it('picks scheduled+due only: sent, suppressed, failed, cancelled, future and other-tenant rows are skipped; a second tick does not double-enqueue (same job_key)', async () => {
    const { w, cron } = await setup(); const due = w.reminder();
    for (const status of ['sent', 'suppressed', 'failed', 'cancelled']) w.reminder({ status, ...(status === 'sent' ? { sent_at: w.now() } : {}) });
    w.reminder({ due_at: new Date(Date.parse(w.now()) + 5 * 60_000).toISOString() }); w.reminder({ tenant_id: TENANT_B, patient_id: ID(0x5b1) });
    await cron(); await cron();
    expect(w.jobs('engagement.send_reminder').map((j) => j['jobKey'])).toEqual([`rem:${due['id']}`]);
  });
  it('batch 500 with FOR UPDATE SKIP LOCKED (two dispatchers never take the same row); oldest due first', async () => {
    const { w, cron } = await setup(); const a = w.reminder({ due_at: new Date(Date.parse(w.now()) - 2 * HOUR).toISOString() }); const b = w.reminder({ due_at: new Date(Date.parse(w.now()) - HOUR).toISOString() });
    await cron();
    const sel = w.stmts.find((s) => /engagement\.reminders/i.test(s.text) && /^\s*select/i.test(s.text) && /for update skip locked/i.test(s.text));
    expect(sel, 'dispatcher SELECT ... FOR UPDATE SKIP LOCKED').toBeTruthy(); expect(`${sel!.text} ${JSON.stringify(sel!.values)}`).toMatch(/\b500\b/);
    expect(w.jobs('engagement.send_reminder').map((j) => j['jobKey'])).toEqual([`rem:${a['id']}`, `rem:${b['id']}`]);
  });
});

describe('US-EN-23.1: due reminder -> NotificationPort.sendSms as system, params exactly {lab_name, datetime}', () => {
  it('custom reminder: template engagement.follow_up_reminder, purpose follow_up_reminder, idempotencyKey rem:<id>, no related; status sent + sent_at + delivery_id', async () => {
    const { w, run } = await setup(); const r = w.reminder({ reason_code: 'follow_up_test', due_at: '2026-03-03T04:00:00.000Z' });
    await run(r['id']);
    expect(w.notif.calls).toHaveLength(1); const c = w.notif.calls[0]!;
    expect(c.method).toBe('sendSms'); expect(c.actor).toBe('system');
    expect(c.input).toMatchObject({ recipient: { kind: 'patient', patientId: PATIENT }, templateCode: 'engagement.follow_up_reminder', purpose: 'follow_up_reminder', idempotencyKey: `rem:${r['id']}` });
    expect(c.input['related']).toBeUndefined();
    expect(Object.keys(paramsOf(w)).sort()).toEqual(['datetime', 'lab_name']);                       // exactly: REQ-SEC-070, 04 R6
    expect(paramsOf(w)['lab_name']).toBe(LAB_NAME); expect(typeof paramsOf(w)['datetime']).toBe('string'); expect(paramsOf(w)['datetime']!.length).toBeGreaterThan(0);
    const row = w.get(r['id']);
    expect(row).toMatchObject({ status: 'sent', failure_code: null, version: 2 }); expect(row['sent_at']).toBe(w.now()); expect(row['delivery_id']).toBe(w.notif.byKey.get(`rem:${r['id']}`));
  });
  it('no PHI/test code/reason in the SMS: reason_code, source_ref_id and patient name never appear in any param value', async () => {
    const { w, run } = await setup(); const r = w.reminder({ kind: 'follow_up', source: 'smart_report', source_ref_id: ID(0x5ee), reason_code: 'follow_up_test' });
    await run(r['id']);
    expect(Object.keys(paramsOf(w)).sort()).toEqual(['datetime', 'lab_name']);
    expect(JSON.stringify(paramsOf(w))).not.toMatch(/follow_up_test|suggested|HbA1c|Test Patient|0x5ee|0000-7000-8000-000000005ee/i);
  });
  it('booking reminder: engagement.booking_reminder, purpose booking_reminder, params {lab_name, datetime, booking_no}, related {booking, <id>}', async () => {
    const { w, run } = await setup(); const b = w.booking();
    const r = w.reminder({ kind: 'booking', source: 'booking', source_ref_id: b['id'], reason_code: null }); await run(r['id']);
    const c = w.notif.calls[0]!;
    expect(c.input).toMatchObject({ templateCode: 'engagement.booking_reminder', purpose: 'booking_reminder', idempotencyKey: `rem:${r['id']}`, related: { entityType: 'booking', entityId: b['id'] } });
    expect(Object.keys(paramsOf(w)).sort()).toEqual(['booking_no', 'datetime', 'lab_name']); expect(paramsOf(w)['booking_no']).toBe('BK2600001');
    expect(w.get(r['id'])['status']).toBe('sent');
  });
});

describe('suppression statuses recorded (done_when; TRD §9 sendSms row)', () => {
  for (const s of ['suppressed_no_consent', 'suppressed_no_contact', 'suppressed_channel_disabled'] as const) {
    it(`port status ${s} -> reminder suppressed, failure_code ${s}, no sent_at`, async () => {
      const { w, run } = await setup(); w.notif.status = s; const r = w.reminder(); await run(r['id']);
      expect(w.notif.calls).toHaveLength(1);
      expect(w.get(r['id'])).toMatchObject({ status: 'suppressed', failure_code: s, sent_at: null });
    });
  }
  it('feature switch reminders_enabled=false (default) -> suppressed, nothing sent; missing settings row behaves the same', async () => {
    const { w, run } = await setup({ remindersEnabled: false }); const r = w.reminder(); await run(r['id']);
    expect(w.notif.calls).toEqual([]); expect(w.get(r['id'])['status']).toBe('suppressed'); expect(String(w.get(r['id'])['failure_code'])).toMatch(/^[a-z_]{1,64}$/);
    const w2 = makeWorld(); w2.t['settings']!.length = 0; const r2 = w2.reminder(); await w2.runTask(await send(), { tenant_id: TENANT_A, reminder_id: r2['id'] });
    expect(w2.notif.calls).toEqual([]); expect(w2.get(r2['id'])['status']).toBe('suppressed');
  });
});

describe('US-EN-23.2/23.3: in-app notification hook + opt-out', () => {
  it('23.2: active link -> SMS sent AND an in-app notification follow_up_reminder for that account (once)', async () => {
    const { w, run } = await setup(); w.account(ACCOUNT_1); w.link(ACCOUNT_1); const r = w.reminder(); await run(r['id']);
    expect(w.notif.calls).toHaveLength(1); expect(w.get(r['id'])['status']).toBe('sent');
    const n = w.notificationsOf(ACCOUNT_1); expect(n).toHaveLength(1); expect(n[0]).toMatchObject({ kind: 'follow_up_reminder', account_id: ACCOUNT_1 });
    expect(JSON.stringify(n[0])).not.toMatch(/follow_up_test/);
  });
  it('booking reminder -> in-app kind booking_reminder', async () => {
    const { w, run } = await setup(); w.account(ACCOUNT_1); w.link(ACCOUNT_1); const b = w.booking(); const r = w.reminder({ kind: 'booking', source: 'booking', source_ref_id: b['id'], reason_code: null }); await run(r['id']);
    expect(w.notificationsOf(ACCOUNT_1).map((n) => n['kind'])).toEqual(['booking_reminder']);
  });
  it('one notification per ACTIVE linked account (two accounts -> two; revoked link -> none)', async () => {
    const { w, run } = await setup(); w.account(ACCOUNT_1); w.account(ACCOUNT_2); w.link(ACCOUNT_1); w.link(ACCOUNT_2, PATIENT, { status: 'revoked' }); const r = w.reminder(); await run(r['id']);
    expect(w.notificationsOf(ACCOUNT_1)).toHaveLength(1); expect(w.notificationsOf(ACCOUNT_2)).toHaveLength(0);
  });
  it('no accounts/links yet -> hook is a no-op: SMS still goes out, no notification rows, no error', async () => {
    const { w, run } = await setup(); const r = w.reminder(); await run(r['id']);
    expect(w.get(r['id'])['status']).toBe('sent'); expect(w.t['notifications']).toEqual([]);
  });
  it('23.3: reminders_opt_out=true -> NO SMS, status suppressed, failure_code opted_out, in-app notification still created', async () => {
    const { w, run } = await setup(); w.account(ACCOUNT_1, { reminders_opt_out: true }); w.link(ACCOUNT_1); const r = w.reminder(); await run(r['id']);
    expect(w.notif.calls).toEqual([]); expect(w.get(r['id'])).toMatchObject({ status: 'suppressed', failure_code: 'opted_out', sent_at: null });
    expect(w.notificationsOf(ACCOUNT_1).map((n) => n['kind'])).toEqual(['follow_up_reminder']);
  });
  it('opt-out of ANY linked account suppresses the SMS (TRD §4.11); the other account still gets its in-app notification', async () => {
    const { w, run } = await setup(); w.account(ACCOUNT_1); w.account(ACCOUNT_2, { reminders_opt_out: true }); w.link(ACCOUNT_1); w.link(ACCOUNT_2); const r = w.reminder(); await run(r['id']);
    expect(w.notif.calls).toEqual([]); expect(w.get(r['id'])).toMatchObject({ status: 'suppressed', failure_code: 'opted_out' });
    expect(w.notificationsOf(ACCOUNT_1)).toHaveLength(1); expect(w.notificationsOf(ACCOUNT_2)).toHaveLength(1);
  });
  it('an opted-out account of ANOTHER patient does not suppress this patient', async () => {
    const { w, run } = await setup(); w.account(ACCOUNT_2, { reminders_opt_out: true }); w.link(ACCOUNT_2, ID(0x5c1)); const r = w.reminder(); await run(r['id']);
    expect(w.notif.calls).toHaveLength(1); expect(w.get(r['id'])['status']).toBe('sent');
  });
});

describe('US-EN-23.4: cancelled -> nothing sent', () => {
  it('cancelled before due: dispatcher skips it; a send_reminder job already queued for it does nothing (no port call, no notification, no write, row unchanged)', async () => {
    const { w, run, cron } = await setup(); w.account(ACCOUNT_1); w.link(ACCOUNT_1); const r = w.reminder({ status: 'cancelled' }); await cron();
    expect(w.jobs('engagement.send_reminder')).toEqual([]);
    const before = JSON.stringify(w.get(r['id'])); const writesBefore = w.writes().length; await run(r['id']);
    expect(w.notif.calls).toEqual([]); expect(w.t['notifications']).toEqual([]); expect(w.writes().length).toBe(writesBefore); expect(JSON.stringify(w.get(r['id']))).toBe(before);
  });
  it('cancelled between dispatch and send (race): the task re-reads the row and sends nothing', async () => {
    const { w, run, cron } = await setup(); const r = w.reminder(); await cron(); expect(w.jobs('engagement.send_reminder')).toHaveLength(1);
    w.get(r['id'])['status'] = 'cancelled'; await run(r['id']); expect(w.notif.calls).toEqual([]); expect(w.get(r['id'])['status']).toBe('cancelled');
  });
});

describe('replay / retry: same delivery, never a second SMS', () => {
  it('crash after the provider call (tx rolled back, reminder still scheduled): the retry reuses idempotencyKey rem:<id>, gets the SAME delivery (replayed) and records it', async () => {
    const { w, run } = await setup(); const r = w.reminder(); w.notif.crashAfterRecordOnce = true;
    await expect(run(r['id'])).rejects.toThrow(); expect(w.get(r['id'])['status']).toBe('scheduled');
    await run(r['id']);
    expect(w.notif.calls.map((c) => c.input['idempotencyKey'])).toEqual([`rem:${r['id']}`, `rem:${r['id']}`]); expect(new Set(w.notif.byKey.values()).size).toBe(1);
    expect(w.get(r['id'])).toMatchObject({ status: 'sent', delivery_id: w.notif.byKey.get(`rem:${r['id']}`) });
  });
  it('task run again after success (duplicate job): no port call, delivery_id and sent_at unchanged, one notification only', async () => {
    const { w, run } = await setup(); w.account(ACCOUNT_1); w.link(ACCOUNT_1); const r = w.reminder(); await run(r['id']);
    const done = JSON.stringify(w.get(r['id'])); w.advance(HOUR); await run(r['id']);
    expect(w.notif.calls).toHaveLength(1); expect(JSON.stringify(w.get(r['id']))).toBe(done); expect(w.notificationsOf(ACCOUNT_1)).toHaveLength(1);
  });
  it('transient NotificationPort failure / unknown template: task throws (queue retry or dead letter), reminder stays scheduled, no notification half-written', async () => {
    const { w, run } = await setup(); w.account(ACCOUNT_1); w.link(ACCOUNT_1); const r = w.reminder();
    w.notif.failNext = new Error('provider down'); await expect(run(r['id'])).rejects.toThrow();
    w.notif.failNext = Object.assign(new Error('reporting.notification_template_unknown'), { code: 'reporting.notification_template_unknown' }); await expect(run(r['id'])).rejects.toThrow();
    expect(w.get(r['id'])['status']).toBe('scheduled'); expect(w.t['notifications']).toEqual([]);
    await run(r['id']); expect(w.get(r['id'])['status']).toBe('sent');                                  // next retry succeeds
  });
  // 03-APP-FLOW reminder states: scheduled -> failed (port error after retries). Without it the row stays scheduled and the */5 dispatcher re-enqueues rem:<id> forever.
  it('port error on the LAST attempt (8/8): no throw, reminder failed with failure_code set (LimsError code, else common.internal); earlier attempts (7/8) still throw and stay scheduled', async () => {
    const { w, run } = await setup(); const r = w.reminder();
    w.notif.failNext = new Error('provider down'); await expect(run(r['id'], { attempt: 7, maxAttempts: 8 })).rejects.toThrow();
    expect(w.get(r['id'])['status']).toBe('scheduled');
    w.notif.failNext = new Error('provider down'); await expect(run(r['id'], { attempt: 8, maxAttempts: 8 })).resolves.toBeUndefined();
    expect(w.get(r['id'])).toMatchObject({ status: 'failed', sent_at: null, failure_code: 'common.internal' });
    const r2 = w.reminder(); w.notif.failNext = Object.assign(new Error('x'), { code: 'reporting.notification_template_unknown' });
    await expect(run(r2['id'], { attempt: 8, maxAttempts: 8 })).resolves.toBeUndefined();
    expect(w.get(r2['id'])['status']).toBe('failed'); expect(String(w.get(r2['id'])['failure_code'])).toMatch(/^[a-z_.]{1,64}$/);
  });
  it('after failed the dispatcher never re-enqueues it and a duplicate send_reminder job is a no-op (no second port call)', async () => {
    const { w, run, cron } = await setup(); const r = w.reminder();
    w.notif.failNext = new Error('provider down'); await run(r['id'], { attempt: 8, maxAttempts: 8 });
    const jobsBefore = w.jobs('engagement.send_reminder').length; const calls = w.notif.calls.length;
    w.advance(5 * 60_000); await cron(); await cron(); await run(r['id']);
    expect(w.jobs('engagement.send_reminder')).toHaveLength(jobsBefore); expect(w.notif.calls).toHaveLength(calls); expect(w.get(r['id'])['status']).toBe('failed');
  });
});

describe('isolation + hostile payloads', () => {
  it('reminder of another tenant under this tenant\'s claims: not found -> silent no-op (no port call, row untouched)', async () => {
    const { w, run } = await setup(); const r = w.reminder({ tenant_id: TENANT_B }); await run(r['id']);
    expect(w.notif.calls).toEqual([]); expect(w.get(r['id'])['status']).toBe('scheduled');
  });
  it('unknown / malformed reminder_id or missing payload keys -> returns normally (no retry storm), nothing sent', async () => {
    const { w } = await setup(); const t = await send();
    for (const p of [{ tenant_id: TENANT_A, reminder_id: ID(0xdead) }, { tenant_id: TENANT_A, reminder_id: "x'; DROP TABLE engagement.reminders;--" }, { tenant_id: TENANT_A }, { tenant_id: TENANT_A, reminder_id: 42 }, {}])
      await expect(w.runTask(t, p as any)).resolves.toBeUndefined();
    expect(w.notif.calls).toEqual([]); expect(w.writes()).toEqual([]);
  });
  it('every statement binds values (no value interpolated into SQL text) and the SMS carries no contact data of its own (recipient by patientId only)', async () => {
    const { w, run, cron } = await setup(); const r = w.reminder(); await cron(); await run(r['id']);
    for (const s of w.stmts) expect(s.text).not.toContain(String(r['id']));
    expect(JSON.stringify(w.notif.calls[0]!.input)).not.toMatch(/\+977\d{6,}/);
  });
});
