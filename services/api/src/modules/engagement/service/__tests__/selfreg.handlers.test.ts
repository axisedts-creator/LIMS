// C16.T-L4 (API half) — E16 `createSelfRegistration` (POST /v1/engagement/me/profiles/self-registrations) + E17 `getSelfRegistration` (GET .../{self_registration_id}).
//  02-TRD §4.3.4 steps 1-3, §5 E16/E17; PRD US-EN-05.3, .4 (and the queued half of .1); 05-SCHEMA self_registrations + link_consents + settings; 07-SECURITY REQ-SEC-005 / REQ-SEC-139 / P2 data.
// tests: child age rule; consent version mismatch; feature off. The task half (US-EN-05.1, .2, .5) is services/worker/.../create_self_patient.test.ts.
// Fails now: handlers/index.ts maps createSelfRegistration / getSelfRegistration to the T-01 placeholder (common.service_unavailable); service/selfreg.service.ts does not exist.
//
// SEAMS (spec fixes behaviour, not file names; same convention as link.redeem-report.test.ts):
//   handlers.createSelfRegistration(req:{params,query,headers,body}, ctx) -> {status:202, headers:{'Cache-Control':'no-store'}, body: SelfRegistration {id, relationship, status:'queued'}}.
//   handlers.getSelfRegistration(req:{params:{self_registration_id}}, ctx) -> {status:200, body: SelfRegistration}.
//   ctx = {tenantId, actor:{type:'patient', id: membership_id}, tx, now(), audit, ports:{IdentityPort}, log, commitOnError()}; permission via IdentityPort.assertRole(ctx,{permission}) BEFORE any tx.query.
//   Account = engagement.accounts row of the actor's membership. Settings = engagement.settings of the tenant (single-table statements: FakeDb grammar).
//   Task enqueue = `SELECT app.enqueue_job('engagement.create_self_patient', payload, 'selfreg:<id>', ...)`; the payload is the writer's, but it must carry NO personal data (name / birth / phone / sex).
//   Age rule (TRD §4.3.4 step 2 + PRD US-EN-05.3): child requires birth_on XOR age_years with age < settings.minor_age_years; age = whole years completed on ctx.now() calendar date (2026-11-05; UTC date = Nepal date for the fixed clock).
//   Assumptions where the spec is silent (asserted only as a status class): non-patient / account-less actor -> 4xx.
//   NOT covered here: per-account profile limit max_profiles_per_account for E16 (TRD §4.3.4 names only the `self` rule), a second `self` request while an earlier one is still queued (unspecified), idempotency-key replay (core pipeline).
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { ACC1, ACC2, ID, NAME, PAT_OTHER_LINKED, PHONE1, T0, TB, VERSION, makeWorld, type World } from '../../__tests__/selfreg.world.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const MANAGE = 'engagement.self.manage', READ = 'engagement.self.read';
const IDEM = { 'idempotency-key': 'k-0001' };
const form = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ relationship: 'self', full_name: NAME, sex: 'female', birth_on: '1990-03-01', sms_consent: true, whatsapp_consent: false, consent_text_version: VERSION, ...o });
const child = (o: Record<string, unknown> = {}) => form({ relationship: 'child', full_name: 'Synthetic Child Sample', birth_on: '2018-06-01', ...o });
const create = (w: World, body: unknown, account = ACC1, over: Record<string, unknown> = {}) =>
  (handlers as any)['createSelfRegistration']({ params: {}, query: {}, headers: IDEM, body }, w.session(account, over));
const get = (w: World, id: unknown, account = ACC1, over: Record<string, unknown> = {}) =>
  (handlers as any)['getSelfRegistration']({ params: { self_registration_id: id }, query: {}, headers: {}, body: undefined }, w.session(account, { operationId: 'getSelfRegistration', ...over }));
const fail = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e: any) { return e; } throw new Error('expected rejection'); };
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'RESOLVED'; };
const paths = (e: any): string[] => (e.errors ?? []).map((x: any) => x.path);
const nothingWritten = (w: World) => { expect(w.writes()).toEqual([]); expect(w.jobs).toEqual([]); expect(w.regs()).toEqual([]); expect(w.consents()).toEqual([]); };
const scan = (w: World) => JSON.stringify({ logs: w.logs, audit: w.audit, jobs: w.jobs.map((j) => ({ p: j.payload, k: j.jobKey, v: j.values })) });

describe('contract: operations, permissions, fail-closed', () => {
  it('x-permission floors engagement.self.manage (E16) / engagement.self.read (E17); strict body; 202 / 200 SelfRegistration', () => {
    const e16 = opOf('createSelfRegistration'), e17 = opOf('getSelfRegistration');
    expect(e16['x-permission']).toBe(MANAGE); expect(e17['x-permission']).toBe(READ);
    expect(e16.requestBody.content['application/json'].schema).toMatchObject({ additionalProperties: false });
    expect(Object.keys(e16.responses)).toContain('202'); expect(Object.keys(e17.responses)).toContain('200');
  });
  it('both are real handlers (not the T-01 placeholder): a bare ctx fails closed with auth.unauthenticated', async () => {
    const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
    expect((await (handlers as any)['createSelfRegistration']({ params: {}, query: {}, headers: IDEM, body: form() }, bare).catch((x: unknown) => x))?.code).toBe('auth.unauthenticated');
    expect((await (handlers as any)['getSelfRegistration']({ params: { self_registration_id: ID(1) }, query: {}, headers: {} }, bare).catch((x: unknown) => x))?.code).toBe('auth.unauthenticated');
  });
  it('E16 asserts engagement.self.manage BEFORE any statement; a denied role -> 403 and nothing happens', async () => {
    const w = makeWorld(); await create(w, form());
    expect(w.identity.asserted[0]).toEqual({ permission: MANAGE, at: 0 });
    const d = makeWorld(); d.identity.deny.add(MANAGE);
    expect(await code(create(d, form()))).toBe('auth.forbidden'); expect(d.stmts).toEqual([]);
  });
  it('E17 asserts engagement.self.read BEFORE any statement; a denied role -> 403', async () => {
    const w = makeWorld(); const reg = w.seedQueuedReg(); await get(w, reg['id']);
    expect(w.identity.asserted[0]).toEqual({ permission: READ, at: 0 });
    const d = makeWorld(); const r2 = d.seedQueuedReg(); d.identity.deny.add(READ);
    expect(await code(get(d, r2['id']))).toBe('auth.forbidden'); expect(d.stmts).toEqual([]);
  });
  it('a non-patient actor, or a membership without an account, is refused (4xx) and writes nothing', async () => {
    const w = makeWorld();
    const e1 = await fail((handlers as any)['createSelfRegistration']({ params: {}, query: {}, headers: IDEM, body: form() }, w.session(ACC1, {}, 'user')));
    const e2 = await fail((handlers as any)['createSelfRegistration']({ params: {}, query: {}, headers: IDEM, body: form() }, w.session(ACC1, { actor: { type: 'patient', id: ID(0x999) } })));
    for (const e of [e1, e2]) { expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500); }
    expect(w.regs()).toEqual([]); expect(w.jobs).toEqual([]);
  });
});

describe('E16 accepted: US-EN-05.1 (queued half) + TRD §4.3.4 step 3', () => {
  it('202 SelfRegistration {id, relationship, status:queued}; no-store; body valid against the OpenAPI schema; no personal data echoed; FrontdeskPort not called by the request', async () => {
    const w = makeWorld(); const out = await create(w, form());
    expect(out.status).toBe(202); expect(out.headers?.['Cache-Control']).toBe('no-store');
    expect(schemaErrors('SelfRegistration', out.body)).toEqual([]);
    expect(out.body).toMatchObject({ relationship: 'self', status: 'queued' }); expect(out.body.profile_id).toBeUndefined(); expect(out.body.failure_code).toBeUndefined();
    expect(JSON.stringify(out.body)).not.toContain(NAME); expect(w.frontdesk.calls).toEqual([]);
  });
  it('inserts ONE self_registrations row: queued, the form fields, account of the caller, no patient / link yet; id = the returned id; expires_at in the future', async () => {
    const w = makeWorld(); const out = await create(w, form({ sms_consent: true, whatsapp_consent: true }));
    expect(w.regs()).toHaveLength(1); const r = w.regs()[0]!;
    expect(r).toMatchObject({ id: out.body.id, account_id: ACC1, relationship: 'self', full_name: NAME, sex: 'female', sms_consent: true, whatsapp_consent: true, status: 'queued', patient_id: null, link_id: null, failure_code: null });
    expect(String(r['birth_on']).slice(0, 10)).toBe('1990-03-01'); expect(r['age_years'] ?? null).toBeNull();
    expect(Date.parse(r['expires_at'])).toBeGreaterThan(Date.parse(T0));
    expect(w.links()).toEqual([]); // the link is created by the task, never by the request
  });
  it('age_years instead of birth_on is stored as age_years (birth_on stays null)', async () => {
    const w = makeWorld(); await create(w, form({ birth_on: undefined, age_years: 34 }));
    expect(w.regs()[0]).toMatchObject({ age_years: 34, birth_on: null });
  });
  it('REQ-SEC-005: one link_consents row {source app, account_id, consent_text_version = the setting, consented_by patient for self / guardian for child}; the registration points to it; patient_id still null', async () => {
    const w = makeWorld(); await create(w, form()); await create(w, child());
    expect(w.consents()).toHaveLength(2);
    const [c1, c2] = w.consents() as [any, any];
    expect(c1).toMatchObject({ source: 'app', account_id: ACC1, relationship: 'self', consented_by: 'patient', patient_id: null }); expect(c1.consent_text_version).toContain(VERSION);
    expect(c2).toMatchObject({ source: 'app', account_id: ACC1, relationship: 'child', consented_by: 'guardian', patient_id: null });
    expect(w.regs().map((r) => r['consent_id'])).toEqual([c1.id, c2.id]);
  });
  it('enqueues engagement.create_self_patient with job_key selfreg:<registration id> exactly once; payload names the registration but carries NO personal data', async () => {
    const w = makeWorld(); const out = await create(w, form({ full_name: 'Zzyzx Qwerty Sample' }));
    expect(w.jobs).toHaveLength(1); const j = w.jobs[0]!;
    expect(j.identifier).toBe('engagement.create_self_patient'); expect(j.jobKey).toBe(`selfreg:${out.body.id}`);
    expect(JSON.stringify(j.payload)).toContain(out.body.id);
    expect(JSON.stringify(j.payload)).not.toMatch(/Zzyzx|Qwerty|1990|female|\+977|phone|full_name|birth/i);
  });
  it('child with age_years < minor_age_years is accepted (relationship child, guardian consent)', async () => {
    const w = makeWorld(); const out = await create(w, child({ birth_on: undefined, age_years: 17 }));
    expect(out.status).toBe(202); expect(out.body.relationship).toBe('child');
  });
  it('self has NO age rule (an under-age birth date is accepted for the account owner)', async () => {
    const w = makeWorld(); expect((await create(w, form({ birth_on: '2015-01-01' }))).status).toBe(202);
  });
  it('personal data never reaches the logs, the audit trail or the job queue (P2 data)', async () => {
    const w = makeWorld(); await create(w, form({ full_name: 'Zzyzx Qwerty Sample', birth_on: '1971-02-03' }));
    expect(scan(w)).not.toMatch(/Zzyzx|Qwerty|1971-02-03/); expect(scan(w)).not.toContain(PHONE1);
  });
});

describe('US-EN-05.4 consent text version + feature switches', () => {
  it('a version different from settings.app_consent_text_version -> 400 common.validation_failed at /consent_text_version; nothing written', async () => {
    for (const v of ['v2026-0', VERSION.toUpperCase(), `${VERSION} `, 'app-' + VERSION]) {
      const w = makeWorld(); const e = await fail(create(w, form({ consent_text_version: v })));
      expect(e.code, v).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); expect(paths(e)).toContain('/consent_text_version'); nothingWritten(w);
    }
  });
  it('the error does not echo the submitted or the configured version', async () => {
    const w = makeWorld(); const e = await fail(create(w, form({ consent_text_version: 'v-secret-guess' }))); expect(e.code).toBe('common.validation_failed');
    expect(JSON.stringify({ d: e.detail, er: e.errors, m: e.message })).not.toMatch(/v-secret-guess|v2026-1/);
  });
  it('tenant without an app consent text (setting NULL) -> 403 common.feature_disabled, whatever version is submitted; nothing written', async () => {
    for (const v of [VERSION, 'v-anything']) {
      const w = makeWorld({ settings: { app_consent_text: null, app_consent_text_version: null } });
      const e = await fail(create(w, form({ consent_text_version: v })));
      expect(e.code).toBe('common.feature_disabled'); expect(e.statusCode).toBe(403); nothingWritten(w);
    }
  });
  it('the feature check comes before the field checks: unset consent text + an otherwise invalid form is still 403', async () => {
    const w = makeWorld({ settings: { app_consent_text: null, app_consent_text_version: null } });
    expect(await code(create(w, child({ birth_on: '1990-01-01' })))).toBe('common.feature_disabled');
  });
  it('tenant with app_enabled = false -> 403 common.feature_disabled; nothing written', async () => {
    const w = makeWorld({ settings: { app_enabled: false } });
    expect(await code(create(w, form()))).toBe('common.feature_disabled'); nothingWritten(w);
  });
  it('a tenant that has no settings row at all fails closed (4xx/5xx, never 202) and writes nothing', async () => {
    const w = makeWorld({ seed: ({ tables }) => { tables['settings']!.length = 0; } });
    const e = await fail(create(w, form())); expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.code).not.toBe('common.service_unavailable'); expect(w.regs()).toEqual([]); expect(w.jobs).toEqual([]);
  });
});

describe('US-EN-05.3 child age rule (age < settings.minor_age_years; birth_on or age_years)', () => {
  // ctx.now() = 2026-11-05: born 2008-11-05 is exactly 18 today; born 2008-11-06 is 17 (turns 18 tomorrow).
  it('birth_on: exactly 18 today -> 400 at /birth_on, nothing written', async () => {
    const w = makeWorld(); const e = await fail(create(w, child({ birth_on: '2008-11-05' })));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); expect(paths(e)).toContain('/birth_on'); nothingWritten(w);
  });
  it('birth_on: one day short of 18 -> accepted', async () => { expect((await create(makeWorld(), child({ birth_on: '2008-11-06' }))).status).toBe(202); });
  it('birth_on: an adult (1990) -> 400 at /birth_on', async () => {
    const w = makeWorld(); const e = await fail(create(w, child({ birth_on: '1990-01-01' }))); expect(paths(e)).toContain('/birth_on'); nothingWritten(w);
  });
  it('birth_on: leap-day birth 2008-02-29 is 18 on 2026-11-05 -> rejected; 2008-12-31 is 17 -> accepted', async () => {
    expect(await code(create(makeWorld(), child({ birth_on: '2008-02-29' })))).toBe('common.validation_failed');
    expect((await create(makeWorld(), child({ birth_on: '2008-12-31' }))).status).toBe(202);
  });
  it('age_years: 18 -> 400 at /age_years; 17 -> accepted; 0 -> accepted', async () => {
    const w = makeWorld(); const e = await fail(create(w, child({ birth_on: undefined, age_years: 18 })));
    expect(e.code).toBe('common.validation_failed'); expect(paths(e)).toContain('/age_years'); nothingWritten(w);
    for (const a of [17, 0]) expect((await create(makeWorld(), child({ birth_on: undefined, age_years: a }))).status, String(a)).toBe(202);
  });
  it('the limit is the TENANT setting: minor_age_years 21 -> age 20 accepted, 21 rejected; 14 -> 14 rejected, 13 accepted', async () => {
    expect((await create(makeWorld({ settings: { minor_age_years: 21 } }), child({ birth_on: undefined, age_years: 20 }))).status).toBe(202);
    expect(await code(create(makeWorld({ settings: { minor_age_years: 21 } }), child({ birth_on: undefined, age_years: 21 })))).toBe('common.validation_failed');
    expect(await code(create(makeWorld({ settings: { minor_age_years: 14 } }), child({ birth_on: undefined, age_years: 14 })))).toBe('common.validation_failed');
    expect((await create(makeWorld({ settings: { minor_age_years: 14 } }), child({ birth_on: undefined, age_years: 13 }))).status).toBe(202);
  });
  it('a future birth_on is rejected (no negative age slips through the child rule)', async () => {
    expect(await code(create(makeWorld(), child({ birth_on: '2027-01-01' })))).toBe('common.validation_failed');
  });
  it('birth_on XOR age_years: both -> 400; neither -> 400 (self and child alike); nothing written', async () => {
    for (const o of [{ birth_on: '2018-06-01', age_years: 8 }, { birth_on: undefined, age_years: undefined }]) {
      for (const f of [form(o), child(o)]) { const w = makeWorld(); expect(await code(create(w, f))).toBe('common.validation_failed'); nothingWritten(w); }
    }
  });
});

describe('E16 validation (strict body) and limits', () => {
  const bad: Array<[string, Record<string, unknown>, string]> = [
    ['unknown relationship', form({ relationship: 'parent' }), '/relationship'], ['relationship missing', form({ relationship: undefined }), '/relationship'],
    ['full_name empty', form({ full_name: '' }), '/full_name'], ['full_name 201 chars', form({ full_name: 'A'.repeat(201) }), '/full_name'], ['full_name not a string', form({ full_name: 42 }), '/full_name'],
    ['sex outside the enum', form({ sex: 'x' }), '/sex'], ['sex missing', form({ sex: undefined }), '/sex'],
    ['birth_on not a date', form({ birth_on: '2020-13-45' }), '/birth_on'], ['age_years 151', form({ birth_on: undefined, age_years: 151 }), '/age_years'], ['age_years -1', form({ birth_on: undefined, age_years: -1 }), '/age_years'],
    ['age_years not an integer', form({ birth_on: undefined, age_years: 3.5 }), '/age_years'],
    ['sms_consent not boolean', form({ sms_consent: 'yes' }), '/sms_consent'], ['whatsapp_consent missing', form({ whatsapp_consent: undefined }), '/whatsapp_consent'],
    ['consent_text_version empty', form({ consent_text_version: '' }), '/consent_text_version'], ['consent_text_version 33 chars', form({ consent_text_version: 'v'.repeat(33) }), '/consent_text_version'],
    ['client-supplied phone_e164', form({ phone_e164: '+9779800000002' }), '/phone_e164'], ['client-supplied patient_id', form({ patient_id: ID(0x11) }), '/patient_id'], ['client-supplied status', form({ status: 'created' }), '/status'],
  ];
  it.each(bad)('%s -> 400 common.validation_failed (path %s), nothing written, no echo of the value', async (_n, body, path) => {
    const w = makeWorld(); const e = await fail(create(w, body));
    expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400); expect(paths(e)).toContain(path); nothingWritten(w);
  });
  it('a non-object body -> 400', async () => { for (const b of [null, 'x', [], 7]) { const w = makeWorld(); expect(await code(create(w, b))).toBe('common.validation_failed'); nothingWritten(w); } });
  it('self when the account already has an active self link -> 409 engagement.link_limit_reached, nothing written', async () => {
    const w = makeWorld(); w.seedLink({ relationship: 'self' });
    const e = await fail(create(w, form())); expect(e.code).toBe('engagement.link_limit_reached'); expect(e.statusCode).toBe(409); nothingWritten(w);
  });
  it('child is NOT blocked by an existing self link; self is NOT blocked by an existing non-self link or by another account\'s self link', async () => {
    const w = makeWorld(); w.seedLink({ relationship: 'self' });
    expect((await create(w, child())).status).toBe(202);
    const w2 = makeWorld(); w2.seedLink({ relationship: 'other' }); expect((await create(w2, form())).status).toBe(202);
    const w3 = makeWorld(); w3.seedLink({ account_id: ACC2, relationship: 'self', patient_id: ID(0x13) }); expect((await create(w3, form())).status).toBe(202);
  });
  it('a revoked self link does not block a new self registration', async () => {
    const w = makeWorld(); w.seedLink({ relationship: 'self', status: 'revoked', revoked_by_kind: 'account', revoked_at: '2026-10-10T00:00:00.000Z' });
    expect((await create(w, form())).status).toBe(202);
  });
  it('a validation failure after the settings read leaves no consent row behind (all or nothing)', async () => {
    const w = makeWorld(); expect((await fail(create(w, child({ birth_on: '1990-01-01' })))).code).toBe('common.validation_failed'); expect(w.consents()).toEqual([]); expect(w.regs()).toEqual([]);
  });
});

describe('E17 getSelfRegistration', () => {
  it('queued: 200 {id, relationship, status:queued}; no personal data, no patient_id / link_id leak; no-store; schema-valid', async () => {
    const w = makeWorld(); const reg = w.seedQueuedReg(); const out = await get(w, reg['id']);
    expect(out.status).toBe(200); expect(out.headers?.['Cache-Control']).toBe('no-store');
    expect(schemaErrors('SelfRegistration', out.body)).toEqual([]); expect(out.body).toEqual({ id: reg['id'], relationship: 'self', status: 'queued' });
  });
  it('created: status created and profile_id = the link id (not the patient id)', async () => {
    const w = makeWorld(); const link = w.seedLink({ id: ID(0xc9), method: 'self_registered' });
    const reg = w.seedQueuedReg({ status: 'created', patient_id: PAT_OTHER_LINKED, link_id: link['id'] });
    const out = await get(w, reg['id']);
    expect(out.body).toEqual({ id: reg['id'], relationship: 'self', status: 'created', profile_id: link['id'] }); expect(schemaErrors('SelfRegistration', out.body)).toEqual([]);
  });
  it('failed: status failed + failure_code, no profile_id (the app offers a retry = a new request)', async () => {
    const w = makeWorld(); const reg = w.seedQueuedReg({ relationship: 'child', status: 'failed', failure_code: 'frontdesk.consent_required' });
    const out = await get(w, reg['id']);
    expect(out.body).toEqual({ id: reg['id'], relationship: 'child', status: 'failed', failure_code: 'frontdesk.consent_required' }); expect(schemaErrors('SelfRegistration', out.body)).toEqual([]);
  });
  it('after the 30-day purge (personal fields NULL, status created) the read still works', async () => {
    const w = makeWorld(); const link = w.seedLink({ id: ID(0xc9), method: 'self_registered' });
    const reg = w.seedQueuedReg({ status: 'created', patient_id: PAT_OTHER_LINKED, link_id: link['id'], full_name: null, sex: null, birth_on: null, age_years: null });
    expect((await get(w, reg['id'])).body).toMatchObject({ status: 'created', profile_id: link['id'] });
  });
  it('another account\'s registration, an unknown id and another tenant\'s id are the SAME 404 common.not_found (no existence oracle)', async () => {
    const w = makeWorld(); const reg = w.seedQueuedReg();
    const shapes = [] as string[];
    for (const run of [() => get(w, reg['id'], ACC2), () => get(w, ID(0xdead)), () => get(makeWorld({ seed: ({ tables }) => { tables['self_registrations'] = []; } }), reg['id'])]) {
      const e = await fail(run()); expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404);
      shapes.push(JSON.stringify({ s: e.statusCode, c: e.code, m: e.message, d: e.detail, er: e.errors }));
    }
    expect(new Set(shapes).size).toBe(1);
  });
  it('reads nothing but the caller\'s own row and writes nothing', async () => {
    const w = makeWorld(); const reg = w.seedQueuedReg(); const before = w.writes().length; await get(w, reg['id']);
    expect(w.writes().length).toBe(before); expect(w.audit.event).toEqual([]);
  });
  it('a registration of tenant B is invisible from tenant A (tenant isolation)', async () => {
    const w = makeWorld(); const reg = w.seedQueuedReg({ tenant_id: TB });
    expect(await code(get(w, reg['id']))).toBe('common.not_found');
  });
});
