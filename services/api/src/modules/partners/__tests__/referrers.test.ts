// C13 T11 — referrers + mapping (06-IMPLEMENTATION-PLAN row T11). Tests: integration (in-memory SQL world) + probes. ACs: US-13.1 – US-13.6.
// done_when: "duplicate rule; member 403; mapping validates via getReferrer (CatalogPort fake); mapping re-enqueues failed lines; samples_this_month".
// Spec: 02-TRD §5.2 F1-F5, §5.3 SR1-SR3, §4.7 (F10), §6 CatalogPort.getReferrer, §8.1 convert task (job_key convert:<line_id>:<attempt>), §10 permissions;
//       03-APP-FLOW §2.6 (mapping table), §2.3 LS7; 05-SCHEMA §3.3 partner_referrers, §3.5 manifest_lines; 07-SECURITY AB2, ST1, ST2, ST4, ST8, ST13;
//       contracts/openapi/partners.yaml (PartnerReferrer / ReferrerMapping allowlists).
// LEAD DECISION LD-140 (UI only) does not apply: backend task.
// Handlers are exercised through manifest.handlers[operationId] (file names are the writer's choice); the service is ../service/referrer.service.ts.
// SEAMS (spec does not fix them; the writer follows them or disputes — see referrer.world.ts header for the SQL subset the fake interprets):
//  - Order: actor type -> IdentityPort.assertRole (F1 partners.referrer.read; F2-F5 partners.referrer.manage; SR1-SR3 partners.referrer.map) FIRST ->
//    partnerContext.require (partner callers; supplies partner_id — never read from the body) -> body / If-Match validation -> lock row -> transition -> port -> store.
//  - If-Match header form `"<version>"` (02-CV §4.2): absent 428 common.precondition_required, malformed 400 common.validation_failed, stale 409 common.version_conflict.
//    Row not visible / other partner / other tenant -> 404 common.not_found. Unknown body key -> 400 common.validation_failed (07-SECURITY AB2).
//  - Null columns are omitted from DTOs (the schemas are not nullable).
//  - samples_this_month: ONE extra single-table statement per request on partners.manifest_lines (state = 'converted' AND converted_at >= $a AND converted_at < $b,
//    GROUP BY referrer_id); month bounds computed in JS from ctx.now() and IdentityPort.getTenantSettings(ctx, {keys:[…'timezone'…]}) — never `date_trunc` in SQL.
//  - SR1: partner {id, name} from a second single-table SELECT on partners.partners (no JOIN); catalog_doctor.display_name from CatalogPort.getReferrer (purpose 'display').
//  - SR2 re-enqueue: UPDATE partners.manifest_lines … state = 'converting', conversion_attempt = conversion_attempt + 1, failure_code = NULL, failed_at = NULL
//    WHERE tenant_id, partner_id, referrer_id, state = 'conversion_failed', failure_code = 'partners.referrer_not_mapped' [RETURNING …]; then per line
//    SELECT app.enqueue_job('partners.convert_manifest_line', <payload incl. attempt, line id, tenant id>::jsonb, 'convert:<line_id>:<attempt>') in the same transaction.
//  - SR2/SR3 write is guarded against a concurrent writer: the row is locked (SELECT … FOR UPDATE on partner_referrers before the first UPDATE) or the UPDATE tests version.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { manifest } from '../index.js';
import { D, id, L, makeCtx, makeWorld, P, R, STAFF, T_A, T_B, U, type Opts, type Who, type World } from './referrer.world.js';

const hoisted = vi.hoisted(() => ({ require: undefined as undefined | ((ctx: any) => Promise<unknown>) }));
vi.mock('../service/partner-context.service.js', () => ({
  partnerContext: { require: (c: unknown) => hoisted.require!(c), load: (c: unknown) => hoisted.require!(c) },
}));

const PR_KEYS = ['id', 'display_name', 'qualification', 'registration_council', 'registration_no', 'is_active', 'mapping_state', 'samples_this_month', 'version'];
const PR_REQUIRED = ['id', 'display_name', 'is_active', 'mapping_state', 'samples_this_month', 'version'];
const RM_KEYS = [...PR_KEYS, 'partner', 'catalog_doctor'];
const CONVERT = 'partners.convert_manifest_line';
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
const req = (o: Partial<{ params: object; query: object; headers: object; body: unknown }> = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });

async function call(w: World, op: string, who: Who, r: ReturnType<typeof req>, over: Opts = {}) {
  const { ctx } = makeCtx(w, who, (fn) => { hoisted.require = fn; }, over);
  const snap = w.snapshot();
  try {
    return (await manifest.handlers[op]!(r as any, ctx)) as { status: number; body: any };
  } catch (e) { w.restore(snap); throw e; } // the pipeline rolls the request tx back on any error
}
async function fails(p: Promise<unknown>, code: string, status?: number) {
  const e: any = await p.then(() => { throw new Error('expected rejection'); }, (x) => x);
  expect(e, String(e?.message)).toBeInstanceOf(LimsError);
  expect(e.code).toBe(code);
  if (status) expect(e.statusCode).toBe(status);
  return e as LimsError;
}
const state = (w: World) => JSON.stringify([w.referrers, w.lines, w.jobs]);
const untouched = (w: World) => { expect(w.writes()).toEqual([]); expect(w.jobs).toEqual([]); };
const dto = (b: any, keys = PR_KEYS) => {
  expect(Object.keys(b).every((k) => keys.includes(k)), JSON.stringify(Object.keys(b))).toBe(true);
  for (const k of PR_REQUIRED) expect(b, k).toHaveProperty(k);
  expect(typeof b.samples_this_month).toBe('number');
  expect(Object.values(b).includes(null)).toBe(false);
};
const sr = (rid: string, o: Partial<{ headers: object; body: unknown; query: object }> = {}) => req({ params: { referrer_id: rid }, ...o });
const body = (o: object = {}) => ({ display_name: 'Dr Omega Synthetic', qualification: 'MBBS (synthetic)', registration_council: 'SYN-NMC', registration_no: 'SYN-9001', ...o });
const lineSnap = (w: World, ...ids: string[]) => JSON.stringify(ids.map((i) => w.line(i)));
const leaks = (x: unknown, needles: string[]) => {
  const plain = x instanceof Error ? Object.fromEntries(Object.getOwnPropertyNames(x).map((k) => [k, (x as any)[k]])) : x;
  const hay = JSON.stringify(plain).toLowerCase();
  return needles.filter((n) => hay.includes(n.toLowerCase()));
};
const ts = (iso: string) => iso;

describe('T11 wiring', () => {
  it('service file exists', () => {
    expect(existsSync(join(__dirname, '..', 'service', 'referrer.service.ts'))).toBe(true);
  });
  it('static: SQL is parameterised (no template-literal interpolation in query text), no commitOnError, no console logging', () => {
    const src = readFileSync(join(__dirname, '..', 'service', 'referrer.service.ts'), 'utf8');
    expect(/query\(\s*`[^`]*\$\{/.test(src)).toBe(false);
    expect(src).not.toContain('commitOnError');
    expect(src).not.toMatch(/console\.(log|info|debug)/);
  });
});

// ------------------------------------------------------------------ F1 list
describe('T11 F1 listPartnerReferrers (US-13.1/13.2)', () => {
  it.each(['adminX', 'memberX'] as const)('%s lists the 4 referrers of partner X only (active and inactive), DTO allowlist, nothing of Y or tenant B', async (who) => {
    for (const noRls of [false, true]) {
      const w = makeWorld();
      const r = await call(w, 'listPartnerReferrers', who, req(), { noRls });
      expect(r.status).toBe(200);
      expect(r.body.page).toBeTruthy();
      const ids = r.body.data.map((x: any) => x.id).sort();
      expect(ids, `noRls=${noRls}`).toEqual([R.x1, R.x2, R.x3, R.x4].sort());
      for (const x of r.body.data) dto(x);
      expect(w.portCalls.find((c) => c.name === 'assertRole')!.input.permission).toBe('partners.referrer.read');
      expect(JSON.stringify(r.body)).not.toMatch(/"(catalog_doctor|mapped_by|tenant_id|partner_id|mapping_reject_\w*)"\s*:/);
      untouched(w);
    }
  });
  it('null columns are omitted; mapped / rejected / unmapped states are shown to the partner', async () => {
    const w = makeWorld();
    const r = await call(w, 'listPartnerReferrers', 'memberX', req());
    const by = (rid: string) => r.body.data.find((x: any) => x.id === rid);
    expect(by(R.x1)).toMatchObject({ display_name: 'Dr Alpha Synthetic', qualification: 'MBBS (synthetic)', registration_council: 'SYN-NMC', registration_no: 'SYN-0001', mapping_state: 'unmapped', is_active: true, version: 1 });
    expect(by(R.x2).mapping_state).toBe('mapped');
    expect(by(R.x3).mapping_state).toBe('rejected');
    expect(by(R.x3)).not.toHaveProperty('qualification');
    expect(by(R.x4).is_active).toBe(false);
  });
  it('filters: is_active, q (case-insensitive name prefix), limit', async () => {
    const w = makeWorld();
    const ids = async (query: object) => (await call(w, 'listPartnerReferrers', 'adminX', req({ query }))).body.data.map((x: any) => x.id).sort();
    expect(await ids({ is_active: true })).toEqual([R.x1, R.x2, R.x3].sort());
    expect(await ids({ is_active: false })).toEqual([R.x4]);
    expect(await ids({ q: 'DR al' })).toEqual([R.x1]);
    expect(await ids({ q: 'Beta' })).toEqual([]); // prefix, not substring
    const lim = await call(w, 'listPartnerReferrers', 'adminX', req({ query: { limit: 2 } }));
    expect(lim.body.data).toHaveLength(2);
    expect(lim.body.page.limit).toBe(2);
  });
  it("q is a literal prefix: LIKE wildcards are escaped and injection text is a bound parameter", async () => {
    const w = makeWorld();
    for (const q of ['%', '_', '\\', "'; DROP TABLE partners.partner_referrers;--"]) {
      const r = await call(w, 'listPartnerReferrers', 'adminX', req({ query: { q } }));
      expect(r.body.data, q).toEqual([]);
    }
    expect(w.sql.every((s) => !s.text.includes('DROP TABLE'))).toBe(true);
    expect(w.referrers.length).toBe(6);
  });
  it('samples_this_month is 0 without converted lines', async () => {
    const w = makeWorld();
    const r = await call(w, 'listPartnerReferrers', 'adminX', req());
    for (const x of r.body.data) expect(x.samples_this_month).toBe(0);
  });
  it('staff token -> 403 auth.forbidden (US-15.4); suspended partner -> partners.partner_inactive (AB8)', async () => {
    const w = makeWorld();
    await fails(call(w, 'listPartnerReferrers', 'staff', req()), 'auth.forbidden', 403);
    await fails(call(w, 'listPartnerReferrers', 'adminZ', req()), 'partners.partner_inactive');
  });
  it('tenant settings are read with explicit keys (D-119: only timezone/calendarDisplay for partner actors)', async () => {
    const w = makeWorld();
    await call(w, 'listPartnerReferrers', 'memberX', req());
    const calls = w.portCalls.filter((c) => c.name === 'getTenantSettings');
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) { expect(Array.isArray(c.input?.keys)).toBe(true); expect(c.input.keys.every((k: string) => ['timezone', 'calendarDisplay'].includes(k))).toBe(true); }
  });
});

// ------------------------------------------------------------------ US-13.6 samples_this_month
describe('T11 samples_this_month (US-13.6) — converted lines of the current month in the tenant timezone', () => {
  const OCT = '2026-10-20T06:00:00.000Z';
  it('30 converted lines in October -> "30"; other states, other months, other referrers and other partners are not counted', async () => {
    const w = makeWorld();
    w.addConverted(R.x2, P.X, 28, ts('2026-10-10T05:00:00.000Z'));
    w.addConverted(R.x2, P.X, 1, ts('2026-09-30T18:15:00.000Z')); // 2026-10-01 00:00 Asia/Kathmandu: first instant of October -> counted
    w.addConverted(R.x2, P.X, 1, ts('2026-10-31T18:14:59.000Z')); // 2026-10-31 23:59:59 Asia/Kathmandu: last second of October -> counted
    w.addConverted(R.x2, P.X, 1, ts('2026-09-30T18:14:59.000Z')); // September 30 23:59:59 local -> not counted
    w.addConverted(R.x2, P.X, 1, ts('2026-10-31T18:15:00.000Z')); // November 1 00:00 local -> not counted
    w.addConverted(R.x2, P.X, 3, ts('2026-10-12T05:00:00.000Z'), 'converting');
    w.addConverted(R.x2, P.X, 2, ts('2026-10-12T05:00:00.000Z'), 'conversion_failed');
    w.addConverted(R.x1, P.X, 5, ts('2026-10-12T05:00:00.000Z'));
    w.addConverted(R.y1, P.Y, 7, ts('2026-10-12T05:00:00.000Z'));
    const r = await call(w, 'listPartnerReferrers', 'memberX', req(), { now: OCT });
    const by = (rid: string) => r.body.data.find((x: any) => x.id === rid);
    expect(by(R.x2).samples_this_month).toBe(30);
    expect(by(R.x1).samples_this_month).toBe(5);
    expect(by(R.x3).samples_this_month).toBe(0);
    expect(r.body.data.map((x: any) => x.id)).not.toContain(R.y1);
  });
  it('month comes from the tenant timezone, not UTC: 2026-10-31T19:00Z is already 1 November in Asia/Kathmandu', async () => {
    const w = makeWorld();
    w.addConverted(R.x2, P.X, 4, ts('2026-10-31T18:14:59.000Z')); // October local
    w.addConverted(R.x2, P.X, 2, ts('2026-10-31T18:15:00.000Z')); // November local
    w.addConverted(R.x2, P.X, 1, ts('2026-11-05T05:00:00.000Z'));
    const r = await call(w, 'listPartnerReferrers', 'adminX', req(), { now: '2026-10-31T19:00:00.000Z' });
    expect(r.body.data.find((x: any) => x.id === R.x2).samples_this_month).toBe(3);
    expect(w.portCalls.some((c) => c.name === 'getTenantSettings')).toBe(true);
  });
  it('the count is the same on the staff mapping list (SR1) and after F3/F4 responses', async () => {
    const w = makeWorld();
    w.addConverted(R.x2, P.X, 6, ts('2026-11-02T05:00:00.000Z'));
    const sr1 = await call(w, 'listReferrerMappings', 'staff', req({ query: { mapping_state: 'mapped' } }));
    expect(sr1.body.data[0]).toMatchObject({ id: R.x2, samples_this_month: 6 });
    const f4 = await call(w, 'deactivatePartnerReferrer', 'adminX', sr(R.x2, { headers: ifm(2) }));
    expect(f4.body.samples_this_month).toBe(6);
  });
});

// ------------------------------------------------------------------ F2 create
describe('T11 F2 createPartnerReferrer (US-13.1)', () => {
  it('US-13.1: partner admin adds a referrer -> 201, active, unmapped, version 1, row scoped to the caller partner/tenant, no C3 call', async () => {
    const w = makeWorld();
    const r = await call(w, 'createPartnerReferrer', 'adminX', req({ body: body() }));
    expect(r.status).toBe(201);
    dto(r.body);
    expect(r.body).toMatchObject({ display_name: 'Dr Omega Synthetic', qualification: 'MBBS (synthetic)', registration_council: 'SYN-NMC', registration_no: 'SYN-9001', is_active: true, mapping_state: 'unmapped', samples_this_month: 0, version: 1 });
    const row = w.ref(r.body.id);
    expect(row).toMatchObject({ tenant_id: T_A, partner_id: P.X, display_name_norm: 'dr omega synthetic', mapping_state: 'unmapped', catalog_doctor_id: null, is_active: true, version: 1, created_by: U.adminX, updated_by: U.adminX });
    expect(w.portCalls.filter((c) => c.name === 'assertRole').map((c) => c.input.permission)).toEqual(['partners.referrer.manage']);
    expect(w.portCalls.some((c) => c.name === 'getReferrer')).toBe(false);
    expect(w.jobs).toEqual([]);
    expect(w.portCalls[0]!.name).toBe('assertRole'); // permission is the first port call
  });
  it('only display_name is required; optional fields stay NULL and are omitted from the response', async () => {
    const w = makeWorld();
    const r = await call(w, 'createPartnerReferrer', 'adminX', req({ body: { display_name: 'Dr Sigma Synthetic' } }));
    expect(r.status).toBe(201);
    expect(r.body).not.toHaveProperty('qualification');
    expect(w.ref(r.body.id)).toMatchObject({ qualification: null, registration_council: null, registration_no: null });
  });
  it('display_name is stored NFC, trimmed, spaces collapsed; display_name_norm = lower-case of that', async () => {
    const w = makeWorld();
    const r = await call(w, 'createPartnerReferrer', 'adminX', req({ body: { display_name: '  Dr.   Zoë   SYNTHETIC ' } }));
    expect(r.body.display_name).toBe('Dr. Zoë SYNTHETIC');
    expect(w.ref(r.body.id)).toMatchObject({ display_name: 'Dr. Zoë SYNTHETIC', display_name_norm: 'dr. zoë synthetic' });
  });
  it('boundaries: 120-char name, 120 qualification, 20 council, 30 registration no are accepted', async () => {
    const w = makeWorld();
    const r = await call(w, 'createPartnerReferrer', 'adminX', req({ body: { display_name: 'n'.repeat(120), qualification: 'q'.repeat(120), registration_council: 'c'.repeat(20), registration_no: 'r'.repeat(30) } }));
    expect(r.status).toBe(201);
  });

  describe('duplicate rule: same (partner, normalised name, registration no) -> 409 partners.referrer_duplicate', () => {
    const dup = async (who: Who, b: object) => {
      const w = makeWorld();
      const n = w.referrers.length;
      await fails(call(w, 'createPartnerReferrer', who, req({ body: b })), 'partners.referrer_duplicate', 409);
      expect(w.referrers).toHaveLength(n);
    };
    it('exact repeat of an existing referrer', () => dup('adminX', { display_name: 'Dr Alpha Synthetic', registration_no: 'SYN-0001' }));
    it('case / whitespace / NFC variants of the name are the same name', () => dup('adminX', { display_name: '  DR   alpha\tSYNTHETIC ', registration_no: 'SYN-0001' }));
    it('no registration no on both sides (coalesce to empty)', () => dup('adminX', { display_name: 'dr gamma  synthetic' }));
    it('a duplicate that only the unique index can see (concurrent create) is still 409, not 500', async () => {
      const w = makeWorld();
      const before = w.referrers.length;
      const hidden = { id: id(300), tenant_id: T_A, partner_id: P.X, display_name: 'Dr Omega Synthetic', display_name_norm: 'dr omega synthetic', registration_no: 'SYN-9001', mapping_state: 'unmapped',
        catalog_doctor_id: null, mapping_reject_reason_code: null, is_active: true, version: 1, created_by: U.adminX, updated_by: U.adminX };
      await fails(call(w, 'createPartnerReferrer', 'adminX', req({ body: body() }), { hiddenDuplicate: hidden }), 'partners.referrer_duplicate', 409);
      expect(w.referrers).toHaveLength(before + 1); // only the hidden one
    });
    it.each([
      ['same name, different registration no', { display_name: 'Dr Alpha Synthetic', registration_no: 'SYN-7777' }],
      ['same name, no registration no (existing has one)', { display_name: 'Dr Alpha Synthetic' }],
      ['different name, same registration no', { display_name: 'Dr Different Synthetic', registration_no: 'SYN-0001' }],
    ])('allowed: %s', async (_l, b) => {
      const w = makeWorld();
      expect((await call(w, 'createPartnerReferrer', 'adminX', req({ body: b }))).status).toBe(201);
    });
    it('the rule is per partner: partner Y may add a name+registration no that only partner X has', async () => {
      const w = makeWorld();
      const r = await call(w, 'createPartnerReferrer', 'adminY', req({ body: { display_name: 'Dr Beta Synthetic', registration_no: 'SYN-0002' } }));
      expect(r.status).toBe(201);
      expect(w.ref(r.body.id).partner_id).toBe(P.Y);
    });
    it('the error does not echo the name or registration no', async () => {
      const w = makeWorld();
      const e = await fails(call(w, 'createPartnerReferrer', 'adminX', req({ body: { display_name: 'Dr Alpha Synthetic', registration_no: 'SYN-0001' } })), 'partners.referrer_duplicate');
      expect(leaks(e, ['Alpha', 'SYN-0001'])).toEqual([]);
    });
  });

  describe('validation: 400 common.validation_failed, nothing written, no port call beyond assertRole', () => {
    it.each([
      ['display_name missing', { display_name: undefined }], ['display_name empty', { display_name: '' }], ['display_name blank', { display_name: '  \t ' }],
      ['display_name 121', { display_name: 'n'.repeat(121) }], ['display_name number', { display_name: 123 }], ['qualification 121', { qualification: 'q'.repeat(121) }],
      ['council 21', { registration_council: 'c'.repeat(21) }], ['registration_no 31', { registration_no: 'r'.repeat(31) }], ['qualification number', { qualification: 5 }],
    ])('%s', async (_l, o) => {
      const w = makeWorld();
      await fails(call(w, 'createPartnerReferrer', 'adminX', req({ body: body(o) })), 'common.validation_failed', 400);
      untouched(w);
      expect(w.referrers).toHaveLength(6);
    });
    it.each(['partner_id', 'tenant_id', 'mapping_state', 'catalog_doctor_id', 'is_active', 'version', 'id', 'created_by', 'samples_this_month', 'mapped_by'])
    ('AB2 / mass assignment: unknown key %s -> 400, nothing written', async (k) => {
      const w = makeWorld();
      await fails(call(w, 'createPartnerReferrer', 'adminX', req({ body: body({ [k]: k === 'is_active' ? false : k === 'version' ? 9 : k === 'mapping_state' ? 'mapped' : P.Y }) })), 'common.validation_failed', 400);
      untouched(w);
    });
    it('a body that is not an object -> 400', async () => {
      const w = makeWorld();
      for (const b of [undefined, null, 'x', [body()]]) await fails(call(w, 'createPartnerReferrer', 'adminX', req({ body: b })), 'common.validation_failed', 400);
      untouched(w);
    });
  });

  it('US-13.2: partner member -> 403 auth.forbidden, nothing written; staff token -> 403; suspended partner -> partners.partner_inactive', async () => {
    const w = makeWorld();
    await fails(call(w, 'createPartnerReferrer', 'memberX', req({ body: body() })), 'auth.forbidden', 403);
    await fails(call(w, 'createPartnerReferrer', 'staff', req({ body: body() })), 'auth.forbidden', 403);
    await fails(call(w, 'createPartnerReferrer', 'adminZ', req({ body: body() })), 'partners.partner_inactive');
    untouched(w);
    expect(w.referrers).toHaveLength(6);
  });
  it('a created referrer of partner B lands in tenant B (tenant from the caller, never the body)', async () => {
    const w = makeWorld();
    const r = await call(w, 'createPartnerReferrer', 'adminB', req({ body: { display_name: 'Dr Alpha Synthetic' } }));
    expect(w.ref(r.body.id)).toMatchObject({ tenant_id: T_B, partner_id: P.B });
  });
});

// ------------------------------------------------------------------ F3 / F4 / F5
describe('T11 F3 updatePartnerReferrer', () => {
  it('updates the given fields only; version + 1; updated_by = caller; display_name_norm follows', async () => {
    const w = makeWorld();
    const r = await call(w, 'updatePartnerReferrer', 'adminX', sr(R.x1, { headers: ifm(1), body: { display_name: ' Dr  Alpha   RENAMED Synthetic', qualification: 'MD (synthetic)' } }));
    expect(r.status).toBe(200);
    dto(r.body);
    expect(r.body).toMatchObject({ id: R.x1, display_name: 'Dr Alpha RENAMED Synthetic', qualification: 'MD (synthetic)', registration_council: 'SYN-NMC', registration_no: 'SYN-0001', version: 2 });
    expect(w.ref(R.x1)).toMatchObject({ display_name_norm: 'dr alpha renamed synthetic', updated_by: U.adminX, version: 2, mapping_state: 'unmapped', is_active: true, partner_id: P.X });
  });
  it('unset[] clears optional fields (omitted in the response)', async () => {
    const w = makeWorld();
    const r = await call(w, 'updatePartnerReferrer', 'adminX', sr(R.x1, { headers: ifm(1), body: { unset: ['qualification', 'registration_council', 'registration_no'] } }));
    expect(r.body).not.toHaveProperty('qualification');
    expect(r.body).not.toHaveProperty('registration_no');
    expect(w.ref(R.x1)).toMatchObject({ qualification: null, registration_council: null, registration_no: null, version: 2 });
  });
  it('re-sending its own name is not a duplicate of itself', async () => {
    const w = makeWorld();
    const r = await call(w, 'updatePartnerReferrer', 'adminX', sr(R.x1, { headers: ifm(1), body: { display_name: ' dr alpha  synthetic' } }));
    expect(r.status).toBe(200);
  });
  it('rejected -> unmapped when the partner edits the name or the registration no (03-APP-FLOW 2.6); reject reason cleared', async () => {
    for (const patch of [{ display_name: 'Dr Gamma Corrected Synthetic' }, { registration_no: 'SYN-0003' }]) {
      const w = makeWorld();
      const r = await call(w, 'updatePartnerReferrer', 'adminX', sr(R.x3, { headers: ifm(1), body: patch }));
      expect(r.body.mapping_state).toBe('unmapped');
      expect(w.ref(R.x3)).toMatchObject({ mapping_state: 'unmapped', mapping_reject_reason_code: null, catalog_doctor_id: null, version: 2 });
    }
  });
  it('409 partners.referrer_duplicate when the new name + registration no collide; row unchanged', async () => {
    const w = makeWorld();
    const before = state(w);
    await fails(call(w, 'updatePartnerReferrer', 'adminX', sr(R.x1, { headers: ifm(1), body: { display_name: 'DR BETA synthetic', registration_no: 'SYN-0002' } })), 'partners.referrer_duplicate', 409);
    expect(state(w)).toBe(before);
  });
  it.each(['mapping_state', 'catalog_doctor_id', 'partner_id', 'is_active', 'version', 'mapped_by'])('AB2: unknown key %s -> 400, row unchanged', async (k) => {
    const w = makeWorld();
    const before = state(w);
    await fails(call(w, 'updatePartnerReferrer', 'adminX', sr(R.x1, { headers: ifm(1), body: { display_name: 'Dr Alpha Synthetic', [k]: k === 'is_active' ? false : 'mapped' } })), 'common.validation_failed', 400);
    expect(state(w)).toBe(before);
  });
  it.each([
    ['display_name empty', { display_name: '' }], ['display_name 121', { display_name: 'n'.repeat(121) }], ['council 21', { registration_council: 'c'.repeat(21) }],
    ['regno 31', { registration_no: 'r'.repeat(31) }], ['unset unknown field', { unset: ['display_name'] }], ['unset > 3', { unset: ['qualification', 'registration_council', 'registration_no', 'qualification'] }],
  ])('validation: %s -> 400', async (_l, b) => {
    const w = makeWorld();
    await fails(call(w, 'updatePartnerReferrer', 'adminX', sr(R.x1, { headers: ifm(1), body: b })), 'common.validation_failed', 400);
    untouched(w);
  });
});

describe('T11 F4 deactivate / F5 reactivate', () => {
  it('F4: is_active=false, version + 1, mapping untouched, lines untouched (inactive stays on existing lines)', async () => {
    const w = makeWorld();
    const lines = lineSnap(w, L.f1, L.f2, L.c1, L.dr);
    const r = await call(w, 'deactivatePartnerReferrer', 'adminX', sr(R.x2, { headers: ifm(2) }));
    expect(r.status).toBe(200);
    dto(r.body);
    expect(r.body).toMatchObject({ id: R.x2, is_active: false, mapping_state: 'mapped', version: 3 });
    expect(w.ref(R.x2)).toMatchObject({ is_active: false, catalog_doctor_id: D.d1, version: 3, updated_by: U.adminX });
    expect(w.writes().some((q) => /manifest_lines/i.test(q.text))).toBe(false);
    expect(lineSnap(w, L.f1, L.f2, L.c1, L.dr)).toBe(lines);
    expect(w.jobs).toEqual([]);
  });
  it('F5: is_active=true, version + 1', async () => {
    const w = makeWorld();
    const r = await call(w, 'reactivatePartnerReferrer', 'adminX', sr(R.x4, { headers: ifm(3) }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: R.x4, is_active: true, version: 4 });
    expect(w.ref(R.x4)).toMatchObject({ is_active: true, version: 4, updated_by: U.adminX });
  });
});

describe.each([
  ['F3 updatePartnerReferrer', 'updatePartnerReferrer', { display_name: 'Dr Alpha Synthetic' }],
  ['F4 deactivatePartnerReferrer', 'deactivatePartnerReferrer', undefined],
  ['F5 reactivatePartnerReferrer', 'reactivatePartnerReferrer', undefined],
] as const)('T11 %s — If-Match, permissions and isolation', (_n, op, b) => {
  const target = op === 'reactivatePartnerReferrer' ? R.x4 : R.x1;
  const ver = op === 'reactivatePartnerReferrer' ? 3 : 1;
  it('If-Match: absent -> 428 common.precondition_required; stale -> 409 common.version_conflict; malformed -> 400; row unchanged', async () => {
    const w = makeWorld();
    const before = state(w);
    await fails(call(w, op, 'adminX', sr(target, { body: b })), 'common.precondition_required', 428);
    await fails(call(w, op, 'adminX', sr(target, { headers: ifm(ver + 5), body: b })), 'common.version_conflict', 409);
    for (const bad of ['abc', '"x"', '""', '"-1"', '"1.5"']) await fails(call(w, op, 'adminX', sr(target, { headers: ifm(bad), body: b })), 'common.validation_failed', 400);
    expect(state(w)).toBe(before);
  });
  it('US-13.2 / ST8: partner member -> 403 auth.forbidden, nothing written; staff token -> 403 (US-15.4)', async () => {
    const w = makeWorld();
    await fails(call(w, op, 'memberX', sr(target, { headers: ifm(ver), body: b })), 'auth.forbidden', 403);
    await fails(call(w, op, 'staff', sr(target, { headers: ifm(ver), body: b })), 'auth.forbidden', 403);
    untouched(w);
    expect(w.portCalls.find((c) => c.name === 'assertRole')!.input.permission).toBe('partners.referrer.manage');
  });
  it('ST2: partner Y credentials on X ids and X credentials on Y/B ids -> 404 common.not_found, no data of the other side, no change (RLS on and off)', async () => {
    for (const noRls of [false, true]) {
      const w = makeWorld();
      const before = state(w);
      await fails(call(w, op, 'adminY', sr(target, { headers: ifm(ver), body: b }), { noRls }), 'common.not_found', 404);
      await fails(call(w, op, 'adminX', sr(R.y1, { headers: ifm(1), body: b }), { noRls }), 'common.not_found', 404);
      await fails(call(w, op, 'adminX', sr(R.b1, { headers: ifm(1), body: b }), { noRls }), 'common.not_found', 404);
      await fails(call(w, op, 'adminB', sr(target, { headers: ifm(ver), body: b }), { noRls }), 'common.not_found', 404);
      await fails(call(w, op, 'adminX', sr(id(999), { headers: ifm(1), body: b }), { noRls }), 'common.not_found', 404);
      expect(state(w), `noRls=${noRls}`).toBe(before);
    }
  });
  it('suspended partner -> partners.partner_inactive', async () => {
    const w = makeWorld();
    await fails(call(w, op, 'adminZ', sr(target, { headers: ifm(1), body: b })), 'partners.partner_inactive');
    untouched(w);
  });
});

// ------------------------------------------------------------------ SR1
describe('T11 SR1 listReferrerMappings (US-13.3)', () => {
  const ids = (r: { body: any }) => r.body.data.map((x: any) => x.id).sort();
  it('default mapping_state = unmapped, tenant-wide across partners; ReferrerMapping DTO with partner {id, name}; permission partners.referrer.map', async () => {
    const w = makeWorld();
    const r = await call(w, 'listReferrerMappings', 'staff', req());
    expect(r.status).toBe(200);
    const got = ids(r);
    expect(got).toEqual(expect.arrayContaining([R.x1, R.y1]));
    for (const not of [R.x2, R.x3, R.b1]) expect(got).not.toContain(not);
    for (const x of r.body.data) { dto(x, RM_KEYS); expect(x.mapping_state).toBe('unmapped'); expect(x).not.toHaveProperty('catalog_doctor'); expect(Object.keys(x.partner).sort()).toEqual(['id', 'name']); }
    expect(r.body.data.find((x: any) => x.id === R.x1).partner).toEqual({ id: P.X, name: 'Synthetic Partner X' });
    expect(r.body.data.find((x: any) => x.id === R.y1).partner).toEqual({ id: P.Y, name: 'Synthetic Partner Y' });
    expect(w.portCalls.find((c) => c.name === 'assertRole')!.input.permission).toBe('partners.referrer.map');
    untouched(w);
  });
  it('mapped rows carry catalog_doctor {id, display_name} resolved through CatalogPort.getReferrer (purpose display) with the staff ctx', async () => {
    const w = makeWorld();
    const r = await call(w, 'listReferrerMappings', 'staff', req({ query: { mapping_state: 'mapped' } }));
    expect(ids(r)).toEqual([R.x2]);
    expect(r.body.data[0].catalog_doctor).toEqual({ id: D.d1, display_name: 'Synthetic Doctor One' });
    const g = w.portCalls.filter((c) => c.name === 'getReferrer');
    expect(g.length).toBeGreaterThanOrEqual(1);
    for (const c of g) { expect(c.input).toEqual({ referrerId: D.d1, purpose: 'display' }); expect(c.tenantId).toBe(T_A); expect(c.ctxArg.actor.type).toBe('user'); }
  });
  it('rejected filter; partner_id filter; limit', async () => {
    const w = makeWorld();
    expect(ids(await call(w, 'listReferrerMappings', 'staff', req({ query: { mapping_state: 'rejected' } })))).toEqual([R.x3]);
    expect(ids(await call(w, 'listReferrerMappings', 'staff', req({ query: { partner_id: P.Y } })))).toEqual([R.y1]);
    const lim = await call(w, 'listReferrerMappings', 'staff', req({ query: { limit: 1 } }));
    expect(lim.body.data).toHaveLength(1);
    expect(lim.body.page.limit).toBe(1);
  });
  it('ST1: tenant isolation — staff of A never sees B rows (also with a foreign partner_id filter); staff of B sees only B (RLS on and off)', async () => {
    for (const noRls of [false, true]) {
      const w = makeWorld();
      expect(ids(await call(w, 'listReferrerMappings', 'staff', req({ query: { mapping_state: 'unmapped' } }), { noRls })), `noRls=${noRls}`).not.toContain(R.b1);
      expect(ids(await call(w, 'listReferrerMappings', 'staff', req({ query: { partner_id: P.B } }), { noRls }))).toEqual([]);
      expect(ids(await call(w, 'listReferrerMappings', 'staffB', req(), { noRls }))).toEqual([R.b1]);
    }
  });
  it('ST4: partner tokens (admin and member) and staff without partners.referrer.map -> 403 auth.forbidden', async () => {
    const w = makeWorld();
    for (const who of ['adminX', 'memberX', 'adminY', 'staffNoMap'] as const) await fails(call(w, 'listReferrerMappings', who, req()), 'auth.forbidden', 403);
    expect(w.portCalls.filter((c) => c.name === 'getReferrer')).toEqual([]);
  });
});

// ------------------------------------------------------------------ SR2
describe('T11 SR2 mapPartnerReferrer (US-13.3 / 13.4 / 13.5)', () => {
  const map = (w: World, rid: string, doc: string | undefined, v: number | string, who: Who = 'staff', over: Opts = {}) =>
    call(w, 'mapPartnerReferrer', who, sr(rid, { headers: ifm(v), body: doc === undefined ? {} : { catalog_doctor_id: doc } }), over);

  it('US-13.3: unmapped -> mapped, catalog_doctor_id/mapped_at/mapped_by stored, version + 1, ReferrerMapping body', async () => {
    const w = makeWorld();
    const r = await map(w, R.x1, D.d1, 1);
    expect(r.status).toBe(200);
    dto(r.body, RM_KEYS);
    expect(r.body).toMatchObject({ id: R.x1, mapping_state: 'mapped', version: 2, partner: { id: P.X, name: 'Synthetic Partner X' }, catalog_doctor: { id: D.d1, display_name: 'Synthetic Doctor One' } });
    expect(w.ref(R.x1)).toMatchObject({ mapping_state: 'mapped', catalog_doctor_id: D.d1, mapped_by: STAFF.id, updated_by: STAFF.id, version: 2, mapping_reject_reason_code: null, partner_id: P.X, tenant_id: T_A });
    expect(w.ref(R.x1).mapped_at).toBeTruthy();
    expect(w.portCalls.find((c) => c.name === 'assertRole')!.input.permission).toBe('partners.referrer.map');
  });
  it('done_when: the doctor is validated through CatalogPort.getReferrer({referrerId, purpose: display}) with the request ctx, after the permission check and BEFORE any write', async () => {
    const w = makeWorld();
    await map(w, R.x1, D.d1, 1);
    const g = w.portCalls.filter((c) => c.name === 'getReferrer');
    expect(g.map((c) => c.input)).toEqual([{ referrerId: D.d1, purpose: 'display' }]);
    expect(g[0]!.tenantId).toBe(T_A);
    const ev = w.events;
    const firstWrite = ev.findIndex((e) => /^SQL (INSERT|UPDATE)/i.test(e));
    expect(ev.indexOf('ASSERT partners.referrer.map')).toBeGreaterThanOrEqual(0);
    expect(ev.indexOf('ASSERT partners.referrer.map')).toBeLessThan(ev.indexOf('PORT getReferrer'));
    expect(ev.indexOf('PORT getReferrer')).toBeLessThan(firstWrite);
  });
  it('the write is guarded against a concurrent writer: row locked FOR UPDATE before the first UPDATE, or the UPDATE tests version', async () => {
    const w = makeWorld();
    await map(w, R.x1, D.d1, 1);
    const firstUpd = w.sql.findIndex((q) => /^\s*UPDATE\s+partners\.partner_referrers/i.test(q.text));
    expect(firstUpd).toBeGreaterThanOrEqual(0);
    const locked = w.sql.slice(0, firstUpd).some((q) => /FROM\s+partners\.partner_referrers[\s\S]*FOR\s+UPDATE/i.test(q.text));
    const versioned = /\bWHERE\b[\s\S]*\bversion\s*=/i.test(w.sql[firstUpd]!.text);
    expect(locked || versioned).toBe(true);
  });

  it('US-13.4: re-enqueues the lines failed with partners.referrer_not_mapped of THIS referrer — attempt + 1, failure cleared, one job each (key convert:<line>:<attempt>)', async () => {
    const w = makeWorld();
    const others = () => lineSnap(w, L.f3, L.c1, L.f5, L.fy, L.fb, L.dr);
    const otherBefore = others();
    await map(w, R.x1, D.d1, 1);
    expect(w.line(L.f1)).toMatchObject({ state: 'converting', conversion_attempt: 2, failure_code: null, failed_at: null });
    expect(w.line(L.f2)).toMatchObject({ state: 'converting', conversion_attempt: 3, failure_code: null, failed_at: null });
    expect(others()).toBe(otherBefore); // other failure code, converting, other referrer, other partner, other tenant, draft: untouched
    expect(w.jobs.map((j) => [j.identifier, j.key]).sort()).toEqual([[CONVERT, `convert:${L.f1}:2`], [CONVERT, `convert:${L.f2}:3`]].sort());
    for (const j of w.jobs) {
      const lineId = j.key.split(':')[1]!;
      expect(j.payload.attempt).toBe(w.line(lineId).conversion_attempt);
      expect(JSON.stringify(j.payload)).toContain(lineId);
      expect(JSON.stringify(j.payload)).toContain(T_A);
    }
  });
  it('line update and enqueue happen after the referrer row is mapped, in the same transaction (jobs follow the line UPDATE)', async () => {
    const w = makeWorld();
    await map(w, R.x1, D.d1, 1);
    const ev = w.events;
    const lineUpd = ev.findIndex((e) => /^SQL UPDATE partners\.manifest_lines/i.test(e));
    const refUpd = ev.findIndex((e) => /^SQL UPDATE partners\.partner_referrers/i.test(e));
    const firstJob = ev.findIndex((e) => e.startsWith('JOB '));
    expect(refUpd).toBeGreaterThanOrEqual(0);
    expect(lineUpd).toBeGreaterThan(refUpd);
    expect(firstJob).toBeGreaterThan(lineUpd);
  });
  it('a line a staff member already retried (or converted) meanwhile is not touched and gets no second job', async () => {
    const w = makeWorld();
    w.line(L.f1).state = 'converting'; w.line(L.f1).failure_code = null; w.line(L.f1).failed_at = null; w.line(L.f1).conversion_attempt = 2;
    const f1 = lineSnap(w, L.f1);
    await map(w, R.x1, D.d1, 1);
    expect(lineSnap(w, L.f1)).toBe(f1);
    expect(w.jobs.map((j) => j.key)).toEqual([`convert:${L.f2}:3`]);
  });
  it('no failed lines -> still 200 and no jobs', async () => {
    const w = makeWorld();
    for (const l of [L.f1, L.f2]) Object.assign(w.line(l), { state: 'converted', failure_code: null, failed_at: null, order_id: w.next(), converted_at: '2026-11-01T00:00:00.000Z' });
    const r = await map(w, R.x1, D.d1, 1);
    expect(r.status).toBe(200);
    expect(w.jobs).toEqual([]);
  });
  it('enqueue failure surfaces (not swallowed) so the request transaction rolls the mapping back', async () => {
    const w = makeWorld();
    const err = new Error('queue down');
    await expect(map(w, R.x1, D.d1, 1, 'staff', { enqueueError: err })).rejects.toBe(err);
    expect(w.ref(R.x1)).toMatchObject({ mapping_state: 'unmapped', catalog_doctor_id: null, version: 1 });
    expect(w.line(L.f1)).toMatchObject({ state: 'conversion_failed', conversion_attempt: 1 });
    expect(w.jobs).toEqual([]);
  });

  describe('US-13.5 / doctor validation (nothing is written, no line is touched, no job)', () => {
    it.each([
      ['doctor of tenant B (via getReferrer)', D.b, 'common.not_found', 404],
      ['unknown doctor id', D.unknown, 'common.not_found', 404],
      ['inactive doctor', D.inactive, 'partners.referrer_doctor_inactive', 422],
    ])('%s', async (_l, doc, code, status) => {
      const w = makeWorld();
      const before = state(w);
      await fails(map(w, R.x1, doc, 1), code, status);
      expect(w.portCalls.filter((c) => c.name === 'getReferrer')).toHaveLength(1);
      expect(state(w)).toBe(before);
      untouched(w);
    });
    it('a merged doctor is stored under its canonicalReferrerId (CR-C3-001)', async () => {
      const w = makeWorld();
      const r = await map(w, R.x1, D.merged, 1);
      expect(w.ref(R.x1).catalog_doctor_id).toBe(D.d2);
      expect(r.body.catalog_doctor.id).toBe(D.d2);
    });
    it('C3 failure other than not_found/inactive is passed through unchanged and nothing is written', async () => {
      const w = makeWorld();
      const err = new LimsError('common.dependency_unavailable');
      await expect(map(w, R.x1, D.d1, 1, 'staff', { catalogError: err })).rejects.toBe(err);
      untouched(w);
    });
    it('the error body does not reveal the other tenant doctor', async () => {
      const w = makeWorld();
      const e = await fails(map(w, R.x1, D.b, 1), 'common.not_found');
      expect(leaks(e, ['Other Tenant', 'SYN-DOC-B'])).toEqual([]);
    });
  });

  it('03-APP-FLOW 2.6: only unmapped -> mapped; mapped (even to the same doctor) and rejected -> 409 partners.referrer_invalid_transition, nothing written', async () => {
    const w = makeWorld();
    await fails(map(w, R.x2, D.d2, 2), 'partners.referrer_invalid_transition', 409);
    await fails(map(w, R.x2, D.d1, 2), 'partners.referrer_invalid_transition', 409);
    await fails(map(w, R.x3, D.d1, 1), 'partners.referrer_invalid_transition', 409);
    untouched(w);
  });
  it('If-Match: absent 428, stale 409 common.version_conflict, malformed 400', async () => {
    const w = makeWorld();
    const before = state(w);
    await fails(call(w, 'mapPartnerReferrer', 'staff', sr(R.x1, { body: { catalog_doctor_id: D.d1 } })), 'common.precondition_required', 428);
    await fails(map(w, R.x1, D.d1, 4), 'common.version_conflict', 409);
    for (const bad of ['abc', '"x"', '""']) await fails(map(w, R.x1, D.d1, bad), 'common.validation_failed', 400);
    expect(state(w)).toBe(before);
  });
  it('a partner edit after the staff screen loaded (version bumped) makes the stale mapping fail with 409 — no jobs', async () => {
    const w = makeWorld();
    await call(w, 'updatePartnerReferrer', 'adminX', sr(R.x1, { headers: ifm(1), body: { qualification: 'MD (synthetic)' } }));
    await fails(map(w, R.x1, D.d1, 1), 'common.version_conflict', 409);
    expect(w.jobs).toEqual([]);
  });
  it.each([
    ['catalog_doctor_id missing', undefined], ['catalog_doctor_id not a uuid', 'not-a-uuid'], ['catalog_doctor_id number', 5],
  ])('validation: %s -> 400 common.validation_failed, no C3 call, nothing written', async (_l, doc) => {
    const w = makeWorld();
    await fails(call(w, 'mapPartnerReferrer', 'staff', sr(R.x1, { headers: ifm(1), body: doc === undefined ? {} : { catalog_doctor_id: doc } })), 'common.validation_failed', 400);
    expect(w.portCalls.filter((c) => c.name === 'getReferrer')).toEqual([]);
    untouched(w);
  });
  it.each(['mapping_state', 'partner_id', 'mapped_by', 'version', 'tenant_id'])('mass assignment: unknown key %s -> 400, nothing written', async (k) => {
    const w = makeWorld();
    await fails(call(w, 'mapPartnerReferrer', 'staff', sr(R.x1, { headers: ifm(1), body: { catalog_doctor_id: D.d1, [k]: P.Y } })), 'common.validation_failed', 400);
    untouched(w);
  });
  it('ST1/ST4: partner admin/member and staff without partners.referrer.map -> 403; staff of tenant B on a tenant A referrer -> 404 (RLS on and off)', async () => {
    const w = makeWorld();
    for (const who of ['adminX', 'memberX', 'adminY', 'staffNoMap'] as const) await fails(map(w, R.x1, D.d1, 1, who), 'auth.forbidden', 403);
    expect(w.portCalls.filter((c) => c.name === 'getReferrer')).toEqual([]);
    untouched(w);
    for (const noRls of [false, true]) {
      const w2 = makeWorld();
      const before = state(w2);
      await fails(map(w2, R.x1, D.d1, 1, 'staffB', { noRls }), 'common.not_found', 404);
      await fails(map(w2, id(999), D.d1, 1, 'staff', { noRls }), 'common.not_found', 404);
      expect(state(w2), `noRls=${noRls}`).toBe(before);
    }
  });
});

// ------------------------------------------------------------------ SR3
describe('T11 SR3 rejectPartnerReferrerMapping / unmapPartnerReferrer', () => {
  const reject = (w: World, rid: string, v: number | string, b: unknown = { reason_code: 'not_identifiable' }, who: Who = 'staff', over: Opts = {}) =>
    call(w, 'rejectPartnerReferrerMapping', who, sr(rid, { headers: ifm(v), body: b }), over);
  const unmap = (w: World, rid: string, v: number | string, who: Who = 'staff', over: Opts = {}) => call(w, 'unmapPartnerReferrer', who, sr(rid, { headers: ifm(v) }), over);

  it('reject: unmapped -> rejected, reason stored, version + 1, no C3 call, no line touched, no job', async () => {
    const w = makeWorld();
    const lines = lineSnap(w, L.f1, L.f2, L.f3, L.c1);
    const r = await reject(w, R.x1, 1);
    expect(r.status).toBe(200);
    dto(r.body, RM_KEYS);
    expect(r.body).toMatchObject({ id: R.x1, mapping_state: 'rejected', version: 2, partner: { id: P.X } });
    expect(w.ref(R.x1)).toMatchObject({ mapping_state: 'rejected', mapping_reject_reason_code: 'not_identifiable', catalog_doctor_id: null, updated_by: STAFF.id, version: 2 });
    expect(w.portCalls.find((c) => c.name === 'assertRole')!.input.permission).toBe('partners.referrer.map');
    expect(w.portCalls.some((c) => c.name === 'getReferrer')).toBe(false);
    expect(lineSnap(w, L.f1, L.f2, L.f3, L.c1)).toBe(lines);
    expect(w.jobs).toEqual([]);
  });
  it('reject: only from unmapped — mapped and already-rejected -> 409 partners.referrer_invalid_transition, nothing written', async () => {
    const w = makeWorld();
    await fails(reject(w, R.x2, 2), 'partners.referrer_invalid_transition', 409);
    await fails(reject(w, R.x3, 1), 'partners.referrer_invalid_transition', 409);
    untouched(w);
  });
  it.each([
    ['reason_code missing', {}], ['reason_code empty', { reason_code: '' }], ['reason_code 65', { reason_code: 'r'.repeat(65) }], ['reason_code number', { reason_code: 5 }],
    ['unknown key', { reason_code: 'not_identifiable', mapping_state: 'mapped' }], ['body null', null],
    ['reason_code not in set', { reason_code: 'not_a_reason' }],
  ])('reject validation: %s -> 400', async (_l, b) => {
    const w = makeWorld();
    await fails(reject(w, R.x1, 1, b), 'common.validation_failed', 400);
    untouched(w);
  });

  it('unmap: mapped -> unmapped, doctor / mapped_at / mapped_by cleared, version + 1; lines and jobs untouched (future conversions omit referrerId)', async () => {
    const w = makeWorld();
    const lines = lineSnap(w, L.f1, L.f2, L.f3, L.c1);
    const r = await unmap(w, R.x2, 2);
    expect(r.status).toBe(200);
    dto(r.body, RM_KEYS);
    expect(r.body).toMatchObject({ id: R.x2, mapping_state: 'unmapped', version: 3 });
    expect(r.body).not.toHaveProperty('catalog_doctor');
    expect(w.ref(R.x2)).toMatchObject({ mapping_state: 'unmapped', catalog_doctor_id: null, mapped_at: null, mapped_by: null, mapping_reject_reason_code: null, version: 3, updated_by: STAFF.id });
    expect(lineSnap(w, L.f1, L.f2, L.f3, L.c1)).toBe(lines);
    expect(w.jobs).toEqual([]);
  });
  it('unmap: only from mapped — unmapped and rejected -> 409 partners.referrer_invalid_transition', async () => {
    const w = makeWorld();
    await fails(unmap(w, R.x1, 1), 'partners.referrer_invalid_transition', 409);
    await fails(unmap(w, R.x3, 1), 'partners.referrer_invalid_transition', 409);
    untouched(w);
  });
  it('mapped -> unmapped -> mapped again works and re-enqueues lines that failed with partners.referrer_not_mapped in between', async () => {
    const w = makeWorld();
    await unmap(w, R.x2, 2);
    w.addConverted(R.x2, P.X, 1, '2026-11-01T00:00:00.000Z', 'conversion_failed');
    const failed = w.lines[w.lines.length - 1]!;
    const r = await call(w, 'mapPartnerReferrer', 'staff', sr(R.x2, { headers: ifm(3), body: { catalog_doctor_id: D.d2 } }));
    expect(r.body).toMatchObject({ mapping_state: 'mapped', version: 4, catalog_doctor: { id: D.d2 } });
    expect(failed).toMatchObject({ state: 'converting', conversion_attempt: 2 });
    expect(w.jobs.map((j) => j.key)).toEqual([`convert:${failed.id}:2`]);
  });
  describe.each([['reject', (w: World, rid: string, v: number, who: Who, o: Opts) => reject(w, rid, v, undefined, who, o)], ['unmap', (w: World, rid: string, v: number, who: Who, o: Opts) => unmap(w, rid, v, who, o)]] as const)('%s — If-Match, permissions, isolation', (_n, run) => {
    const rid = _n === 'reject' ? R.x1 : R.x2, v = _n === 'reject' ? 1 : 2;
    it('If-Match absent 428, stale 409 common.version_conflict, malformed 400', async () => {
      const w = makeWorld();
      const before = state(w);
      const op = _n === 'reject' ? 'rejectPartnerReferrerMapping' : 'unmapPartnerReferrer';
      await fails(call(w, op, 'staff', sr(rid, { body: { reason_code: 'not_identifiable' } })), 'common.precondition_required', 428);
      await fails(run(w, rid, v + 5, 'staff', {}), 'common.version_conflict', 409);
      for (const bad of ['abc', '"x"']) await fails((_n === 'reject' ? reject(w, rid, bad) : unmap(w, rid, bad)), 'common.validation_failed', 400);
      expect(state(w)).toBe(before);
    });
    it('partner tokens and staff without partners.referrer.map -> 403; tenant B staff -> 404 (RLS on and off)', async () => {
      const w = makeWorld();
      for (const who of ['adminX', 'memberX', 'staffNoMap'] as const) await fails(run(w, rid, v, who, {}), 'auth.forbidden', 403);
      untouched(w);
      for (const noRls of [false, true]) {
        const w2 = makeWorld();
        const before = state(w2);
        await fails(run(w2, rid, v, 'staffB', { noRls }), 'common.not_found', 404);
        expect(state(w2), `noRls=${noRls}`).toBe(before);
      }
    });
  });
});

// ------------------------------------------------------------------ PHI (07-SECURITY ST13)
describe('T11 log scan (ST13): doctor names and registration numbers never reach the logs', () => {
  it('create + update + list + map + reject + unmap leave no planted values in the logs', async () => {
    const w = makeWorld();
    await call(w, 'createPartnerReferrer', 'adminX', req({ body: body({ display_name: 'Dr Planted Leak Synthetic', registration_no: 'SYN-LEAK-1' }) }));
    await call(w, 'updatePartnerReferrer', 'adminX', sr(R.x1, { headers: ifm(1), body: { qualification: 'PLANTED-QUAL' } }));
    await call(w, 'listPartnerReferrers', 'adminX', req({ query: { q: 'planted' } }));
    await call(w, 'listReferrerMappings', 'staff', req());
    await call(w, 'mapPartnerReferrer', 'staff', sr(R.x1, { headers: ifm(2), body: { catalog_doctor_id: D.d1 } }));
    await call(w, 'unmapPartnerReferrer', 'staff', sr(R.x1, { headers: ifm(3) }));
    await call(w, 'rejectPartnerReferrerMapping', 'staff', sr(R.x1, { headers: ifm(4), body: { reason_code: 'not_identifiable' } }));
    expect(leaks(w.logs, ['Planted', 'SYN-LEAK-1', 'PLANTED-QUAL', 'Alpha', 'SYN-0001', 'Doctor One'])).toEqual([]);
    expect(leaks(w.jobs, ['Planted', 'SYN-LEAK-1', 'Alpha', 'SYN-0001'])).toEqual([]); // job payloads carry ids only
  });
});
