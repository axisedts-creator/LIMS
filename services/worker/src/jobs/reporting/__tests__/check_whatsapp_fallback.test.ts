// C6-T23 worker task reporting.check_whatsapp_fallback (01-PRD AC-09.2; 02-TRD §4.8 "Fallback", §9 row `run_at = sent_at + fallback minutes`, max attempts 8; REQ-ARCH-085).
// ASSUMED: tasks/check_whatsapp_fallback.ts exports `checkWhatsappFallback` (TaskHandler) or `createCheckWhatsappFallback()`; payload { delivery_id } (what send_delivery schedules);
// ctx.tx, system actor; a WhatsApp delivery that is `failed`, or still `sent` (not delivered/read) once sent_at + whatsapp_fallback_minutes (settings, default 30) <= now, gets ONE
// SMS delivery: same recipient / report / version / purpose / template / params, channel `sms`, status `queued`, fallback_of_delivery_id = original, deferred_link channel `sms`
// (the SMS-channel link itself is issued by the send task), own send job (key = id) and one status_changed event (absent -> queued). Only if the tenant SMS channel is enabled AND the
// patient consents to SMS AND a phone exists (else nothing is created). Never for sms / e-mail deliveries or for a fallback itself. The original row is not modified.
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { D, deliveryWorld, dRow, EMAIL, FULL_NAME, I, idN, LAB, LAB_NAME, minutesAgo, NOW, PHONE, REG_NO, sentRow, SEND, STATUS_EVENT, TENANT_A, TENANT_B, FALLBACK, type DW, type DWorldOpts, type Row } from './delivery.helpers.js';

type Task = (p: any, c: any) => Promise<void>;
async function setup(o: DWorldOpts = {}) {
  const w = deliveryWorld({ deliveries: [sentRow(1, 31)], ...o });
  const m: any = await import('../tasks/check_whatsapp_fallback.js');
  const task: Task = m.checkWhatsappFallback ?? m.createCheckWhatsappFallback?.();
  const go = (id: string = D(1), over: Row = {}) => w.run(task, { delivery_id: id }, over);
  return { w, task, go };
}
const fb = (w: DW, id: string = D(1)) => w.fallbacksOf(id);

describe('AC-09.2: the SMS fallback of a WhatsApp delivery that was not delivered in time', () => {
  it('sent but not delivered after whatsapp_fallback_minutes (31 >= 30) -> exactly one SMS fallback delivery with fallback_of_delivery_id', async () => {
    const { w, go } = await setup(); expect(await go()).toBe('ok'); expect(fb(w)).toHaveLength(1);
    expect(fb(w)[0]).toMatchObject({ tenant_id: TENANT_A, channel: 'sms', status: 'queued', fallback_of_delivery_id: D(1), purpose: 'report_ready', template_code: 'reporting.report_ready', recipient_kind: 'patient',
      recipient_id: I.patient, report_id: LAB, report_version_no: 1, params: { lab_name: LAB_NAME }, link_id: null, related_entity_type: 'report', related_entity_id: LAB });
    expect(fb(w)[0]!['id']).not.toBe(D(1)); expect(fb(w)[0]!['idempotency_key']).not.toBe(w.delivery(D(1))['idempotency_key']);
  });
  it('the fallback gets a NEW SMS-channel link at send time: deferred_link is bound to channel `sms` (never the WhatsApp link)', async () => {
    const { w, go } = await setup({ links: [{ id: idN(0x1101), tenant_id: TENANT_A, channel: 'whatsapp', delivery_id: D(1) }].map((l) => ({ ...l, centre_id: I.centre, report_id: LAB, bound_version_no: 1, recipient_kind: 'patient', patient_display_snapshot: 'T. P.', token_sha256: Buffer.alloc(32, 9), expires_at: '2026-12-01T00:00:00.000Z', created_by: idN(1), updated_by: idN(1) })) });
    await go(); expect(fb(w)[0]!['deferred_link']).toEqual({ report_id: LAB, version_no: 1, channel: 'sms', recipient_kind: 'patient' });
    expect(w.portalLinks().filter((l) => l['revoked_at'] != null)).toEqual([]);      // the original link is neither reused nor revoked here
  });
  it('queues the fallback for sending: one reporting.send_delivery job { delivery_id } with job key = the new delivery id', async () => {
    const { w, go } = await setup(); await go(); const j = w.sendJobs().filter((x) => x.payload?.delivery_id === fb(w)[0]!['id']);
    expect(j).toHaveLength(1); expect(j[0]).toMatchObject({ jobKey: fb(w)[0]!['id'] }); expect(j[0]!.payload).toEqual({ delivery_id: fb(w)[0]!['id'] });
  });
  it('publishes reporting.delivery.status_changed.v1 for the new delivery (absent -> queued, channel sms) and nothing for the original', async () => {
    const { w, go } = await setup(); await go(); const ev = w.statusEvents(); expect(ev).toHaveLength(1);
    expect(ev[0]!.type).toBe(STATUS_EVENT); expect(ev[0]!.input.payload).toMatchObject({ delivery_id: fb(w)[0]!['id'], channel: 'sms', purpose: 'report_ready', to_status: 'queued', report_id: LAB, report_version_no: 1 });
    expect(ev[0]!.input.payload.from_status).toBeUndefined();
  });
  it('the original delivery is left untouched (still `sent`, same version)', async () => {
    const { w, go } = await setup(); const before = JSON.stringify(w.delivery(D(1))); await go(); expect(JSON.stringify(w.delivery(D(1)))).toBe(before);
  });
  it('a WhatsApp delivery that FAILED gets the fallback at once', async () => {
    const { w, go } = await setup({ deliveries: [sentRow(1, 1, { status: 'failed', failed_at: minutesAgo(1), failure_code: 'provider_rejected' })] }); await go(); expect(fb(w)).toHaveLength(1);
  });
  it('timing: due exactly at sent_at + minutes; 29 min is too early; a longer setting (60) postpones it', async () => {
    const a = await setup({ deliveries: [sentRow(1, 30)] }); await a.go(); expect(fb(a.w)).toHaveLength(1);
    const b = await setup({ deliveries: [sentRow(1, 29)] }); await b.go(); expect(fb(b.w)).toEqual([]); expect(b.w.sendJobs()).toEqual([]);
    const c = await setup({ settings: { whatsapp_fallback_minutes: 60 } }); await c.go(); expect(fb(c.w)).toEqual([]);                    // sent 31 min ago
    const d = await setup({ settings: { whatsapp_fallback_minutes: 60 }, deliveries: [sentRow(1, 61)] }); await d.go(); expect(fb(d.w)).toHaveLength(1);
  });
  it.each(['delivered', 'read'])('a delivery that is already %s needs no fallback', async (st) => {
    const { w, go } = await setup({ deliveries: [sentRow(1, 45, { status: st, delivered_at: minutesAgo(40), ...(st === 'read' ? { read_at: minutesAgo(39) } : {}) })] });
    expect(await go()).toBe('ok'); expect(fb(w)).toEqual([]); expect(w.sendJobs()).toEqual([]); expect(w.statusEvents()).toEqual([]);
  });
});

describe('"if SMS is enabled and consented"', () => {
  it.each([
    ['tenant SMS channel off', { channels: { smsEnabled: false } }],
    ['no SMS consent', { consent: { sms: false } }],
    ['no phone on file', { phone: null }],
  ] as Array<[string, DWorldOpts]>)('%s -> no fallback, no job, no event, the task resolves', async (_n, extra) => {
    const { w, go } = await setup(extra); expect(await go()).toBe('ok'); expect(fb(w)).toEqual([]); expect(w.sendJobs()).toEqual([]); expect(w.statusEvents()).toEqual([]);
    expect(w.deliveries()).toHaveLength(1);
  });
  it('consent / contact are read as the system actor with purpose `notification`; Billing / Payment / SmartReport ports are not touched', async () => {
    const { w, go } = await setup(); await go();
    expect(w.portCalls.frontdesk.length).toBeGreaterThan(0); expect(w.portCalls.frontdesk.every((c) => c.purpose === 'notification' && c.actorType === 'system')).toBe(true); expect(w.portCalls.forbidden).toEqual([]);
  });
});

describe('at most one fallback per delivery, and only for WhatsApp originals', () => {
  it('a second run (queue retry) creates nothing more: same rows, jobs, events', async () => {
    const { w, go } = await setup(); await go(); const rows = JSON.stringify(w.deliveries()); const jobs = w.sendJobs().length; await go();
    expect(JSON.stringify(w.deliveries())).toBe(rows); expect(w.sendJobs()).toHaveLength(jobs); expect(w.statusEvents()).toHaveLength(1);
  });
  it('a fallback that already exists (created at once by the send task) is respected: no second SMS, no error', async () => {
    const { w, go } = await setup({ deliveries: [sentRow(1, 31), dRow(2, { channel: 'sms', idempotency_key: 'fb0', fallback_of_delivery_id: D(1), deferred_link: { report_id: LAB, version_no: 1, channel: 'sms', recipient_kind: 'patient' } })] });
    expect(await go()).toBe('ok'); expect(fb(w)).toHaveLength(1); expect(fb(w)[0]!['id']).toBe(D(2)); expect(w.statusEvents()).toEqual([]);
  });
  it('parallel runs create exactly one fallback (unique index on fallback_of_delivery_id)', async () => {
    const { w, task } = await setup(); await Promise.allSettled([1, 2, 3].map(() => task({ delivery_id: D(1) }, w.ctx())));
    expect(fb(w)).toHaveLength(1); expect(w.sendJobs().filter((j) => j.payload?.delivery_id === fb(w)[0]!['id'])).toHaveLength(1);
  });
  it('SMS and e-mail deliveries never get a fallback; a fallback delivery never gets one (no chains)', async () => {
    for (const row of [sentRow(1, 90, { channel: 'sms', deferred_link: { report_id: LAB, version_no: 1, channel: 'sms', recipient_kind: 'patient' } }), sentRow(1, 90, { channel: 'email' })]) {
      const { w, go } = await setup({ deliveries: [row] }); expect(await go()).toBe('ok'); expect(w.deliveries()).toHaveLength(1);
    }
    const chain = await setup({ deliveries: [sentRow(1, 90), dRow(2, { channel: 'sms', status: 'sent', sent_at: minutesAgo(80), idempotency_key: 'fb0', fallback_of_delivery_id: D(1) })] });
    expect(await chain.go(D(2))).toBe('ok'); expect(chain.w.deliveries()).toHaveLength(2);
  });
  it('suppressed originals are not handled here (the send task falls back at once, review fix #19)', async () => {
    const { w, go } = await setup({ deliveries: [dRow(1, { status: 'suppressed', failure_code: 'no_consent', suppressed_at: minutesAgo(40) })] }); expect(await go()).toBe('ok'); expect(fb(w)).toEqual([]);
  });
});

describe('scope and PHI', () => {
  it('unknown delivery, malformed id, other tenant (RLS off) -> silent no-op', async () => {
    const { w, task } = await setup({ rls: false, deliveries: [sentRow(1, 31, { tenant_id: TENANT_B })] });
    expect(await w.run(task, { delivery_id: D(1) })).toBe('ok'); expect(await w.run(task, { delivery_id: idN(0xdead) })).toBe('ok'); expect(await w.run(task, { delivery_id: 'nope' })).toBe('ok'); expect(await w.run(task, {})).toBe('ok');
    expect(w.deliveries()).toHaveLength(1);
  });
  it('no phone, e-mail, name or registration number in logs, events, jobs, access log; the fallback row holds no address', async () => {
    const { w, go } = await setup(); await go(); const text = w.leakText(); for (const s of [PHONE, EMAIL, FULL_NAME, REG_NO, '/r/']) expect(text, s).not.toContain(s);
    expect(JSON.stringify(fb(w))).not.toContain(PHONE);
  });
});

describe('worker manifest wiring', () => {
  it('reporting.check_whatsapp_fallback is a registered task (maxAttempts 8) that works end to end through the manifest', async () => {
    const { manifest } = await import('../index.js'); const w = deliveryWorld({ deliveries: [sentRow(1, 31)] });
    expect(manifest.maxAttempts![FALLBACK]).toBe(8); expect(await w.run(manifest.tasks![FALLBACK]! as Task, { delivery_id: D(1) })).toBe('ok'); expect(w.fallbacksOf(D(1))).toHaveLength(1);
  });
});
void NOW; void SEND;
