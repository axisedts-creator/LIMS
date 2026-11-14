// C16.T-L1 — L1 issueLinkCode, L2 revokeLinkCode, L3 listPatientAppLinks, L4 revokeAppLink + link_consents (staff side of linking).
// (06-PLAN row T-L1; 02-TRD §4.3 constants + §4.3.1, §5 L1-L4, §5.4 (no-store), §13 metric; 05-SCHEMA link_consents / link_codes / account_patient_links;
//  01-PRD US-EN-03.1, 03.6, 03.7, 06.6; 07-SECURITY §3 L1 row, §6.1 cross-tenant, §6.5 actor confusion, REQ-SEC log denylist; 08 A2.4/A5.5 raw 32-byte bytea HMACs.)
// done_when: code shown once; code_hmac / bound_phone_hmac / record_phone_hmac stored as 32-byte bytea; access log; volume metric (FrontdeskPort fake, CR-C16-007).
// tests: integration; probes (staff of tenant B; patient actor -> 403).
// Fails now: handlers/index.ts maps issueLinkCode / revokeLinkCode / listPatientAppLinks / revokeAppLink to the T-01 placeholder (common.service_unavailable).
//
// SEAMS (spec does not fix them; same convention as booking.handlers.test.ts):
//   handlers[op](req:{params,query,headers,body}, ctx) -> {status, body, headers?}; tenant and actor come from ctx only. ctx = {tenantId, actor, tx, now, log, audit:{access}, metrics:{inc},
//   ports:{IdentityPort, FrontdeskPort}}. FrontdeskPort = the REAL C0 fake (packages/fakes FrontdeskPort.fake.ts, purpose 'patient_app_link', needs the engagement.link.issue permission).
//   IdentityPort.assertRole(ctx,{permission}) is called BEFORE any tx.query (L1 engagement.link.issue, L2/L4 engagement.link.revoke, L3 engagement.link.read).
//   DB = the in-house SQL interpreter fakeSql.ts (no OR/JOIN/sub-select, no rollback). HMAC keys = the test-env key files (LIMS_ENGAGEMENT_LINK_HMAC_KEY_FILE / _PHONE_HMAC_KEY_FILE).
//   Metric: ctx.metrics.inc('lims_engagement_link_events_total', {method, outcome}) (TRD §13; outcome `issued` / `revoked`) is the "volume metric" of the plan row.
//   Access log: ctx.audit.access({action, entityType, entityId, outcome}) with the codes of TRD §5.5 (L1 link_code.issue / patient; L4 app_link.revoke / app_link).
//   ASSUMPTION (flagged in .orchestra/notes/T-L1-tests.md): link_codes has no version column, so L2's If-Match is accepted as the constant ETag "1"; L2 without If-Match -> 428 (x-error-codes).
//   NOT covered here (owned by T-L2 / DB tests): the DEFINER app.engagement_redeem_link_code (bytea = bytea at redemption), failure counters, RLS policy text.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { TENANTS, idFor } from '../../../../../../../packages/fakes/src/base';
import { createFakeFrontdeskPort } from '../../../../../../../packages/fakes/src/FrontdeskPort.fake';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { LINK_CODE_ALPHABET, normalizeLinkCode } from '../../domain/linkCode.js';
import { maskPhone } from '../../domain/phone.js';
import { FakeDb, type Call, type Row, type TableDef } from '../../__tests__/fakeSql.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (schema: object, x: unknown): string[] => {
  const v = ajv.compile({ ...schema, components: spec.components });
  return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`);
};
const named = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };
const okSchema = (op: string, status: string) => opOf(op).responses[status].content['application/json'].schema;

const A: string = TENANTS.A;
const B: string = TENANTS.B;
const ID = (n: number) => `01950c16-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = '2026-11-10T04:15:00.000Z';
const plusH = (iso: string, h: number) => new Date(Date.parse(iso) + h * 3_600_000).toISOString();
const ISSUE = 'engagement.link.issue', REVOKE = 'engagement.link.revoke', READ = 'engagement.link.read';

// ---------------------------------------------------------------- fixtures (synthetic only)
const PH = { REC: '+9779841000011', MINOR_REC: '+9779841000012', GUARDIAN: '+9779851000013', OTHER: '+9779851000014', BAD_PREFIX: '+14155550100' };
const PT = (n: number) => idFor(1, 0x700 + n);       // FrontdeskPort fake ids (seed 1)
const P = { REC: PT(1), NOPHONE: PT(2), MERGED: PT(3), BUSY: PT(4), OK: PT(5), MINOR: PT(6), CODES: PT(7), LIST: PT(8), EMPTY: PT(9), B_ONLY: PT(10), UNKNOWN: PT(99) };
const NAME = { REC: 'Rupa Synthetic Recordphone', MINOR: 'Milan Synthetic Minor' };
const CONSENTS = { sms: true, whatsapp: false, email: false, shareWithReferrer: false, consentTextVersion: 'v1' };
const pat = (id: string, o: Record<string, unknown> = {}, tenantId: string = A) => ({ id, tenantId, patientCode: `P-${id.slice(-4)}`, fullName: 'Synthetic Patient', sex: 'female', birthOn: '1990-01-01', consents: CONSENTS, status: 'active', ...o });
const patients = () => [
  pat(P.REC, { fullName: NAME.REC, phoneE164: PH.REC, sex: 'female' }), pat(P.NOPHONE, { fullName: 'Nima Synthetic Nophone' }), pat(P.MERGED, { phoneE164: PH.REC, status: 'merged' }),
  pat(P.BUSY, { phoneE164: PH.REC }), pat(P.OK, { phoneE164: PH.REC }), pat(P.MINOR, { fullName: NAME.MINOR, sex: 'male', birthOn: '2018-05-05', phoneE164: PH.MINOR_REC }),
  pat(P.CODES, { phoneE164: PH.REC }), pat(P.LIST, { fullName: 'Lila Synthetic Listed', phoneE164: PH.REC }), pat(P.EMPTY, { phoneE164: PH.REC }), pat(P.B_ONLY, { phoneE164: PH.REC }, B),
];

const ACC = (n: number) => ID(0xa00 + n);
const acc = (n: number, phone: string, tenant: string = A): Row => ({ id: ACC(n), tenant_id: tenant, phone_e164: phone, phone_hmac: Buffer.alloc(32, n), status: 'active' });
const H32 = (n: number) => Buffer.alloc(32, n);
const lk = (n: number, patient: string, account: number, o: Row = {}): Row => ({
  id: ID(0xb00 + n), tenant_id: A, account_id: ACC(account), patient_id: patient, relationship: 'self', method: 'link_code', link_code_id: null, consent_id: null, display_name: 'Synthetic Patient', sex_snapshot: 'female',
  status: 'active', suspend_reason: null, suspended_at: null, visible_from: null, record_phone_hmac_at_link: H32(9), revoked_by_kind: null, revoked_reason_code: null, revoked_at: null,
  version: 1, is_active: true, created_at: NOW, created_by: A, updated_at: NOW, updated_by: A, ...o });
const lc = (n: number, patient: string, createdAgoH: number, o: Row = {}): Row => ({
  id: ID(0xc00 + n), tenant_id: A, patient_id: patient, code_hmac: H32(0x40 + n), bound_phone_hmac: H32(0x60 + n), bound_phone_last2: '11', record_phone_hmac: null, relationship: 'self', consent_id: ID(0xd00 + n),
  display_name_snapshot: 'Synthetic Patient', sex_snapshot: 'female', issued_by_membership_id: A, issued_centre_id: null, status: 'issued', revoke_reason: null, redeemed_at: null, redeemed_account_id: null,
  created_at: plusH(NOW, -createdAgoH), created_by: A, expires_at: plusH(NOW, 72 - createdAgoH), updated_at: plusH(NOW, -createdAgoH), updated_by: A, ...o });
const settings = (o: Row = {}): Row => ({ id: ID(0xe01), tenant_id: A, app_enabled: true, allowed_phone_prefixes: ['+977'], app_consent_text_version: 'v3', max_profiles_per_account: 8, max_accounts_per_patient: 3, link_code_ttl_hours: 72, version: 1, ...o });

const seed = (o: { settings?: Row } = {}): Record<string, Row[]> => ({
  settings: [settings(o.settings), settings({ id: ID(0xe02), tenant_id: B, app_consent_text_version: 'vB' })],
  accounts: [acc(1, PH.REC), acc(2, PH.OTHER), acc(3, PH.GUARDIAN), acc(4, '+9779861000015'), acc(5, '+9779861000016'), acc(9, PH.REC, B)],
  // P_BUSY: 3 active links = max_accounts_per_patient (default 3); P_OK: 2 active + revoked + suspended (only active ones count)
  account_patient_links: [
    lk(1, P.BUSY, 1), lk(2, P.BUSY, 2, { relationship: 'other' }), lk(3, P.BUSY, 3, { relationship: 'other' }),
    lk(4, P.OK, 1), lk(5, P.OK, 2, { relationship: 'other' }), lk(6, P.OK, 3, { relationship: 'other', status: 'revoked', revoked_by_kind: 'account', revoked_reason_code: 'patient_request', revoked_at: NOW }),
    lk(7, P.OK, 4, { relationship: 'other', status: 'suspended', suspend_reason: 'phone_mismatch', suspended_at: NOW }),
    // P_LIST: one of each state, version 2 on the active one (L4 If-Match)
    lk(8, P.LIST, 1, { version: 2 }), lk(9, P.LIST, 2, { relationship: 'other', status: 'revoked', revoked_by_kind: 'staff', revoked_reason_code: 'staff_error', revoked_at: NOW }),
    lk(10, P.LIST, 4, { relationship: 'other', status: 'suspended', suspend_reason: 'dormant', suspended_at: NOW }),
    { ...lk(11, P.B_ONLY, 9), tenant_id: B },
  ],
  // one consent per seeded code (FK link_codes__consent__fk, 05-SCHEMA:328); n=10 is tenant B's code
  link_consents: [
    ...[[1, P.CODES], [2, P.CODES], [3, P.CODES], [4, P.CODES], [5, P.CODES], [6, P.CODES], [7, P.LIST], [8, P.LIST], [9, P.LIST], [10, P.B_ONLY]].map(([n, patient]) => ({
      id: ID(0xd00 + (n as number)), tenant_id: n === 10 ? B : A, source: 'desk', patient_id: patient as string, relationship: 'self', consented_by: 'patient', consent_text_version: 'v1',
      identity_check_method: 'photo_id', recorded_by_membership_id: A, created_by: A } as Row)),
  ],
  link_codes: [
    // P_CODES: three unexpired issued codes (oldest 30h, 20h, 10h) + expired-issued + redeemed + revoked (none of the last three counts toward the cap of 3)
    lc(1, P.CODES, 30), lc(2, P.CODES, 20), lc(3, P.CODES, 10),
    lc(4, P.CODES, 100, { expires_at: plusH(NOW, -28) }), lc(5, P.CODES, 40, { status: 'redeemed', redeemed_at: plusH(NOW, -5), redeemed_account_id: ACC(1) }), lc(6, P.CODES, 50, { status: 'revoked', revoke_reason: 'staff' }),
    // P_LIST: one issued, one redeemed, one revoked
    lc(7, P.LIST, 2), lc(8, P.LIST, 30, { status: 'redeemed', redeemed_at: plusH(NOW, -20), redeemed_account_id: ACC(1) }), lc(9, P.LIST, 40, { status: 'revoked', revoke_reason: 'staff' }),
    { ...lc(10, P.B_ONLY, 2), tenant_id: B },
  ],
});

const defs = (clock: { iso: string }): Record<string, TableDef> => ({
  settings: { columns: ['id', 'tenant_id', 'app_enabled', 'allowed_phone_prefixes', 'app_consent_text_version', 'max_profiles_per_account', 'max_accounts_per_patient', 'link_code_ttl_hours', 'version'] },
  accounts: { columns: ['id', 'tenant_id', 'phone_e164', 'phone_hmac', 'status'] },
  account_patient_links: {
    columns: ['id', 'tenant_id', 'account_id', 'patient_id', 'relationship', 'method', 'link_code_id', 'consent_id', 'display_name', 'sex_snapshot', 'status', 'suspend_reason', 'suspended_at', 'visible_from', 'record_phone_hmac_at_link',
      'revoked_by_kind', 'revoked_reason_code', 'revoked_at', 'version', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'],
    notNull: ['id', 'tenant_id', 'account_id', 'patient_id', 'relationship', 'method', 'display_name', 'status', 'version', 'created_by', 'updated_by'], defaults: { status: 'active', version: 1, is_active: true, created_at: clock.iso, updated_at: clock.iso },
    unique: [['tenant_id', 'id']],
    check: (r) => !['active', 'pending', 'suspended', 'revoked'].includes(r['status']) ? 'account_patient_links__status__ck' : (r['status'] === 'revoked') !== (r['revoked_at'] != null) ? 'account_patient_links__revoked__ck' : undefined,
  },
  link_consents: {
    columns: ['id', 'tenant_id', 'patient_id', 'account_id', 'source', 'relationship', 'consented_by', 'consent_text_version', 'identity_check_method', 'recorded_by_membership_id', 'recorded_at', 'created_at', 'created_by'],
    notNull: ['id', 'tenant_id', 'source', 'relationship', 'consented_by', 'consent_text_version', 'created_by'], defaults: { recorded_at: clock.iso, created_at: clock.iso }, unique: [['tenant_id', 'id']],
    check: (r) => !['self', 'child', 'parent', 'spouse', 'sibling', 'other'].includes(r['relationship']) ? 'link_consents__relationship__ck' : !['patient', 'guardian'].includes(r['consented_by']) ? 'link_consents__by__ck'
      : !(r['source'] === 'desk' && r['patient_id'] != null && r['identity_check_method'] != null && r['recorded_by_membership_id'] != null) ? 'link_consents__shape__ck' : undefined,
  },
  link_codes: {
    columns: ['id', 'tenant_id', 'patient_id', 'code_hmac', 'bound_phone_hmac', 'bound_phone_last2', 'record_phone_hmac', 'relationship', 'consent_id', 'display_name_snapshot', 'sex_snapshot', 'issued_by_membership_id', 'issued_centre_id', 'status',
      'revoke_reason', 'redeemed_at', 'redeemed_account_id', 'created_at', 'created_by', 'expires_at', 'updated_at', 'updated_by'],
    notNull: ['id', 'tenant_id', 'patient_id', 'code_hmac', 'bound_phone_hmac', 'bound_phone_last2', 'relationship', 'consent_id', 'display_name_snapshot', 'issued_by_membership_id', 'status', 'created_by', 'expires_at', 'updated_by'],
    defaults: { status: 'issued', created_at: clock.iso, updated_at: clock.iso }, unique: [['tenant_id', 'id']],
    fk: [{ cols: ['tenant_id', 'consent_id'], ref: 'link_consents', refCols: ['tenant_id', 'id'] }],
    check: (r) => !['issued', 'redeemed', 'revoked'].includes(r['status']) ? 'link_codes__status__ck' : (r['status'] === 'revoked') !== (r['revoke_reason'] != null) ? 'link_codes__revoke__ck'
      : !(r['revoke_reason'] == null || ['staff', 'superseded'].includes(r['revoke_reason'])) ? 'link_codes__revoke_reason__ck'
      : !(Buffer.isBuffer(r['code_hmac']) && r['code_hmac'].length === 32 && Buffer.isBuffer(r['bound_phone_hmac']) && r['bound_phone_hmac'].length === 32
          && (r['record_phone_hmac'] == null || (Buffer.isBuffer(r['record_phone_hmac']) && r['record_phone_hmac'].length === 32)) && /^[0-9]{2}$/.test(String(r['bound_phone_last2']))) ? 'link_codes__hash__ck'
      : !(Date.parse(r['expires_at']) <= Date.parse(r['created_at']) + 168 * 3_600_000) ? 'link_codes__ttl__ck' : undefined,
  },
});

// ---------------------------------------------------------------- harness
const verb = (c: Call) => /^\s*(select|insert|update|delete)\b/i.exec(c.text)?.[1]?.toLowerCase();
const dml = (calls: Call[]) => calls.filter((c) => ['insert', 'update', 'delete'].includes(verb(c) ?? ''));
interface Who { grants: readonly string[]; actorType?: 'user' | 'patient' }
const STAFF_ALL: Who = { grants: [ISSUE, REVOKE, READ] };
const ISSUE_ONLY: Who = { grants: [ISSUE] };
const READ_ONLY: Who = { grants: [READ] };
const NOBODY: Who = { grants: [] };
const PATIENT: Who = { grants: [], actorType: 'patient' };
function identity(w: Who) {
  const calls: Array<{ permission: string }> = [];
  return {
    calls,
    async assertRole(_c: unknown, r: { permission: string }) { calls.push({ permission: r?.permission }); if (!w.grants.includes(r?.permission)) throw new LimsError('auth.forbidden'); },
    async getTenantSettings() { return { timezone: 'Asia/Kathmandu' }; },
    async getActor() { return { actor: { type: w.actorType ?? 'user', id: A }, permissions: [...w.grants], roles: [], centreScope: { all: true, centreIds: [] }, mfa: { enrolled: true, level: 'aal2' } }; },
  };
}
const ctxFor = makeCtxFor();
const ACTOR: string = (ctxFor('A', {}) as any).actor.id;
const keyOf = (name: string) => readFileSync(process.env[name]!);
const linkHmac = (tenant: string, code: string) => createHmac('sha256', keyOf('LIMS_ENGAGEMENT_LINK_HMAC_KEY_FILE')).update(`${tenant}:${normalizeLinkCode(code)}`).digest();
const phoneHmac = (tenant: string, phone: string) => createHmac('sha256', keyOf('LIMS_ENGAGEMENT_PHONE_HMAC_KEY_FILE')).update(`${tenant}:${phone}`).digest();

const newDb = (o: { settings?: Row } = {}) => { const clock = { iso: NOW }; return new FakeDb(seed(o), defs(clock), clock); };
interface Out { out: any; error: any; db: FakeDb; calls: Call[]; id: ReturnType<typeof identity>; rows: Record<string, Row[]>; logs: unknown[]; audit: any[]; metrics: Array<{ name: string; labels: any }> }
const run = async (op: string, o: { params?: object; query?: object; headers?: object; body?: unknown }, who: Who, opts: { session?: string; db?: FakeDb } = {}): Promise<Out> => {
  const sessionTenant = opts.session ?? A;
  const db = opts.db ?? newDb();
  const s = db.session(sessionTenant, { all: true, centres: [] }, A);
  const id = identity(who); const logs: unknown[] = []; const audit: any[] = []; const metrics: Array<{ name: string; labels: any }> = [];
  const tx = { query: (text: string, values: unknown[] = []) => s.tx.query(text, values), startedAt: new Date(NOW) };
  const log = { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a) };
  const frontdesk = createFakeFrontdeskPort({ seed: 1, fixtures: { patients: patients() as any } });
  const base: any = ctxFor(sessionTenant === B ? 'B' : 'A', { tx: tx as never, now: () => NOW, ports: { IdentityPort: id, FrontdeskPort: frontdesk } as never });
  const ctx = { operationId: op, clientIp: '203.0.113.9', log, ...base, ...(who.actorType === 'patient' ? { actor: { type: 'patient', id: A } } : {}),
    audit: { access: async (e: unknown) => { audit.push(e); } }, metrics: { inc: (name: string, labels?: unknown) => { metrics.push({ name, labels }); }, set() {}, observe() {} } } as never;
  const r = { params: {}, query: {}, headers: {}, body: undefined, ...o } as never;
  let out: any, error: any;
  try { out = await (handlers as any)[op](r, ctx); } catch (e) { error = e; }
  return { out, error, db, calls: db.calls, id, rows: db.tables, logs, audit, metrics };
};
const BODY = (o: Row = {}) => ({ patient_id: P.REC, relationship: 'self', consented_by: 'patient', identity_check_method: 'photo_id', bind_phone: 'record', ...o });
const issue = (body: unknown, who: Who = STAFF_ALL, opts: { session?: string; db?: FakeDb } = {}) => run('issueLinkCode', { body }, who, opts);
const ifm = (v: string) => ({ 'if-match': v });
const revokeCode = (id: string, headers: object, who: Who = STAFF_ALL, opts: { session?: string; db?: FakeDb } = {}) => run('revokeLinkCode', { params: { link_code_id: id }, headers }, who, opts);
const revokeLink = (id: string, body: unknown, headers: object, who: Who = STAFF_ALL, opts: { session?: string; db?: FakeDb } = {}) => run('revokeAppLink', { params: { link_id: id }, body, headers }, who, opts);
const listLinks = (patientId: string, who: Who = STAFF_ALL, opts: { session?: string; db?: FakeDb } = {}) => run('listPatientAppLinks', { params: { patient_id: patientId } }, who, opts);
const snapshot = (db: FakeDb) => JSON.stringify(db.tables, (_k, v) => (v && v.type === 'Buffer' ? `buf:${Buffer.from(v.data).toString('hex')}` : v));
const untouched = (r: Out, before: string) => { expect(dml(r.calls)).toEqual([]); expect(snapshot(r.db)).toBe(before); };
const codeRow = (db: FakeDb, id: string) => db.tables['link_codes']!.find((x) => x['id'] === id)!;
const newCodes = (db: FakeDb) => db.tables['link_codes']!.filter((x) => !/^01950c16-0000-7000-8000-000000000c/.test(x['id']));
const SEEDED_CONSENTS = new Set(Array.from({ length: 10 }, (_, i) => ID(0xd01 + i)));
const newConsents = (db: FakeDb) => db.tables['link_consents']!.filter((x) => !SEEDED_CONSENTS.has(x['id']));
const codeErr = (r: Out) => r.error?.code;

// ---------------------------------------------------------------- contract
describe('contract: floors, idempotency and error codes match 02-TRD §5 L1-L4', () => {
  it('x-permission floors: L1 link.issue, L2/L4 link.revoke, L3 link.read', () => {
    expect(opOf('issueLinkCode')['x-permission']).toBe(ISSUE);
    for (const op of ['revokeLinkCode', 'revokeAppLink']) expect(opOf(op)['x-permission']).toBe(REVOKE);
    expect(opOf('listPatientAppLinks')['x-permission']).toBe(READ);
  });
  it('L1 stores no replay (x-idempotency none: the 201 body holds the plaintext code); L2/L4 are If-Match guarded', () => {
    expect(opOf('issueLinkCode')['x-idempotency']).toBe('none');
    for (const op of ['revokeLinkCode', 'revokeAppLink']) expect(opOf(op)['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict', 'common.precondition_required', 'common.not_found']));
    expect(opOf('issueLinkCode')['x-error-codes']).toEqual(expect.arrayContaining(['engagement.link_limit_reached', 'common.feature_disabled', 'common.validation_failed']));
  });
  it('the module exports a metric for link events with labels method + outcome only (no code, no phone)', async () => {
    const { ENGAGEMENT_METRICS } = await import('../../metrics.js');
    expect(ENGAGEMENT_METRICS['lims_engagement_link_events_total']).toEqual(['counter', ['method', 'outcome']]);
  });
});

// ---------------------------------------------------------------- L1 issue
describe('US-EN-03.1: issueLinkCode returns the code once and stores only 32-byte bytea HMACs', () => {
  it('201 {link_code_id, code, expires_at, bound_phone_masked}; schema-valid; code XXXXX-XXXXX Crockford base32; expires now + link_code_ttl_hours; Cache-Control no-store', async () => {
    const r = await issue(BODY());
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(201);
    const b = r.out.body;
    expect(schemaErrors(okSchema('issueLinkCode', '201'), b)).toEqual([]);
    expect(Object.keys(b).sort()).toEqual(['bound_phone_masked', 'code', 'expires_at', 'link_code_id']);
    expect(b.code).toMatch(new RegExp(`^[${LINK_CODE_ALPHABET}]{5}-[${LINK_CODE_ALPHABET}]{5}$`));
    expect(b.expires_at).toBe(plusH(NOW, 72));
    expect(b.bound_phone_masked).toBe(maskPhone(PH.REC));
    const cc = Object.entries(r.out.headers ?? {}).find(([k]) => k.toLowerCase() === 'cache-control')?.[1];
    expect(String(cc)).toMatch(/no-store/);
  });
  it('expires_at follows settings.link_code_ttl_hours (24 h and the 168 h maximum)', async () => {
    for (const h of [24, 168]) {
      const r = await issue(BODY(), STAFF_ALL, { db: newDb({ settings: { link_code_ttl_hours: h } }) });
      expect(r.error).toBeUndefined(); expect(r.out.body.expires_at).toBe(plusH(NOW, h));
    }
  });
  it('code_hmac / bound_phone_hmac / record_phone_hmac are raw 32-byte Buffers = HMAC-SHA256(key, tenant_id:value); last2 and snapshots stored; row is tenant A, issued by the actor', async () => {
    const r = await issue(BODY());
    const [row] = newCodes(r.db);
    expect(row).toBeDefined();
    for (const k of ['code_hmac', 'bound_phone_hmac', 'record_phone_hmac']) { expect(Buffer.isBuffer(row![k]), k).toBe(true); expect(row![k].length, k).toBe(32); }
    expect(row!['code_hmac'].equals(linkHmac(A, r.out.body.code))).toBe(true);
    expect(row!['bound_phone_hmac'].equals(phoneHmac(A, PH.REC))).toBe(true);
    expect(row!['record_phone_hmac'].equals(phoneHmac(A, PH.REC))).toBe(true);
    expect(row).toMatchObject({ id: r.out.body.link_code_id, tenant_id: A, patient_id: P.REC, bound_phone_last2: '11', relationship: 'self', display_name_snapshot: NAME.REC, sex_snapshot: 'female',
      issued_by_membership_id: ACTOR, status: 'issued', revoke_reason: null, redeemed_at: null, redeemed_account_id: null, expires_at: r.out.body.expires_at, created_by: ACTOR });
  });
  it('the 32-byte digests reach the database as Buffer parameters: never a hex string, never decode(.., hex)', async () => {
    const r = await issue(BODY());
    const want = [linkHmac(A, r.out.body.code), phoneHmac(A, PH.REC)];
    const inserts = r.calls.filter((c) => verb(c) === 'insert' && /link_codes/i.test(c.text));
    expect(inserts).toHaveLength(1);
    for (const w of want) expect(inserts[0]!.values.some((v) => Buffer.isBuffer(v) && v.equals(w))).toBe(true);
    for (const c of r.calls) {
      expect(c.text).not.toMatch(/decode\s*\(/i);
      for (const v of c.values) { if (typeof v === 'string') expect(v, 'hex string param').not.toMatch(/^(\\x)?[0-9a-f]{64}$/i); }
    }
  });
  it('the plaintext code, the full phone numbers and the patient name never reach logs, audit rows, metrics or the stored consent', async () => {
    const r = await issue(BODY({ bind_phone: 'other', phone_e164: PH.OTHER }));
    expect(r.error).toBeUndefined();
    const code = r.out.body.code as string;
    const hay = JSON.stringify({ logs: r.logs, audit: r.audit, metrics: r.metrics });
    for (const needle of [code, normalizeLinkCode(code), PH.REC, PH.OTHER, NAME.REC]) expect(hay, needle).not.toContain(needle);
    const stored = JSON.stringify({ c: r.rows['link_codes'], k: r.rows['link_consents'] });
    for (const needle of [code, normalizeLinkCode(code), PH.REC, PH.OTHER]) expect(stored, needle).not.toContain(needle);
    expect(JSON.stringify(r.calls.map((c) => c.values.filter((v) => typeof v === 'string')))).not.toContain(normalizeLinkCode(code));
  });
  it('writes a link_consents row {source desk, relationship, consented_by, identity_check_method, current consent_text_version, recorded_by = actor}; the code points at it', async () => {
    const r = await issue(BODY({ relationship: 'spouse', identity_check_method: 'known_patient' }));
    const consents = newConsents(r.db);
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ tenant_id: A, patient_id: P.REC, source: 'desk', relationship: 'spouse', consented_by: 'patient', identity_check_method: 'known_patient', consent_text_version: 'v3', recorded_by_membership_id: ACTOR, created_by: ACTOR });
    expect(newCodes(r.db)[0]).toMatchObject({ consent_id: consents[0]!['id'], relationship: 'spouse' });
  });
  it('FrontdeskPort is asked for the demographics with purpose patient_app_link before anything is written (sex_snapshot comes from it)', async () => {
    const db = newDb();
    const r = await issue(BODY({ patient_id: P.MINOR, relationship: 'child', consented_by: 'guardian', identity_check_method: 'guardian_photo_id', bind_phone: 'other', phone_e164: PH.GUARDIAN }), STAFF_ALL, { db });
    expect(r.error).toBeUndefined();
    expect(newCodes(db)[0]).toMatchObject({ sex_snapshot: 'male', display_name_snapshot: NAME.MINOR });
  });
  it('access log link_code.issue {entityType patient, entityId patient}; no code or phone in the entry', async () => {
    const r = await issue(BODY());
    expect(r.audit).toHaveLength(1);
    expect(r.audit[0]).toMatchObject({ action: 'link_code.issue', entityType: 'patient', entityId: P.REC });
  });
  it('volume metric: lims_engagement_link_events_total{method link_code, outcome issued} once per issued code; labels carry no id/phone/code', async () => {
    const r = await issue(BODY());
    const m = r.metrics.filter((x) => x.name === 'lims_engagement_link_events_total');
    expect(m).toEqual([{ name: 'lims_engagement_link_events_total', labels: { method: 'link_code', outcome: 'issued' } }]);
  });
  it('each call issues a new code (no replay, double submit = second code); 5 codes are distinct and at most 3 stay issued+unexpired for the patient', async () => {
    const db = newDb(); const codes = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const r = await issue(BODY({ patient_id: P.EMPTY }), STAFF_ALL, { db });
      expect(r.error).toBeUndefined(); codes.add(r.out.body.code);
      const live = db.tables['link_codes']!.filter((x) => x['patient_id'] === P.EMPTY && x['status'] === 'issued' && Date.parse(x['expires_at']) > Date.parse(NOW));
      expect(live.length).toBeLessThanOrEqual(3);
    }
    expect(codes.size).toBe(5);
    expect(db.tables['link_codes']!.filter((x) => x['patient_id'] === P.EMPTY && x['revoke_reason'] === 'superseded')).toHaveLength(2);
  });
});

describe('US-EN-03.1 / 03.6: phone binding', () => {
  it("bind_phone 'other' binds the body's phone (guardian P3 for a minor): bound_phone_hmac = HMAC(P3), record_phone_hmac = HMAC(record phone), consented_by guardian, masked = P3", async () => {
    const r = await issue(BODY({ patient_id: P.MINOR, relationship: 'child', consented_by: 'guardian', identity_check_method: 'guardian_photo_id', bind_phone: 'other', phone_e164: PH.GUARDIAN }));
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(201);
    expect(r.out.body.bound_phone_masked).toBe(maskPhone(PH.GUARDIAN));
    const row = newCodes(r.db)[0]!;
    expect(row['bound_phone_hmac'].equals(phoneHmac(A, PH.GUARDIAN))).toBe(true);
    expect(row['bound_phone_hmac'].equals(phoneHmac(A, PH.MINOR_REC))).toBe(false);
    expect(row['record_phone_hmac'].equals(phoneHmac(A, PH.MINOR_REC))).toBe(true);
    expect(row).toMatchObject({ relationship: 'child', bound_phone_last2: '13' });
    expect(newConsents(r.db)[0]).toMatchObject({ consented_by: 'guardian', relationship: 'child', identity_check_method: 'guardian_photo_id' });
  });
  it('a record without phone: bind record -> 400 /bind_phone; bind other works and record_phone_hmac stays NULL', async () => {
    const before = newDb(); const snap = snapshot(before);
    const bad = await issue(BODY({ patient_id: P.NOPHONE }), STAFF_ALL, { db: before });
    expect(codeErr(bad)).toBe('common.validation_failed'); expect(bad.error.errors?.map((e: any) => e.path)).toContain('/bind_phone'); untouched(bad, snap);
    const ok = await issue(BODY({ patient_id: P.NOPHONE, bind_phone: 'other', phone_e164: PH.OTHER }));
    expect(ok.error).toBeUndefined();
    expect(newCodes(ok.db)[0]).toMatchObject({ record_phone_hmac: null });
  });
  it("phone_e164 is required iff bind_phone = other: 'other' without it and 'record' with it -> 400 /phone_e164, nothing written", async () => {
    for (const body of [BODY({ bind_phone: 'other' }), BODY({ bind_phone: 'record', phone_e164: PH.OTHER })]) {
      const db = newDb(); const snap = snapshot(db);
      const r = await issue(body, STAFF_ALL, { db });
      expect(codeErr(r)).toBe('common.validation_failed'); expect(r.error.errors?.map((e: any) => e.path)).toContain('/phone_e164'); untouched(r, snap);
    }
  });
  it('a phone outside settings.allowed_phone_prefixes -> 400 /phone_e164 (prefix-checked), nothing written', async () => {
    const db = newDb(); const snap = snapshot(db);
    const r = await issue(BODY({ bind_phone: 'other', phone_e164: PH.BAD_PREFIX }), STAFF_ALL, { db });
    expect(codeErr(r)).toBe('common.validation_failed'); expect(r.error.errors?.map((e: any) => e.path)).toContain('/phone_e164'); untouched(r, snap);
  });
});

describe('US-EN-03.1: refusals write nothing', () => {
  it('tenant app_enabled = false -> 403 common.feature_disabled', async () => {
    const db = newDb({ settings: { app_enabled: false } }); const snap = snapshot(db);
    const r = await issue(BODY(), STAFF_ALL, { db });
    expect(codeErr(r)).toBe('common.feature_disabled'); untouched(r, snap);
  });
  it('patient merged or anonymised -> 400 common.validation_failed /patient_id; unknown patient -> 404 common.not_found', async () => {
    const db = newDb(); const snap = snapshot(db);
    const merged = await issue(BODY({ patient_id: P.MERGED }), STAFF_ALL, { db });
    expect(codeErr(merged)).toBe('common.validation_failed'); expect(merged.error.errors?.map((e: any) => e.path)).toContain('/patient_id'); untouched(merged, snap);
    const unknown = await issue(BODY({ patient_id: P.UNKNOWN }), STAFF_ALL, { db });
    expect(codeErr(unknown)).toBe('common.not_found'); untouched(unknown, snap);
  });
  it('patient already at max_accounts_per_patient active links -> 409 engagement.link_limit_reached; revoked and suspended links do not count', async () => {
    const db = newDb(); const snap = snapshot(db);
    const full = await issue(BODY({ patient_id: P.BUSY }), STAFF_ALL, { db });
    expect(codeErr(full)).toBe('engagement.link_limit_reached'); untouched(full, snap);
    const ok = await issue(BODY({ patient_id: P.OK }), STAFF_ALL, { db });
    expect(ok.error).toBeUndefined(); expect(ok.out.status).toBe(201);
  });
  it('the cap follows settings: max_accounts_per_patient = 2 refuses P_OK (2 active links)', async () => {
    const r = await issue(BODY({ patient_id: P.OK }), STAFF_ALL, { db: newDb({ settings: { max_accounts_per_patient: 2 } }) });
    expect(codeErr(r)).toBe('engagement.link_limit_reached');
  });
  it('a 4th unexpired issued code auto-revokes only the oldest one (superseded); expired, redeemed and revoked codes are untouched', async () => {
    const r = await issue(BODY({ patient_id: P.CODES }));
    expect(r.error).toBeUndefined();
    const st = (n: number) => r.rows['link_codes']!.find((x) => x['id'] === ID(0xc00 + n))!;
    expect(st(1)).toMatchObject({ status: 'revoked', revoke_reason: 'superseded' });
    expect(st(2)['status']).toBe('issued'); expect(st(3)['status']).toBe('issued');
    expect(st(4)).toMatchObject({ status: 'issued', revoke_reason: null }); expect(st(5)['status']).toBe('redeemed'); expect(st(6)).toMatchObject({ status: 'revoked', revoke_reason: 'staff' });
    expect(r.rows['link_codes']!.filter((x) => x['patient_id'] === P.CODES && x['status'] === 'issued' && Date.parse(x['expires_at']) > Date.parse(NOW))).toHaveLength(3);
  });
});

// ---------------------------------------------------------------- probes
describe('probes (07-SECURITY §6.1 cross-tenant, §6.5 actor confusion) - L1', () => {
  it('staff of tenant B using tenant A\'s patient id -> 404 common.not_found, no write, no access-log entry, no metric', async () => {
    const db = newDb(); const snap = snapshot(db);
    const r = await issue(BODY({ patient_id: P.REC }), STAFF_ALL, { db, session: B });
    expect(codeErr(r)).toBe('common.not_found'); untouched(r, snap); expect(r.audit).toEqual([]); expect(r.metrics).toEqual([]);
  });
  it('staff of tenant A using tenant B\'s patient id -> 404, nothing written in either tenant', async () => {
    const db = newDb(); const snap = snapshot(db);
    const r = await issue(BODY({ patient_id: P.B_ONLY }), STAFF_ALL, { db });
    expect(codeErr(r)).toBe('common.not_found'); untouched(r, snap);
  });
  it('rows are written for the caller\'s tenant only (tenant from ctx, never from the body)', async () => {
    const r = await issue({ ...BODY(), tenant_id: B });
    if (r.error) { expect(r.error.code).toBe('common.validation_failed'); return; }  // an unknown body field may be refused
    expect(newCodes(r.db)).toHaveLength(1);
    for (const row of [...newCodes(r.db), ...newConsents(r.db)]) expect(row['tenant_id']).toBe(A);
  });
  it('actor without engagement.link.issue (front desk role removed) -> 403 auth.forbidden before any database access', async () => {
    for (const who of [NOBODY, READ_ONLY]) {
      const db = newDb(); const snap = snapshot(db);
      const r = await issue(BODY(), who, { db });
      expect(codeErr(r)).toBe('auth.forbidden'); expect(r.calls).toEqual([]); untouched(r, snap); expect(r.id.calls[0]).toEqual({ permission: ISSUE });
    }
  });
  it('patient actor -> 403 auth.forbidden on all four staff operations, before any database access', async () => {
    const call = { issueLinkCode: { body: BODY() }, revokeLinkCode: { params: { link_code_id: ID(0xc07) }, headers: ifm('"1"') }, listPatientAppLinks: { params: { patient_id: P.LIST } },
      revokeAppLink: { params: { link_id: ID(0xb08) }, body: { reason_code: 'patient_request' }, headers: ifm('"2"') } };
    for (const [op, o] of Object.entries(call)) {
      const db = newDb(); const snap = snapshot(db);
      const r = await run(op, o, PATIENT, { db });
      expect(codeErr(r), op).toBe('auth.forbidden'); expect(r.calls, op).toEqual([]); untouched(r, snap);
    }
  });
});

// ---------------------------------------------------------------- L2
describe('L2 revokeLinkCode', () => {
  it('204: an issued code becomes revoked / revoke_reason staff; the code row is not deleted', async () => {
    const r = await revokeCode(ID(0xc07), ifm('"1"'));
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(204); expect(r.out.body).toBeUndefined();
    expect(codeRow(r.db, ID(0xc07))).toMatchObject({ status: 'revoked', revoke_reason: 'staff', updated_by: ACTOR });
    expect(dml(r.calls).every((c) => verb(c) === 'update')).toBe(true);
  });
  it('If-Match missing -> 428 common.precondition_required before any database access', async () => {
    const r = await revokeCode(ID(0xc07), {});
    expect(codeErr(r)).toBe('common.precondition_required'); expect(r.calls).toEqual([]);
  });
  it('unknown code and tenant B code (from tenant A) -> 404 common.not_found, nothing changes; tenant B staff cannot revoke A\'s code', async () => {
    const db = newDb(); const snap = snapshot(db);
    for (const [id, session] of [[ID(0xcff), A], [ID(0xc0a), A], [ID(0xc07), B]] as const) {
      const r = await revokeCode(id, ifm('"1"'), STAFF_ALL, { db, session });
      expect(codeErr(r), `${id}/${session}`).toBe('common.not_found'); untouched(r, snap);
    }
  });
  it('without engagement.link.revoke -> 403 before any database access', async () => {
    const r = await revokeCode(ID(0xc07), ifm('"1"'), ISSUE_ONLY);
    expect(codeErr(r)).toBe('auth.forbidden'); expect(r.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------- L3
describe('L3 listPatientAppLinks', () => {
  it('200 {data: AppLink[], codes: [{link_code_id, status, expires_at, issued_at}]} for the patient\'s links and codes, schema-valid', async () => {
    const r = await listLinks(P.LIST);
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(200);
    const b = r.out.body;
    expect(schemaErrors(okSchema('listPatientAppLinks', '200'), b)).toEqual([]);
    expect(b.data.map((l: any) => l.link_id).sort()).toEqual([ID(0xb08), ID(0xb09), ID(0xb0a)].sort());
    expect(b.data.find((l: any) => l.link_id === ID(0xb08))).toMatchObject({ patient_id: P.LIST, status: 'active', method: 'link_code', relationship: 'self', account_phone_masked: maskPhone(PH.REC) });
    expect(b.data.find((l: any) => l.link_id === ID(0xb09))).toMatchObject({ status: 'revoked', revoked_reason_code: 'staff_error' });
    expect(b.data.find((l: any) => l.link_id === ID(0xb0a))).toMatchObject({ status: 'suspended', suspend_reason: 'dormant' });
    expect(b.codes.map((c: any) => [c.link_code_id, c.status]).sort()).toEqual([[ID(0xc07), 'issued'], [ID(0xc08), 'redeemed'], [ID(0xc09), 'revoked']].sort());
    for (const c of b.codes) expect(Object.keys(c).sort()).toEqual(['expires_at', 'issued_at', 'link_code_id', 'status']);
  });
  it('never returns a code, a hash, a full phone number or another tenant\'s rows', async () => {
    const r = await listLinks(P.LIST);
    const s = JSON.stringify(r.out.body);
    for (const needle of [PH.REC, PH.OTHER, 'code_hmac', 'bound_phone_hmac', 'record_phone_hmac', 'phone_hmac', ID(0xb0b), ID(0xc0a)]) expect(s, needle).not.toContain(needle);
    expect(r.calls.every((c) => verb(c) === 'select')).toBe(true);
  });
  it('a patient with no links and no codes -> 200 with empty arrays (the W8 empty state)', async () => {
    const r = await listLinks(P.EMPTY);
    expect(r.out.status).toBe(200); expect(r.out.body).toEqual({ data: [], codes: [] });
  });
  it('probes: tenant B staff with A\'s patient id and A staff with B\'s patient id -> 404 common.not_found, no leak', async () => {
    const a = await listLinks(P.LIST, STAFF_ALL, { session: B }); expect(codeErr(a)).toBe('common.not_found'); expect(a.out).toBeUndefined();
    const b = await listLinks(P.B_ONLY); expect(codeErr(b)).toBe('common.not_found');
    const u = await listLinks(P.UNKNOWN); expect(codeErr(u)).toBe('common.not_found');
  });
  it('needs engagement.link.read (issue alone is not enough) -> 403 before any database access', async () => {
    const r = await listLinks(P.LIST, ISSUE_ONLY);
    expect(codeErr(r)).toBe('auth.forbidden'); expect(r.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------- L4
describe('US-EN-06.6 / L4 revokeAppLink', () => {
  it('200 AppLink revoked: revoked_by_kind staff, revoked_reason_code from the body, revoked_at now, version + 1; access log app_link.revoke; no other link changes', async () => {
    const r = await revokeLink(ID(0xb08), { reason_code: 'patient_request' }, ifm('"2"'));
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(200);
    expect(schemaErrors(named('AppLink'), r.out.body)).toEqual([]);
    expect(r.out.body).toMatchObject({ link_id: ID(0xb08), patient_id: P.LIST, status: 'revoked', revoked_reason_code: 'patient_request', revoked_at: NOW });
    const row = r.rows['account_patient_links']!.find((x) => x['id'] === ID(0xb08))!;
    expect(row).toMatchObject({ status: 'revoked', revoked_by_kind: 'staff', revoked_reason_code: 'patient_request', revoked_at: NOW, version: 3, updated_by: ACTOR });
    expect(r.rows['account_patient_links']!.filter((x) => x['status'] === 'revoked' && x['id'] !== ID(0xb08) && x['patient_id'] === P.LIST)).toHaveLength(1); // the one already revoked
    expect(r.rows['account_patient_links']!.find((x) => x['id'] === ID(0xb04))!['status']).toBe('active');
    expect(r.audit).toHaveLength(1); expect(r.audit[0]).toMatchObject({ action: 'app_link.revoke', entityType: 'app_link', entityId: ID(0xb08) });
    expect(r.metrics).toContainEqual({ name: 'lims_engagement_link_events_total', labels: expect.objectContaining({ outcome: 'revoked' }) });
  });
  it('If-Match absent -> 428 before any database access; stale If-Match -> 409 common.version_conflict, row unchanged', async () => {
    const none = await revokeLink(ID(0xb08), { reason_code: 'patient_request' }, {});
    expect(codeErr(none)).toBe('common.precondition_required'); expect(none.calls).toEqual([]);
    const db = newDb(); const snap = snapshot(db);
    const stale = await revokeLink(ID(0xb08), { reason_code: 'patient_request' }, ifm('"1"'), STAFF_ALL, { db });
    expect(codeErr(stale)).toBe('common.version_conflict'); untouched(stale, snap);
  });
  it('reason_code outside patient_request|suspected_misuse|staff_error|other (e.g. account_deleted) or a missing body -> 400, nothing written', async () => {
    for (const body of [{ reason_code: 'account_deleted' }, { reason_code: 'nope' }, {}, undefined]) {
      const db = newDb(); const snap = snapshot(db);
      const r = await revokeLink(ID(0xb08), body, ifm('"2"'), STAFF_ALL, { db });
      expect(codeErr(r), JSON.stringify(body)).toBe('common.validation_failed'); untouched(r, snap);
    }
  });
  it('probes: unknown link, tenant B link from tenant A, tenant A link from tenant B -> 404 common.not_found, nothing changes, no access-log entry', async () => {
    const db = newDb(); const snap = snapshot(db);
    for (const [id, session] of [[ID(0xbff), A], [ID(0xb0b), A], [ID(0xb08), B]] as const) {
      const r = await revokeLink(id, { reason_code: 'other' }, ifm('"2"'), STAFF_ALL, { db, session });
      expect(codeErr(r), `${id}/${session}`).toBe('common.not_found'); untouched(r, snap); expect(r.audit).toEqual([]);
    }
  });
  it('without engagement.link.revoke -> 403 before any database access', async () => {
    const r = await revokeLink(ID(0xb08), { reason_code: 'other' }, ifm('"2"'), READ_ONLY);
    expect(codeErr(r)).toBe('auth.forbidden'); expect(r.calls).toEqual([]);
  });
});
