// C6-T23 worker task reporting.dispatch_release_deliveries (02-TRD §4.6 rule 4/6, §4.8, §9; 01-PRD AC-08.1, AC-09.4 (queue side); 07-SECURITY REQ-SEC-006/070).
// ASSUMED: tasks/dispatch_release_deliveries.ts exports `dispatchReleaseDeliveries` (TaskHandler) or `createDispatchReleaseDeliveries()`; payload { tenant_id, report_version_id }
// (what release.service enqueues, job key dispatch:<version id>); runs in ctx.tx as the reporting system actor, reads patient contact + consents through
// ctx.ports.FrontdeskPort.getPatientDemographics({ purpose: 'notification' }), tenant channels through ctx.ports.IdentityPort.getTenantSettings, the referrer through
// ctx.ports.CatalogPort.getReferrer, settings / centre_contacts / qr_tokens / report_versions through ctx.tx. It writes the deliveries ITSELF through the internal delivery
// service (not NotificationPort): status queued, template reporting.report_ready, purpose report_ready, params { lab_name } only (lab name = qr_tokens.lab_name_snapshot),
// deferred_link { report_id, version_no, channel, recipient_kind }, report_id / report_version_no, one `reporting.delivery.status_changed.v1` and one `reporting.send_delivery`
// job { delivery_id } (job key = delivery id) per queued delivery. The idempotency key format is NOT fixed by the spec: tests only need it to contain the version id and to
// make a re-run a no-op. Patient: first channel of patient_mobile_channel_order that is enabled + has a phone + consent; e-mail IN ADDITION (patient_email_enabled, channel enabled,
// address, consent). Referrer: only when audiences has `referrer`, referrer_delivery_enabled, channel from referrer_channels, patient shareWithReferrer still true.
// Centre: only when audiences has `centre` and centre_delivery_enabled; one delivery per ACTIVE centre_contacts row, recipient_id = contact id, key suffix `:<contact id>`.
// Partner: nothing is sent in Phase 1 (rows, if any, are `suppressed`). `print_only`: nothing at all.
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { eventValidators } from '../../../../../api/src/core/events/publish.js';
import { CENTRE_PHONE, CONTACT, deliveryWorld, DISPATCH, EMAIL, FULL_NAME, I, idN, LAB, LAB_NAME, NOW, PHONE, REFERRER_PHONE, REG_NO, released, rendered, sha256buf, STATUS_EVENT, SYSTEM_ACTOR, TENANT_A, TENANT_B, V, type DW, type DWorldOpts, type Row } from './delivery.helpers.js';

type Task = (p: any, c: any) => Promise<void>;
async function load(): Promise<Task> {
  const m: any = await import('../tasks/dispatch_release_deliveries.js');
  return (m.dispatchReleaseDeliveries ?? m.createDispatchReleaseDeliveries?.()) as Task;
}
async function setup(o: DWorldOpts = {}) {
  const w = deliveryWorld({ ...o, consent: { email: false, ...o.consent } });   // e-mail consent is opt-in per test so the mobile-channel cases stay one-delivery
  const task = await load();
  const go = (over: Row = {}, payload: Row = { tenant_id: TENANT_A, report_version_id: V(1) }) => w.run(task, payload, over);
  return { w, task, go };
}
const queued = (w: DW) => w.deliveries().filter((d) => d['status'] === 'queued');
const kinds = (w: DW) => queued(w).map((d) => `${d['recipient_kind']}:${d['channel']}`).sort();
const CONTACT_SMS = (n: number, over: Row = {}) => ({ id: CONTACT(n), tenant_id: TENANT_A, centre_id: I.centre, channel: 'sms', address: CENTRE_PHONE, is_active: true, created_at: `2026-11-01T00:00:0${n}.000Z`, ...over });

describe('patient audience (AC-08.1, 02-TRD §4.8)', () => {
  it('whatsapp consent + phone + channel enabled -> ONE queued WhatsApp report_ready delivery with the deferred link and only lab_name as param', async () => {
    const { w, go } = await setup({ audiences: ['patient'] }); expect(await go()).toBe('ok');
    expect(queued(w)).toHaveLength(1); const d = queued(w)[0]!;
    expect(d).toMatchObject({ tenant_id: TENANT_A, channel: 'whatsapp', purpose: 'report_ready', template_code: 'reporting.report_ready', recipient_kind: 'patient', recipient_id: I.patient, status: 'queued',
      report_id: LAB, report_version_no: 1, related_entity_type: 'report', related_entity_id: LAB, params: { lab_name: LAB_NAME }, link_id: null, fallback_of_delivery_id: null });
    expect(d['deferred_link']).toEqual({ report_id: LAB, version_no: 1, channel: 'whatsapp', recipient_kind: 'patient' });
    expect(String(d['idempotency_key'])).toContain(V(1)); expect(d['destination_masked'] ?? '').not.toContain(PHONE);
    if (d['destination_sha256']) expect(Buffer.from(d['destination_sha256']).equals(sha256buf(PHONE))).toBe(true);
  });
  it('one send job per queued delivery: payload { delivery_id } only (no address, no params), job key = delivery id', async () => {
    const { w, go } = await setup({ audiences: ['patient'] }); await go();
    const d = queued(w)[0]!; expect(w.sendJobs()).toHaveLength(1);
    expect(w.sendJobs()[0]).toMatchObject({ jobKey: d['id'] }); expect(w.sendJobs()[0]!.payload).toEqual({ delivery_id: d['id'] });
  });
  it('no WhatsApp consent -> the next channel of the order: SMS', async () => {
    const { w, go } = await setup({ audiences: ['patient'], consent: { whatsapp: false } }); await go(); expect(kinds(w)).toEqual(['patient:sms']);
  });
  it('tenant WhatsApp channel switched off -> SMS', async () => {
    const { w, go } = await setup({ audiences: ['patient'], channels: { whatsappEnabled: false } }); await go(); expect(kinds(w)).toEqual(['patient:sms']);
  });
  it('patient_mobile_channel_order [sms, whatsapp] is honoured', async () => {
    const { w, go } = await setup({ audiences: ['patient'], settings: { patient_mobile_channel_order: ['sms', 'whatsapp'] } }); await go(); expect(kinds(w)).toEqual(['patient:sms']);
  });
  it('e-mail is sent IN ADDITION to the mobile channel when enabled, an address exists and email consent is true', async () => {
    const { w, go } = await setup({ audiences: ['patient'], consent: { email: true } }); await go(); expect(kinds(w)).toEqual(['patient:email', 'patient:whatsapp']);
    const mail = queued(w).find((d) => d['channel'] === 'email')!; expect(mail['deferred_link']).toMatchObject({ channel: 'email', recipient_kind: 'patient' }); expect(w.sendJobs()).toHaveLength(2);
  });
  it.each([
    ['patient_email_enabled = false', { settings: { patient_email_enabled: false } }],
    ['tenant e-mail channel off', { channels: { emailEnabled: false } }],
    ['no email consent', { consent: { email: false } }],
    ['no email address', { email: null }],
  ] as Array<[string, DWorldOpts]>)('no e-mail delivery when %s', async (_n, extra) => {
    const { w, go } = await setup({ audiences: ['patient'], ...extra, consent: { email: true, ...extra.consent } }); await go(); expect(kinds(w)).toEqual(['patient:whatsapp']);
  });
  it('no phone on file -> e-mail only', async () => {
    const { w, go } = await setup({ audiences: ['patient'], phone: null, consent: { email: true } }); await go(); expect(kinds(w)).toEqual(['patient:email']);
  });
  it('no consent on any channel -> nothing is queued, no send job, the task resolves (rows, if written, are suppressed)', async () => {
    const { w, go } = await setup({ audiences: ['patient'], consent: { sms: false, whatsapp: false, email: false } });
    expect(await go()).toBe('ok'); expect(queued(w)).toEqual([]); expect(w.sendJobs()).toEqual([]);
    expect(w.deliveries().every((d) => d['status'] === 'suppressed' && typeof d['failure_code'] === 'string')).toBe(true);
  });
  it('contacts are read as the system actor with purpose `notification`; BillingPort / PaymentProviderPort / SmartReportPort are never called', async () => {
    const { w, go } = await setup({ audiences: ['patient'] }); await go();
    expect(w.portCalls.frontdesk.length).toBeGreaterThan(0); expect(w.portCalls.frontdesk.every((c) => c.purpose === 'notification' && c.actorType === 'system' && c.patientId === I.patient)).toBe(true);
    expect(w.portCalls.forbidden).toEqual([]);
  });
});

describe('referrer / centre / partner / print_only audiences (§4.6 rule 6, §4.8)', () => {
  it('referrer in audiences + shareWithReferrer + referrer_channels [sms] + a referrer phone -> one SMS referrer delivery with the same deferred link shape', async () => {
    const { w, go } = await setup({ audiences: ['patient', 'referrer'] }); await go();
    expect(kinds(w)).toEqual(['patient:whatsapp', 'referrer:sms']);
    const r = queued(w).find((d) => d['recipient_kind'] === 'referrer')!;
    expect(r).toMatchObject({ purpose: 'report_ready', template_code: 'reporting.report_ready', report_version_no: 1, recipient_id: I.referrer });
    expect(r['deferred_link']).toEqual({ report_id: LAB, version_no: 1, channel: 'sms', recipient_kind: 'referrer' });
    expect(w.portCalls.catalog.every((c) => c.purpose === 'notification' && c.actorType === 'system' && c.referrerId === I.referrer)).toBe(true);
  });
  it('REQ-SEC-006: consent shareWithReferrer withdrawn since the release -> no referrer delivery is queued', async () => {
    const { w, go } = await setup({ audiences: ['patient', 'referrer'], consent: { shareWithReferrer: false } }); await go();
    expect(queued(w).some((d) => d['recipient_kind'] === 'referrer')).toBe(false);
  });
  it('referrer_delivery_enabled = false, or no referrer contact -> no referrer delivery', async () => {
    const a = await setup({ audiences: ['patient', 'referrer'], settings: { referrer_delivery_enabled: false } }); await a.go(); expect(queued(a.w).some((d) => d['recipient_kind'] === 'referrer')).toBe(false);
    const b = await setup({ audiences: ['patient', 'referrer'], referrer: { phoneE164: null } }); await b.go(); expect(queued(b.w).some((d) => d['recipient_kind'] === 'referrer')).toBe(false);
  });
  it('the order has a referrer but `referrer` is not in the version audiences -> nothing for the referrer (the released audiences are authoritative)', async () => {
    const { w, go } = await setup({ audiences: ['patient'] }); await go(); expect(queued(w).some((d) => d['recipient_kind'] === 'referrer')).toBe(false); expect(w.portCalls.catalog).toEqual([]);
  });
  it('centre: centre_delivery_enabled = false (default) -> no centre delivery even when `centre` is in audiences', async () => {
    const { w, go } = await setup({ audiences: ['centre'], centreContacts: [CONTACT_SMS(1)] }); await go(); expect(queued(w)).toEqual([]);
  });
  it('centre (review fix #30): one delivery per ACTIVE contact, recipient_id = contact id, key suffixed `:<contact id>`, inactive contacts skipped', async () => {
    const { w, go } = await setup({ audiences: ['centre'], settings: { centre_delivery_enabled: true },
      centreContacts: [CONTACT_SMS(1), CONTACT_SMS(2, { address: '+9779800000099' }), CONTACT_SMS(3, { is_active: false }), CONTACT_SMS(4, { channel: 'email', address: 'centre@example.invalid' })] });
    await go(); const c = queued(w).filter((d) => d['recipient_kind'] === 'centre');
    expect(c.map((d) => d['recipient_id']).sort()).toEqual([CONTACT(1), CONTACT(2), CONTACT(4)].sort());
    for (const d of c) { expect(String(d['idempotency_key']).endsWith(`:${d['recipient_id']}`)).toBe(true); expect(d['centre_id']).toBe(I.centre); expect(d['purpose']).toBe('report_ready'); }
    expect(new Set(c.map((d) => d['idempotency_key'])).size).toBe(3); expect(JSON.stringify(c)).not.toContain(CENTRE_PHONE);
  });
  it('partner audience: Phase 1 sends nothing (no partner contact is resolvable); any row written is suppressed', async () => {
    const { w, go } = await setup({ audiences: ['partner'] }); expect(await go()).toBe('ok');
    expect(queued(w)).toEqual([]); expect(w.sendJobs()).toEqual([]);
  });
  it('print_only (suppress_notifications) -> no delivery rows, no jobs, no contact lookups', async () => {
    const { w, go } = await setup({ audiences: ['print_only'] }); expect(await go()).toBe('ok');
    expect(w.deliveries()).toEqual([]); expect(w.sendJobs()).toEqual([]); expect(w.portCalls.frontdesk).toEqual([]);
  });
});

describe('version state, idempotency, tenant scope', () => {
  it('a version that is not (or no longer) `released` gets nothing: rendered / superseded', async () => {
    const a = await setup({ versions: [rendered(1)] }); expect(await a.go()).toBe('ok'); expect(a.w.deliveries()).toEqual([]);
    const b = await setup({ versions: [released(1, { status: 'superseded', superseded_at: NOW, audiences: ['patient'] }), released(2, { audiences: ['patient'], supersedes_version_no: 1 })] });
    expect(await b.go()).toBe('ok'); expect(b.w.deliveries()).toEqual([]);
  });
  it('an amended version v2 is delivered with report_version_no 2 and its own idempotency keys', async () => {
    const { w, go } = await setup({ versions: [released(1, { status: 'superseded', superseded_at: NOW, audiences: ['patient'] }), released(2, { audiences: ['patient'], supersedes_version_no: 1 })],
      deliveries: [], extraSeed: { 'reporting.qr_tokens': [{ id: idN(0x9a11), tenant_id: TENANT_A, centre_id: I.centre, report_id: LAB, report_version_id: V(2), token_sha256: sha256buf('q2'), lab_name_snapshot: LAB_NAME, patient_display_snapshot: 'T. P.', panel_names_snapshot: [], issued_at: NOW, created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR }] } });
    await go({}, { tenant_id: TENANT_A, report_version_id: V(2) });
    expect(queued(w).length).toBeGreaterThan(0); expect(queued(w).every((d) => d['report_version_no'] === 2 && (d['deferred_link'] as any).version_no === 2 && String(d['idempotency_key']).includes(V(2)))).toBe(true);
  });
  it('re-running the task (queue retry) changes nothing: same rows, one job and one event per delivery', async () => {
    const { w, go } = await setup({ audiences: ['patient', 'referrer'] }); await go(); const rows = JSON.stringify(w.deliveries()); const jobs = w.sendJobs().length; const evs = w.statusEvents().length;
    expect(await go()).toBe('ok'); expect(JSON.stringify(w.deliveries())).toBe(rows); expect(w.sendJobs()).toHaveLength(jobs); expect(w.statusEvents()).toHaveLength(evs);
  });
  it('parallel runs of the same job create each delivery once', async () => {
    const { w, task } = await setup({ audiences: ['patient'] });
    await Promise.all([1, 2, 3].map(() => task({ tenant_id: TENANT_A, report_version_id: V(1) }, w.ctx())));
    expect(queued(w).filter((d) => d['channel'] === 'whatsapp')).toHaveLength(1); expect(w.sendJobs().filter((j) => j.jobKey === queued(w)[0]!['id'])).toHaveLength(1);
  });
  it('payload tenant different from the job tenant, unknown version id, malformed payload -> silent no-op (no rows, no throw)', async () => {
    const { w, go } = await setup({ audiences: ['patient'] });
    expect(await go({}, { tenant_id: TENANT_B, report_version_id: V(1) })).toBe('ok');
    expect(await go({}, { tenant_id: TENANT_A, report_version_id: idN(0xdead) })).toBe('ok');
    expect(await go({}, { tenant_id: TENANT_A, report_version_id: 'not-a-uuid' })).toBe('ok');
    expect(await go({}, {})).toBe('ok'); expect(w.deliveries()).toEqual([]);
  });
  it('another tenant\'s version is invisible even with RLS off (every statement names tenant_id)', async () => {
    const { w, go } = await setup({ audiences: ['patient'], rls: false });
    expect(await go({ tenantId: TENANT_B }, { tenant_id: TENANT_B, report_version_id: V(1) })).toBe('ok'); expect(w.deliveries()).toEqual([]);
  });
});

describe('events, atomicity, PHI', () => {
  it('each delivery publishes exactly one reporting.delivery.status_changed.v1 (absent -> queued) that validates against the contract schema', async () => {
    const { w, go } = await setup({ audiences: ['patient', 'referrer'] }); await go();
    const evs = w.statusEvents(); expect(evs).toHaveLength(queued(w).length);
    const validate = eventValidators().get(STATUS_EVENT)!;
    for (const e of evs) {
      expect(e.input.payload).toMatchObject({ channel: expect.any(String), purpose: 'report_ready', to_status: 'queued', report_id: LAB, report_version_no: 1 }); expect(e.input.payload.from_status).toBeUndefined();
      expect(validate({ event_id: idN(0xe9), event_type: STATUS_EVENT, tenant_id: TENANT_A, occurred_at: NOW, actor: { type: 'system', id: SYSTEM_ACTOR }, idempotency_key: e.input.idempotencyKey,
        producer: 'reporting', aggregate: e.input.aggregate, request_id: idN(0xf1), payload: e.input.payload })).toBe(true);
    }
    expect(new Set(evs.map((e) => e.input.idempotencyKey)).size).toBe(evs.length);
  });
  it('a failure half-way (port down) leaves nothing behind: no rows, no jobs, no events; the error is thrown for the queue retry', async () => {
    const { w, go } = await setup({ audiences: ['patient', 'referrer'], frontdeskDown: true });
    const r = await go(); expect(r).toBeInstanceOf(Error); expect(w.deliveries()).toEqual([]); expect(w.sendJobs()).toEqual([]); expect(w.statusEvents()).toEqual([]);
  });
  it('no phone, e-mail, patient name, registration number or link token reaches jobs, events, access log or logs', async () => {
    const { w, go } = await setup({ audiences: ['patient', 'referrer', 'centre'], consent: { email: true }, settings: { centre_delivery_enabled: true }, centreContacts: [CONTACT_SMS(1)] }); await go();
    const text = w.leakText(); for (const s of [PHONE, EMAIL, FULL_NAME, REG_NO, REFERRER_PHONE, CENTRE_PHONE, '/r/']) expect(text, s).not.toContain(s);
  });
  it('the deliveries hold no URL and no link: params has only lab_name, link_id NULL, no portal link is issued at dispatch time', async () => {
    const { w, go } = await setup({ audiences: ['patient', 'centre'], settings: { centre_delivery_enabled: true }, centreContacts: [CONTACT_SMS(1)] }); await go();
    for (const d of queued(w)) { expect(Object.keys(d['params'])).toEqual(['lab_name']); expect(d['link_id']).toBeNull(); }
    expect(w.portalLinks()).toEqual([]);
  });
});

describe('worker manifest wiring', () => {
  it('reporting.dispatch_release_deliveries is the real task (no longer the fail-loud stub) with maxAttempts 10; end to end through the manifest', async () => {
    const { manifest } = await import('../index.js'); const w = deliveryWorld({ audiences: ['patient'], consent: { email: false } });
    expect(manifest.maxAttempts![DISPATCH]).toBe(10);
    const r = await w.run(manifest.tasks![DISPATCH]! as Task, { tenant_id: TENANT_A, report_version_id: V(1) });
    expect(r).toBe('ok'); expect(queued(w)).toHaveLength(1);
  });
});
