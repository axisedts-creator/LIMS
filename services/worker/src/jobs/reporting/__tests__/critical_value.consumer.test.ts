// C6-T24 — consumer lab.critical_value.detected.v1 (02-TRD §8.2 consumer table, §7.2 steps 4-5; 01-PRD AC-14.1, AC-14.2; 07-SECURITY REQ-SEC-006/024/070; 08 A13 D-35; review fix #16).
// ASSUMED API (spec gives no signatures; repeated in .orchestra/notes/C6-T24-tests.md):
//   consumers/lab.critical_value.detected.v1.ts -> `export const handle: ConsumerHandler` (event envelope, JobContext) like the other consumers; wired in jobs/reporting/index.ts `subscriptions`.
//   It writes reporting.deliveries rows through the same internal delivery path as dispatch_release_deliveries (T23): purpose critical_value_alert, template reporting.critical_value_alert,
//   channel sms, deferred_link null, related = {critical_event, critical_event_id}, centre_id = the EVENT's centre_id, report_id = the order's `laboratory` report (null while none exists),
//   idempotency key `<critical_event_id>:<recipient_kind>:<recipient_id>`. Referrer: queued only if settings.critical_alert_referrer_enabled AND patient consent shareWithReferrer AND a phone exists
//   (a recipient that cannot be reached may be either NOT written or written `suppressed` — both accepted; never `queued`). Staff: one row per `critical_alert_recipient` assignment, status
//   `suppressed` / failure_code `no_contact` (Phase 1). Ports: ctx.ports.{FrontdeskPort,IdentityPort,CatalogPort} (system actor), single-table SQL only (fake limits).
// lab_name / lab_phone (ruling): IdentityPort.getTenantSettings(ctx, { keys: ['branding'] }) -> branding.displayName / branding.phones[0] (IC 03:1619-1622, 02-TRD:342).
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { eventValidators } from '../../../../../api/src/core/events/publish.js';
import { envelope } from './consumers.helpers.js';
import { deliveryWorld, I, idN, LAB, LAB_NAME, LAB_PHONE, makeTransport, PHONE, EMAIL, FULL_NAME, REG_NO, REFERRER_PHONE, sha256buf, SYSTEM_ACTOR, TENANT_A, TENANT_B, type DW, type DWorldOpts, type Row } from './delivery.helpers.js';

const EVENT = 'lab.critical_value.detected.v1';
const TEMPLATE = 'reporting.critical_value_alert';
export const CE = (n = 1) => idN(0x160000 + n);                 // critical_event_id
const M = (n: number) => idN(0x3100 + n);                        // staff memberships
const CENTRE_2 = idN(0xc0c2);
const RESULT = idN(0x6101); const ANALYTE = idN(0x7101);
const base = { tenant_id: TENANT_A, created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR };
const assign = (n: number, membership: string, kind = 'critical_alert_recipient', tenant = TENANT_A): Row => ({ ...base, tenant_id: tenant, id: idN(0x5a00 + n), assignment: kind, membership_id: membership, sort_order: n, version: 1 });

export function criticalEvent(payloadOver: Row = {}, over: Row = {}, ceId = CE(1)): any {
  const payload: Row = { critical_event_id: ceId, result_id: RESULT, result_version_no: 1, order_id: I.order, patient_id: I.patient, centre_id: I.centre, referrer_id: I.referrer,
    analyte_id: ANALYTE, direction: 'high', detected_at: '2026-11-07T11:59:00.000Z', ...payloadOver };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  return envelope(EVENT, 'lab', 'result', RESULT, 1, payload, { idempotency_key: `${RESULT}:critical:1:${'ab'.repeat(8)}`, ...over });
}

async function setup(o: DWorldOpts & { staff?: string[]; assignments?: Row[]; noReport?: boolean; narrativeReport?: boolean } = {}) {
  const { staff = [M(1), M(2)], assignments, noReport, narrativeReport, ...rest } = o;
  const opts: DWorldOpts = { audiences: ['patient'], ...rest, extraSeed: { 'reporting.staff_assignments': assignments ?? staff.map((m, i) => assign(i + 1, m)), ...rest.extraSeed } };
  const w = deliveryWorld(opts);
  const reports = w.db.store['reporting.reports']!;
  if (narrativeReport) { const lab = reports.find((r: Row) => r['id'] === LAB)!; reports.unshift({ ...lab, id: idN(0xa102), family: 'narrative' }); }
  if (noReport) reports.length = 0;
  const m: any = await import('../consumers/lab.critical_value.detected.v1.js');
  const handle = m.handle as (e: any, c: any) => Promise<void>;
  const go = (e: any = criticalEvent(), over: Row = {}) => w.run(handle, e, over);
  return { w, opts, handle, go };
}
const alerts = (w: DW) => w.deliveries().filter((d) => d['purpose'] === 'critical_value_alert');
const ofKind = (w: DW, kind: string) => alerts(w).filter((d) => d['recipient_kind'] === kind);
const ok = (r: 'ok' | Error) => expect(r).toBe('ok');

describe('fixture', () => {
  it('the critical event used here is valid against contracts/events/lab.critical_value.detected.v1', () => {
    const e = criticalEvent();
    expect(eventValidators().get(EVENT)!({ ...e, event_id: idN(0xe901), request_id: idN(0xf1), idempotency_key: e.idempotency_key })).toBe(true);
  });
});

describe('AC-14.1 referrer alert', () => {
  it('shareWithReferrer + phone -> ONE queued SMS: purpose, template, referrer recipient, related critical_event, event centre, laboratory report, key, no link', async () => {
    const { w, go } = await setup(); ok(await go());
    const rows = ofKind(w, 'referrer'); expect(rows).toHaveLength(1); const d = rows[0]!;
    expect(d).toMatchObject({ channel: 'sms', purpose: 'critical_value_alert', template_code: TEMPLATE, recipient_kind: 'referrer', recipient_id: I.referrer, status: 'queued', failure_code: null,
      related_entity_type: 'critical_event', related_entity_id: CE(1), centre_id: I.centre, report_id: LAB, idempotency_key: `${CE(1)}:referrer:${I.referrer}` });
    expect(d['deferred_link'] ?? null).toBeNull(); expect(d['link_id'] ?? null).toBeNull(); expect(w.portalLinks()).toEqual([]);              // no link, no portal_links row (D-35)
    expect(Buffer.compare(d['destination_sha256'], sha256buf(REFERRER_PHONE))).toBe(0); expect(String(d['destination_masked'])).not.toBe(REFERRER_PHONE);
    expect(d['destination_e164'] ?? null).toBeNull();
    expect(w.sendJobs().filter((j) => j.payload?.delivery_id === d['id'])).toHaveLength(1);                                                       // handed to reporting.send_delivery
  });
  it('params are exactly {lab_name, lab_phone, ref}; ref = first 8 chars of the critical_event_id; no value / analyte / patient data', async () => {
    const { w, go } = await setup(); ok(await go()); const p = ofKind(w, 'referrer')[0]!['params'];
    expect(Object.keys(p).sort()).toEqual(['lab_name', 'lab_phone', 'ref']);
    expect(p.ref).toBe(CE(1).slice(0, 8));
    expect(p.lab_name).toBe(LAB_NAME); expect(p.lab_phone).toBe(LAB_PHONE);                       // IdentityPort.getTenantSettings({keys:['branding']}): displayName, phones[0] (IC 03:1619-1622)
    expect(p.lab_name).toMatch(/^[A-Za-z0-9 .,:/()-]{1,40}$/); expect(String(p.lab_phone).length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(p)).not.toMatch(/https?:|www\./i);
  });
  it('the SMS the provider receives is EXACTLY "{lab_name}: critical result for your patient. Please call {lab_phone} now. Ref {ref}." to the referrer phone (via send_delivery, recording transport)', async () => {
    const { w, go } = await setup(); ok(await go());
    const d = ofKind(w, 'referrer')[0]!; const rec = makeTransport('recording');
    const m: any = await import('../tasks/send_delivery.js');
    const task = m.createSendDelivery({ env: { ...w.env }, transports: { recording: rec } });
    ok(await w.run(task, { delivery_id: d['id'] }));
    expect(rec.calls).toBe(1); const msg = rec.sent[0]!.msg;
    expect(msg).toMatchObject({ channel: 'sms', to: REFERRER_PHONE });
    expect(msg.body).toBe(`${d['params'].lab_name}: critical result for your patient. Please call ${d['params'].lab_phone} now. Ref ${CE(1).slice(0, 8)}.`);
    for (const s of [FULL_NAME, REG_NO, PHONE, EMAIL, 'http']) expect(JSON.stringify(msg), s).not.toContain(s);
    expect(w.delivery(d['id'])['status']).toBe('sent'); expect(w.portalLinks()).toEqual([]);
  });
  it('publishes reporting.delivery.status_changed.v1 once per delivery created (queued for the referrer, suppressed for staff)', async () => {
    const { w, go } = await setup(); ok(await go());
    const ev = w.statusEvents().filter((e) => e.input.payload.purpose === 'critical_value_alert');
    expect(ev).toHaveLength(3);
    const to = (kind: string) => ev.filter((e) => e.input.payload.recipient_kind === kind).map((e) => e.input.payload.to_status);
    expect(to('referrer')).toEqual(['queued']); expect(to('staff')).toEqual(['suppressed', 'suppressed']);
    for (const e of ev) expect(e.input.payload).toMatchObject({ channel: 'sms', purpose: 'critical_value_alert' });
  });
  it('REQ-SEC-006: patient without shareWithReferrer -> no queued referrer SMS, nothing sent', async () => {
    const { w, go } = await setup({ consent: { shareWithReferrer: false } }); ok(await go());
    expect(ofKind(w, 'referrer').filter((d) => d['status'] === 'queued')).toEqual([]);
    for (const d of ofKind(w, 'referrer')) expect(d).toMatchObject({ status: 'suppressed', failure_code: 'no_consent' });
    expect(w.sendJobs().filter((j) => ofKind(w, 'referrer').some((d) => d['id'] === j.payload?.delivery_id))).toEqual([]);
    expect(ofKind(w, 'staff')).toHaveLength(2);                                                                                               // staff alerts do not depend on that consent
  });
  it('settings.critical_alert_referrer_enabled = false -> no queued referrer SMS; staff rows still written', async () => {
    const { w, go } = await setup({ settings: { critical_alert_referrer_enabled: false } }); ok(await go());
    expect(ofKind(w, 'referrer').filter((d) => d['status'] === 'queued')).toEqual([]); expect(w.portCalls.catalog).toEqual([]);                // contact never even fetched
    expect(ofKind(w, 'staff')).toHaveLength(2);
  });
  it('event without referrer_id -> no referrer row at all', async () => {
    const { w, go } = await setup(); ok(await go(criticalEvent({ referrer_id: undefined })));
    expect(ofKind(w, 'referrer')).toEqual([]); expect(ofKind(w, 'staff')).toHaveLength(2);
  });
  it('referrer without a phone, or SMS channel disabled for the tenant -> never queued (suppressed or absent)', async () => {
    for (const o of [{ referrer: { phoneE164: null } } as DWorldOpts, { channels: { smsEnabled: false } } as DWorldOpts]) {
      const { w, go } = await setup(o); ok(await go());
      expect(ofKind(w, 'referrer').filter((d) => d['status'] === 'queued')).toEqual([]);
      for (const d of ofKind(w, 'referrer')) expect(['no_contact', 'channel_disabled']).toContain(d['failure_code']);
    }
  });
  it('the referrer contact is read as the system actor with purpose notification; consents of the EVENT patient', async () => {
    const { w, go } = await setup(); ok(await go());
    expect(w.portCalls.catalog.length).toBeGreaterThan(0); expect(w.portCalls.catalog.every((c) => c.referrerId === I.referrer && c.purpose === 'notification' && c.actorType === 'system')).toBe(true);
    expect(w.portCalls.frontdesk.every((c) => c.patientId === I.patient && c.purpose === 'notification' && c.actorType === 'system')).toBe(true);
  });
});

describe('AC-14.2 staff alert rows', () => {
  it('each critical_alert_recipient gets ONE suppressed_no_contact row (sms, staff, related event, event centre, report, key <event>:staff:<membership>)', async () => {
    const { w, go } = await setup({ staff: [M(1), M(2), M(3)] }); ok(await go());
    const rows = ofKind(w, 'staff'); expect(rows.map((r) => r['recipient_id']).sort()).toEqual([M(1), M(2), M(3)].sort());
    for (const d of rows) {
      expect(d).toMatchObject({ channel: 'sms', purpose: 'critical_value_alert', template_code: TEMPLATE, status: 'suppressed', failure_code: 'no_contact', related_entity_type: 'critical_event',
        related_entity_id: CE(1), centre_id: I.centre, report_id: LAB, idempotency_key: `${CE(1)}:staff:${d['recipient_id']}` });
      expect(d['destination_sha256'] ?? null).toBeNull(); expect(d['destination_masked'] ?? null).toBeNull(); expect(d['suppressed_at']).toBeTruthy(); expect(d['deferred_link'] ?? null).toBeNull();
      expect(Object.keys(d['params']).sort()).toEqual(['lab_name', 'lab_phone', 'ref']);
    }
    expect(w.sendJobs().filter((j) => rows.some((r) => r['id'] === j.payload?.delivery_id))).toEqual([]);                                       // nothing to send in Phase 1
  });
  it('only the critical_alert_recipient assignment counts: nominated signatories are not alerted', async () => {
    const { w, go } = await setup({ assignments: [assign(1, M(1)), assign(2, M(2), 'nominated_signatory'), assign(3, M(3), 'nominated_signatory')] }); ok(await go());
    expect(ofKind(w, 'staff').map((r) => r['recipient_id'])).toEqual([M(1)]);
  });
  it('no assignments configured -> no staff rows (referrer SMS still queued)', async () => {
    const { w, go } = await setup({ staff: [] }); ok(await go());
    expect(ofKind(w, 'staff')).toEqual([]); expect(ofKind(w, 'referrer')).toHaveLength(1);
  });
  it('REQ-SEC-024: another tenant\'s assignments are never alerted (also with RLS off: the statement itself is tenant-scoped)', async () => {
    for (const rls of [true, false]) {
      const { w, go } = await setup({ rls, assignments: [assign(1, M(1)), assign(2, M(9), 'critical_alert_recipient', TENANT_B)] }); ok(await go());
      expect(ofKind(w, 'staff').map((r) => r['recipient_id'])).toEqual([M(1)]);
      expect(alerts(w).every((d) => d['tenant_id'] === TENANT_A)).toBe(true);
      expect(w.db.writes().every((s) => s.values.every((v) => v !== TENANT_B && v !== M(9)))).toBe(true);
    }
  });
  it('the Phase-1 suppression does NOT call C2 for a staff contact (no phone is exposed by any port)', async () => {
    const { w, go } = await setup(); (w.ports.IdentityPort as any).getStaffNotificationContact = async () => { throw new Error('getStaffNotificationContact must not be called for critical alerts'); };
    ok(await go()); expect(ofKind(w, 'staff')).toHaveLength(2);
  });
});

describe('centre and report linkage (review fix #16)', () => {
  it('centre_id is the EVENT\'s centre (not the report\'s); report_id = the order\'s laboratory report even when a narrative report exists', async () => {
    const { w, go } = await setup({ narrativeReport: true }); ok(await go(criticalEvent({ centre_id: CENTRE_2 })));
    expect(alerts(w)).toHaveLength(3);
    for (const d of alerts(w)) expect(d).toMatchObject({ centre_id: CENTRE_2, report_id: LAB });
  });
  it('no report yet for the order -> report_id absent, rows still written with the event centre', async () => {
    const { w, go } = await setup({ noReport: true }); ok(await go());
    expect(alerts(w)).toHaveLength(3);
    for (const d of alerts(w)) { expect(d['report_id'] ?? null).toBeNull(); expect(d['report_version_no'] ?? null).toBeNull(); expect(d).toMatchObject({ centre_id: I.centre, related_entity_type: 'critical_event', related_entity_id: CE(1) }); }
  });
});

describe('idempotent per recipient (done_when)', () => {
  const snapshot = (w: DW) => JSON.stringify(alerts(w).map((d) => [d['id'], d['idempotency_key'], d['status'], d['version']]).sort());
  it('the same event twice (also a redelivery with another event_id) creates nothing extra: no rows, no send jobs, no status events', async () => {
    const { w, go } = await setup(); ok(await go()); const before = snapshot(w); const jobs = w.sendJobs().length; const evs = w.statusEvents().length;
    ok(await go()); ok(await go(criticalEvent({}, { event_id: idN(0xe902) })));
    expect(alerts(w)).toHaveLength(3); expect(snapshot(w)).toBe(before); expect(w.sendJobs()).toHaveLength(jobs); expect(w.statusEvents()).toHaveLength(evs);
  });
  it('a recipient added between two deliveries of the event gets exactly one new row; existing ones are untouched', async () => {
    const { w, go } = await setup(); ok(await go());
    w.db.store['reporting.staff_assignments']!.push(assign(7, M(7)));
    ok(await go());
    expect(ofKind(w, 'staff').map((r) => r['recipient_id']).sort()).toEqual([M(1), M(2), M(7)].sort()); expect(ofKind(w, 'referrer')).toHaveLength(1);
    ok(await go()); expect(alerts(w)).toHaveLength(4);
  });
  it('two DIFFERENT critical events for the same order alert separately (keys are per event)', async () => {
    const { w, go } = await setup(); ok(await go()); ok(await go(criticalEvent({}, {}, CE(2))));
    expect(alerts(w)).toHaveLength(6); expect(new Set(alerts(w).map((d) => d['idempotency_key'])).size).toBe(6);
    expect(ofKind(w, 'referrer').map((d) => d['params'].ref).sort()).toEqual([CE(1).slice(0, 8), CE(2).slice(0, 8)].sort());
  });
  it('a failing dependency is NOT swallowed (queue retry), leaves no partial rows, and the retry completes the set exactly once', async () => {
    const { w, go, opts } = await setup({ frontdeskDown: true });
    const r1 = await go(); expect(r1).toBeInstanceOf(Error); expect(alerts(w)).toEqual([]);
    opts.frontdeskDown = false; ok(await go()); ok(await go());
    expect(alerts(w)).toHaveLength(3); expect(new Set(alerts(w).map((d) => d['idempotency_key'])).size).toBe(3);
  });
});

describe('trust boundary + PHI', () => {
  it('an event of another tenant than the job\'s tenant is refused and writes nothing (REQ-SEC-024)', async () => {
    const { w, go } = await setup(); const r = await go(criticalEvent({}, { tenant_id: TENANT_B }));
    expect(r).toBeInstanceOf(Error); expect(alerts(w)).toEqual([]); expect(w.db.writes().filter((s) => /\binsert\b/i.test(s.text) && /reporting\.deliveries/i.test(s.text))).toEqual([]);
  });
  it('a malformed payload (no / non-UUID critical_event_id, bad centre) writes nothing', async () => {
    for (const bad of [{ critical_event_id: undefined }, { critical_event_id: 'not-a-uuid' }, { centre_id: 'x' }, { critical_event_id: `${CE(1)}'; DROP TABLE reporting.deliveries;--` }]) {
      const { w, go } = await setup(); await go(criticalEvent(bad as Row)); expect(alerts(w), JSON.stringify(bad)).toEqual([]);
    }
  });
  it('no value / analyte / result / patient identity is copied into delivery rows, events, jobs, audit or logs', async () => {
    const { w, go } = await setup(); ok(await go());
    const rows = JSON.stringify(alerts(w).map((d) => ({ ...d, destination_sha256: undefined })));
    for (const s of [ANALYTE, RESULT, I.patient, 'direction', '"high"', FULL_NAME, PHONE, EMAIL, REFERRER_PHONE]) expect(rows, s).not.toContain(s);
    for (const s of [ANALYTE, RESULT, FULL_NAME, PHONE, EMAIL, REFERRER_PHONE, REG_NO]) expect(w.leakText(), s).not.toContain(s);
  });
  it('the send job payload carries only the delivery id', async () => {
    const { w, go } = await setup(); ok(await go());
    expect(w.sendJobs().length).toBeGreaterThan(0);
    for (const j of w.sendJobs()) expect(Object.keys(j.payload)).toEqual(['delivery_id']);
  });
});

describe('wiring', () => {
  it('the reporting manifest subscribes lab.critical_value.detected.v1 to the consumer', async () => {
    const m: any = await import('../index.js'); const c: any = await import('../consumers/lab.critical_value.detected.v1.js');
    expect(m.manifest.subscriptions['lab.critical_value.detected.v1']).toBe(c.handle);
  });
});
