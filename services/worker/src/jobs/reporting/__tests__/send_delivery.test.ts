// C6-T23 worker task reporting.send_delivery (02-TRD §4.8, §5.4, §9; 01-PRD AC-09.1, AC-09.4, AC-09.5, AC-09.8, AC-08.1; 03-APP-FLOW D3-D7, E25; 07-SECURITY REQ-SEC-070/101/136).
// ASSUMED: tasks/send_delivery.ts exports `createSendDelivery({ env?, transports? })` -> TaskHandler (or `sendDelivery`). Payload { delivery_id } (what delivery.service enqueues; the tenant is
// ctx.tenantId). `env` = { NODE_ENV, LIMS_REPORTING_ALLOW_REAL_PROVIDERS, LIMS_ORIGIN_PORTAL } read at call time (default process.env). `transports` overrides the adapter registry by
// provider kind (02-TRD §5.4 Transport: send(msg, creds), throws TransportError(retryable, failureCode) from delivery/transport.ts); the built-in `recording` adapter
// (delivery/adapters/recording.ts) is used when none is injected for it. The provider is the one of the delivery's channel_accounts row, EXCEPT outside production where every
// delivery goes through `recording` (AC-09.5, REQ-SEC-136): the recorded delivery gets provider_kind 'recording'.
// Flow per run (ctx.tx, system actor): lock + load the delivery (status must be `queued`, else silent no-op) -> re-check channel switch + consent + contact via ports
// (FrontdeskPort.getPatientDemographics purpose 'notification'; IdentityPort.getTenantSettings; CatalogPort.getReferrer; centre_contacts by recipient_id; destination_e164 for
// phone_otp) -> `suppressed` (failure_code channel_disabled | no_consent | no_contact) + attempt `suppressed` (+ immediate SMS fallback for WhatsApp, see check_whatsapp_fallback)
// -> issue the deferred link (portal_links row, revoking the previous unsent link of this delivery with reason `superseded_attempt`) -> render message_template_texts body
// ({placeholders}) -> transport -> delivery_attempts row (attempt_no continues) -> sent (+ fallback check job at sent_at + whatsapp_fallback_minutes for WhatsApp) | failed.
// A retryable failure keeps the attempt row (the task either calls ctx.commitOnError() before it throws, or resolves and re-enqueues itself); the harness rolls a throw back otherwise.
import '../../../../../api/src/__tests__/setup-env.js';
import http from 'node:http';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../../../../../api/src/modules/reporting/domain/tokens.js';
import { eventValidators } from '../../../../../api/src/core/events/publish.js';
import {
  ACC, D, deliveryWorld, dRow, EMAIL, FALLBACK, FULL_NAME, I, idN, LAB, LAB_NAME, linkRow, LINK, makeTransport, minutesAgo, NOW, PHONE, PORTAL_ORIGIN, REG_NO, rendered, SEND, sentRow,
  sha256buf, STATUS_EVENT, SYSTEM_ACTOR, TENANT_A, TENANT_B, tokenIn, transportError, V, type DW, type DWorldOpts, type Row,
} from './delivery.helpers.js';

type Task = (p: any, c: any) => Promise<void>;
async function setup(o: DWorldOpts = {}, taskOpts: { transports?: Record<string, any>; env?: Record<string, string | undefined> } = {}) {
  const w = deliveryWorld({ deliveries: [dRow(1)], ...o });
  const m: any = await import('../tasks/send_delivery.js');
  const task: Task = m.createSendDelivery ? m.createSendDelivery({ env: { ...w.env, ...taskOpts.env }, transports: taskOpts.transports ?? {} }) : m.sendDelivery;
  const go = (id: string = D(1), over: Row = {}) => w.run(task, { delivery_id: id }, over);
  return { w, task, go };
}
const row = (w: DW, id: string = D(1)) => w.delivery(id);
const ok = (r: 'ok' | Error) => expect(r).toBe('ok');
/** True when the run kept the attempt for the queue: threw (and committed the attempt) or resolved after re-enqueueing a send job. */
const retried = (r: 'ok' | Error, w: DW) => r instanceof Error || w.sendJobs().some((j) => j.payload?.delivery_id === D(1));
const fetchSpy = () => vi.fn(async () => { throw new Error('network call must not happen'); });
let netCalls: string[] = [];
beforeEach(() => {
  netCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (u: unknown) => { netCalls.push(`fetch ${String(u)}`); throw new Error('no network'); }));
  vi.spyOn(http, 'request').mockImplementation(((...a: unknown[]) => { netCalls.push(`http ${String(a[0])}`); throw new Error('no network'); }) as any);
  vi.spyOn(https, 'request').mockImplementation(((...a: unknown[]) => { netCalls.push(`https ${String(a[0])}`); throw new Error('no network'); }) as any);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('send path with the recording transport (AC-09.5, AC-08.1)', () => {
  it('queued WhatsApp delivery -> sent: sent_at, provider_kind recording, channel account, provider message id, version bumped; one attempt `accepted`', async () => {
    const { w, go } = await setup(); ok(await go());
    expect(row(w)).toMatchObject({ status: 'sent', sent_at: NOW, provider_kind: 'recording', channel_account_id: ACC.whatsapp, failure_code: null });
    expect(typeof row(w)['provider_message_id']).toBe('string'); expect(row(w)['provider_message_id'].length).toBeGreaterThan(0); expect(row(w)['version']).toBeGreaterThan(1);
    const a = w.attempts(D(1)); expect(a).toHaveLength(1); expect(a[0]).toMatchObject({ attempt_no: 1, outcome: 'accepted', error_code: null }); expect(a[0]!['finished_at']).not.toBeNull();
    expect(netCalls).toEqual([]);
  });
  it('publishes reporting.delivery.status_changed.v1 queued -> sent once, valid against the contract schema', async () => {
    const { w, go } = await setup(); await go(); const ev = w.statusEvents(); expect(ev).toHaveLength(1);
    expect(ev[0]!.input.payload).toMatchObject({ delivery_id: D(1), channel: 'whatsapp', purpose: 'report_ready', recipient_kind: 'patient', from_status: 'queued', to_status: 'sent', report_id: LAB, report_version_no: 1 });
    expect(typeof ev[0]!.input.payload.delivery_created_at).toBe('string');
    expect(eventValidators().get(STATUS_EVENT)!({ event_id: idN(0xe9), event_type: STATUS_EVENT, tenant_id: TENANT_A, occurred_at: NOW, actor: { type: 'system', id: SYSTEM_ACTOR }, idempotency_key: ev[0]!.input.idempotencyKey,
      producer: 'reporting', aggregate: ev[0]!.input.aggregate, request_id: idN(0xf1), payload: ev[0]!.input.payload })).toBe(true);
  });
  it('the message the provider gets: real E.164 from the patient record (system actor), lab name + link only, WhatsApp template data, sender id', async () => {
    const rec = makeTransport('recording'); const { w, go } = await setup({}, { transports: { recording: rec } }); ok(await go());
    expect(rec.calls).toBe(1); const m = rec.sent[0]!.msg;
    expect(m).toMatchObject({ deliveryId: D(1), channel: 'whatsapp', to: PHONE, senderId: 'SYN' });
    expect(m.body).toMatch(new RegExp(`^Report ready from ${LAB_NAME}: ${PORTAL_ORIGIN.replace(/\./g, '\\.')}/r/[A-Za-z0-9_-]{22}$`));
    expect(m.providerTemplate).toMatchObject({ name: 'reporting_report_ready', language: 'en' }); expect(Array.isArray(m.providerTemplate.variables)).toBe(true);
    for (const s of [FULL_NAME, REG_NO, EMAIL, 'Urine', 'result']) expect(JSON.stringify(m), s).not.toContain(s);
    expect(w.portCalls.frontdesk.every((c) => c.actorType === 'system' && c.purpose === 'notification')).toBe(true);
  });
  it('SMS goes to the patient phone; e-mail is link-only (subject + body, NO attachment of any kind) to the address on file', async () => {
    const s = await setup({ deliveries: [dRow(1, { channel: 'sms', deferred_link: { report_id: LAB, version_no: 1, channel: 'sms', recipient_kind: 'patient' } })] }, { transports: { recording: makeTransport('recording') } });
    ok(await s.go()); expect(row(s.w)['channel_account_id']).toBe(ACC.sms);
    const rec = makeTransport('recording');
    const e = await setup({ deliveries: [dRow(1, { channel: 'email', destination_masked: 'p***@example.invalid', deferred_link: { report_id: LAB, version_no: 1, channel: 'email', recipient_kind: 'patient' } })] }, { transports: { recording: rec } });
    ok(await e.go()); const m = rec.sent[0]!.msg;
    expect(m).toMatchObject({ channel: 'email', to: EMAIL, subject: `Your report from ${LAB_NAME}` }); expect(tokenIn(m.body)).toBeTruthy();
    expect(Object.keys(m).filter((k) => /attach|pdf|file|bytes/i.test(k))).toEqual([]);
  });
  it('WhatsApp: a fallback check job is scheduled at sent_at + whatsapp_fallback_minutes (default 30) and deliveries.fallback_check_at is set; SMS / e-mail schedule none', async () => {
    const { w, go } = await setup(); await go(); const jobs = w.db.jobs.filter((j) => j.identifier === FALLBACK);
    expect(jobs).toHaveLength(1); expect(jobs[0]!.payload).toEqual({ delivery_id: D(1) });
    expect(Date.parse(String(jobs[0]!.runAt))).toBe(Date.parse(NOW) + 30 * 60_000); expect(Date.parse(String(row(w)['fallback_check_at']))).toBe(Date.parse(NOW) + 30 * 60_000);
    const s = await setup({ deliveries: [dRow(1, { channel: 'sms', deferred_link: { report_id: LAB, version_no: 1, channel: 'sms', recipient_kind: 'patient' } })] }); await s.go();
    expect(s.w.db.jobs.filter((j) => j.identifier === FALLBACK)).toEqual([]);
  });
  it('the fallback delay follows the setting whatsapp_fallback_minutes', async () => {
    const { w, go } = await setup({ settings: { whatsapp_fallback_minutes: 90 } }); await go();
    expect(Date.parse(String(w.db.jobs.find((j) => j.identifier === FALLBACK)!.runAt))).toBe(Date.parse(NOW) + 90 * 60_000);
  });
  it('BillingPort / PaymentProviderPort / SmartReportPort are never called', async () => { const { w, go } = await setup(); await go(); expect(w.portCalls.forbidden).toEqual([]); });
});

describe('REQ-SEC-136 / AC-09.5: recording only outside production', () => {
  const real = () => makeTransport('whatsapp_cloud_api');
  it('non-production + an account configured for a REAL provider -> the real transport is never called, nothing leaves the stack, the record says `recording`', async () => {
    const r = real(); const { w, go } = await setup({ accounts: { whatsapp: 'whatsapp_cloud_api' } }, { transports: { whatsapp_cloud_api: r } }); ok(await go());
    expect(r.calls).toBe(0); expect(netCalls).toEqual([]); expect(row(w)).toMatchObject({ status: 'sent', provider_kind: 'recording' }); expect(w.attempts(D(1))[0]!['outcome']).toBe('accepted');
  });
  it('...even if the environment claims LIMS_REPORTING_ALLOW_REAL_PROVIDERS=true (defence in depth: boot should have failed)', async () => {
    const r = real(); const { w, go } = await setup({ accounts: { whatsapp: 'whatsapp_cloud_api' } }, { transports: { whatsapp_cloud_api: r }, env: { NODE_ENV: 'development', LIMS_REPORTING_ALLOW_REAL_PROVIDERS: 'true' } });
    await go(); expect(r.calls).toBe(0); expect(netCalls).toEqual([]); expect(row(w)['provider_kind']).toBe('recording');
  });
  it.each(['sms_sparrow', 'sms_aakash', 'email_smtp_relay'])('non-production: provider %s is not contacted either', async (kind) => {
    const ch = kind === 'email_smtp_relay' ? 'email' : 'sms'; const r = makeTransport(kind);
    const { w, go } = await setup({ accounts: { [ch]: kind }, deliveries: [dRow(1, { channel: ch, deferred_link: { report_id: LAB, version_no: 1, channel: ch, recipient_kind: 'patient' } })] }, { transports: { [kind]: r } });
    await go(); expect(r.calls).toBe(0); expect(netCalls).toEqual([]); expect(row(w)['provider_kind']).toBe('recording');
  });
  it('production: a `recording` account is not a valid provider -> nothing is sent through it (the delivery does not become `sent`)', async () => {
    const rec = makeTransport('recording'); const { w, go } = await setup({}, { transports: { recording: rec }, env: { NODE_ENV: 'production', LIMS_REPORTING_ALLOW_REAL_PROVIDERS: 'true' } });
    await go(); expect(rec.calls).toBe(0); expect(row(w)['status']).not.toBe('sent'); expect(w.attempts(D(1)).some((a) => a['outcome'] === 'accepted')).toBe(false);
  });
  it('production without LIMS_REPORTING_ALLOW_REAL_PROVIDERS: the real provider is not called either', async () => {
    const r = real(); const { w, go } = await setup({ accounts: { whatsapp: 'whatsapp_cloud_api' } }, { transports: { whatsapp_cloud_api: r }, env: { NODE_ENV: 'production', LIMS_REPORTING_ALLOW_REAL_PROVIDERS: 'false' } });
    await go(); expect(r.calls).toBe(0); expect(row(w)['status']).not.toBe('sent');
  });
});

describe('deferred link (02-TRD §4.8, 05-SCHEMA §2.8, 03-IC issuePortalLink)', () => {
  it('issued at send time: channel-bound row for this delivery, token hash = sha256 of the token in the message, ttl = reportLinkTtlDays, destination hash of the contact', async () => {
    const rec = makeTransport('recording'); const { w, go } = await setup({}, { transports: { recording: rec } }); ok(await go());
    const links = w.linksOf(D(1)); expect(links).toHaveLength(1); const l = links[0]!; const token = tokenIn(rec.sent[0]!.msg.body)!;
    expect(l).toMatchObject({ tenant_id: TENANT_A, report_id: LAB, bound_version_no: 1, channel: 'whatsapp', recipient_kind: 'patient', purpose: 'report', delivery_id: D(1), revoked_at: null });
    expect(Buffer.from(l['token_sha256']).equals(Buffer.from(hashToken(token)))).toBe(true); expect(l['patient_display_snapshot'].length).toBeLessThanOrEqual(60);
    expect(Math.abs(Date.parse(String(l['expires_at'])) - (Date.parse(NOW) + 30 * 86_400_000))).toBeLessThan(120_000);
    expect(Buffer.from(l['destination_sha256']).equals(sha256buf(PHONE))).toBe(true); expect(row(w)['link_id']).toBe(l['id']);
  });
  it('the plaintext URL / token is never stored: not in the delivery row, params, links, attempts, events, jobs, logs', async () => {
    const rec = makeTransport('recording'); const { w, go } = await setup({}, { transports: { recording: rec } }); await go(); const token = tokenIn(rec.sent[0]!.msg.body)!;
    expect(w.everything()).not.toContain(token); expect(w.everything()).not.toContain('/r/'); expect(row(w)['params']).toEqual({ lab_name: LAB_NAME });
  });
  it('every delivery gets its OWN link: two deliveries -> two distinct tokens / rows', async () => {
    const rec = makeTransport('recording');
    const { w, task } = await setup({ deliveries: [dRow(1), dRow(2, { idempotency_key: 'k2' })] }, { transports: { recording: rec } });
    await w.run(task, { delivery_id: D(1) }); await w.run(task, { delivery_id: D(2) });
    const t = rec.sent.map((s) => tokenIn(s.msg.body)); expect(new Set(t).size).toBe(2); expect(w.portalLinks()).toHaveLength(2);
  });
  it('a retry issues a FRESH link and revokes the previous unsent one (reason superseded_attempt); one live link remains', async () => {
    const rec = makeTransport('recording');
    const { w, go } = await setup({ deliveries: [dRow(1, { link_id: LINK(1), attempt_no: 2 })], links: [linkRow(1, { delivery_id: D(1) })],
      attempts: [{ id: idN(0xa1), tenant_id: TENANT_A, delivery_id: D(1), attempt_no: 1, started_at: minutesAgo(3), finished_at: minutesAgo(3), outcome: 'retryable_error', error_code: 'provider_timeout', created_by: SYSTEM_ACTOR }] }, { transports: { recording: rec } });
    ok(await go()); const links = w.linksOf(D(1)); const old = links.find((l) => l['id'] === LINK(1))!; const live = links.filter((l) => l['revoked_at'] == null);
    expect(old['revoked_at']).not.toBeNull(); expect(old['revoke_reason_code']).toBe('superseded_attempt'); expect(live).toHaveLength(1); expect(live[0]!['id']).not.toBe(LINK(1));
    expect(row(w)['link_id']).toBe(live[0]!['id']); expect(Buffer.from(live[0]!['token_sha256']).equals(Buffer.from(hashToken(tokenIn(rec.sent[0]!.msg.body)!)))).toBe(true);
    expect(w.attempts(D(1)).map((a) => a['attempt_no'])).toEqual([1, 2]);
  });
  it('dues reminder (08 A21.1): deferred_link.purpose `dues` -> a dues link (purpose dues) bound to the HELD version, even though no version is released yet', async () => {
    const rec = makeTransport('recording');
    const { w, go } = await setup({ versions: [rendered(1)], deliveries: [dRow(1, { channel: 'sms', purpose: 'dues_reminder', template_code: 'reporting.dues_due', params: { lab_name: LAB_NAME, amount_text: 'NPR 500.00' },
      deferred_link: { report_id: LAB, version_no: 1, channel: 'sms', recipient_kind: 'patient', purpose: 'dues' } })] }, { transports: { recording: rec } });
    ok(await go()); const l = w.linksOf(D(1))[0]!; expect(l).toMatchObject({ purpose: 'dues', bound_version_no: 1, channel: 'sms', recipient_kind: 'patient' });
    expect(rec.sent[0]!.msg.body).toMatch(/^Synthetic Lab: NPR due NPR 500\.00\. Pay: https:\/\/portal\.example\.invalid\/r\/[A-Za-z0-9_-]{22}$/);
  });
  it('a delivery without a deferred link (print / external template) gets no portal link', async () => {
    const { w, go } = await setup({ deliveries: [dRow(1, { channel: 'sms', purpose: 'otp', template_code: 'reporting.portal_otp', deferred_link: null, report_id: null, report_version_no: null, related_entity_type: null, related_entity_id: null,
      params: { otp_code: '654321', lab_name: LAB_NAME, minutes: '10' } })] }); ok(await go()); expect(w.portalLinks()).toEqual([]); expect(row(w)['status']).toBe('sent');
  });
});

describe('consent / channel re-check at send time (AC-09.4, AC-09.8, REQ-ARCH-085, review fix #19)', () => {
  it('AC-09.4: WhatsApp consent withdrawn after queueing -> `suppressed` / no_consent; nothing sent, no link, attempt `suppressed`, event queued -> suppressed', async () => {
    const rec = makeTransport('recording'); const { w, go } = await setup({ consent: { whatsapp: false } }, { transports: { recording: rec } }); ok(await go());
    expect(rec.calls).toBe(0); expect(row(w)).toMatchObject({ status: 'suppressed', failure_code: 'no_consent', sent_at: null }); expect(row(w)['suppressed_at']).not.toBeNull();
    expect(w.attempts(D(1))).toHaveLength(1); expect(w.attempts(D(1))[0]!['outcome']).toBe('suppressed'); expect(w.portalLinks()).toEqual([]);
    const ev = w.statusEvents().find((e) => e.input.payload.delivery_id === D(1))!; expect(ev.input.payload).toMatchObject({ from_status: 'queued', to_status: 'suppressed', failure_code: 'no_consent' });
    expect(w.db.jobs.filter((j) => j.identifier === FALLBACK)).toEqual([]);
  });
  it('AC-09.8 (E25): tenant WhatsApp channel switched off -> `suppressed` / channel_disabled AND ONE SMS fallback is created at once (fallback_of_delivery_id, queued, own send job + event)', async () => {
    const { w, go } = await setup({ channels: { whatsappEnabled: false } }); ok(await go());
    expect(row(w)).toMatchObject({ status: 'suppressed', failure_code: 'channel_disabled' }); const fb = w.fallbacksOf(D(1)); expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ channel: 'sms', status: 'queued', fallback_of_delivery_id: D(1), purpose: 'report_ready', template_code: 'reporting.report_ready', recipient_kind: 'patient', recipient_id: I.patient,
      report_id: LAB, report_version_no: 1, params: { lab_name: LAB_NAME }, link_id: null });
    expect(fb[0]!['deferred_link']).toEqual({ report_id: LAB, version_no: 1, channel: 'sms', recipient_kind: 'patient' }); expect(fb[0]!['id']).not.toBe(D(1)); expect(fb[0]!['idempotency_key']).not.toBe(row(w)['idempotency_key']);
    expect(w.sendJobs().filter((j) => j.payload?.delivery_id === fb[0]!['id'] && j.jobKey === fb[0]!['id'])).toHaveLength(1);
    const ev = w.statusEvents().filter((e) => e.input.payload.delivery_id === fb[0]!['id']); expect(ev).toHaveLength(1); expect(ev[0]!.input.payload).toMatchObject({ channel: 'sms', to_status: 'queued' }); expect(ev[0]!.input.payload.from_status).toBeUndefined();
  });
  it('AC-09.8: WhatsApp consent withdrawn (no_consent) also falls back to SMS at once', async () => {
    const { w, go } = await setup({ consent: { whatsapp: false, sms: true } }); await go(); expect(row(w)['failure_code']).toBe('no_consent'); expect(w.fallbacksOf(D(1))).toHaveLength(1);
  });
  it.each([
    ['SMS channel disabled', { channels: { whatsappEnabled: false, smsEnabled: false } }],
    ['no SMS consent', { consent: { whatsapp: false, sms: false } }],
    ['no phone on file at all', { phone: null }],
  ] as Array<[string, DWorldOpts]>)('no fallback when %s (SMS must be enabled AND consented)', async (_n, extra) => {
    const { w, go } = await setup(extra); ok(await go()); expect(row(w)['status']).toBe('suppressed'); expect(w.fallbacksOf(D(1))).toEqual([]); expect(w.sendJobs().filter((j) => j.payload?.delivery_id !== D(1))).toEqual([]);
  });
  it('only a WhatsApp suppression falls back: SMS and e-mail deliveries that are suppressed stay suppressed', async () => {
    for (const ch of ['sms', 'email'] as const) {
      const { w, go } = await setup({ consent: { sms: false, email: false }, deliveries: [dRow(1, { channel: ch, deferred_link: { report_id: LAB, version_no: 1, channel: ch, recipient_kind: 'patient' } })] });
      await go(); expect(row(w), ch).toMatchObject({ status: 'suppressed', failure_code: 'no_consent' }); expect(w.fallbacksOf(D(1))).toEqual([]);
    }
  });
  it('no contact any more (phone removed) -> suppressed / no_contact, no fallback to a phone that does not exist', async () => {
    const { w, go } = await setup({ phone: null }); await go(); expect(row(w)).toMatchObject({ status: 'suppressed', failure_code: 'no_contact' }); expect(w.fallbacksOf(D(1))).toEqual([]);
  });
  it('a fallback that already exists (unique index: one per delivery) is not duplicated and does not make the task fail', async () => {
    const { w, go } = await setup({ channels: { whatsappEnabled: false }, deliveries: [dRow(1), dRow(2, { channel: 'sms', idempotency_key: 'fb-existing', fallback_of_delivery_id: D(1), deferred_link: { report_id: LAB, version_no: 1, channel: 'sms', recipient_kind: 'patient' } })] });
    ok(await go()); expect(row(w)['status']).toBe('suppressed'); expect(w.fallbacksOf(D(1))).toHaveLength(1); expect(w.fallbacksOf(D(1))[0]!['id']).toBe(D(2));
  });
  it('the OTP exception: SMS consent OR WhatsApp consent is enough for an SMS OTP; a phone_otp recipient needs no consent and is sent to destination_e164', async () => {
    const otp = (over: Row = {}) => dRow(1, { channel: 'sms', purpose: 'otp', template_code: 'reporting.portal_otp', deferred_link: null, report_id: null, report_version_no: null, related_entity_type: null, related_entity_id: null,
      params: { otp_code: '654321', lab_name: LAB_NAME, minutes: '10' }, ...over });
    const a = makeTransport('recording'); const s = await setup({ consent: { sms: false, whatsapp: true }, deliveries: [otp()] }, { transports: { recording: a } }); ok(await s.go());
    expect(row(s.w)['status']).toBe('sent'); expect(a.sent[0]!.msg).toMatchObject({ to: PHONE, body: 'Your code 654321 for Synthetic Lab is valid 10 minutes.' });
    const b = makeTransport('recording'); const t = await setup({ consent: { sms: false, whatsapp: false }, deliveries: [otp({ recipient_kind: 'phone_otp', recipient_id: null, destination_e164: '+9779811111111', destination_sha256: sha256buf('+9779811111111'), centre_id: null })] }, { transports: { recording: b } });
    ok(await t.go()); expect(b.sent[0]!.msg.to).toBe('+9779811111111'); expect(t.w.portCalls.frontdesk).toEqual([]);
  });
});

describe('retryable errors, attempts and exhaustion (AC-09.1, 02-TRD §5.4 failure mapping, 03-APP-FLOW D4/D7)', () => {
  it('AC-09.1: a retryable error is logged as an attempt and kept for the queue; the delivery stays `queued`; the next run is attempt 2; success on attempt 3 -> sent with a 3-row log', async () => {
    const err = await transportError(true, 'provider_timeout'); const rec = makeTransport('recording', (n) => (n < 3 ? err : 'ok'));
    const { w, go } = await setup({}, { transports: { recording: rec } });
    const r1 = await go(); expect(retried(r1, w)).toBe(true); expect(row(w)['status']).toBe('queued'); expect(w.attempts(D(1))).toHaveLength(1);
    expect(w.attempts(D(1))[0]).toMatchObject({ attempt_no: 1, outcome: 'retryable_error', error_code: 'provider_timeout' }); expect(w.attempts(D(1))[0]!['finished_at']).not.toBeNull();
    const r2 = await go(D(1), { attempt: 2 }); expect(retried(r2, w)).toBe(true); expect(w.attempts(D(1)).map((a) => a['attempt_no'])).toEqual([1, 2]);
    ok(await go(D(1), { attempt: 3 })); expect(row(w)['status']).toBe('sent'); expect(w.attempts(D(1)).map((a) => `${a['attempt_no']}:${a['outcome']}`)).toEqual(['1:retryable_error', '2:retryable_error', '3:accepted']);
    expect(rec.calls).toBe(3);
  });
  it('a retryable failure does not mark the delivery failed, does not set failed_at, and publishes no status event', async () => {
    const err = await transportError(true, 'provider_unavailable'); const { w, go } = await setup({}, { transports: { recording: makeTransport('recording', () => err) } });
    await go(); expect(row(w)).toMatchObject({ status: 'queued', failed_at: null, failure_code: null }); expect(w.statusEvents()).toEqual([]);
  });
  it('max 8 attempts: seven retryable runs keep it queued; the 8th retryable failure ends it `failed` (failed_at, failure_code, event queued -> failed) with 8 logged attempts', async () => {
    const err = await transportError(true, 'provider_timeout'); const rec = makeTransport('recording', () => err);
    const { w, go } = await setup({}, { transports: { recording: rec } });
    for (let n = 1; n <= 7; n++) { await go(D(1), { attempt: n }); expect(row(w)['status'], `after attempt ${n}`).toBe('queued'); }
    await go(D(1), { attempt: 8 });
    expect(row(w)['status']).toBe('failed'); expect(row(w)['failed_at']).not.toBeNull(); expect(typeof row(w)['failure_code']).toBe('string'); expect(w.attempts(D(1))).toHaveLength(8);
    expect(w.attempts(D(1)).every((a) => a['outcome'] === 'retryable_error')).toBe(true);
    expect(w.statusEvents().find((e) => e.input.payload.delivery_id === D(1))!.input.payload).toMatchObject({ from_status: 'queued', to_status: 'failed' });
  });
  it('REQ-ARCH-085: a WhatsApp delivery that fails for good creates the SMS fallback (D7)', async () => {
    const err = await transportError(true, 'provider_timeout'); const { w, go } = await setup({}, { transports: { recording: makeTransport('recording', () => err) } });
    await go(D(1), { attempt: 8 }); expect(row(w)['status']).toBe('failed'); const fb = w.fallbacksOf(D(1)); expect(fb).toHaveLength(1); expect(fb[0]).toMatchObject({ channel: 'sms', status: 'queued' });
  });
  it('a non-retryable error (invalid number) -> failed at once with the adapter\'s failure code, ONE permanent_error attempt, no queue retry, SMS fallback for WhatsApp', async () => {
    const err = await transportError(false, 'invalid_destination'); const rec = makeTransport('recording', () => err); const { w, go } = await setup({}, { transports: { recording: rec } });
    ok(await go()); expect(row(w)).toMatchObject({ status: 'failed', failure_code: 'invalid_destination' }); expect(row(w)['failed_at']).not.toBeNull();
    expect(w.attempts(D(1))).toHaveLength(1); expect(w.attempts(D(1))[0]).toMatchObject({ outcome: 'permanent_error', error_code: 'invalid_destination' }); expect(rec.calls).toBe(1);
    expect(w.fallbacksOf(D(1))).toHaveLength(1);
  });
  it('a failed SMS delivery has no fallback; an unexpected (non-Transport) error is treated as retryable, never as a silent success', async () => {
    const err = await transportError(false, 'provider_rejected');
    const a = await setup({ deliveries: [dRow(1, { channel: 'sms', deferred_link: { report_id: LAB, version_no: 1, channel: 'sms', recipient_kind: 'patient' } })] }, { transports: { recording: makeTransport('recording', () => err) } });
    await a.go(); expect(row(a.w)['status']).toBe('failed'); expect(a.w.fallbacksOf(D(1))).toEqual([]);
    const b = await setup({}, { transports: { recording: makeTransport('recording', () => new TypeError('boom')) } }); const r = await b.go();
    expect(row(b.w)['status']).not.toBe('sent'); expect(row(b.w)['status']).not.toBe('delivered'); expect(retried(r, b.w) || row(b.w)['status'] === 'queued').toBe(true);
  });
  it('terminal status scrubs the secrets: params.otp_code / url removed and destination_e164 nulled on `failed`', async () => {
    const err = await transportError(false, 'invalid_destination');
    const { w, go } = await setup({ deliveries: [dRow(1, { channel: 'sms', purpose: 'otp', template_code: 'reporting.portal_otp', recipient_kind: 'phone_otp', recipient_id: null, centre_id: null, destination_e164: '+9779811111111', destination_sha256: sha256buf('+9779811111111'),
      deferred_link: null, report_id: null, report_version_no: null, related_entity_type: null, related_entity_id: null, params: { otp_code: '654321', lab_name: LAB_NAME, minutes: '10' } })] }, { transports: { recording: makeTransport('recording', () => err) } });
    await go(); expect(row(w)['status']).toBe('failed'); expect(row(w)['params']).toEqual({ lab_name: LAB_NAME, minutes: '10' }); expect(row(w)['destination_e164']).toBeNull();
  });
  it('attempt numbering continues after earlier attempts (the log is append-only and never rewritten)', async () => {
    const rec = makeTransport('recording');
    const { w, go } = await setup({ attempts: [1, 2].map((n) => ({ id: idN(0xa0 + n), tenant_id: TENANT_A, delivery_id: D(1), attempt_no: n, started_at: minutesAgo(10 - n), finished_at: minutesAgo(10 - n), outcome: 'retryable_error', error_code: 'provider_timeout', created_by: SYSTEM_ACTOR })) }, { transports: { recording: rec } });
    ok(await go()); expect(w.attempts(D(1)).map((a) => a['attempt_no'])).toEqual([1, 2, 3]); expect(w.attempts(D(1))[2]!['outcome']).toBe('accepted');
  });
  it('circuit breaker (02-TRD §5.4): after 10 consecutive failures on a channel account the next send is NOT attempted (attempt `circuit_open`), and it closes again after 60 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW));
    const err = await transportError(true, 'provider_unavailable'); const rec = makeTransport('recording', () => err);
    const ds = Array.from({ length: 12 }, (_, i) => dRow(i + 1, { idempotency_key: `cb-${i}` }));
    const { w, task } = await setup({ deliveries: ds }, { transports: { recording: rec } });
    for (let i = 1; i <= 10; i++) await w.run(task, { delivery_id: D(i) }); expect(rec.calls).toBe(10);
    const r11 = await w.run(task, { delivery_id: D(11) }); expect(rec.calls).toBe(10); expect(w.attempts(D(11))[0]!['outcome']).toBe('circuit_open'); expect(w.delivery(D(11))['status']).toBe('queued'); expect(retried(r11, w) || r11 === 'ok').toBe(true);
    w.clock.t = new Date(Date.parse(NOW) + 61_000).toISOString(); vi.setSystemTime(new Date(w.clock.t));
    await w.run(task, { delivery_id: D(12) }); expect(rec.calls).toBe(11);
  });
});

describe('guards: state, scope, concurrency, PHI', () => {
  it.each(['sent', 'delivered', 'read', 'failed', 'suppressed'])('a delivery that is already `%s` is a silent no-op: no transport call, no attempt, no event, no link', async (st) => {
    const rec = makeTransport('recording'); const { w, go } = await setup({ deliveries: [dRow(1, { status: st, sent_at: st === 'suppressed' ? null : minutesAgo(2), failure_code: st === 'suppressed' || st === 'failed' ? 'no_consent' : null })] }, { transports: { recording: rec } });
    ok(await go()); expect(rec.calls).toBe(0); expect(w.attempts()).toEqual([]); expect(w.statusEvents()).toEqual([]); expect(w.portalLinks()).toEqual([]); expect(row(w)['status']).toBe(st);
  });
  it('unknown delivery, malformed id, another tenant\'s delivery (RLS off: the statements name tenant_id) -> silent no-op', async () => {
    const rec = makeTransport('recording'); const { w, task } = await setup({ rls: false, deliveries: [dRow(1, { tenant_id: TENANT_B })] }, { transports: { recording: rec } });
    expect(await w.run(task, { delivery_id: D(1) })).toBe('ok'); expect(await w.run(task, { delivery_id: idN(0xdead) })).toBe('ok'); expect(await w.run(task, { delivery_id: 'x' })).toBe('ok'); expect(await w.run(task, {})).toBe('ok');
    expect(rec.calls).toBe(0); expect(w.delivery(D(1))['status']).toBe('queued');
  });
  it('N + 1 parallel runs for one delivery send exactly once (claim by row lock / guarded UPDATE / unique attempt_no)', async () => {
    const rec = makeTransport('recording'); const { w, task } = await setup({}, { transports: { recording: rec } });
    await Promise.allSettled([1, 2, 3].map(() => task({ delivery_id: D(1) }, w.ctx()))); expect(rec.calls).toBe(1); expect(row(w)['status']).toBe('sent'); expect(w.attempts(D(1)).filter((a) => a['outcome'] === 'accepted')).toHaveLength(1);
  });
  it('a transient port failure (Frontdesk down) is a queue retry: nothing is sent, the delivery is NOT suppressed or failed', async () => {
    const rec = makeTransport('recording'); const { w, go } = await setup({ frontdeskDown: true }, { transports: { recording: rec } }); const r = await go();
    expect(rec.calls).toBe(0); expect(row(w)['status']).toBe('queued'); expect(r === 'ok' ? w.sendJobs().length > 0 : true).toBe(true);
  });
  it('the referrer is resolved through CatalogPort as the system actor; the centre contact comes from centre_contacts by recipient_id', async () => {
    const rec = makeTransport('recording');
    const r = await setup({ deliveries: [dRow(1, { channel: 'sms', recipient_kind: 'referrer', recipient_id: I.referrer, deferred_link: { report_id: LAB, version_no: 1, channel: 'sms', recipient_kind: 'referrer' } })] }, { transports: { recording: rec } });
    ok(await r.go()); expect(rec.sent[0]!.msg.to).toBe('+9779800000077'); expect(r.w.portCalls.catalog[0]).toMatchObject({ referrerId: I.referrer, purpose: 'notification', actorType: 'system' });
    const rec2 = makeTransport('recording');
    const c = await setup({ settings: { centre_delivery_enabled: true }, centreContacts: [{ id: idN(0xcc01), tenant_id: TENANT_A, channel: 'sms', address: '+9779800000088', is_active: true }],
      deliveries: [dRow(1, { channel: 'sms', recipient_kind: 'centre', recipient_id: idN(0xcc01), deferred_link: { report_id: LAB, version_no: 1, channel: 'sms', recipient_kind: 'centre' } })] }, { transports: { recording: rec2 } });
    ok(await c.go()); expect(rec2.sent[0]!.msg.to).toBe('+9779800000088'); expect(c.w.linksOf(D(1))[0]).toMatchObject({ recipient_kind: 'centre' });
  });
  it('REQ-SEC-070 / 07-SECURITY 9: no phone, e-mail, name, registration number, message body or link reaches logs, events, jobs or the access log', async () => {
    const rec = makeTransport('recording'); const { w, go } = await setup({ consent: { email: true } }, { transports: { recording: rec } }); await go();
    const text = w.leakText(); for (const s of [PHONE, EMAIL, FULL_NAME, REG_NO, rec.sent[0]!.msg.body, tokenIn(rec.sent[0]!.msg.body)!, '/r/']) expect(text, s).not.toContain(s);
  });
  it('the OTP code reaches the provider but never logs / events / jobs', async () => {
    const rec = makeTransport('recording');
    const { w, go } = await setup({ deliveries: [dRow(1, { channel: 'sms', purpose: 'otp', template_code: 'reporting.portal_otp', deferred_link: null, report_id: null, report_version_no: null, related_entity_type: null, related_entity_id: null, params: { otp_code: '654321', lab_name: LAB_NAME, minutes: '10' } })] }, { transports: { recording: rec } });
    await go(); expect(rec.sent[0]!.msg.body).toContain('654321'); expect(w.leakText()).not.toContain('654321');
  });
});

describe('worker manifest wiring', () => {
  it('registers reporting.send_delivery and reporting.check_whatsapp_fallback with maxAttempts 8 (02-TRD §9)', async () => {
    const { manifest } = await import('../index.js');
    for (const id of [SEND, FALLBACK]) { expect(typeof manifest.tasks![id], id).toBe('function'); expect(manifest.maxAttempts![id], id).toBe(8); }
  });
  it('the registered send task works end to end on the world (recording transport by default outside production)', async () => {
    const { manifest } = await import('../index.js'); const w = deliveryWorld({ deliveries: [dRow(1)] });
    expect(await w.run(manifest.tasks![SEND]! as Task, { delivery_id: D(1) })).toBe('ok'); expect(w.delivery(D(1))['status']).toBe('sent'); expect(netCalls).toEqual([]);
  });
});
void fetchSpy; void LINK; void rendered; void sentRow; void TENANT_B;
