// C6-T23 — D1 listDeliveries, D2 getDelivery, D3 sendReportDelivery, D4 retryDelivery (02-TRD §6.3 + DTO §6.1; 01-PRD AC-09.6, AC-09.7; 03-APP-FLOW D1/D8; 07-SECURITY REQ-SEC-024/070/081).
// ASSUMED: handlers/delivery.handlers.ts exports the four operations wired into the module manifest (index.ts); handler ctx = { tenantId, actor:{type:'user',id,membershipId}, tx, ports, events,
// audit, now(), requestId, log } like R6/R8; request = { params, query, headers (lower-case: if-match, idempotency-key), body }; response { status, headers?, body }. Schema / permission /
// Idempotency-Key are enforced by the core pipeline, so the handler is tested directly, including input the pipeline would already have rejected (it never trusts it).
// DB = the worker delivery fake (delivery.helpers.ts: DDL rules enforced; ORDER BY / LIMIT applied). SQL only through repository/ (repository.static.test.ts).
// D1: tenant-scoped, newest first (-created_at, id as tie-break), keyset cursor `page.next_cursor` (opaque), default limit 50, 1..200, filters status/channel/purpose/recipient_kind/report_id/
//     created_at_from/to; rows = Delivery DTO WITHOUT attempts; no nulls (absent instead). D2: Delivery + attempts[{attempt_no, started_at, finished_at?, outcome, error_code?}], header etag "<row version>".
// D3: 201 Delivery (queued or suppressed); new delivery purpose report_ready / template reporting.report_ready / params {lab_name} / deferred_link {report_id, version_no: released, channel, recipient_kind}; one
//     send job + one status event; `reporting.report_not_released`, `reporting.channel_not_configured` (no active channel_accounts row for the channel), centre_contact_id iff recipient_kind centre.
// D4: If-Match = delivery.version; status must be `failed` (else common.immutable_record); 201 NEW delivery (same channel / purpose / template / recipient / report / version / params / deferred_link,
//     NOT fallback_of), the failed original untouched, the original's unrevoked link revoked (the new delivery gets its fresh link when the send task runs).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import {
  ACC, CENTRE_PHONE, CONTACT, D, deliveryWorld, dRow, EMAIL, FULL_NAME, I, idN, LAB, LAB_NAME, LINK, linkRow, minutesAgo, NOW, PHONE, rendered, REG_NO, rejection, sentRow, sha256hex, TENANT_A, TENANT_B, USER,
  MEMBERSHIP, V, type DW, type DWorldOpts, type Row,
} from '../../../../../worker/src/jobs/reporting/__tests__/delivery.helpers.js';
import * as sendMod from '../../../../../worker/src/jobs/reporting/tasks/send_delivery.js';

let manifest: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t23-')), 'otp.key'); writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev'; delete process.env.NODE_ENV; delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
});
const OPS = { list: 'listDeliveries', get: 'getDelivery', send: 'sendReportDelivery', retry: 'retryDelivery' } as const;
const DTO = ['id', 'channel', 'purpose', 'recipient_kind', 'status', 'attempt_no', 'destination_masked', 'template_code', 'report_id', 'report_version_no', 'fallback_of_delivery_id', 'failure_code',
  'queued_at', 'sent_at', 'delivered_at', 'read_at', 'failed_at', 'attempts'];
const ATT = ['attempt_no', 'started_at', 'finished_at', 'outcome', 'error_code'];

function setup(o: DWorldOpts = {}) {
  const w = deliveryWorld(o);
  const ctx = (over: Row = {}) => w.userCtx({ tx: w.tx, ports: w.ports, operationId: 'x', requestId: idN(0xf100 + Math.floor(Math.random() * 0xfff)), ...over });
  const call = (op: string, req: { params?: Row; query?: Row; headers?: Row; body?: unknown } = {}, over: Row = {}) =>
    manifest.handlers[op]({ params: {}, query: {}, headers: {}, body: undefined, ...req }, ctx({ operationId: op, ...over }));
  return { w, ctx, call };
}
const failedRow = (n = 1, over: Row = {}) => dRow(n, { status: 'failed', failure_code: 'provider_rejected', failed_at: minutesAgo(5), sent_at: null, version: 3, link_id: LINK(n), ...over });
const code = async (p: Promise<unknown>) => (await rejection(p))?.code;
const noNulls = (x: unknown): boolean => x === null ? false : Array.isArray(x) ? x.every(noNulls) : typeof x === 'object' ? Object.values(x as object).every(noNulls) : true;

describe('contract and fail-closed', () => {
  it('D1-D4 exist with the documented permission / idempotency / If-Match', () => {
    const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml')); const op = (p: string, m: string) => spec.paths[p][m];
    expect(op('/v1/reporting/deliveries', 'get')).toMatchObject({ operationId: OPS.list, 'x-permission': 'reporting.delivery.read' });
    expect(op('/v1/reporting/deliveries/{delivery_id}', 'get')).toMatchObject({ operationId: OPS.get, 'x-permission': 'reporting.delivery.read' });
    expect(op('/v1/reporting/reports/{report_id}/deliveries', 'post')).toMatchObject({ operationId: OPS.send, 'x-permission': 'reporting.delivery.resend', 'x-idempotency': 'required' });
    const r = op('/v1/reporting/deliveries/{delivery_id}/retry', 'post'); expect(r).toMatchObject({ operationId: OPS.retry, 'x-permission': 'reporting.delivery.resend', 'x-idempotency': 'required' });
    expect(JSON.stringify(r.parameters)).toContain('IfMatch');
  });
  it.each(Object.values(OPS))('%s is no longer a 501 stub: without a request context it fails closed (auth.unauthenticated) and echoes no input', async (op) => {
    const planted = 'PLANTED-TOKEN-7d2e';
    const e = await rejection(manifest.handlers[op]({ params: { delivery_id: planted, report_id: planted }, query: { status: planted }, headers: { 'if-match': '"1"', authorization: planted }, body: undefined }, { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.details })).not.toContain(planted);
  });
});

describe('D1 listDeliveries', () => {
  const rows = () => [
    dRow(1, { created_at: '2026-11-07T10:00:00.000Z', status: 'sent', sent_at: '2026-11-07T10:01:00.000Z' }),
    dRow(2, { created_at: '2026-11-07T11:00:00.000Z', channel: 'sms', status: 'failed', failure_code: 'provider_rejected', failed_at: '2026-11-07T11:02:00.000Z' }),
    dRow(3, { created_at: '2026-11-07T11:00:00.000Z', channel: 'email', purpose: 'otp', template_code: 'reporting.portal_otp', recipient_kind: 'phone_otp', report_id: null, report_version_no: null }),
    dRow(4, { created_at: '2026-11-07T09:00:00.000Z', recipient_kind: 'referrer', report_id: idN(0xa102) }),
    dRow(5, { tenant_id: TENANT_B, created_at: '2026-11-07T12:00:00.000Z' }),
  ];
  it('own tenant only (RLS off: the statement names tenant_id), newest first, equal created_at ordered by id descending', async () => {
    const { call } = setup({ rls: false, deliveries: rows() }); const r = await call(OPS.list);
    expect(r.status).toBe(200); expect(r.body.data.map((d: Row) => d.id)).toEqual([D(3), D(2), D(1), D(4)]);
  });
  it('rows are the Delivery DTO: allow-listed keys only, no attempts, no nulls; never params / contact hash / e164 / key / deferred link / tenant / actor columns', async () => {
    const { call } = setup({ deliveries: rows().filter((r) => r['tenant_id'] === TENANT_A).map((r) => ({ ...r, params: { lab_name: LAB_NAME, url: 'https://portal.example.invalid/r/PLANTEDTOKEN0000000000', otp_code: '654321' }, destination_e164: null })) });
    const r = await call(OPS.list); expect(noNulls(r.body)).toBe(true);
    for (const d of r.body.data) { expect(Object.keys(d).filter((k) => !DTO.includes(k))).toEqual([]); expect(d.attempts).toBeUndefined(); expect(d).toMatchObject({ id: expect.any(String), status: expect.any(String), attempt_no: 1 }); }
    const text = JSON.stringify(r.body); for (const s of ['PLANTEDTOKEN', '654321', PHONE, EMAIL, sha256hex(PHONE), 'idempotency', 'deferred', 'tenant_id', 'created_by']) expect(text, s).not.toContain(s);
    const first = r.body.data.find((d: Row) => d.id === D(1)); expect(first.destination_masked).toBe('+97798•••••042');
  });
  it.each([
    [{ status: 'failed' }, [D(2)]], [{ channel: 'email' }, [D(3)]], [{ purpose: 'otp' }, [D(3)]], [{ recipient_kind: 'referrer' }, [D(4)]], [{ report_id: idN(0xa102) }, [D(4)]],
    [{ created_at_from: '2026-11-07T10:00:00.000Z' }, [D(3), D(2), D(1)]], [{ created_at_to: '2026-11-07T10:00:00.000Z' }, [D(1), D(4)]],
    [{ created_at_from: '2026-11-07T10:00:00.000Z', created_at_to: '2026-11-07T10:59:59.000Z', status: 'sent' }, [D(1)]], [{ sort: '-created_at' }, [D(3), D(2), D(1), D(4)]],
  ] as Array<[Row, string[]]>)('filter %j', async (query, ids) => {
    const { call } = setup({ rls: false, deliveries: rows() }); const r = await call(OPS.list, { query }); expect(r.body.data.map((d: Row) => d.id)).toEqual(ids);
  });
  it('keyset pagination (limit 2): pages are disjoint, cover everything once in order, the last page has no next_cursor; limit may arrive as number or string', async () => {
    const { call } = setup({ deliveries: rows().filter((r) => r['tenant_id'] === TENANT_A) }); const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r: any = await call(OPS.list, { query: { limit: pages % 2 ? '2' : 2, ...(cursor ? { cursor } : {}) } }); seen.push(...r.body.data.map((d: Row) => d.id)); cursor = r.body.page.next_cursor; pages++;
      expect(r.body.page.limit).toBe(2); expect(r.body.data.length).toBeLessThanOrEqual(2);
    } while (cursor && pages < 5);
    expect(seen).toEqual([D(3), D(2), D(1), D(4)]); expect(pages).toBe(2);
  });
  it('invalid input never reaches SQL: bad enum / uuid / date / sort / limit / cursor -> common.validation_failed', async () => {
    const { call, w } = setup({ deliveries: [dRow(1)] });
    for (const query of [{ status: "queued' OR 1=1 --" }, { channel: 'fax' }, { purpose: 'x; DROP TABLE reporting.deliveries' }, { recipient_kind: 7 }, { report_id: 'nope' }, { created_at_from: 'yesterday' },
      { sort: 'created_at' }, { sort: 'id; --' }, { limit: 0 }, { limit: 201 }, { limit: 'abc' }, { cursor: '%%%not-a-cursor' }, { cursor: "' OR 1=1 --" }]) expect(await code(call(OPS.list, { query })), JSON.stringify(query)).toBe('common.validation_failed');
    expect(w.tx).toBeDefined(); expect(w.deliveries()).toHaveLength(1);
  });
  it('default page size is 50 and the maximum 200', async () => {
    const many = Array.from({ length: 210 }, (_, i) => dRow(i + 1, { idempotency_key: `k${i}`, created_at: new Date(Date.parse('2026-11-07T00:00:00.000Z') + i * 1000).toISOString() }));
    const { call } = setup({ deliveries: many }); expect((await call(OPS.list)).body.data).toHaveLength(50); expect((await call(OPS.list, { query: { limit: 200 } })).body.data).toHaveLength(200);
  });
});

describe('D2 getDelivery (AC-09.6)', () => {
  const secrets = { params: { lab_name: LAB_NAME, url: 'https://portal.example.invalid/r/PLANTEDTOKEN0000000000', otp_code: '654321' } };
  const att = (n: number, over: Row = {}) => ({ id: idN(0xa0 + n), tenant_id: TENANT_A, delivery_id: D(1), attempt_no: n, started_at: `2026-11-07T11:0${n}:00.000Z`, finished_at: `2026-11-07T11:0${n}:01.000Z`, outcome: 'retryable_error', error_code: 'provider_timeout', provider_status_raw: 'raw-body-PLANTED', latency_ms: 12, created_by: idN(1), ...over });
  it('channel, purpose, recipient kind, MASKED destination, status timeline and attempts; etag = row version', async () => {
    const { call } = setup({ deliveries: [sentRow(1, 20, { ...secrets, version: 4, delivered_at: minutesAgo(10) })], attempts: [att(1), att(2, { outcome: 'accepted', error_code: null })] });
    const r = await call(OPS.get, { params: { delivery_id: D(1) } }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"4"'); expect(noNulls(r.body)).toBe(true);
    expect(r.body).toMatchObject({ id: D(1), channel: 'whatsapp', purpose: 'report_ready', recipient_kind: 'patient', status: 'sent', attempt_no: 1, destination_masked: '+97798•••••042', template_code: 'reporting.report_ready',
      report_id: LAB, report_version_no: 1, queued_at: expect.any(String), sent_at: expect.any(String), delivered_at: expect.any(String) });
    expect(r.body.attempts).toEqual([{ attempt_no: 1, started_at: '2026-11-07T11:01:00.000Z', finished_at: '2026-11-07T11:01:01.000Z', outcome: 'retryable_error', error_code: 'provider_timeout' },
      { attempt_no: 2, started_at: '2026-11-07T11:02:00.000Z', finished_at: '2026-11-07T11:02:01.000Z', outcome: 'accepted' }]);
    expect(Object.keys(r.body).filter((k) => !DTO.includes(k))).toEqual([]); for (const a of r.body.attempts) expect(Object.keys(a).filter((k) => !ATT.includes(k))).toEqual([]);
  });
  it('never the full phone / e-mail / link URL / OTP / message body / provider raw status / hashes', async () => {
    const { call } = setup({ deliveries: [dRow(1, { ...secrets, destination_e164: null, destination_masked: '+97798•••••042' })], attempts: [att(1)], links: [linkRow(1, { delivery_id: D(1) })] });
    const text = JSON.stringify((await call(OPS.get, { params: { delivery_id: D(1) } })).body);
    for (const s of [PHONE, EMAIL, FULL_NAME, REG_NO, 'PLANTEDTOKEN', '/r/', '654321', 'raw-body-PLANTED', sha256hex(PHONE), 'Report ready from']) expect(text, s).not.toContain(s);
  });
  it('unknown, malformed and other-tenant ids answer the same common.not_found', async () => {
    const { call } = setup({ rls: false, deliveries: [dRow(1, { tenant_id: TENANT_B })] }); const errs = [];
    for (const id of [D(1), idN(0xdead), 'not-a-uuid', "' OR 1=1 --"]) errs.push(await rejection(call(OPS.get, { params: { delivery_id: id } })));
    expect(errs.map((e) => e.code)).toEqual(Array(4).fill('common.not_found')); expect(new Set(errs.map((e) => JSON.stringify({ m: e.message, d: e.details }))).size).toBe(1);
  });
  it('a print delivery (no template) is readable', async () => {
    const { call } = setup({ deliveries: [dRow(1, { channel: 'print', template_code: null, status: 'sent', sent_at: minutesAgo(1), destination_masked: null, deferred_link: null })] });
    const r = await call(OPS.get, { params: { delivery_id: D(1) } }); expect(r.body.channel).toBe('print'); expect(r.body.template_code).toBeUndefined();
  });
});

describe('D3 sendReportDelivery (resend)', () => {
  const send = (call: any, body: unknown = { recipient_kind: 'patient', channel: 'whatsapp' }, over: Row = {}, report = LAB) =>
    call(OPS.send, { params: { report_id: report }, headers: { 'idempotency-key': 'idem-1' }, body }, over);
  it('201 Delivery queued: the report_ready template, deferred link of the RELEASED version, lab name only, one send job, one status event', async () => {
    const { w, call } = setup(); const r = await send(call); expect(r.status).toBe(201); expect(noNulls(r.body)).toBe(true);
    expect(r.body).toMatchObject({ channel: 'whatsapp', purpose: 'report_ready', recipient_kind: 'patient', status: 'queued', attempt_no: 1, template_code: 'reporting.report_ready', report_id: LAB, report_version_no: 1 });
    expect(Object.keys(r.body).filter((k) => !DTO.includes(k))).toEqual([]);
    const d = w.delivery(r.body.id); expect(d).toMatchObject({ tenant_id: TENANT_A, status: 'queued', params: { lab_name: LAB_NAME }, report_id: LAB, report_version_no: 1, recipient_id: I.patient, link_id: null, fallback_of_delivery_id: null, created_by: USER });
    expect(d['deferred_link']).toEqual({ report_id: LAB, version_no: 1, channel: 'whatsapp', recipient_kind: 'patient' });
    expect(w.sendJobs()).toHaveLength(1); expect(w.sendJobs()[0]).toMatchObject({ jobKey: r.body.id, payload: { delivery_id: r.body.id } });
    expect(w.statusEvents()).toHaveLength(1); expect(w.statusEvents()[0]!.input.payload).toMatchObject({ delivery_id: r.body.id, to_status: 'queued', report_id: LAB });
    const text = JSON.stringify(r.body); for (const s of [PHONE, EMAIL, '/r/']) expect(text).not.toContain(s);
  });
  it('a resend is a NEW delivery each time (distinct ids and idempotency keys), the earlier ones are untouched', async () => {
    const { w, call } = setup({ deliveries: [sentRow(1, 120)] }); const a = await send(call); const b = await send(call, undefined, { requestId: idN(0xf777) });
    expect(new Set([a.body.id, b.body.id, D(1)]).size).toBe(3); expect(new Set(w.deliveries().map((d) => d['idempotency_key'])).size).toBe(3); expect(w.delivery(D(1))['status']).toBe('sent');
  });
  it('consent missing -> still 201, status `suppressed` with failure_code no_consent (no job, nothing to send)', async () => {
    const { w, call } = setup({ consent: { whatsapp: false } }); const r = await send(call); expect(r.status).toBe(201); expect(r.body).toMatchObject({ status: 'suppressed', failure_code: 'no_consent' }); expect(w.sendJobs()).toEqual([]);
  });
  it('tenant channel switched off -> 201 suppressed / channel_disabled', async () => {
    const { call } = setup({ channels: { smsEnabled: false } }); const r = await send(call, { recipient_kind: 'patient', channel: 'sms' }); expect(r.body).toMatchObject({ status: 'suppressed', failure_code: 'channel_disabled' });
  });
  it('reporting.report_not_released when no version is released (rendered/held); common.not_found for unknown or other-tenant reports', async () => {
    const a = setup({ versions: [rendered(1)] }); expect(await code(send(a.call))).toBe('reporting.report_not_released');
    const b = setup({ rls: false }); expect(await code(send(b.call, undefined, {}, idN(0xdead)))).toBe('common.not_found'); expect(await code(send(b.call, undefined, {}, 'nope'))).toBe('common.not_found');
    const c = setup({ rls: false }); expect(await code(send(c.call, undefined, { tenantId: TENANT_B }))).toBe('common.not_found');
  });
  it('reporting.channel_not_configured when the tenant has no channel account for the channel', async () => {
    const { w, call } = setup({ accounts: { sms: null } }); expect(await code(send(call, { recipient_kind: 'patient', channel: 'sms' }))).toBe('reporting.channel_not_configured'); expect(w.deliveries()).toEqual([]);
  });
  it('centre_contact_id is required iff recipient_kind = centre; the contact must be an active contact of this tenant', async () => {
    const contacts = [{ id: CONTACT(1), tenant_id: TENANT_A, channel: 'sms', address: CENTRE_PHONE, is_active: true }, { id: CONTACT(2), tenant_id: TENANT_A, channel: 'sms', address: '+9779800000099', is_active: false },
      { id: CONTACT(3), tenant_id: TENANT_B, channel: 'sms', address: '+9779800000066', is_active: true }];
    const { w, call } = setup({ rls: false, centreContacts: contacts, settings: { centre_delivery_enabled: true } });
    expect(await code(send(call, { recipient_kind: 'centre', channel: 'sms' }))).toBe('common.validation_failed');
    expect(await code(send(call, { recipient_kind: 'patient', channel: 'sms', centre_contact_id: CONTACT(1) }))).toBe('common.validation_failed');
    for (const id of [CONTACT(2), CONTACT(3), idN(0xdead)]) expect(await code(send(call, { recipient_kind: 'centre', channel: 'sms', centre_contact_id: id })), id).toBe('common.not_found');
    const r = await send(call, { recipient_kind: 'centre', channel: 'sms', centre_contact_id: CONTACT(1) }); expect(r.status).toBe(201);
    expect(w.delivery(r.body.id)).toMatchObject({ recipient_kind: 'centre', recipient_id: CONTACT(1), channel: 'sms' }); expect(JSON.stringify(r.body)).not.toContain(CENTRE_PHONE);
  });
  it('review C6-T23 #1: an ACTIVE contact of ANOTHER centre of the same tenant -> common.not_found, no delivery row, no job (no cross-centre disclosure)', async () => {
    const other = { id: CONTACT(4), tenant_id: TENANT_A, centre_id: idN(0xce77), channel: 'sms', address: '+9779800000055', is_active: true };
    const { w, call } = setup({ rls: false, centreContacts: [other], settings: { centre_delivery_enabled: true } });
    expect(await code(send(call, { recipient_kind: 'centre', channel: 'sms', centre_contact_id: CONTACT(4) }))).toBe('common.not_found');
    expect(w.deliveries()).toEqual([]); expect(w.sendJobs()).toEqual([]);
  });
  it('a referrer without a phone/e-mail on record -> 201 suppressed / no_contact', async () => {
    const { call } = setup({ referrer: { phoneE164: null } }); const r = await send(call, { recipient_kind: 'referrer', channel: 'sms' }); expect(r.status).toBe(201); expect(r.body).toMatchObject({ recipient_kind: 'referrer', status: 'suppressed', failure_code: 'no_contact' });
  });
  it('malformed bodies are refused: unknown recipient kind / channel, extra property, missing field, non-uuid contact, non-object', async () => {
    const { call, w } = setup();
    for (const b of [{ recipient_kind: 'partner', channel: 'sms' }, { recipient_kind: 'staff', channel: 'sms' }, { recipient_kind: 'patient', channel: 'print' }, { recipient_kind: 'patient', channel: 'sms', url: 'x' }, { recipient_kind: 'patient' }, { channel: 'sms' },
      { recipient_kind: 'centre', channel: 'sms', centre_contact_id: 'zz' }, null, 'x', []]) expect(await code(send(call, b)), JSON.stringify(b)).toBe('common.validation_failed');
    expect(w.deliveries()).toEqual([]);
  });
  it('contacts are read as the system actor purpose `notification` even though the caller is a user; no billing / payment calls', async () => {
    const { w, call } = setup(); await send(call); expect(w.portCalls.frontdesk.length).toBeGreaterThan(0); expect(w.portCalls.frontdesk.every((c) => c.purpose === 'notification')).toBe(true); expect(w.portCalls.forbidden).toEqual([]);
  });
});

describe('D4 retryDelivery (AC-09.7)', () => {
  const retry = (call: any, id: string = D(1), ifMatch: string | null = '"3"', over: Row = {}) => call(OPS.retry, { params: { delivery_id: id }, headers: { 'idempotency-key': 'idem-2', ...(ifMatch === null ? {} : { 'if-match': ifMatch }) } }, over);
  const world = (o: DWorldOpts = {}) => setup({ deliveries: [failedRow(1)], links: [linkRow(1, { delivery_id: D(1) })], ...o });
  it('201: a NEW queued delivery cloned from the failed one (not a fallback), the failed original kept as it was', async () => {
    const { w, call } = world(); const before = JSON.stringify(w.delivery(D(1))); const r = await retry(call); expect(r.status).toBe(201);
    expect(r.body.id).not.toBe(D(1)); expect(r.body).toMatchObject({ channel: 'whatsapp', purpose: 'report_ready', recipient_kind: 'patient', status: 'queued', attempt_no: 1, template_code: 'reporting.report_ready', report_id: LAB, report_version_no: 1 });
    expect(r.body.failure_code).toBeUndefined(); expect(r.body.fallback_of_delivery_id).toBeUndefined();
    const n = w.delivery(r.body.id); expect(n).toMatchObject({ status: 'queued', recipient_id: I.patient, params: { lab_name: LAB_NAME }, link_id: null, fallback_of_delivery_id: null, failure_code: null, created_by: USER });
    expect(n['deferred_link']).toEqual({ report_id: LAB, version_no: 1, channel: 'whatsapp', recipient_kind: 'patient' }); expect(n['idempotency_key']).not.toBe(w.delivery(D(1))['idempotency_key']);
    expect(JSON.stringify(w.delivery(D(1)))).toBe(before);
    expect(w.sendJobs()).toHaveLength(1); expect(w.sendJobs()[0]).toMatchObject({ jobKey: r.body.id, payload: { delivery_id: r.body.id } }); expect(w.statusEvents().filter((e) => e.input.payload.delivery_id === r.body.id)).toHaveLength(1);
  });
  it('AC-09.7: the old link is revoked; once the send task runs the new delivery has its own NEW link (exactly one live link left)', async () => {
    const { w, call } = world(); const r = await retry(call);
    const old = w.portalLinks().find((l) => l['id'] === LINK(1))!; expect(old['revoked_at']).not.toBeNull(); expect(typeof old['revoke_reason_code']).toBe('string');
    const m: any = sendMod; const task = m.createSendDelivery ? m.createSendDelivery({ env: w.env, transports: {} }) : m.sendDelivery;
    expect(await w.run(task, { delivery_id: r.body.id })).toBe('ok');
    const live = w.portalLinks().filter((l) => l['revoked_at'] == null); expect(live).toHaveLength(1); expect(live[0]!['id']).not.toBe(LINK(1)); expect(live[0]!['delivery_id']).toBe(r.body.id); expect(w.delivery(r.body.id)['status']).toBe('sent');
  });
  it('only a `failed` delivery can be retried: queued / sent / delivered / read / suppressed -> common.immutable_record, nothing created', async () => {
    for (const st of ['queued', 'sent', 'delivered', 'read', 'suppressed']) {
      const { w, call } = setup({ deliveries: [dRow(1, { status: st, version: 3, failure_code: st === 'suppressed' ? 'no_consent' : null })] });
      expect(await code(retry(call)), st).toBe('common.immutable_record'); expect(w.deliveries()).toHaveLength(1); expect(w.sendJobs()).toEqual([]);
    }
  });
  it('If-Match: missing -> common.precondition_required; stale -> common.version_conflict; malformed -> common.validation_failed', async () => {
    const { w, call } = world(); expect(await code(retry(call, D(1), null))).toBe('common.precondition_required'); expect(await code(retry(call, D(1), '"2"'))).toBe('common.version_conflict');
    for (const bad of ['3', '"x"', '"0"', '"3" OR 1=1', 'W/"3"']) expect(await code(retry(call, D(1), bad)), bad).toBe('common.validation_failed');
    expect(w.deliveries()).toHaveLength(1);
  });
  it('unknown, malformed and other-tenant delivery ids -> common.not_found', async () => {
    const { call } = setup({ rls: false, deliveries: [failedRow(1, { tenant_id: TENANT_B })] });
    for (const id of [D(1), idN(0xdead), 'nope']) expect(await code(retry(call, id)), id).toBe('common.not_found');
  });
  it('the retry is created through the delivery path: consent withdrawn since -> 201 `suppressed` (no job), not a send', async () => {
    const { w, call } = world({ consent: { whatsapp: false } }); const r = await retry(call); expect(r.status).toBe(201); expect(r.body.status).toBe('suppressed'); expect(w.sendJobs()).toEqual([]);
  });
  it('no phone, e-mail, link or token in the response', async () => {
    const { call } = world(); const text = JSON.stringify((await retry(call)).body); for (const s of [PHONE, EMAIL, '/r/', sha256hex(PHONE)]) expect(text).not.toContain(s);
  });
});
void ACC; void MEMBERSHIP; void NOW; void V; void sentRow; void minutesAgo; void (null as unknown as DW);
