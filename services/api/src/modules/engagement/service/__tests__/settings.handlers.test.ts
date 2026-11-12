// C16.T-03 — T1 getEngagementSettings, T2 updateEngagementSettings, T3a listEngagementCodedSet, T3b listMyCodedSet
// (06-PLAN row T-03; 02-TRD §5 T1/T2/T3a/T3b, §10.2; 05-SCHEMA §2.1, §8; PRD US-EN-20.1/20.2; 07-SECURITY REQ-SEC-080/099/113).
// done_when: range errors -> 422 engagement.setting_out_of_range; consent text change requires a new version. tests: aal1 -> auth.mfa_required on T2; probes.
// Fails now: handlers/index.ts maps all four operationIds to the T-01 placeholder (common.service_unavailable).
//
// SEAMS (spec does not fix them; same convention as billing/identity settings handlers):
//   handlers[op](req:{params,query,headers,body}, ctx) -> {status, body, headers?:{etag}}; ctx = {tenantId, actor:{type,id}, tx, now, ports:{IdentityPort}}; missing tenantId/actor/tx -> auth.unauthenticated.
//   Permission = ctx.ports.IdentityPort.assertRole(ctx, {permission}) called by the handler BEFORE any tx.query (core only logs authz_not_asserted).
//     T1/T3a engagement.booking.read, T2 engagement.settings.manage (privileged: aal1 -> auth.mfa_required), T3b engagement.self.read.
//   If-Match arrives as the raw header '"<version>"' (key 'if-match'); ETag '"<version>"' in headers.etag on 200 of T1/T2.
//   DB = fake tx.query answering by statement TYPE on `engagement.settings` / `engagement.g_cs_<set>` (not by exact SQL): SELECT -> row of the SESSION tenant (RLS model),
//   INSERT -> lazily creates the DDL-default row (version 1), UPDATE -> version + 1 (rows [] when the statement carries the stale version bind STALE).
//   Pipeline-level checks (schema min/max -> 400, x-permission floor, Idempotency-Key) are NOT re-tested; handlers are driven directly, so the handler itself must refuse
//   out-of-range input (defence in depth + the DB CHECK / trigger races, which surface as pg 23514 and must also map to engagement.setting_out_of_range).
//   Not covered here (other tasks): E1 getPatientAppConfig (T-A2) and the 426 gate / app update screen (T-A1, REQ-SEC-113). T-03 owns the settings that feed them (min versions, gateways, consent).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TENANTS } from '../../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`);
};
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const A: string = TENANTS.A; // tenants of packages/fakes; ctx.tenantId comes from makeCtxFor (tenant_id from tx context, 02-CONVENTIONS)
const B: string = TENANTS.B;
const CENTRE = '01950c16-0000-7000-8000-000000000285';
const BOOKING_READ = 'engagement.booking.read', MANAGE = 'engagement.settings.manage', SELF_READ = 'engagement.self.read';
const PRIVILEGED = new Set([MANAGE]); // contracts/permissions.yaml: engagement.settings.manage privileged:true
const STALE = 40, CURRENT = 41; // body values below never contain 40 / 41 / 42

const DEFAULTS = Object.freeze({ // 05-SCHEMA §2.1 / DDL defaults
  app_enabled: false, bookings_enabled: false, home_collection_enabled: false, queue_enabled: false, reminders_enabled: false, memberships_enabled: false,
  enquiries_enabled: false, smart_report_in_app: false, show_partner_orders: false, auto_no_show: true, auto_follow_up_reminders: false,
  allowed_phone_prefixes: ['+977'], otp_daily_cap: 2000, min_app_version_android: '0.0.0', min_app_version_ios: '0.0.0', app_gateways: [],
  max_profiles_per_account: 8, max_accounts_per_patient: 3, link_code_ttl_hours: 72, dormant_after_days: 180, minor_age_years: 18, booking_horizon_days: 14,
  booking_min_lead_minutes: 120, booking_cancel_cutoff_minutes: 60, no_show_grace_minutes: 120, max_active_bookings_per_profile: 2,
  max_bookings_created_per_account_day: 3, max_orderables_per_booking: 20, booking_reminder_hours_before: 24, follow_up_reminder_lead_days: 3,
  queue_display_history_count: 5,
});
const SERVER_COLUMNS = ['tenant_id', 'id', 'is_active', 'created_at', 'created_by', 'updated_at', 'updated_by'];
const rowOf = (tenant: string, over: Record<string, unknown> = {}) => ({
  id: '01900000-0000-7000-8000-0000000000c1', tenant_id: tenant, ...DEFAULTS, home_collection_centre_id: null, support_phone: null, app_consent_text: null,
  app_consent_text_version: null, smart_report_disclaimer_text: null, version: 1, is_active: true, created_at: new Date(0), created_by: A, updated_at: new Date(0), updated_by: A, ...over,
});
const STORED_A = rowOf(A, { app_enabled: true, bookings_enabled: true, otp_daily_cap: 3000, min_app_version_android: '1.4.0', app_gateways: ['khalti'],
  app_consent_text: 'Synthetic consent text v1', app_consent_text_version: '2026-01', version: CURRENT });

// A valid T2 body that changes nothing about consent (stored consent text/version repeated), so tests vary one thing at a time.
const BASE = Object.freeze({
  app_enabled: true, bookings_enabled: true, home_collection_enabled: true, queue_enabled: true, reminders_enabled: true, memberships_enabled: true, enquiries_enabled: true,
  smart_report_in_app: false, show_partner_orders: false, auto_no_show: false, auto_follow_up_reminders: false, home_collection_centre_id: CENTRE,
  allowed_phone_prefixes: ['+977', '+91'], otp_daily_cap: 5000, min_app_version_android: '1.4.0', min_app_version_ios: '1.2.0', app_gateways: ['esewa'],
  support_phone: '+15550100100', app_consent_text: 'Synthetic consent text v1', app_consent_text_version: '2026-01', max_profiles_per_account: 5, max_accounts_per_patient: 2,
  link_code_ttl_hours: 48, dormant_after_days: 90, minor_age_years: 16, booking_horizon_days: 30, booking_min_lead_minutes: 60, booking_cancel_cutoff_minutes: 30,
  no_show_grace_minutes: 30, max_active_bookings_per_profile: 3, max_bookings_created_per_account_day: 4, max_orderables_per_booking: 10, booking_reminder_hours_before: 12,
  follow_up_reminder_lead_days: 5, queue_display_history_count: 4, smart_report_disclaimer_text: 'Synthetic disclaimer.',
});
const SETS: Record<string, Array<Record<string, unknown>>> = {
  booking_cancel_reasons: [{ code: 'patient_request', display: 'Patient request', sort_order: 1 }, { code: 'duplicate', display: 'Duplicate booking', sort_order: 2 }],
  reminder_reasons: [{ code: 'follow_up_test', display: 'Follow-up test', sort_order: 1 }],
  enquiry_categories: [{ code: 'booking', display: 'Booking', sort_order: 1 }, { code: 'report', display: 'Report', sort_order: 2 }],
};

interface Call { text: string; values: unknown[] }
/** Fake Postgres for one request. `rows` = settings rows per tenant; the session tenant (RLS) is `session`. */
function fakeDb(session: string, rows: Record<string, Record<string, any>> = {}, failUpdate?: Record<string, unknown>,
  tenantSets: Record<string, Record<string, Array<Record<string, unknown>>>> = {}) {
  const calls: Call[] = [];
  const tables: Record<string, Record<string, any>> = { ...rows };
  return {
    calls, tables,
    tx: {
      async query(text: string, values: unknown[] = []) {
        calls.push({ text, values });
        if (/\bINSERT\b[\s\S]*engagement\.settings/i.test(text)) {
          tables[session] ??= rowOf(session);
          return { rows: [tables[session]], rowCount: 1 };
        }
        if (/\bUPDATE\b[\s\S]*engagement\.settings/i.test(text)) {
          if (failUpdate) throw Object.assign(new Error(String(failUpdate['message'] ?? 'check_violation')), failUpdate);
          const cur = tables[session];
          if (!cur || values.includes(STALE)) return { rows: [], rowCount: 0 };
          tables[session] = { ...cur, version: cur['version'] + 1 };
          return { rows: [tables[session]], rowCount: 1 };
        }
        if (/engagement\.settings/i.test(text)) { const r = tables[session]; return { rows: r ? [r] : [], rowCount: r ? 1 : 0 }; }
        const m = /engagement\.g_cs_(\w+)/i.exec(text);
        if (m && SETS[m[1]!]) {
          const glob = SETS[m[1]!]!.map((x) => ({ ...x, is_active: true, tenant_id: null }));
          // tenant table `engagement.cs_<set>` (RLS: session tenant only) shadows the global row by code (02-CONVENTIONS §5.5); only if the SQL reads it
          const own = new RegExp(`(?<!g_)\\bcs_${m[1]}\\b`, 'i').test(text) ? (tenantSets[session]?.[m[1]!] ?? []) : [];
          const r = [...own, ...glob.filter((g) => !own.some((t) => t['code'] === g['code']))]
            .sort((a, b) => (a['sort_order'] as number) - (b['sort_order'] as number) || String(a['code']).localeCompare(String(b['code'])));
          return { rows: r, rowCount: r.length };
        }
        throw new Error(`fake: unsupported SQL: ${text.slice(0, 80)}`);
      },
    },
  };
}
const writes = (c: Call[]) => c.filter((x) => /\b(INSERT|UPDATE|DELETE)\b/i.test(x.text));
const updates = (c: Call[]) => c.filter((x) => /\bUPDATE\b/i.test(x.text));

/** Fake IdentityPort.assertRole: missing permission -> auth.forbidden; privileged at aal1 -> auth.mfa_required (contract: 03-IC §4 / IdentityPort.ts:62). */
function identity(grants: readonly string[], aal: 1 | 2 = 2) {
  const asserted: string[] = [];
  return {
    asserted,
    async assertRole(_ctx: unknown, r: { permission: string }) {
      asserted.push(r?.permission);
      if (!grants.includes(r?.permission)) throw new LimsError('auth.forbidden');
      if (PRIVILEGED.has(r.permission) && aal < 2) throw new LimsError('auth.mfa_required');
    },
  };
}
const ctxFor = makeCtxFor();
const hctx = (db: { tx: unknown }, id: ReturnType<typeof identity>, over: Record<string, unknown> = {}, who = 'A') => ({
  operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
  ...ctxFor(who, { tx: db.tx as never, ports: { IdentityPort: id } as never }), ...over,
}) as never;
const req = (o: { params?: unknown; query?: unknown; headers?: unknown; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o }) as never;
const run = (op: string, r: unknown, c: unknown): Promise<any> => (handlers as any)[op](r, c);
const rej = (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
const PUT = (body: unknown, ifMatch: string | undefined = `"${CURRENT}"`) => req({ body, headers: ifMatch === undefined ? {} : { 'if-match': ifMatch } });
const put = (db: ReturnType<typeof fakeDb>, body: unknown, o: { grants?: string[]; aal?: 1 | 2; ifMatch?: string } = {}) =>
  run('updateEngagementSettings', PUT(body, 'ifMatch' in o ? o.ifMatch : undefined), hctx(db, identity(o.grants ?? [MANAGE], o.aal ?? 2)));
const asA = () => fakeDb(A, { [A]: { ...STORED_A } });

describe('contract: operations exist, floors and shapes match 02-TRD §5 (T1/T2/T3a/T3b)', () => {
  it('x-permission floors', () => {
    expect(opOf('getEngagementSettings')['x-permission']).toBe(BOOKING_READ);
    expect(opOf('updateEngagementSettings')['x-permission']).toBe(MANAGE);
    expect(opOf('listEngagementCodedSet')['x-permission']).toBe(BOOKING_READ);
    expect(opOf('listMyCodedSet')['x-permission']).toBe(SELF_READ);
  });
  it('T2 is privileged in contracts/permissions.yaml (aal2) and documents 422 / 409 / 428 / mfa', () => {
    const perms = readFileSync(join(REPO_ROOT, 'contracts/permissions.yaml'), 'utf8') as string;
    expect(perms).toMatch(/code:\s*engagement\.settings\.manage,\s*privileged:\s*true/);
    const codes: string[] = opOf('updateEngagementSettings')['x-error-codes'];
    for (const c of ['engagement.setting_out_of_range', 'auth.mfa_required', 'common.version_conflict', 'common.precondition_required']) expect(codes).toContain(c);
    expect(JSON.stringify(opOf('updateEngagementSettings').parameters)).toContain('IfMatch');
  });
  it('request schema is strict and carries no server-owned fields (REQ-SEC-080)', () => {
    const s = spec.components.schemas['EngagementSettingsInput'];
    expect(s.additionalProperties).toBe(false);
    for (const k of ['version', ...SERVER_COLUMNS]) expect(Object.keys(s.properties), k).not.toContain(k);
  });
  it('every T-03 operation has a real handler (not the T-01 placeholder)', async () => {
    for (const op of ['getEngagementSettings', 'updateEngagementSettings', 'listEngagementCodedSet', 'listMyCodedSet']) {
      const e = await run(op, req({ params: { set_name: 'booking_cancel_reasons' }, body: BASE, headers: { 'if-match': `"${CURRENT}"` } }), {
        operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }).catch((x: unknown) => x);
      expect(e?.code, op).toBe('auth.unauthenticated'); // bare ctx -> fail closed; the placeholder says common.service_unavailable
    }
  });
});

describe('T1 getEngagementSettings', () => {
  it('asserts engagement.booking.read before any query; without it -> auth.forbidden and no DB access', async () => {
    const db = asA(), id = identity([]);
    expect((await rej(run('getEngagementSettings', req(), hctx(db, id)))).code).toBe('auth.forbidden');
    expect(db.calls).toEqual([]);
    const ok = identity([BOOKING_READ]);
    await run('getEngagementSettings', req(), hctx(asA(), ok));
    expect(ok.asserted).toEqual([BOOKING_READ]);
  });
  it('stored row -> 200 EngagementSettings (schema-valid), ETag "<version>", no server-owned columns (US-EN-20.2: versions, gateways, consent text + version)', async () => {
    const out = await run('getEngagementSettings', req(), hctx(asA(), identity([BOOKING_READ])));
    expect(out.status).toBe(200);
    expect(schemaErrors('EngagementSettings', out.body)).toEqual([]);
    expect(out.body).toMatchObject({ app_enabled: true, otp_daily_cap: 3000, min_app_version_android: '1.4.0', min_app_version_ios: '0.0.0', app_gateways: ['khalti'],
      app_consent_text: 'Synthetic consent text v1', app_consent_text_version: '2026-01', version: CURRENT });
    expect(out.headers?.etag).toBe(`"${CURRENT}"`);
    for (const k of SERVER_COLUMNS) expect(Object.keys(out.body), k).not.toContain(k);
  });
  it('row absent -> the documented defaults (all feature switches off, auto_no_show on), version 1, schema-valid, stable on a second read', async () => {
    const db = fakeDb(A);
    const first = await run('getEngagementSettings', req(), hctx(db, identity([BOOKING_READ])));
    expect(first.status).toBe(200);
    expect(schemaErrors('EngagementSettings', first.body)).toEqual([]);
    expect(first.body).toMatchObject({ ...DEFAULTS, version: 1 });
    expect(first.headers?.etag).toBe('"1"');
    for (const k of SERVER_COLUMNS) expect(Object.keys(first.body), k).not.toContain(k);
    for (const k of ['home_collection_centre_id', 'support_phone', 'app_consent_text', 'app_consent_text_version', 'smart_report_disclaimer_text'])
      expect(first.body[k] ?? undefined, k).toBeUndefined(); // NULL columns are omitted, never null (schema types are non-nullable)
    const second = await run('getEngagementSettings', req(), hctx(db, identity([BOOKING_READ])));
    expect(second.body).toEqual(first.body);
  });
  it('response never carries secrets (key files, HMAC, token fields) — US-EN-20.2', async () => {
    const out = await run('getEngagementSettings', req(), hctx(asA(), identity([BOOKING_READ])));
    expect(JSON.stringify(out.body)).not.toMatch(/secret|hmac|key_file|password|token|private/i);
  });
  it('PROBE tenant: tenant A never sees tenant B\'s row (defaults instead) and no query binds B', async () => {
    const db = fakeDb(A, { [B]: rowOf(B, { app_enabled: true, otp_daily_cap: 777, app_consent_text: 'B only', app_consent_text_version: 'b1', version: 9 }) });
    const out = await run('getEngagementSettings', req(), hctx(db, identity([BOOKING_READ])));
    expect(out.body).toMatchObject({ app_enabled: false, otp_daily_cap: 2000, version: 1 });
    expect(JSON.stringify(out.body)).not.toContain('B only');
    expect(JSON.stringify(db.calls)).not.toContain(B);
  });
  it('PROBE actor: a patient actor holding only engagement.self.read is refused (auth.forbidden)', async () => {
    const db = asA();
    expect((await rej(run('getEngagementSettings', req(), hctx(db, identity([SELF_READ]), {}, 'A:patient')))).code).toBe('auth.forbidden');
    expect(db.calls).toEqual([]);
  });
  it('without tenantId / actor / tx -> auth.unauthenticated (REQ-SEC-099)', async () => {
    const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
    expect((await rej(run('getEngagementSettings', req(), bare))).code).toBe('auth.unauthenticated');
  });
});

describe('T2 updateEngagementSettings — authorisation', () => {
  it('aal1 -> 403 auth.mfa_required BEFORE any DB access (privileged engagement.settings.manage)', async () => {
    const db = asA();
    const e = await rej(put(db, BASE, { aal: 1 }));
    expect(e.code).toBe('auth.mfa_required');
    expect(db.calls).toEqual([]);
  });
  it('permission missing (booking.read only) -> auth.forbidden, no DB access', async () => {
    const db = asA();
    expect((await rej(put(db, BASE, { grants: [BOOKING_READ] }))).code).toBe('auth.forbidden');
    expect(db.calls).toEqual([]);
  });
  it('aal2 + permission -> asserts exactly engagement.settings.manage', async () => {
    const id = identity([MANAGE], 2);
    await run('updateEngagementSettings', PUT(BASE), hctx(asA(), id));
    expect(id.asserted).toEqual([MANAGE]);
  });
  it('without tenantId / actor / tx -> auth.unauthenticated', async () => {
    const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
    expect((await rej(run('updateEngagementSettings', PUT(BASE), bare))).code).toBe('auth.unauthenticated');
  });
});

describe('T2 updateEngagementSettings — happy path, If-Match, lazy row', () => {
  it('If-Match "41" -> 200, schema-valid body, ETag "42", exactly one UPDATE carrying the submitted values', async () => {
    const db = asA();
    const out = await put(db, BASE);
    expect(out.status).toBe(200);
    expect(schemaErrors('EngagementSettings', out.body)).toEqual([]);
    expect(out.body.version).toBe(CURRENT + 1);
    expect(out.headers?.etag).toBe(`"${CURRENT + 1}"`);
    expect(updates(db.calls)).toHaveLength(1);
    const binds = JSON.stringify(updates(db.calls)[0]!.values);
    for (const v of ['5000', '"1.4.0"', '"1.2.0"', '"esewa"', CENTRE, A]) expect(binds, v).toContain(v);
  });
  it('no If-Match -> 428 common.precondition_required, no DB access', async () => {
    const db = asA();
    const e = await rej(run('updateEngagementSettings', req({ body: BASE, headers: {} }), hctx(db, identity([MANAGE]))));
    expect(e.code).toBe('common.precondition_required');
    expect(db.calls).toEqual([]);
  });
  it('malformed If-Match (unquoted, weak, zero, text, oversized, list, *) -> common.validation_failed, no DB access', async () => {
    for (const h of ['41', 'W/"41"', '"0"', '"abc"', '"99999999999"', '"41", "42"', '*']) {
      const db = asA();
      expect((await rej(put(db, BASE, { ifMatch: h }))).code, h).toBe('common.validation_failed');
      expect(db.calls, h).toEqual([]);
    }
  });
  it('stale If-Match -> 409 common.version_conflict and the row is unchanged', async () => {
    const db = asA();
    const e = await rej(put(db, BASE, { ifMatch: `"${STALE}"` }));
    expect(e.code).toBe('common.version_conflict');
    expect(e.statusCode).toBe(409);
    expect(db.tables[A]!['version']).toBe(CURRENT);
  });
  it('no row yet (defaults in force): PUT with If-Match "1" creates the row lazily (INSERT … ON CONFLICT DO NOTHING) then updates -> 200 ETag "2"', async () => {
    const db = fakeDb(A);
    const out = await put(db, BASE, { ifMatch: '"1"' });
    expect(out.status).toBe(200);
    expect(out.headers?.etag).toBe('"2"');
    expect(db.calls.some((c) => /\bINSERT\b[\s\S]*ON CONFLICT[\s\S]*DO NOTHING/i.test(c.text))).toBe(true);
  });
  it('boundary values at both ends of every range are accepted', async () => {
    for (const [k, lo, hi] of RANGES) for (const v of [lo, hi]) {
      const db = asA();
      expect((await put(db, { ...BASE, [k]: v })).status, `${k}=${v}`).toBe(200);
    }
  });
  it('a body without optional fields (centre not needed while home collection is off, texts absent) is accepted when the stored consent is cleared in step', async () => {
    const db = fakeDb(A, { [A]: { ...STORED_A, app_consent_text: null, app_consent_text_version: null } });
    const { home_collection_centre_id: _c, support_phone: _s, smart_report_disclaimer_text: _d, app_consent_text: _t, app_consent_text_version: _v, ...rest } = BASE;
    expect((await put(db, { ...rest, home_collection_enabled: false })).status).toBe(200);
  });
});

// [field, min, max] from 05-SCHEMA §2.1 (the DDL settings__ranges__ck)
const RANGES: Array<[string, number, number]> = [
  ['otp_daily_cap', 100, 20000], ['max_profiles_per_account', 1, 10], ['max_accounts_per_patient', 1, 5], ['link_code_ttl_hours', 1, 168],
  ['dormant_after_days', 30, 730], ['minor_age_years', 14, 21], ['booking_horizon_days', 1, 60], ['booking_min_lead_minutes', 0, 2880],
  ['booking_cancel_cutoff_minutes', 0, 2880], ['no_show_grace_minutes', 15, 1440], ['max_active_bookings_per_profile', 1, 5],
  ['max_bookings_created_per_account_day', 1, 10], ['max_orderables_per_booking', 1, 50], ['booking_reminder_hours_before', 1, 72],
  ['follow_up_reminder_lead_days', 0, 30], ['queue_display_history_count', 1, 10],
];

describe('T2 updateEngagementSettings — range errors -> 422 engagement.setting_out_of_range (done_when)', () => {
  const OUT: Array<[string, number]> = RANGES.flatMap(([k, lo, hi]) => [[k, lo - 1], [k, hi + 1]] as Array<[string, number]>);
  it.each(OUT)('%s = %i -> 422 engagement.setting_out_of_range at /%s, no write issued', async (field, value) => {
    const db = asA();
    const e = await rej(put(db, { ...BASE, [field]: value }));
    expect(e.code).toBe('engagement.setting_out_of_range');
    expect(e.statusCode).toBe(422);
    expect((e.errors ?? []).map((x: any) => x.path)).toContain(`/${field}`);
    expect(writes(db.calls)).toEqual([]);
  });
  const BAD: Array<[string, unknown]> = [
    ['allowed_phone_prefixes', []], ['allowed_phone_prefixes', ['+1', '+2', '+3', '+4', '+5', '+6']], ['allowed_phone_prefixes', ['977']],
    ['allowed_phone_prefixes', ['+0123']], ['allowed_phone_prefixes', ['+12345']], ['allowed_phone_prefixes', ['+977, +91']],
    ['app_gateways', ['paypal']], ['app_gateways', ['esewa', 'stripe']],
    ['min_app_version_android', '1.4'], ['min_app_version_android', '1.4.0-rc1'], ['min_app_version_android', '1000.0.0'], ['min_app_version_android', 'v1.4.0'],
    ['min_app_version_ios', '1.4.00000'], ['min_app_version_ios', ''],
    ['support_phone', '+'.padEnd(41, '1')], ['smart_report_disclaimer_text', 'x'.repeat(1001)],
    ['app_consent_text', 'x'.repeat(4001)], ['app_consent_text_version', 'v'.repeat(33)], ['app_consent_text_version', ''],
  ];
  it.each(BAD)('%s = %j -> 422 engagement.setting_out_of_range, no write issued', async (field, value) => {
    const db = asA();
    const e = await rej(put(db, { ...BASE, [field]: value, ...(field === 'app_consent_text' ? { app_consent_text_version: '2026-09' } : {}) }));
    expect(e.code).toBe('engagement.setting_out_of_range');
    expect(writes(db.calls)).toEqual([]);
  });
  it('home_collection_enabled without home_collection_centre_id -> 422 engagement.setting_out_of_range at /home_collection_centre_id (settings__hc_centre__ck)', async () => {
    const db = asA();
    const { home_collection_centre_id: _c, ...rest } = BASE;
    const e = await rej(put(db, { ...rest, home_collection_enabled: true }));
    expect(e.code).toBe('engagement.setting_out_of_range');
    expect((e.errors ?? []).map((x: any) => x.path)).toContain('/home_collection_centre_id');
    expect(writes(db.calls)).toEqual([]);
  });
  it('wrong JSON type (string for an integer, non-array prefixes) -> 400 common.validation_failed', async () => {
    for (const patch of [{ otp_daily_cap: '5000' }, { allowed_phone_prefixes: '+977' }, { app_enabled: 'yes' }]) {
      const db = asA();
      expect((await rej(put(db, { ...BASE, ...patch }))).code, JSON.stringify(patch)).toBe('common.validation_failed');
      expect(writes(db.calls)).toEqual([]);
    }
  });
  it('a DB check violation that slips past the handler (pg 23514, e.g. a concurrent rule) is mapped to engagement.setting_out_of_range, not a 500', async () => {
    const db = fakeDb(A, { [A]: { ...STORED_A } }, { code: '23514', constraint: 'settings__ranges__ck' });
    const e = await rej(put(db, BASE));
    expect(e.code).toBe('engagement.setting_out_of_range');
    expect(e.statusCode).toBe(422);
  });
  it('error bodies never echo the submitted value (no PHI / secret reflection)', async () => {
    const db = asA();
    const e = await rej(put(db, { ...BASE, support_phone: `ZZMARKER${'9'.repeat(40)}` }));
    expect(JSON.stringify({ d: e.detail, errors: e.errors, m: e.message })).not.toContain('ZZMARKER');
  });
});

describe('T2 updateEngagementSettings — consent text change requires a new version (done_when; AC US-EN-20.2)', () => {
  const CHANGED = 'Synthetic consent text v2';
  const refused = async (patch: Record<string, unknown>) => {
    const db = asA();
    const e = await rej(put(db, { ...BASE, ...patch }));
    // 422 engagement.setting_out_of_range is the C16 code for 05-SCHEMA §2.1 rules (the trigger's SQLSTATE is 23514); a plain 400 is also tolerated.
    expect(['engagement.setting_out_of_range', 'common.validation_failed']).toContain(e.code);
    expect(writes(db.calls)).toEqual([]);
  };
  it('text changed, version unchanged -> refused, no write', async () => { await refused({ app_consent_text: CHANGED }); });
  it('text set while version omitted / version set while text omitted -> refused (settings__texts__ck pairs them)', async () => {
    const { app_consent_text_version: _v, ...noVersion } = BASE;
    const { app_consent_text: _t, ...noText } = BASE;
    for (const body of [{ ...noVersion, app_consent_text: CHANGED }, noText]) {
      const db = asA();
      const e = await rej(put(db, body));
      expect(['engagement.setting_out_of_range', 'common.validation_failed']).toContain(e.code);
      expect(writes(db.calls)).toEqual([]);
    }
  });
  it('text changed AND version changed -> 200, both stored in one UPDATE', async () => {
    const db = asA();
    const out = await put(db, { ...BASE, app_consent_text: CHANGED, app_consent_text_version: '2026-02' });
    expect(out.status).toBe(200);
    const binds = JSON.stringify(updates(db.calls)[0]!.values);
    expect(binds).toContain(CHANGED);
    expect(binds).toContain('2026-02');
  });
  it('text and version both unchanged -> 200 (no spurious bump required)', async () => {
    expect((await put(asA(), BASE)).status).toBe(200);
  });
  it('the DB trigger error (23514 consent_version_required) is mapped, not a 500', async () => {
    const db = fakeDb(A, { [A]: { ...STORED_A } }, { code: '23514', message: 'consent_version_required' });
    const e = await rej(put(db, { ...BASE, app_consent_text: CHANGED, app_consent_text_version: '2026-02' }));
    expect(['engagement.setting_out_of_range', 'common.validation_failed']).toContain(e.code);
    expect(e.statusCode).toBeLessThan(500);
  });
});

describe('T2 updateEngagementSettings — mass assignment and tenant probes (REQ-SEC-080)', () => {
  it.each([['tenant_id', B], ['id', B], ['is_active', false], ['created_by', B], ['updated_by', B], ['version', 99], ['unknown_flag', true]])(
    'body field %s is refused (common.validation_failed) and nothing is written', async (k, v) => {
      const db = asA();
      const e = await rej(put(db, { ...BASE, [k]: v }));
      expect(e.code).toBe('common.validation_failed');
      expect(writes(db.calls)).toEqual([]);
    });
  it('PROBE tenant: updating as A touches only A — no query binds B, B\'s row is untouched, and the answer is A\'s row', async () => {
    const rowB = rowOf(B, { otp_daily_cap: 777, version: 9 });
    const db = fakeDb(A, { [A]: { ...STORED_A }, [B]: rowB });
    const out = await put(db, BASE);
    expect(out.status).toBe(200);
    expect(JSON.stringify(db.calls)).not.toContain(B);
    expect(db.tables[B]).toEqual(rowB);
    expect(updates(db.calls)[0]!.values).toContain(A);
  });
});

describe('T3a listEngagementCodedSet / T3b listMyCodedSet', () => {
  const T3A = ['booking_cancel_reasons', 'reminder_reasons', 'enquiry_categories'];
  const T3B = ['booking_cancel_reasons', 'enquiry_categories'];
  it.each(T3A)('T3a %s -> 200 {data:[{code,display,sort_order}]} only; schema-valid; asserts engagement.booking.read', async (set_name) => {
    const db = asA(), id = identity([BOOKING_READ]);
    const out = await run('listEngagementCodedSet', req({ params: { set_name } }), hctx(db, id));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ data: SETS[set_name]!.map(({ code, display, sort_order }) => ({ code, display, sort_order })) });
    expect(id.asserted).toEqual([BOOKING_READ]);
    expect(db.calls.map((c) => c.text).join(' ')).toMatch(new RegExp(`engagement\\.g_cs_${set_name}\\b`));
    expect(JSON.stringify(out.body)).not.toMatch(/tenant_id|is_active/);
  });
  it.each(T3B)('T3b %s as a patient actor -> 200 same shape; asserts engagement.self.read', async (set_name) => {
    const db = asA(), id = identity([SELF_READ]);
    const out = await run('listMyCodedSet', req({ params: { set_name } }), hctx(db, id, {}, 'A:patient'));
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ data: SETS[set_name]!.map(({ code, display, sort_order }) => ({ code, display, sort_order })) });
    expect(id.asserted).toEqual([SELF_READ]);
  });
  describe('tenant additions / overrides shadow the global rows by code (05-SCHEMA §3 cs_*; 02-CONVENTIONS §5.5)', () => {
    const tRow = (code: string, display: string, sort_order: number, is_active = true) => ({ code, display, sort_order, is_active, tenant_id: A });
    const listA = (tenantSets: Record<string, Array<Record<string, unknown>>>, extra: Record<string, typeof tenantSets> = {}) => {
      const db = fakeDb(A, { [A]: { ...STORED_A } }, undefined, { [A]: tenantSets, ...extra });
      return { db, out: run('listEngagementCodedSet', req({ params: { set_name: 'booking_cancel_reasons' } }), hctx(db, identity([BOOKING_READ]))) };
    };
    it('(a) tenant row with a global code overrides display / sort_order', async () => {
      const { out } = listA({ booking_cancel_reasons: [tRow('duplicate', 'Dup (tenant)', 0)] });
      expect((await out).body).toEqual({ data: [{ code: 'duplicate', display: 'Dup (tenant)', sort_order: 0 }, { code: 'patient_request', display: 'Patient request', sort_order: 1 }] });
    });
    it('(b) tenant row is_active=false hides the global code', async () => {
      const { out } = listA({ booking_cancel_reasons: [tRow('duplicate', 'Duplicate booking', 2, false)] });
      expect((await out).body).toEqual({ data: [{ code: 'patient_request', display: 'Patient request', sort_order: 1 }] });
    });
    it('(c) tenant-only code appears, T3b too', async () => {
      const { db, out } = listA({ booking_cancel_reasons: [tRow('moved_city', 'Moved city', 3)] });
      expect(((await out).body.data as any[]).map((x) => x.code)).toEqual(['patient_request', 'duplicate', 'moved_city']);
      const id = identity([SELF_READ]);
      const mine = await run('listMyCodedSet', req({ params: { set_name: 'booking_cancel_reasons' } }), hctx(db, id, {}, 'A:patient'));
      expect(mine.body.data.map((x: any) => x.code)).toEqual(['patient_request', 'duplicate', 'moved_city']);
    });
    it('(d) PROBE tenant: the coded-set query reads the tenant table, binds ctx.tenantId (A) and never B; B\'s additions do not leak', async () => {
      const { db, out } = listA({}, { [B]: { booking_cancel_reasons: [{ ...tRow('b_only', 'B only', 1), tenant_id: B }] } });
      expect(JSON.stringify((await out).body)).not.toContain('b_only');
      const q = db.calls.at(-1)!;
      expect(q.text).toMatch(/engagement\.cs_booking_cancel_reasons\b/);
      expect(q.values).toContain(A);
      expect(JSON.stringify(db.calls)).not.toContain(B);
    });
  });
  it('T3b is NOT open to reminder_reasons (staff-only set) and unknown / injected set names: refused before any query', async () => {
    for (const set_name of ['reminder_reasons', 'nope', '', 'booking_cancel_reasons; DROP TABLE engagement.settings', '../settings', 'BOOKING_CANCEL_REASONS', undefined]) {
      const db = asA();
      const e = await rej(run('listMyCodedSet', req({ params: { set_name } }), hctx(db, identity([SELF_READ]), {}, 'A:patient')));
      expect(['common.validation_failed', 'common.not_found'], String(set_name)).toContain(e.code);
      expect(db.calls, String(set_name)).toEqual([]);
    }
  });
  it('T3a refuses names outside its three sets before any query', async () => {
    for (const set_name of ['payment_methods', 'nope', '', 'enquiry_categories\'--', 'settings', undefined]) {
      const db = asA();
      const e = await rej(run('listEngagementCodedSet', req({ params: { set_name } }), hctx(db, identity([BOOKING_READ]))));
      expect(['common.validation_failed', 'common.not_found'], String(set_name)).toContain(e.code);
      expect(db.calls, String(set_name)).toEqual([]);
    }
  });
  it('PROBE actor: T3a without booking.read -> auth.forbidden; T3b with only booking.read (staff) -> auth.forbidden; no DB access either way', async () => {
    const d1 = asA();
    expect((await rej(run('listEngagementCodedSet', req({ params: { set_name: 'booking_cancel_reasons' } }), hctx(d1, identity([SELF_READ]), {}, 'A:patient')))).code).toBe('auth.forbidden');
    const d2 = asA();
    expect((await rej(run('listMyCodedSet', req({ params: { set_name: 'booking_cancel_reasons' } }), hctx(d2, identity([BOOKING_READ]))))).code).toBe('auth.forbidden');
    expect(d1.calls).toEqual([]);
    expect(d2.calls).toEqual([]);
  });
  it('without tenantId / actor / tx -> auth.unauthenticated for both', async () => {
    const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
    for (const op of ['listEngagementCodedSet', 'listMyCodedSet'])
      expect((await rej(run(op, req({ params: { set_name: 'booking_cancel_reasons' } }), bare))).code, op).toBe('auth.unauthenticated');
  });
});
