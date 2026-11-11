// C6-T25 — message templates & channel accounts admin: M1 listMessageTemplates, M2 upsertMessageTemplateText, C1 listChannelAccounts, C2 upsertChannelAccount,
// C3 rotateChannelCallbackToken (02-TRD §6.5 rows M1/M2/C1/C2/C3; 05-SCHEMA message_template_texts / channel_accounts / g_message_templates; 01-PRD AC-13.4;
// 04-UI-UX §7; 07-SECURITY test 8h "secrets not replayed", REQ-SEC-024 tenant scope, REQ-SEC-128 secret reference only, REQ-SEC-136 recording not in production; 08 A13 P-8 E1).
// Integration level: the REAL manifest handlers + REAL service over the in-memory fake tx of messaging-admin.helpers.ts. Permission, schema and Idempotency-Key are enforced by
// the core pipeline; the handlers fail closed without a request context (auth.unauthenticated) like T1-T4 / S1-S7.
// ASSUMED (spec gives no more; see .orchestra/notes/C6-T25-tests.md):
//  - request shape { params:{template_code,channel}, headers:{'if-match':'"<n>"'}, body } like T4/S2; success bodies per OpenAPI (M2 MessageTemplateText, C2 ChannelAccount, C3 {callback_url}); ETag = row version
//  - placeholder = `{name}` (single braces, as 04-UI-UX §7 and the worker's send_delivery `fill`); any `{token}` in body_text / subject_text whose name is not a declared param of the
//    template (g_message_templates.params) -> 422 reporting.notification_params_invalid, nothing written; provider_variable_order names are checked against the same declared set
//  - unknown / inactive template, or a channel the template does not allow -> reporting.notification_template_unknown (02-TRD §7.2 step 2)
//  - M2 absent If-Match = create (existing row -> common.version_conflict); present = update at that version (stale -> common.version_conflict; row missing -> not_found|version_conflict)
//  - approval_status other than not_required stamps approval_recorded_by = actor, approval_recorded_at (columns exist for the manual record, AC-13.4)
//  - M1 params[].max_length is always an integer (OpenAPI makes it required; seed rows only carry it for short_text)
//  - C2 has no If-Match: upsert by (tenant, channel); update keeps callback_token_sha256 and bumps version; provider_kind `recording` -> common.validation_failed when LIMS_CORE_ENV=production
//  - C3: 201 {callback_url: "<origin>/v1/reporting/provider-callbacks/<43-char base64url token>"}; stores ONLY sha256(token) (32 bytes) and bumps version; x-idempotency none, so the token
//    exists only in the response: it must not appear in any SQL value, log, audit entry or metric, and no statement may touch core.idempotency_keys
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../core/module.js';
import {
  ACC_A_SMS, ACC_A_WA, ACC_B_SMS, B_TOKEN, INACTIVE_CODE, OLD_TOKEN, TENANT_A, TENANT_B, TXT_A_SMS, TXT_A_WA, TXT_B_WA, USER,
  makeMsgWorld, rejection, sha256buf, type MsgWorld,
} from './messaging-admin.helpers.js';

let manifest: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t25-')), 'otp.key'); writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev'; delete process.env.NODE_ENV; delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
});

const OP = { listM: 'listMessageTemplates', putM: 'upsertMessageTemplateText', listC: 'listChannelAccounts', putC: 'upsertChannelAccount', rotate: 'rotateChannelCallbackToken' } as const;
const w = (): MsgWorld => makeMsgWorld(manifest);
const code = async (p: Promise<unknown>) => (await rejection(p))?.code;
const ifm = (v: unknown) => ({ 'if-match': `"${v}"` });
const REPORT_READY = 'reporting.report_ready';
const okText = (o: Record<string, unknown> = {}) => ({ language: 'en', body_text: '{lab_name}: your report is ready. Open {url}', approval_status: 'not_required', is_active: true, ...o });
const putText = (t: MsgWorld, tpl: string, channel: string, body: unknown, headers: unknown = {}) => t.run(OP.putM, { params: { template_code: tpl, channel }, headers, body });
const putAcct = (t: MsgWorld, channel: string, body: unknown, over: Record<string, unknown> = {}) => t.run(OP.putC, { params: { channel }, body }, over);
const rotate = (t: MsgWorld, channel: string, headers: unknown = {}) => t.run(OP.rotate, { params: { channel }, headers });
const okAcct = (o: Record<string, unknown> = {}) => ({ provider_kind: 'sms_sparrow', sender_id: 'SYNLAB', secret_ref: 'secrets/sms-synthetic', is_active: true, ...o });
const nothingWritten = (t: MsgWorld) => expect(t.db.writes()).toHaveLength(0);
const snap = <T>(v: T): T => {
  const c = (x: any): any => Buffer.isBuffer(x) ? Buffer.from(x) : x instanceof Date ? new Date(x) : Array.isArray(x) ? x.map(c)
    : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, c(y)])) : x;
  return c(v);
};
const TEXT_KEYS = ['channel', 'language', 'body_text', 'subject_text', 'provider_template_name', 'provider_template_language', 'provider_variable_order', 'approval_status', 'is_active', 'version'];
const ACCT_KEYS = ['id', 'channel', 'provider_kind', 'sender_id', 'secret_ref', 'callback_url_configured', 'is_active', 'version'];
const TOKEN_URL = /\/v1\/reporting\/provider-callbacks\/([A-Za-z0-9_-]{43})$/;
const hasNull = (o: Record<string, unknown>) => Object.values(o).some((v) => v === null);

// ---------------------------------------------------------------------------------------------------------------- wiring + contract
describe('M1, M2, C1, C2, C3 are real handlers (not 501 stubs)', () => {
  it.each(Object.values(OP))('%s fails closed without a request context', async (op) => {
    const noop = { info() {}, warn() {}, error() {} };
    const e = await rejection(manifest.handlers[op]({ params: {}, query: {}, headers: {}, body: undefined }, { operationId: op, clientIp: '203.0.113.9', log: noop }));
    expect(e?.code).toBe('auth.unauthenticated');
  });
  it('a happy-path call returns a non-501 status', async () => {
    expect((await w().run(OP.listM)).status).not.toBe(501);
  });
});

describe('contract (contracts/openapi/reporting.yaml)', () => {
  const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/reporting.yaml'));
  const op = (path: string, method: string) => spec.paths[`/v1/reporting${path}`][method];
  it('M1/M2 need reporting.message_template.manage, C1-C3 reporting.channel.manage', () => {
    expect(op('/message-templates', 'get')['x-permission']).toBe('reporting.message_template.manage');
    expect(op('/message-templates/{template_code}/texts/{channel}', 'put')['x-permission']).toBe('reporting.message_template.manage');
    for (const [p, m] of [['/channel-accounts', 'get'], ['/channel-accounts/{channel}', 'put'], ['/channel-accounts/{channel}/callback-token', 'post']] as const) expect(op(p, m)['x-permission']).toBe('reporting.channel.manage');
  });
  it('C3 is x-idempotency none with the E1 justification and requires If-Match: the callback URL is never replayed from core.idempotency_keys', () => {
    const c3 = op('/channel-accounts/{channel}/callback-token', 'post');
    expect(c3.operationId).toBe(OP.rotate); expect(c3['x-idempotency']).toBe('none'); expect(c3['x-idempotency-justification']).toMatch(/^E1 /);
    expect(c3.requestBody).toBeUndefined(); expect(JSON.stringify(c3.parameters)).toMatch(/IfMatch/);
    expect(Object.keys(c3.responses)).toContain('201'); expect(c3['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict', 'common.precondition_required']));
  });
  it('no operation of this task requires an Idempotency-Key (M2 PUT and C2 PUT are idempotent by nature, M1/C1 are reads)', () => {
    for (const [p, m] of [['/message-templates', 'get'], ['/message-templates/{template_code}/texts/{channel}', 'put'], ['/channel-accounts', 'get'], ['/channel-accounts/{channel}', 'put'], ['/channel-accounts/{channel}/callback-token', 'post']] as const)
      expect(op(p, m)['x-idempotency'], `${m} ${p}`).toBe('none');
  });
});

// ---------------------------------------------------------------------------------------------------------------- M1
describe('M1 listMessageTemplates', () => {
  it('200 {data[]}: every global template with code / purpose / channels / params, OpenAPI keys only, params always carry an integer max_length', async () => {
    const t = w(); const r = await t.run(OP.listM);
    expect(r.status).toBe(200);
    const codes = r.body.data.map((x: any) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['reporting.report_ready', 'reporting.critical_value_alert', 'engagement.login_otp', 'analytics.report_ready', 'frontdesk.registration_confirmation']));
    for (const x of r.body.data) {
      expect(Object.keys(x).every((k) => ['code', 'purpose', 'channels', 'params', 'texts'].includes(k)), JSON.stringify(Object.keys(x))).toBe(true);
      expect(Array.isArray(x.channels) && x.channels.length >= 1).toBe(true); expect(Array.isArray(x.params)).toBe(true); expect(Array.isArray(x.texts)).toBe(true);
      for (const p of x.params) { expect(Object.keys(p).sort()).toEqual(['kind', 'max_length', 'name']); expect(Number.isInteger(p.max_length) && p.max_length >= 1 && p.max_length <= 1000, `${x.code}.${p.name}`).toBe(true); }
    }
    expect(r.body.data.find((x: any) => x.code === 'reporting.critical_value_alert').params.map((p: any) => p.name).sort()).toEqual(['lab_name', 'lab_phone', 'ref']);
    nothingWritten(t);
  });
  it('texts are this tenant\'s only (tenant B\'s text and ids never appear) and carry the OpenAPI text keys without nulls', async () => {
    const t = w(); const r = await t.run(OP.listM);
    const ready = r.body.data.find((x: any) => x.code === REPORT_READY);
    expect(ready.texts.map((x: any) => `${x.channel}/${x.language}`).sort()).toEqual(['sms/en', 'whatsapp/en']);
    expect(ready.texts.find((x: any) => x.channel === 'whatsapp')).toMatchObject({ body_text: 'Existing A whatsapp {lab_name} {url}', version: 2, approval_status: 'not_required', is_active: true });
    for (const x of ready.texts) { expect(Object.keys(x).every((k) => TEXT_KEYS.includes(k)), JSON.stringify(Object.keys(x))).toBe(true); expect(hasNull(x)).toBe(false); }
    const wire = JSON.stringify(r.body); expect(wire).not.toContain('TENANT-B-ONLY'); expect(wire).not.toContain(TXT_B_WA); expect(wire).not.toContain(TENANT_B); expect(wire).not.toContain(TENANT_A);
  });
  it('a template this tenant has not customised lists with texts: []', async () => {
    const r = await w().run(OP.listM);
    expect(r.body.data.find((x: any) => x.code === 'engagement.login_otp').texts).toEqual([]);
  });
  it('tenant B sees its own text only', async () => {
    const t = makeMsgWorld(manifest, { ctx: { tenantId: TENANT_B } }); const r = await t.run(OP.listM);
    const ready = r.body.data.find((x: any) => x.code === REPORT_READY);
    expect(ready.texts).toHaveLength(1); expect(ready.texts[0].body_text).toContain('TENANT-B-ONLY'); expect(JSON.stringify(r.body)).not.toContain('Existing A');
  });
  it('the texts SELECT carries an explicit tenant predicate bound to the context tenant (REQ-SEC-024)', async () => {
    const t = w(); await t.run(OP.listM);
    const sel = t.db.stmts.filter((s) => /message_template_texts/.test(s.text)); expect(sel.length).toBeGreaterThan(0);
    for (const s of sel) { expect(s.text).toMatch(/tenant_id\s*=\s*\$\d+/); expect(s.values).toContain(TENANT_A); }
  });
});

// ---------------------------------------------------------------------------------------------------------------- M2 create / update
describe('M2 upsertMessageTemplateText: create, update, versions', () => {
  it('create (no If-Match): 200 MessageTemplateText, version 1, ETag "1", stored for the ctx tenant with audit columns', async () => {
    const t = w(); const r = await putText(t, REPORT_READY, 'email', okText({ language: 'en', subject_text: 'Your report from {lab_name} is ready' }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ channel: 'email', language: 'en', body_text: '{lab_name}: your report is ready. Open {url}', subject_text: 'Your report from {lab_name} is ready', approval_status: 'not_required', is_active: true, version: 1 });
    expect(Object.keys(r.body).every((k) => TEXT_KEYS.includes(k)), JSON.stringify(Object.keys(r.body))).toBe(true); expect(hasNull(r.body)).toBe(false);
    if (r.headers?.etag ?? r.headers?.ETag) expect(r.headers.etag ?? r.headers.ETag).toBe('"1"');
    const row = t.db.texts().find((x) => x['channel'] === 'email')!;
    expect(row).toMatchObject({ tenant_id: TENANT_A, template_code: REPORT_READY, language: 'en', version: 1, created_by: USER, updated_by: USER });
    expect(t.db.texts()).toHaveLength(3);
  });
  it('a different language of the same template/channel is a separate row (Nepali text is entered by the tenant)', async () => {
    const t = w(); const r = await putText(t, REPORT_READY, 'sms', okText({ language: 'ne', body_text: 'तपाईंको {lab_name} रिपोर्ट तयार छ। {url}' }));
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ language: 'ne', version: 1 });
    expect(t.db.texts().filter((x) => x['channel'] === 'sms').map((x) => x['language']).sort()).toEqual(['en', 'ne']);
  });
  it('update with If-Match = current version: 200, version +1, ETag, only that row changed', async () => {
    const t = w(); const other = snap(t.db.text(TXT_A_SMS));
    const r = await putText(t, REPORT_READY, 'whatsapp', okText({ body_text: 'Updated {lab_name}: {url}' }), ifm(2));
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ body_text: 'Updated {lab_name}: {url}', version: 3 });
    if (r.headers?.etag ?? r.headers?.ETag) expect(r.headers.etag ?? r.headers.ETag).toBe('"3"');
    expect(t.db.text(TXT_A_WA)).toMatchObject({ body_text: 'Updated {lab_name}: {url}', version: 3, updated_by: USER });
    expect(t.db.text(TXT_A_SMS)).toEqual(other); expect(t.db.text(TXT_B_WA)).toMatchObject({ version: 5, body_text: 'TENANT-B-ONLY whatsapp text {lab_name}' });
  });
  it('stale If-Match -> common.version_conflict and nothing is written', async () => {
    const t = w(); for (const v of [1, 3, 99]) expect(await code(putText(t, REPORT_READY, 'whatsapp', okText(), ifm(v)))).toBe('common.version_conflict');
    nothingWritten(t); expect(t.db.text(TXT_A_WA)['version']).toBe(2);
  });
  it('create over an existing (template, channel, language) without If-Match -> common.version_conflict, the stored text is untouched', async () => {
    const t = w(); expect(await code(putText(t, REPORT_READY, 'whatsapp', okText({ body_text: 'Overwrite {lab_name}' })))).toBe('common.version_conflict');
    expect(t.db.text(TXT_A_WA)).toMatchObject({ version: 2, body_text: 'Existing A whatsapp {lab_name} {url}' });
  });
  it('If-Match for a row that does not exist -> not_found or version_conflict, and no row is created', async () => {
    const t = w(); expect(['common.not_found', 'common.version_conflict']).toContain(await code(putText(t, REPORT_READY, 'email', okText(), ifm(1))));
    expect(t.db.texts().filter((x) => x['channel'] === 'email')).toHaveLength(0);
  });
  it('a malformed If-Match is rejected (never a 500) and writes nothing', async () => {
    const t = w(); for (const h of ['abc', '"0"', '"-1"', '"1e3"', '"99999999999999999999"', '']) {
      const e = await rejection(putText(t, REPORT_READY, 'whatsapp', okText(), { 'if-match': h })); expect(['common.validation_failed', 'common.precondition_required', 'common.version_conflict'], h).toContain(e.code);
    }
    nothingWritten(t);
  });
  it('BOLA: tenant A cannot update or read tenant B\'s text through its version (B\'s version 5 does not match, A\'s row is the only candidate)', async () => {
    const t = w(); expect(await code(putText(t, REPORT_READY, 'whatsapp', okText(), ifm(5)))).toBe('common.version_conflict');
    expect(t.db.text(TXT_B_WA)).toMatchObject({ version: 5, body_text: 'TENANT-B-ONLY whatsapp text {lab_name}' });
  });
  it('the UPDATE is optimistic-locked and tenant-scoped in SQL (version = $n AND tenant_id = $n), the INSERT names tenant_id', async () => {
    const t = w(); await putText(t, REPORT_READY, 'whatsapp', okText(), ifm(2)); await putText(t, REPORT_READY, 'email', okText());
    for (const s of t.db.writes()) {
      expect(s.text).toMatch(/\btenant_id\b/); expect(s.values).toContain(TENANT_A);
      if (s.verb === 'update') { expect(s.text).toMatch(/\btenant_id\s*=\s*\$\d+/); expect(s.text).toMatch(/\bversion\s*=\s*\$\d+/); expect(s.text).toMatch(/\bversion\s*=\s*(?:\w+\.)?version\s*\+\s*1/i); }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------- AC-13.4
describe('AC-13.4: provider template name and approval are recorded manually; no parameter beyond the declared set', () => {
  const wa = (o: Record<string, unknown> = {}) => okText({ provider_template_name: 'lab_report_ready_v1', provider_template_language: 'en', provider_variable_order: ['lab_name', 'url'], approval_status: 'approved', ...o });
  it('records provider template name / language / variable order / approval status on the WhatsApp text', async () => {
    const t = w(); const r = await putText(t, REPORT_READY, 'whatsapp', wa(), ifm(2));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ provider_template_name: 'lab_report_ready_v1', provider_template_language: 'en', provider_variable_order: ['lab_name', 'url'], approval_status: 'approved' });
    const row = t.db.text(TXT_A_WA);
    expect(row).toMatchObject({ provider_template_name: 'lab_report_ready_v1', provider_template_language: 'en', approval_status: 'approved', approval_recorded_by: USER });
    expect(typeof row['approval_recorded_at'] === 'string' || row['approval_recorded_at'] instanceof Date).toBe(true);
    const order = row['provider_variable_order']; expect(Array.isArray(order) ? order : String(order).replace(/[{}"]/g, '').split(',')).toEqual(['lab_name', 'url']);
  });
  it.each(['draft', 'submitted', 'approved', 'rejected', 'not_required'])('approval_status %s is accepted', async (s) => {
    const r = await putText(w(), REPORT_READY, 'whatsapp', wa({ approval_status: s }), ifm(2)); expect(r.status).toBe(200); expect(r.body.approval_status).toBe(s);
  });
  it('approval is a manual record only: saving never calls a provider (no outbound access, no job queued)', async () => {
    const t = w(); await putText(t, REPORT_READY, 'whatsapp', wa(), ifm(2));
    expect(t.db.stmts.filter((s) => /enqueue_job/i.test(s.text))).toHaveLength(0);
  });
  it('declared placeholders are accepted in body_text and subject_text; text without placeholders is accepted', async () => {
    const t = w();
    expect((await putText(t, REPORT_READY, 'email', okText({ subject_text: 'Your report from {lab_name}', body_text: 'Open {url} to view it.' }))).status).toBe(200);
    expect((await putText(t, 'engagement.login_otp', 'sms', okText({ body_text: '{otp_code} is your {lab_name} code. Expires in {minutes} minutes.' }))).status).toBe(200);
    expect((await putText(t, 'reporting.critical_value_alert', 'sms', okText({ body_text: '{lab_name}: critical result for your patient. Please call {lab_phone} now. Ref {ref}.' }))).status).toBe(200);
    expect((await putText(t, 'frontdesk.recollection_request', 'sms', okText({ body_text: 'Please call us to give a new sample.' }))).status).toBe(200);
  });
  it.each([
    ['patient_name', 'Hello {patient_name}, your report is ready'],
    ['an undeclared name beside declared ones', '{lab_name}: open {url} {secret_ref}'],
    ['a name that only differs in case', '{LAB_NAME}: your report is ready'],
    ['a parameter of another template', '{otp_code} is your code'],
    ['a double-brace wrapper around an undeclared name', 'Hello {{patient_name}}'],
    ['__proto__', 'x {__proto__} y'],
    ['constructor', 'x {constructor} y'],
    ['a numeric placeholder', 'Hello {0}'],
  ])('rejects body_text with %s -> reporting.notification_params_invalid, nothing written, text not echoed', async (_n, body_text) => {
    const t = w(); const e = await rejection(putText(t, REPORT_READY, 'whatsapp', okText({ body_text }), ifm(2)));
    expect(e.code).toBe('reporting.notification_params_invalid'); nothingWritten(t);
    expect(JSON.stringify({ message: e.message, details: e.details, title: e.title })).not.toContain('patient_name');
    expect(t.db.text(TXT_A_WA)).toMatchObject({ version: 2, body_text: 'Existing A whatsapp {lab_name} {url}' });
  });
  it('the declared set is per template: critical_value_alert has no `url` (no link in a critical alert, 08 A13 D-35)', async () => {
    const t = w(); expect(await code(putText(t, 'reporting.critical_value_alert', 'sms', okText({ body_text: '{lab_name}: call {lab_phone} or open {url}' })))).toBe('reporting.notification_params_invalid');
    nothingWritten(t);
  });
  it('an undeclared placeholder in subject_text is rejected too', async () => {
    const t = w(); expect(await code(putText(t, REPORT_READY, 'email', okText({ subject_text: 'Report for {patient_name}' })))).toBe('reporting.notification_params_invalid'); nothingWritten(t);
  });
  it('provider_variable_order cannot name a parameter beyond the declared set', async () => {
    const t = w(); for (const order of [['lab_name', 'patient_name'], ['secret_ref'], ['lab_name', 'url', 'otp_code'], ['__proto__']])
      expect(await code(putText(t, REPORT_READY, 'whatsapp', wa({ provider_variable_order: order }), ifm(2))), JSON.stringify(order)).toBe('reporting.notification_params_invalid');
    nothingWritten(t);
  });
  it('the declared param set itself cannot be changed through M2: no write to g_message_templates, and a `params` field in the body is rejected', async () => {
    const t = w(); await putText(t, REPORT_READY, 'email', okText());
    expect(t.db.stmts.filter((s) => ['insert', 'update', 'delete'].includes(s.verb) && /g_message_templates/.test(s.text))).toHaveLength(0);
    const before = snap(t.db.store['g_message_templates']);
    for (const extra of [{ params: [{ name: 'patient_name', kind: 'short_text' }] }, { declared_params: ['patient_name'] }, { default_texts: { sms: { body: 'x' } } }])
      expect(await code(putText(t, REPORT_READY, 'sms', okText(extra), ifm(1)))).toBe('common.validation_failed');
    expect(t.db.store['g_message_templates']).toEqual(before);
  });
});

describe('M2 template / channel / body validation', () => {
  it('unknown template code -> reporting.notification_template_unknown', async () => {
    const t = w(); for (const c of ['reporting.no_such', 'x', "reporting.report_ready' OR '1'='1"]) expect(await code(putText(t, c, 'sms', okText({ body_text: 'x' }))), c).toBe('reporting.notification_template_unknown'); nothingWritten(t);
  });
  it('an inactive template is unknown', async () => {
    const t = w(); expect(await code(putText(t, INACTIVE_CODE, 'sms', okText({ body_text: '{lab_name}' })))).toBe('reporting.notification_template_unknown'); nothingWritten(t);
  });
  it('a channel the template does not allow -> reporting.notification_template_unknown (login_otp is sms only; critical_value_alert has no email)', async () => {
    const t = w(); for (const [c, ch] of [['engagement.login_otp', 'email'], ['engagement.login_otp', 'whatsapp'], ['reporting.critical_value_alert', 'email'], ['analytics.report_ready', 'sms']] as const)
      expect(await code(putText(t, c, ch, okText({ body_text: 'x' }))), `${c}/${ch}`).toBe('reporting.notification_template_unknown');
    nothingWritten(t);
  });
  it.each([
    ['empty body_text', { body_text: '' }], ['body_text 1001 chars', { body_text: 'x'.repeat(1001) }], ['subject_text 151 chars', { subject_text: 'x'.repeat(151) }],
    ['provider_template_name 129 chars', { provider_template_name: 'x'.repeat(129) }], ['provider_template_language 17 chars', { provider_template_language: 'x'.repeat(17) }],
    ['language fr', { language: 'fr' }], ['language missing', { language: undefined }], ['approval_status unknown', { approval_status: 'auto_approved' }],
    ['approval_status missing', { approval_status: undefined }], ['is_active not boolean', { is_active: 'yes' }], ['unknown key', { tenant_id: TENANT_B }],
    ['body_text not a string', { body_text: 12 }], ['provider_variable_order not an array', { provider_variable_order: 'lab_name' }],
    ['21 variable-order entries', { provider_variable_order: Array.from({ length: 21 }, () => 'lab_name') }],
  ])('%s -> common.validation_failed, nothing written', async (_n, over) => {
    const t = w(); expect(await code(putText(t, REPORT_READY, 'whatsapp', okText(over as Record<string, unknown>), ifm(2)))).toBe('common.validation_failed'); nothingWritten(t);
  });
  it('a body of exactly 1000 chars and a subject of exactly 150 are accepted (boundaries)', async () => {
    const t = w(); const r = await putText(t, REPORT_READY, 'email', okText({ body_text: 'x'.repeat(1000), subject_text: 'y'.repeat(150) })); expect(r.status).toBe(200);
  });
  it('a non-object body and a missing body are rejected', async () => {
    const t = w(); for (const b of [undefined, null, 'text', [], 7]) expect(await code(putText(t, REPORT_READY, 'sms', b)), String(b)).toBe('common.validation_failed'); nothingWritten(t);
  });
  it('a channel outside whatsapp|sms|email (print, portal, hostile) is rejected', async () => {
    const t = w(); for (const ch of ['print', 'portal', 'SMS', "sms' OR 1=1 --", '']) expect(['common.validation_failed', 'reporting.notification_template_unknown'], ch).toContain(await code(putText(t, REPORT_READY, ch, okText()))); nothingWritten(t);
  });
  it('HTML / script in the text is stored verbatim and never executed or transformed server-side (plain-text channels; escaping is the sender\'s job)', async () => {
    const t = w(); const r = await putText(t, REPORT_READY, 'email', okText({ body_text: '<b>{lab_name}</b> {url}' }));
    expect(r.status).toBe(200); expect(r.body.body_text).toBe('<b>{lab_name}</b> {url}');
  });
});

// ---------------------------------------------------------------------------------------------------------------- C1
describe('C1 listChannelAccounts', () => {
  it('200 {data[]}: this tenant\'s accounts with the OpenAPI keys; callback_url_configured reflects a stored token hash', async () => {
    const t = w(); const r = await t.run(OP.listC);
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.id).sort()).toEqual([ACC_A_SMS, ACC_A_WA].sort());
    for (const x of r.body.data) { expect(Object.keys(x).every((k) => ACCT_KEYS.includes(k)), JSON.stringify(Object.keys(x))).toBe(true); expect(hasNull(x)).toBe(false); expect(typeof x.callback_url_configured).toBe('boolean'); }
    const by = (id: string) => r.body.data.find((x: any) => x.id === id);
    expect(by(ACC_A_SMS)).toMatchObject({ channel: 'sms', provider_kind: 'recording', sender_id: 'LABA', secret_ref: 'secrets/sms-a', callback_url_configured: false, is_active: true, version: 3 });
    expect(by(ACC_A_WA)).toMatchObject({ channel: 'whatsapp', provider_kind: 'whatsapp_cloud_api', callback_url_configured: true });
    nothingWritten(t);
  });
  it('never returns the token, its hash, tenant ids or another tenant\'s account (REQ-SEC-024, REQ-SEC-128)', async () => {
    const t = w(); const wire = JSON.stringify((await t.run(OP.listC)).body);
    for (const bad of [OLD_TOKEN, B_TOKEN, 'callback_token', 'sha256', sha256buf(OLD_TOKEN).toString('hex'), sha256buf(OLD_TOKEN).toString('base64'), ACC_B_SMS, TENANT_A, TENANT_B, 'secrets/sms-b']) expect(wire, bad).not.toContain(bad);
  });
  it('the SELECT carries an explicit tenant predicate bound to the context tenant (REQ-SEC-024)', async () => {
    const t = w(); await t.run(OP.listC); const sel = t.db.stmts.filter((s) => /channel_accounts/.test(s.text)); expect(sel.length).toBeGreaterThan(0);
    for (const s of sel) { expect(s.text).toMatch(/tenant_id\s*=\s*\$\d+/); expect(s.values).toContain(TENANT_A); }
  });
  it('tenant B sees only its own account', async () => {
    const r = await makeMsgWorld(manifest, { ctx: { tenantId: TENANT_B } }).run(OP.listC); expect(r.body.data.map((x: any) => x.id)).toEqual([ACC_B_SMS]);
  });
});

// ---------------------------------------------------------------------------------------------------------------- C2
describe('C2 upsertChannelAccount', () => {
  it('creates the tenant\'s account for a channel with no account yet: 200, version 1, no callback configured', async () => {
    const t = w(); const r = await putAcct(t, 'email', okAcct({ provider_kind: 'email_smtp_relay', sender_id: 'reports@lab.invalid', secret_ref: 'secrets/smtp-synthetic' }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ channel: 'email', provider_kind: 'email_smtp_relay', sender_id: 'reports@lab.invalid', secret_ref: 'secrets/smtp-synthetic', callback_url_configured: false, is_active: true, version: 1 });
    expect(Object.keys(r.body).every((k) => ACCT_KEYS.includes(k)), JSON.stringify(Object.keys(r.body))).toBe(true); expect(hasNull(r.body)).toBe(false);
    expect(t.db.accts().find((a) => a['channel'] === 'email')).toMatchObject({ tenant_id: TENANT_A, provider_kind: 'email_smtp_relay', created_by: USER, updated_by: USER, callback_token_sha256: null });
    expect(t.db.accts()).toHaveLength(3);
  });
  it('updates the existing account of the channel (one per tenant+channel): version +1, callback token hash KEPT, other accounts untouched', async () => {
    const t = w(); const wa0 = sha256buf(OLD_TOKEN); const b0 = snap(t.db.acct(ACC_B_SMS)); const sms0 = snap(t.db.acct(ACC_A_SMS));
    const r = await putAcct(t, 'whatsapp', okAcct({ provider_kind: 'whatsapp_cloud_api', sender_id: undefined, secret_ref: 'secrets/wa-rotated', is_active: false }));
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ id: ACC_A_WA, channel: 'whatsapp', secret_ref: 'secrets/wa-rotated', is_active: false, version: 2, callback_url_configured: true });
    expect(Buffer.from(t.db.acct(ACC_A_WA)['callback_token_sha256']).equals(wa0)).toBe(true);
    expect(t.db.accts().filter((a) => a['channel'] === 'whatsapp')).toHaveLength(1);
    expect(t.db.acct(ACC_B_SMS)).toEqual(b0); expect(t.db.acct(ACC_A_SMS)).toEqual(sms0);
  });
  it('stores a secret REFERENCE only: the response and the statements carry the ref, there is no way to send a secret value', async () => {
    const t = w(); for (const extra of [{ secret: 'p4ssw0rd-SENTINEL' }, { secret_value: 'p4ssw0rd-SENTINEL' }, { api_key: 'p4ssw0rd-SENTINEL' }, { callback_token_sha256: 'AA' }, { tenant_id: TENANT_B }, { version: 99 }])
      expect(await code(putAcct(t, 'sms', okAcct(extra))), JSON.stringify(extra)).toBe('common.validation_failed');
    nothingWritten(t); expect(t.everything()).not.toContain('p4ssw0rd-SENTINEL');
  });
  it.each([
    ['secret_ref with a space', { secret_ref: 'has space' }], ['secret_ref upper case', { secret_ref: 'Secrets/SMS' }], ['secret_ref path traversal chars', { secret_ref: '../../etc/passwd;rm' }],
    ['secret_ref 129 chars', { secret_ref: 'a'.repeat(129) }], ['secret_ref empty', { secret_ref: '' }], ['secret_ref missing', { secret_ref: undefined }],
    ['sender_id 65 chars', { sender_id: 'x'.repeat(65) }], ['unknown provider_kind', { provider_kind: 'sms_twilio' }], ['provider_kind missing', { provider_kind: undefined }],
    ['is_active not boolean', { is_active: 'true' }], ['is_active missing', { is_active: undefined }],
  ])('%s -> common.validation_failed, nothing written', async (_n, over) => {
    const t = w(); expect(await code(putAcct(t, 'sms', okAcct(over as Record<string, unknown>)))).toBe('common.validation_failed'); nothingWritten(t);
  });
  it('boundaries: secret_ref of exactly 128 chars and sender_id of exactly 64 chars are accepted', async () => {
    expect((await putAcct(w(), 'sms', okAcct({ secret_ref: 'a'.repeat(128), sender_id: 's'.repeat(64) }))).status).toBe(200);
  });
  it('a channel other than whatsapp|sms|email is rejected', async () => {
    const t = w(); for (const ch of ['print', 'portal', "sms' OR 1=1 --"]) expect(await code(putAcct(t, ch, okAcct())), ch).toBe('common.validation_failed'); nothingWritten(t);
  });
  it('provider_kind `recording` is accepted outside production and REJECTED in production (REQ-SEC-136)', async () => {
    expect((await putAcct(w(), 'email', okAcct({ provider_kind: 'recording', sender_id: undefined }))).status).toBe(200);
    const saved = { core: process.env.LIMS_CORE_ENV, real: process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS };
    try {
      process.env.LIMS_CORE_ENV = 'production'; process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS = 'true';
      const t = w(); expect(await code(putAcct(t, 'email', okAcct({ provider_kind: 'recording' }), { env: { ...process.env } }))).toBe('common.validation_failed'); nothingWritten(t);
      expect((await putAcct(w(), 'email', okAcct({ provider_kind: 'email_smtp_relay' }), { env: { ...process.env } })).status).toBe(200);
    } finally {
      process.env.LIMS_CORE_ENV = saved.core; if (saved.real === undefined) delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; else process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS = saved.real;
    }
  });
  it('the UPDATE never touches callback_token_sha256 (rotation is C3 only) and is tenant-scoped', async () => {
    const t = w(); await putAcct(t, 'whatsapp', okAcct({ provider_kind: 'whatsapp_cloud_api' }));
    for (const s of t.db.writes().filter((x) => /channel_accounts/.test(x.text))) { expect(s.text).toMatch(/\btenant_id\b/); expect(s.values).toContain(TENANT_A); }
    for (const s of t.db.writes().filter((x) => x.verb === 'update')) expect(s.text.replace(/\bwhere\b[\s\S]*$/i, '')).not.toMatch(/callback_token_sha256/i);
    for (const s of t.db.writes().filter((x) => /do\s+update\s+set/i.test(x.text))) expect(/do\s+update\s+set([\s\S]*?)(?:\breturning\b|$)/i.exec(s.text)![1]).not.toMatch(/callback_token_sha256/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------- C3
describe('C3 rotateChannelCallbackToken', () => {
  const urlTokenOf = (r: any): string => TOKEN_URL.exec(r.body.callback_url)![1]!;
  it('201 {callback_url} only; the URL ends in a 256-bit base64url token; version +1; only sha256(token) is stored', async () => {
    const t = w(); const r = await rotate(t, 'sms', ifm(3));
    expect(r.status).toBe(201); expect(Object.keys(r.body)).toEqual(['callback_url']); expect(r.body.callback_url).toMatch(TOKEN_URL);
    const token = urlTokenOf(r); const row = t.db.acct(ACC_A_SMS);
    expect(Buffer.from(row['callback_token_sha256']).equals(sha256buf(token))).toBe(true); expect(Buffer.from(row['callback_token_sha256'])).toHaveLength(32);
    expect(row).toMatchObject({ version: 4, updated_by: USER });
    expect(Object.values(row).map((v) => (typeof v === 'string' ? v : '')).some((v) => v.includes(token))).toBe(false);
  });
  it('rotating replaces an existing token: the old hash is gone, a different one is stored, C1 keeps showing configured', async () => {
    const t = w(); const r = await rotate(t, 'whatsapp', ifm(1)); const token = urlTokenOf(r);
    const h = Buffer.from(t.db.acct(ACC_A_WA)['callback_token_sha256']);
    expect(h.equals(sha256buf(OLD_TOKEN))).toBe(false); expect(h.equals(sha256buf(token))).toBe(true); expect(token).not.toBe(OLD_TOKEN);
    expect((await t.run(OP.listC)).body.data.find((x: any) => x.id === ACC_A_WA).callback_url_configured).toBe(true);
  });
  it('each rotation yields a fresh unguessable token', async () => {
    const t = w(); const tokens = new Set<string>(); let v = 3;
    for (let i = 0; i < 5; i++) { tokens.add(urlTokenOf(await rotate(t, 'sms', ifm(v)))); v++; }
    expect(tokens.size).toBe(5);
  });
  it('done_when: the plaintext token appears in NO statement value, log, audit entry or metric, and no statement touches core.idempotency_keys', async () => {
    const t = w(); const r = await rotate(t, 'sms', { ...ifm(3), 'idempotency-key': 'KEY-SENTINEL-0001' }); const token = urlTokenOf(r);
    expect(t.db.idemStmts()).toHaveLength(0);
    const all = t.everything(); expect(all).not.toContain(token); expect(all).not.toContain(r.body.callback_url);
    for (const s of t.db.stmts) expect(JSON.stringify(s.values)).not.toContain(token);
    expect(t.db.stmts.some((s) => s.values.some((v) => v instanceof Uint8Array && Buffer.from(v).equals(sha256buf(token))))).toBe(true);   // the hash IS what gets bound
  });
  it('a client Idempotency-Key does not make the handler store or replay anything: two calls with the same key and the same stale version -> second is version_conflict', async () => {
    const t = w(); const h = { ...ifm(3), 'idempotency-key': 'KEY-SENTINEL-0002' };
    expect((await rotate(t, 'sms', h)).status).toBe(201);
    expect(await code(rotate(t, 'sms', h))).toBe('common.version_conflict');
    expect(t.db.idemStmts()).toHaveLength(0);
  });
  it('If-Match is required: absent -> common.precondition_required, nothing written, no token minted', async () => {
    const t = w(); expect(await code(rotate(t, 'sms'))).toBe('common.precondition_required');
    nothingWritten(t); expect(t.db.acct(ACC_A_SMS)).toMatchObject({ version: 3, callback_token_sha256: null });
  });
  it('stale If-Match -> common.version_conflict (a double submit gets 409), nothing written, the stored hash is unchanged', async () => {
    const t = w(); const before = Buffer.from(t.db.acct(ACC_A_WA)['callback_token_sha256']);
    for (const v of [2, 3, 99]) expect(await code(rotate(t, 'whatsapp', ifm(v))), String(v)).toBe('common.version_conflict');
    nothingWritten(t); expect(Buffer.from(t.db.acct(ACC_A_WA)['callback_token_sha256']).equals(before)).toBe(true);
  });
  it('double submit with the same If-Match: exactly one wins, the token of the loser is never stored', async () => {
    const t = w(); const first = await rotate(t, 'sms', ifm(3)); const stored = Buffer.from(t.db.acct(ACC_A_SMS)['callback_token_sha256']);
    expect(await code(rotate(t, 'sms', ifm(3)))).toBe('common.version_conflict');
    expect(Buffer.from(t.db.acct(ACC_A_SMS)['callback_token_sha256']).equals(stored)).toBe(true); expect(stored.equals(sha256buf(urlTokenOf(first)))).toBe(true); expect(t.db.acct(ACC_A_SMS)['version']).toBe(4);
  });
  it('two concurrent rotations with the same If-Match: one 201, one common.version_conflict', async () => {
    const t = w(); const res = await Promise.allSettled([rotate(t, 'sms', ifm(3)), rotate(t, 'sms', ifm(3))]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1); const rej = res.find((x) => x.status === 'rejected') as PromiseRejectedResult; expect(rej.reason.code).toBe('common.version_conflict');
    expect(t.db.acct(ACC_A_SMS)['version']).toBe(4);
  });
  it('malformed If-Match is rejected without a write (never a 500)', async () => {
    const t = w(); for (const h of ['abc', '"0"', '"-1"', '"1e3"', '"99999999999999999999"']) expect(['common.validation_failed', 'common.precondition_required', 'common.version_conflict'], h).toContain(await code(rotate(t, 'sms', { 'if-match': h })));
    nothingWritten(t);
  });
  it('no account for the channel -> common.not_found, nothing written', async () => {
    const t = w(); expect(await code(rotate(t, 'email', ifm(1)))).toBe('common.not_found'); nothingWritten(t);
  });
  it('BOLA: tenant A cannot rotate tenant B\'s account, even with B\'s version number; B\'s hash is untouched', async () => {
    const t = w(); const b0 = snap(t.db.acct(ACC_B_SMS));
    expect(await code(rotate(t, 'sms', ifm(1)))).toBe('common.version_conflict');   // A's sms is at version 3; B's version 1 is not A's
    expect(t.db.acct(ACC_B_SMS)).toEqual(b0); expect(Buffer.from(t.db.acct(ACC_B_SMS)['callback_token_sha256']).equals(sha256buf(B_TOKEN))).toBe(true);
  });
  it('an invalid channel -> common.validation_failed', async () => {
    const t = w(); for (const ch of ['print', "sms' OR 1=1 --"]) expect(await code(rotate(t, ch, ifm(1))), ch).toBe('common.validation_failed'); nothingWritten(t);
  });
  it('the UPDATE is optimistic-locked and tenant-scoped (version = $n, tenant_id = $n) and bumps version', async () => {
    const t = w(); await rotate(t, 'sms', ifm(3)); const upd = t.db.writes().filter((s) => s.verb === 'update' && /channel_accounts/.test(s.text)); expect(upd.length).toBe(1);
    expect(upd[0]!.text).toMatch(/\btenant_id\s*=\s*\$\d+/); expect(upd[0]!.text).toMatch(/\bversion\s*=\s*\$\d+/); expect(upd[0]!.text).toMatch(/\bversion\s*=\s*(?:\w+\.)?version\s*\+\s*1/i); expect(upd[0]!.values).toContain(TENANT_A);
  });
});

describe('error bodies never echo input or secrets', () => {
  it('a rejected M2 / C2 / C3 call does not put the planted values into the error', async () => {
    const t = w(); const planted = 'PLANTED-7c1e';
    const errs = [
      await rejection(putText(t, REPORT_READY, 'whatsapp', okText({ body_text: `{${planted}}` }), ifm(2))),
      await rejection(putAcct(t, 'sms', okAcct({ secret_ref: `BAD ${planted}` }))),
      await rejection(rotate(t, 'sms', ifm(77))),
    ];
    for (const e of errs) expect(JSON.stringify({ code: e.code, message: e.message, details: e.details, status: e.status })).not.toContain(planted);
  });
});

