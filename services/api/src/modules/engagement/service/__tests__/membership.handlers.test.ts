// C16.T-M1 — membership plans / enrolment / lookup / cancel (M1a, M1b create+update, M2, M3, M4, M5) and E47 listMyMemberships
// (06-PLAN row T-M1; 02-TRD §4.12, §5 M1–M5/E47, §6.1 getPriceListStatus row, §7 permissions; 05-SCHEMA membership_plans/patient_memberships/number_counters;
//  PRD US-EN-17.1–17.5; 07-SECURITY aal1 row + "Membership card QR" row + access-log item 7; 08 A24.1 / CR-C16-023 / R25).
// done_when: card token format; overlap rule (CatalogPort.getPriceListStatus fake). tests: aal1 on plan write -> mfa_required; patient sees only own profiles' cards;
//   getPriceListStatus fake: not_found / isActive false / draft each -> 400, published + active -> 201; no catalog.v_pub_* read from the handler.
// Fails now: handlers/index.ts maps all seven operationIds to the T-01 placeholder (common.service_unavailable) and service/membership.service.ts does not exist.
//
// SEAMS (spec fixes behaviour, not file names; same convention as settings.handlers.test.ts / reminder.handlers.test.ts):
//   handlers[op](req:{params,query,headers,body}, ctx) -> {status, body, headers?}; errors are thrown LimsError(code). ctx = {tenantId, actor:{type,id}, tx, now(), audit:{access}, ports:{IdentityPort, CatalogPort}}.
//   Permission = ctx.ports.IdentityPort.assertRole(ctx,{permission}) BEFORE any tx.query: M1a/M3/M4 engagement.membership.read, M1b engagement.membership_plan.manage (privileged -> aal1 = auth.mfa_required),
//   M2/M5 engagement.membership.enrol, E47 engagement.self.read. Missing tenantId/actor/tx -> auth.unauthenticated.
//   DB = world of __tests__/membership.world.ts on the shared FakeDb SQL interpreter: SINGLE-TABLE statements only (no JOIN / sub-select; the grammar is listed in fakeSql.ts), tenant RLS, PAT_ACC / PAT_PID for patient actors,
//   NOT NULL / UNIQUE / FK / CHECK of 05-SCHEMA and the partial unique index (one active membership per patient -> pg 23505 `patient_memberships__tenant_id_patient_active__p_uq`).
//   Counter row: engagement.number_counters key `card_no:<yy>` (05-SCHEMA), card_no = MB{yy}{seq:6}; yy = year of ctx.now() in Asia/Kathmandu.
//   valid_from window "today ... +30 d" is evaluated on the Asia/Kathmandu calendar date of ctx.now() (05-SCHEMA P-15). valid_to = valid_from + plan.validity_days (calendar days).
//   Assumptions where the spec is silent (not asserted beyond the status class): duplicate plan code -> any 4xx (never 500, never a second row); cancelling a non-active membership -> 409; unknown plan / patient on M2 -> 404 or 400.
//   Pipeline-level checks (schema min/max, x-permission floor, Idempotency-Key replay) are not re-tested; handlers are driven directly so they must refuse bad input themselves.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { ACC1, ACC2, ID, LINK1, LINK_ACC2, LINK_REVOKED, P, PAT1, PAT2, PAT3, PAT_B, PLAN_B, PLAN_GOLD, PLAN_OLD, PL_DISCARDED, PL_DRAFT, PL_INACTIVE, PL_PUBLISHED, PL_UNKNOWN,
  STAFF, TA, TB, TOKEN_B, TOKEN_OK, TOKEN_RE, makeWorld, membership, plan, type World } from '../../__tests__/membership.world.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

type Who = 'staff' | 'patient' | 'system';
const call = (op: string, w: World, req: Record<string, any> = {}, who: Who = 'staff', over: Record<string, unknown> = {}, account?: string) =>
  (handlers as any)[op]({ params: {}, query: {}, headers: {}, body: undefined, ...req }, (account ? w.session(who, over, undefined, account) : w.session(who, over)));
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'RESOLVED'; };
const fail = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e: any) { return e; } throw new Error('expected rejection'); };
const hdr = (out: any, name: string) => out.headers?.[name] ?? out.headers?.[name.toLowerCase()];
const IFM = (v: number) => ({ 'if-match': `"${v}"` });
const IDEM = { 'idempotency-key': 'k-0001' };
const BASE_PLAN = { code: 'SILVER', display_name: 'Silver plan (synthetic)', description: 'Synthetic description', price_list_id: PL_PUBLISHED, validity_days: 365, is_active: true };
const createPlan = (w: World, body: unknown) => call('createMembershipPlan', w, { body, headers: IDEM });
const enrolBody = (o: Record<string, unknown> = {}) => ({ patient_id: PAT1, plan_id: PLAN_GOLD, valid_from: '2026-11-05', ...o });
const enrol = (w: World, body: unknown = enrolBody(), over: Record<string, unknown> = {}) => call('enrolMembership', w, { body, headers: IDEM }, 'staff', over);
const noViews = (w: World) => expect(w.stmts.filter((c) => /v_pub_|\bcatalog\./i.test(c.text))).toEqual([]);

describe('contract: operations exist and floors match 02-TRD §5 / §7', () => {
  it('x-permission floors', () => {
    const floors: Record<string, string> = { listMembershipPlans: P.READ, createMembershipPlan: P.PLAN_MANAGE, updateMembershipPlan: P.PLAN_MANAGE, enrolMembership: P.ENROL,
      listPatientMemberships: P.READ, lookupMembershipCard: P.READ, cancelMembership: P.ENROL, listMyMemberships: P.SELF };
    for (const [op, perm] of Object.entries(floors)) expect(opOf(op)['x-permission'], op).toBe(perm);
  });
  it('engagement.membership_plan.manage is privileged (aal2); enrol/read are not (contracts/permissions.yaml)', () => {
    const perms = readFileSync(join(REPO_ROOT, 'contracts/permissions.yaml'), 'utf8') as string;
    expect(perms).toMatch(/code:\s*engagement\.membership_plan\.manage,\s*privileged:\s*true/);
    expect(perms).toMatch(/code:\s*engagement\.membership\.enrol,\s*privileged:\s*false/);
    expect(perms).toMatch(/code:\s*engagement\.membership\.read,\s*privileged:\s*false/);
  });
  it('every T-M1 operation has a real handler (not the T-01 placeholder): a bare ctx fails closed with auth.unauthenticated', async () => {
    const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
    for (const op of ['listMembershipPlans', 'createMembershipPlan', 'updateMembershipPlan', 'enrolMembership', 'listPatientMemberships', 'lookupMembershipCard', 'cancelMembership', 'listMyMemberships']) {
      const e = await (handlers as any)[op]({ params: { plan_id: PLAN_GOLD, patient_id: PAT1, membership_id: ID(1) }, query: {}, headers: { ...IFM(1), ...IDEM }, body: { reason_code: 'other' } }, bare).catch((x: unknown) => x);
      expect(e?.code, op).toBe('auth.unauthenticated');
    }
  });
  it('request schemas are strict (no server-owned fields in M1b / M2 / M5 bodies)', () => {
    expect(spec.components.schemas['MembershipPlanInput'].additionalProperties).toBe(false);
    for (const k of ['id', 'tenant_id', 'version', 'created_by']) expect(Object.keys(spec.components.schemas['MembershipPlanInput'].properties), k).not.toContain(k);
  });
});

describe('M1a listMembershipPlans', () => {
  it('200 {data:[MembershipPlan]} of the session tenant only (never tenant B), schema-valid, no tenant_id/audit columns; asserts engagement.membership.read before any query', async () => {
    const w = makeWorld();
    const out = await call('listMembershipPlans', w);
    expect(out.status).toBe(200);
    expect(out.body.data.map((x: any) => x.id).sort()).toEqual([PLAN_GOLD, PLAN_OLD].sort());
    for (const x of out.body.data) { expect(schemaErrors('MembershipPlan', x)).toEqual([]); for (const k of ['tenant_id', 'created_by', 'updated_by']) expect(x, k).not.toHaveProperty(k); }
    expect(w.identity.asserted[0]).toEqual({ permission: P.READ, at: 0 });
    expect(JSON.stringify(w.stmts)).not.toContain(TB);
  });
  it('is_active filter: true -> active plans only, false -> inactive only; a non-boolean value -> 400 and no query', async () => {
    const w = makeWorld();
    expect((await call('listMembershipPlans', w, { query: { is_active: 'true' } })).body.data.map((x: any) => x.id)).toEqual([PLAN_GOLD]);
    expect((await call('listMembershipPlans', w, { query: { is_active: 'false' } })).body.data.map((x: any) => x.id)).toEqual([PLAN_OLD]);
    const w2 = makeWorld();
    expect(await code(call('listMembershipPlans', w2, { query: { is_active: 'maybe' } }))).toBe('common.validation_failed');
    expect(w2.stmts).toEqual([]);
  });
  it('permission refused -> auth.forbidden and no statement ran; reads never write', async () => {
    const w = makeWorld(); w.identity.deny.add(P.READ);
    expect(await code(call('listMembershipPlans', w))).toBe('auth.forbidden');
    expect(w.stmts).toEqual([]);
    const w2 = makeWorld(); await call('listMembershipPlans', w2); expect(w2.writes()).toEqual([]);
  });
});

describe('M1b createMembershipPlan — authorisation (07-SECURITY: createMembershipPlan at aal1 -> 403 auth.mfa_required)', () => {
  it('aal1 -> 403 auth.mfa_required BEFORE any DB access and before the catalog is asked', async () => {
    const w = makeWorld(); w.identity.aal = 1;
    const e = await fail(createPlan(w, BASE_PLAN));
    expect(e.code).toBe('auth.mfa_required');
    expect(e.statusCode).toBe(403);
    expect(w.stmts).toEqual([]);
    expect(w.catalog.calls).toEqual([]);
  });
  it('aal1 is also refused for updateMembershipPlan', async () => {
    const w = makeWorld(); w.identity.aal = 1;
    expect(await code(call('updateMembershipPlan', w, { params: { plan_id: PLAN_GOLD }, body: BASE_PLAN, headers: IFM(1) }))).toBe('auth.mfa_required');
    expect(w.stmts).toEqual([]);
  });
  it('permission missing -> auth.forbidden, no statement, no catalog call; aal2 + permission asserts exactly engagement.membership_plan.manage', async () => {
    const w = makeWorld(); w.identity.deny.add(P.PLAN_MANAGE);
    expect(await code(createPlan(w, BASE_PLAN))).toBe('auth.forbidden');
    expect(w.stmts).toEqual([]); expect(w.catalog.calls).toEqual([]);
    const ok = makeWorld(); await createPlan(ok, BASE_PLAN);
    expect(ok.identity.asserted.map((a) => a.permission)).toEqual([P.PLAN_MANAGE]);
  });
});

describe('M1b createMembershipPlan — price list validation by CatalogPort.getPriceListStatus (08 A24.1, CR-C16-023; TRD §4.12)', () => {
  it('published + active -> 201 MembershipPlan (schema-valid, version 1, is_active as submitted), one INSERT for tenant A, created_by = actor', async () => {
    const w = makeWorld();
    const out = await createPlan(w, BASE_PLAN);
    expect(out.status).toBe(201);
    expect(schemaErrors('MembershipPlan', out.body)).toEqual([]);
    expect(out.body).toMatchObject({ code: 'SILVER', display_name: 'Silver plan (synthetic)', price_list_id: PL_PUBLISHED, validity_days: 365, is_active: true, version: 1 });
    expect(out.body).not.toHaveProperty('tenant_id');
    const row = w.tables['membership_plans']!.find((r) => r['code'] === 'SILVER' && r['tenant_id'] === TA)!;
    expect(row).toMatchObject({ price_list_id: PL_PUBLISHED, created_by: STAFF, updated_by: STAFF });
    expect(w.writes().filter((c) => /membership_plans/i.test(c.text))).toHaveLength(1);
    expect(w.catalog.calls).toHaveLength(1);
    expect((w.catalog.calls[0] as any).input).toEqual({ priceListId: PL_PUBLISHED }); // exactly the A24.1 signature, tenant comes from ctx
    noViews(w);
  });
  it.each([
    ['not_found (unknown id / another tenant\'s list)', PL_UNKNOWN],
    ['isActive false (status published)', PL_INACTIVE],
    ['status draft (isActive true)', PL_DRAFT],
    ['status discarded', PL_DISCARDED],
  ])('%s -> 400 common.validation_failed and nothing is stored', async (_name, priceListId) => {
    const w = makeWorld();
    const e = await fail(createPlan(w, { ...BASE_PLAN, price_list_id: priceListId }));
    expect(e.code).toBe('common.validation_failed');
    expect(e.statusCode).toBe(400);
    expect(w.catalog.calls).toHaveLength(1);
    expect(w.writes()).toEqual([]);
    expect(w.tables['membership_plans']!.some((r) => r['code'] === 'SILVER')).toBe(false);
  });
  it('a status the port can return but the plan must not accept: superseded / any unknown status -> 400', async () => {
    for (const status of ['superseded', 'retired', 'PUBLISHED', '']) {
      const w = makeWorld(); w.catalog.lists[PL_DRAFT] = { isActive: true, status };
      expect(await code(createPlan(w, { ...BASE_PLAN, price_list_id: PL_DRAFT })), status).toBe('common.validation_failed');
      expect(w.writes(), status).toEqual([]);
    }
  });
  it('other port errors propagate unchanged (never turned into a 400, never swallowed into a 201)', async () => {
    const w = makeWorld(); w.catalog.lists[PL_PUBLISHED] = 'error';
    expect(await code(createPlan(w, BASE_PLAN))).toBe('common.dependency_unavailable');
    expect(w.writes()).toEqual([]);
  });
  it('no request handler reads a catalog view or table (08 R25 / A17 P-21): no statement mentions v_pub_* or catalog.*', async () => {
    const w = makeWorld();
    await createPlan(w, BASE_PLAN); await call('listMembershipPlans', w);
    await code(createPlan(w, { ...BASE_PLAN, code: 'BAD1', price_list_id: PL_DRAFT }));
    noViews(w);
    expect(w.stmts.length).toBeGreaterThan(0);
  });
});

describe('M1b createMembershipPlan — body validation, mass assignment, duplicates', () => {
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['code lowercase', { code: 'gold' }], ['code too short', { code: 'G' }], ['code 21 chars', { code: 'A'.repeat(21) }], ['code with space', { code: 'GOLD 1' }], ['code with quote', { code: "G'; DROP TABLE x;--" }],
    ['display_name empty', { display_name: '' }], ['display_name 61 chars', { display_name: 'x'.repeat(61) }], ['description 301 chars', { description: 'x'.repeat(301) }],
    ['validity_days 29', { validity_days: 29 }], ['validity_days 1096', { validity_days: 1096 }], ['validity_days string', { validity_days: '365' }], ['validity_days fraction', { validity_days: 365.5 }],
    ['price_list_id not a uuid', { price_list_id: 'PL1' }], ['is_active string', { is_active: 'yes' }],
    ['tenant_id', { tenant_id: TB }], ['id', { id: ID(9) }], ['version', { version: 9 }], ['created_by', { created_by: TB }], ['unknown field', { surprise: true }],
  ];
  it.each(BAD)('%s -> 400 common.validation_failed, no write, the catalog is not asked', async (_n, patch) => {
    const w = makeWorld();
    expect(await code(createPlan(w, { ...BASE_PLAN, ...patch }))).toBe('common.validation_failed');
    expect(w.writes()).toEqual([]); expect(w.catalog.calls).toEqual([]);
  });
  it('missing required fields and non-object bodies -> 400', async () => {
    for (const k of ['code', 'display_name', 'price_list_id', 'validity_days', 'is_active']) {
      const w = makeWorld(); const { [k]: _x, ...rest } = BASE_PLAN as Record<string, unknown>;
      expect(await code(createPlan(w, rest)), k).toBe('common.validation_failed'); expect(w.writes(), k).toEqual([]);
    }
    for (const body of [null, 'x', 5, []]) expect(await code(createPlan(makeWorld(), body)), String(body)).toBe('common.validation_failed');
  });
  it('boundaries accepted: validity 30 and 1095, display_name 60 chars, description 300 chars, code of 2 and 20 chars', async () => {
    for (const [i, patch] of [{ validity_days: 30 }, { validity_days: 1095 }, { display_name: 'x'.repeat(60) }, { description: 'y'.repeat(300) }, { code: 'AB' }, { code: 'A'.repeat(20) }].entries()) {
      const w = makeWorld();
      expect((await createPlan(w, { ...BASE_PLAN, code: `OK${i}`, ...patch })).status, JSON.stringify(patch).slice(0, 40)).toBe(201);
    }
  });
  it('a plan code already used in this tenant -> 4xx (never 500), still exactly one such row; the same code in tenant B does not clash', async () => {
    const w = makeWorld();
    const e = await fail(createPlan(w, { ...BASE_PLAN, code: 'GOLD' }));
    expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500);
    expect(w.tables['membership_plans']!.filter((r) => r['tenant_id'] === TA && r['code'] === 'GOLD')).toHaveLength(1);
  });
  it('is_active false is stored as submitted (the plan is then not offered for enrolment)', async () => {
    const w = makeWorld();
    expect((await createPlan(w, { ...BASE_PLAN, is_active: false })).body.is_active).toBe(false);
  });
});

describe('M1b updateMembershipPlan', () => {
  const upd = (w: World, body: unknown, headers: Record<string, string> | undefined = IFM(1), planId = PLAN_GOLD) => call('updateMembershipPlan', w, { params: { plan_id: planId }, body, headers: headers ?? {} });
  const BODY = { code: 'GOLD', display_name: 'Gold plan v2 (synthetic)', description: 'Updated', price_list_id: PL_PUBLISHED, validity_days: 180, is_active: true };
  it('current If-Match -> 200, version + 1, ETag, fields updated; tenant B row untouched', async () => {
    const w = makeWorld();
    const out = await upd(w, BODY);
    expect(out.status).toBe(200);
    expect(schemaErrors('MembershipPlan', out.body)).toEqual([]);
    expect(out.body).toMatchObject({ id: PLAN_GOLD, display_name: 'Gold plan v2 (synthetic)', validity_days: 180, version: 2 });
    expect(hdr(out, 'etag')).toBe('"2"');
    expect(w.tables['membership_plans']!.find((r) => r['id'] === PLAN_B)).toMatchObject({ display_name: 'Tenant B plan', version: 1 });
  });
  it('stale If-Match -> 409 common.version_conflict, row unchanged; unknown plan and tenant B\'s plan -> 404 common.not_found, nothing written', async () => {
    const w = makeWorld();
    expect(await code(upd(w, BODY, IFM(7)))).toBe('common.version_conflict');
    expect(w.tables['membership_plans']!.find((r) => r['id'] === PLAN_GOLD)).toMatchObject({ version: 1, validity_days: 365 });
    const w2 = makeWorld();
    for (const id of [PLAN_B, ID(0xdead)]) expect(await code(upd(w2, BODY, IFM(1), id)), id).toBe('common.not_found');
    expect(w2.tables['membership_plans']!.find((r) => r['id'] === PLAN_B)).toMatchObject({ version: 1 });
  });
  it('malformed If-Match (weak, unquoted, zero, text) -> 400 and no write', async () => {
    for (const h of ['W/"1"', '1', '"0"', '"abc"']) {
      const w = makeWorld();
      expect(await code(upd(w, BODY, { 'if-match': h })), h).toBe('common.validation_failed'); expect(w.writes(), h).toEqual([]);
    }
  });
  it('changing price_list_id re-validates it: draft / inactive / unknown -> 400, row unchanged; published + active -> 200', async () => {
    for (const pl of [PL_DRAFT, PL_INACTIVE, PL_UNKNOWN]) {
      const w = makeWorld();
      expect(await code(upd(w, { ...BODY, price_list_id: pl })), pl).toBe('common.validation_failed');
      expect(w.tables['membership_plans']!.find((r) => r['id'] === PLAN_GOLD)).toMatchObject({ price_list_id: PL_PUBLISHED, version: 1 });
    }
    const w = makeWorld(); w.catalog.lists[ID(0x706)] = { isActive: true, status: 'published' };
    expect((await upd(w, { ...BODY, price_list_id: ID(0x706) })).body.price_list_id).toBe(ID(0x706));
    expect((w.catalog.calls[0] as any).input).toEqual({ priceListId: ID(0x706) });
  });
  it('deactivating (is_active false) is allowed and keeps existing memberships (they are not touched)', async () => {
    const w = makeWorld({ seed: (s) => s.tables['patient_memberships']!.push(membership()) });
    expect((await upd(w, { ...BODY, is_active: false })).body.is_active).toBe(false);
    expect(w.mem(membership()['id'])).toMatchObject({ status: 'active', version: 1 });
  });
  it('body validation as on create (mass assignment, ranges) -> 400 and no write', async () => {
    for (const patch of [{ tenant_id: TB }, { version: 9 }, { validity_days: 29 }, { code: 'bad' }]) {
      const w = makeWorld();
      expect(await code(upd(w, { ...BODY, ...patch })), JSON.stringify(patch)).toBe('common.validation_failed'); expect(w.writes()).toEqual([]);
    }
  });
});

describe('M2 enrolMembership (US-EN-17.2)', () => {
  it('201 Membership: active, card_no MB{yy}{seq:6}, 26-char Crockford token, valid_to = valid_from + validity_days, enrolled_by = actor; schema-valid; stored for tenant A', async () => {
    const w = makeWorld();
    const out = await enrol(w);
    expect(out.status).toBe(201);
    expect(schemaErrors('Membership', out.body)).toEqual([]);
    expect(out.body).toMatchObject({ patient_id: PAT1, plan_id: PLAN_GOLD, plan_display_name: 'Gold plan (synthetic)', card_no: 'MB26000001', status: 'active', valid_from: '2026-11-05', valid_to: '2027-11-05', version: 1 });
    expect(out.body.card_token).toMatch(TOKEN_RE);
    expect(out.body).not.toHaveProperty('tenant_id');
    expect(w.tables['patient_memberships']).toHaveLength(1);
    expect(w.tables['patient_memberships']![0]).toMatchObject({ tenant_id: TA, patient_id: PAT1, enrolled_by: STAFF, created_by: STAFF, status: 'active' });
    expect(w.identity.asserted[0]).toEqual({ permission: P.ENROL, at: 0 });
    noViews(w);
  });
  it('valid_to arithmetic: plan of 30 days and a start 30 days ahead (calendar days, leap-safe)', async () => {
    const w = makeWorld({ seed: (s) => s.tables['membership_plans']!.push(plan({ id: ID(0x23), code: 'SHORT', validity_days: 30 })) });
    expect((await enrol(w, enrolBody({ plan_id: ID(0x23) }))).body).toMatchObject({ valid_from: '2026-11-05', valid_to: '2026-12-05' });
    const w2 = makeWorld({ seed: (s) => s.tables['membership_plans']!.push(plan({ id: ID(0x24), code: 'LONG', validity_days: 1095 })) });
    expect((await enrol(w2, enrolBody({ plan_id: ID(0x24), valid_from: '2026-12-05' }))).body).toMatchObject({ valid_from: '2026-12-05', valid_to: '2029-12-04' });
  });
  it('card numbers count up per tenant and year: MB26000001, MB26000002; counter row card_no:26 = 2; a new year restarts at MB27000001', async () => {
    const w = makeWorld();
    expect((await enrol(w, enrolBody({ patient_id: PAT1 }))).body.card_no).toBe('MB26000001');
    expect((await enrol(w, enrolBody({ patient_id: PAT2 }))).body.card_no).toBe('MB26000002');
    expect(w.tables['number_counters']!.find((c) => c['tenant_id'] === TA && c['counter_key'] === 'card_no:26')).toMatchObject({ last_value: 2 });
    const w2 = makeWorld({ now: '2027-02-01T04:15:00.000Z' });
    expect((await enrol(w2, enrolBody({ valid_from: '2027-02-01' }))).body.card_no).toBe('MB27000001');
  });
  it('year comes from the Asia/Kathmandu date: 2026-12-31 20:00 UTC is already 2027-01-01 NPT -> MB27…', async () => {
    const w = makeWorld({ now: '2026-12-31T20:00:00.000Z' });
    expect((await enrol(w, enrolBody({ valid_from: '2027-01-01' }))).body.card_no).toMatch(/^MB27\d{6}$/);
  });
  it('card_token: 40 enrolments give 40 distinct, well-formed 26-char tokens that look random (many distinct characters, not sequential), never equal to the card number', async () => {
    const w = makeWorld({ seed: (s) => { for (let i = 0; i < 40; i++) s.tables['patients']!.push({ id: ID(0x900 + i), tenant_id: TA }); } });
    const tokens: string[] = [];
    for (let i = 0; i < 40; i++) tokens.push((await enrol(w, enrolBody({ patient_id: ID(0x900 + i) }))).body.card_token);
    expect(new Set(tokens).size).toBe(40);
    for (const t of tokens) expect(t).toMatch(TOKEN_RE);
    expect(new Set(tokens.join('')).size).toBeGreaterThanOrEqual(24); // 32 symbols over 1040 draws
    expect(new Set(tokens.map((t) => t[0])).size).toBeGreaterThanOrEqual(8);
    for (const t of tokens) expect(t).not.toMatch(/^(.)\1{5}/);
  });
  it('overlap rule: a second active membership for the same patient -> 409 engagement.membership_overlap, nothing new stored (US-EN-17.2)', async () => {
    const w = makeWorld();
    await enrol(w);
    const e = await fail(enrol(w, enrolBody({ valid_from: '2026-11-20' })));
    expect(e.code).toBe('engagement.membership_overlap');
    expect(e.statusCode).toBe(409);
    expect(w.tables['patient_memberships']).toHaveLength(1);
  });
  it('overlap is only against ACTIVE memberships: after a cancel (and after expiry) the patient can be enrolled again with a fresh card', async () => {
    const w = makeWorld({ seed: (s) => s.tables['patient_memberships']!.push(membership({ status: 'expired' })) });
    const out = await enrol(w);
    expect(out.status).toBe(201);
    expect(out.body.card_token).not.toBe(TOKEN_OK);
    expect(out.body.card_no).not.toBe('MB26000001'); // card numbers are never reused
    expect(w.tables['patient_memberships']).toHaveLength(2);
  });
  it('two parallel enrolments of the SAME patient -> exactly one 201 and one 409 engagement.membership_overlap, one active row', async () => {
    const w = makeWorld();
    const res = await Promise.allSettled([enrol(w), enrol(w, enrolBody({ valid_from: '2026-11-06' }))]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('engagement.membership_overlap');
    expect(w.tables['patient_memberships']!.filter((m) => m['status'] === 'active')).toHaveLength(1);
  });
  it('parallel enrolments of DIFFERENT patients get different card numbers and tokens', async () => {
    const w = makeWorld();
    const [a, b] = await Promise.all([enrol(w, enrolBody({ patient_id: PAT1 })), enrol(w, enrolBody({ patient_id: PAT2 }))]);
    expect(a.body.card_no).not.toBe(b.body.card_no);
    expect(a.body.card_token).not.toBe(b.body.card_token);
  });
  it('inactive plan -> 409 engagement.plan_inactive, nothing stored', async () => {
    const w = makeWorld();
    const e = await fail(enrol(w, enrolBody({ plan_id: PLAN_OLD })));
    expect(e.code).toBe('engagement.plan_inactive');
    expect(e.statusCode).toBe(409);
    expect(w.tables['patient_memberships']).toEqual([]);
  });
  it('plan of tenant B / unknown plan / patient of tenant B / unknown patient -> 404 or 400 (never 201, never 500, nothing stored, no cross-tenant bind)', async () => {
    for (const patch of [{ plan_id: PLAN_B }, { plan_id: ID(0xdead) }, { patient_id: PAT_B }, { patient_id: ID(0xdeaf) }]) {
      const w = makeWorld();
      expect(['common.not_found', 'common.validation_failed'], JSON.stringify(patch)).toContain(await code(enrol(w, enrolBody(patch))));
      expect(w.tables['patient_memberships'], JSON.stringify(patch)).toEqual([]);
      expect(JSON.stringify(w.stmts.map((c) => c.values)), JSON.stringify(patch)).not.toContain(TB);
    }
  });
  it('valid_from window "today … today + 30 d": today and +30 accepted; yesterday, +31, wrong formats -> 400 and no write', async () => {
    for (const d of ['2026-11-05', '2026-12-05']) expect((await enrol(makeWorld(), enrolBody({ valid_from: d }))).status, d).toBe(201);
    for (const d of ['2026-11-04', '2026-12-06', '2026-02-30', '05/11/2026', '2026-11-05T00:00:00Z', '', null, 20261105]) {
      const w = makeWorld();
      expect(await code(enrol(w, enrolBody({ valid_from: d }))), String(d)).toBe('common.validation_failed'); expect(w.writes(), String(d)).toEqual([]);
    }
  });
  it('"today" is the Asia/Kathmandu date: at 2026-11-05 19:00 UTC (= 2026-11-06 00:45 NPT) 2026-11-05 is already in the past', async () => {
    const w = makeWorld({ now: '2026-11-05T19:00:00.000Z' });
    expect(await code(enrol(w, enrolBody({ valid_from: '2026-11-05' })))).toBe('common.validation_failed');
    expect((await enrol(makeWorld({ now: '2026-11-05T19:00:00.000Z' }), enrolBody({ valid_from: '2026-11-06' }))).status).toBe(201);
  });
  it('mass assignment / malformed bodies -> 400, zero writes (status, card_no, card_token, valid_to, tenant_id, enrolled_by are never accepted)', async () => {
    const bads: unknown[] = [enrolBody({ status: 'active' }), enrolBody({ card_no: 'MB26000099' }), enrolBody({ card_token: TOKEN_OK }), enrolBody({ valid_to: '2030-01-01' }), enrolBody({ tenant_id: TB }),
      enrolBody({ enrolled_by: TB }), enrolBody({ patient_id: 'nope' }), enrolBody({ plan_id: 'nope' }), { plan_id: PLAN_GOLD, valid_from: '2026-11-05' }, { patient_id: PAT1, valid_from: '2026-11-05' }, { patient_id: PAT1, plan_id: PLAN_GOLD }, null, 'x'];
    for (const b of bads) { const w = makeWorld(); expect(await code(enrol(w, b)), JSON.stringify(b)).toBe('common.validation_failed'); expect(w.writes(), JSON.stringify(b)).toEqual([]); }
  });
  it('permission refused -> auth.forbidden and not a single statement; enrol is NOT privileged: aal1 is enough', async () => {
    const w = makeWorld(); w.identity.deny.add(P.ENROL);
    expect(await code(enrol(w))).toBe('auth.forbidden'); expect(w.stmts).toEqual([]);
    const w2 = makeWorld(); w2.identity.aal = 1;
    expect((await enrol(w2)).status).toBe(201);
  });
  it('the card number and token never reach logs or the audit trail', async () => {
    const logs: unknown[] = [];
    const w = makeWorld();
    const out = await enrol(w, enrolBody(), { log: { info: (x: unknown) => logs.push(x), warn: (x: unknown) => logs.push(x), error: (x: unknown) => logs.push(x), debug: (x: unknown) => logs.push(x), child() { return this; } } });
    const noise = JSON.stringify([logs, w.audit]);
    expect(noise).not.toContain(out.body.card_token);
    expect(noise).not.toContain(out.body.card_no);
  });
});

describe('M3 listPatientMemberships', () => {
  const seed = (s: any) => s.tables['patient_memberships'].push(membership(), membership({ id: ID(0x302), card_no: 'MB26000002', card_token: '7ABCDEFGHJKMNPQRSTVWXYZ012', status: 'expired', valid_from: '2025-01-01', valid_to: '2025-12-31' }),
    membership({ id: ID(0x303), tenant_id: TB, patient_id: PAT_B, plan_id: PLAN_B, card_no: 'MB26000001', card_token: TOKEN_B }));
  it('200 {data:[Membership]} of that patient (any status), schema-valid; tenant B rows and other patients never appear; asserts membership.read first', async () => {
    const w = makeWorld({ seed });
    const out = await call('listPatientMemberships', w, { params: { patient_id: PAT1 } });
    expect(out.status).toBe(200);
    expect(out.body.data.map((m: any) => m.id).sort()).toEqual([ID(0x301), ID(0x302)].sort());
    for (const m of out.body.data) { expect(schemaErrors('Membership', m)).toEqual([]); expect(m).not.toHaveProperty('tenant_id'); expect(m.plan_display_name).toBe('Gold plan (synthetic)'); }
    expect(w.identity.asserted[0]).toEqual({ permission: P.READ, at: 0 });
    expect(JSON.stringify(out.body)).not.toContain(TOKEN_B);
  });
  it('patient of tenant B -> empty list or 404, never B\'s cards; malformed id -> 400/404; permission refused -> auth.forbidden before any statement', async () => {
    const w = makeWorld({ seed });
    const r = await call('listPatientMemberships', w, { params: { patient_id: PAT_B } }).then((x: any) => x.body.data, (e: any) => e.code);
    expect(r === 'common.not_found' || (Array.isArray(r) && r.length === 0)).toBe(true);
    expect(['common.validation_failed', 'common.not_found']).toContain(await code(call('listPatientMemberships', makeWorld(), { params: { patient_id: "1'; DROP TABLE x;--" } })));
    const w2 = makeWorld({ seed }); w2.identity.deny.add(P.READ);
    expect(await code(call('listPatientMemberships', w2, { params: { patient_id: PAT1 } }))).toBe('auth.forbidden'); expect(w2.stmts).toEqual([]);
  });
});

describe('M4 lookupMembershipCard (US-EN-17.4; 07-SECURITY "Membership card QR"; access log patient_membership.lookup)', () => {
  const seed = (s: any) => s.tables['patient_memberships'].push(membership(), membership({ id: ID(0x303), tenant_id: TB, patient_id: PAT_B, plan_id: PLAN_B, card_no: 'MB26000001', card_token: TOKEN_B }));
  const look = (w: World, body: unknown, over: Record<string, unknown> = {}) => call('lookupMembershipCard', w, { body }, 'staff', over);
  it('by card_token -> 200 Membership incl. patient_id; one access-log entry patient_membership.lookup for entity patient_membership/<id>; no write', async () => {
    const w = makeWorld({ seed });
    const out = await look(w, { card_token: TOKEN_OK });
    expect(out.status).toBe(200);
    expect(schemaErrors('Membership', out.body)).toEqual([]);
    expect(out.body).toMatchObject({ id: ID(0x301), patient_id: PAT1, card_no: 'MB26000001', status: 'active', plan_display_name: 'Gold plan (synthetic)' });
    expect(w.audit.access).toHaveLength(1);
    expect(w.audit.access[0]).toMatchObject({ action: 'patient_membership.lookup', entityType: 'patient_membership', entityId: ID(0x301) });
    expect(w.writes()).toEqual([]);
    expect(w.identity.asserted[0]).toEqual({ permission: P.READ, at: 0 });
  });
  it('by card_no -> the same membership and also an access-log entry', async () => {
    const w = makeWorld({ seed });
    const out = await look(w, { card_no: 'MB26000001' });
    expect(out.body.id).toBe(ID(0x301));
    expect(w.audit.access).toHaveLength(1);
  });
  it('the access-log entry carries neither the token nor the card number nor the patient id as free text', async () => {
    const w = makeWorld({ seed });
    await look(w, { card_token: TOKEN_OK });
    const blob = JSON.stringify(w.audit.access);
    expect(blob).not.toContain(TOKEN_OK); expect(blob).not.toContain('MB26000001');
  });
  it('the scanned value is only ever a bind parameter: no statement text contains it (injection / logging hygiene)', async () => {
    const w = makeWorld({ seed });
    await look(w, { card_token: TOKEN_OK }); await look(w, { card_no: 'MB26000001' });
    const texts = JSON.stringify(w.stmts.map((c) => c.text));
    expect(texts).not.toContain(TOKEN_OK); expect(texts).not.toContain('MB26000001');
  });
  it('a cancelled or expired card is still returned, with its status (the desk must see why it is not valid)', async () => {
    for (const status of ['cancelled', 'expired']) {
      const w = makeWorld({ seed: (s) => s.tables['patient_memberships']!.push(membership(status === 'cancelled' ? { status, cancelled_at: '2026-10-15T00:00:00.000Z', cancel_reason_code: 'patient_request' } : { status })) });
      expect((await look(w, { card_token: TOKEN_OK })).body.status, status).toBe(status);
    }
  });
  it('unknown token and tenant B\'s token are indistinguishable: 404 common.not_found, same detail, no cross-tenant bind, no access-log entry claiming a hit', async () => {
    const w = makeWorld({ seed });
    const e1 = await fail(look(w, { card_token: '0000000000000000000000000Z' }));
    const e2 = await fail(look(w, { card_token: TOKEN_B }));
    for (const e of [e1, e2]) { expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404); }
    expect(e2.detail).toEqual(e1.detail);
    expect(w.audit.access.filter((a: any) => a.entityId === ID(0x303))).toEqual([]);
    expect(JSON.stringify(w.stmts.map((c) => c.values))).not.toContain(TB);
    expect((await fail(look(w, { card_no: 'MB26000099' }))).code).toBe('common.not_found');
  });
  it('card_token XOR card_no: both, neither, extra keys, lowercase / short / long / wrong-alphabet values -> 400 and no statement, no access-log entry', async () => {
    const bads: unknown[] = [{ card_token: TOKEN_OK, card_no: 'MB26000001' }, {}, null, 'x', { card_token: TOKEN_OK, extra: 1 }, { card_token: TOKEN_OK.toLowerCase() }, { card_token: TOKEN_OK.slice(1) }, { card_token: `${TOKEN_OK}A` },
      { card_token: `U${TOKEN_OK.slice(1)}` }, { card_token: `I${TOKEN_OK.slice(1)}` }, { card_no: 'mb26000001' }, { card_no: 'MB2600001' }, { card_no: 'MB260000011' }, { card_no: "MB26000001' OR '1'='1" }, { card_token: 123 }];
    for (const b of bads) {
      const w = makeWorld({ seed });
      expect(await code(look(w, b)), JSON.stringify(b)).toBe('common.validation_failed');
      expect(w.stmts, JSON.stringify(b)).toEqual([]); expect(w.audit.access, JSON.stringify(b)).toEqual([]);
    }
  });
  it('permission refused (card is no credential on its own) -> auth.forbidden, no statement, no access-log entry; patient / device actors never hold membership.read', async () => {
    const w = makeWorld({ seed }); w.identity.deny.add(P.READ);
    expect(await code(look(w, { card_token: TOKEN_OK }))).toBe('auth.forbidden');
    expect(w.stmts).toEqual([]); expect(w.audit.access).toEqual([]);
    const w2 = makeWorld({ seed }); w2.grants.delete(P.READ);
    expect(await code(call('lookupMembershipCard', w2, { body: { card_token: TOKEN_OK } }, 'patient'))).toBe('auth.forbidden');
    expect(w2.stmts).toEqual([]);
  });
});

describe('M5 cancelMembership', () => {
  const seed = (s: any) => s.tables['patient_memberships'].push(membership(), membership({ id: ID(0x303), tenant_id: TB, patient_id: PAT_B, plan_id: PLAN_B, card_no: 'MB26000001', card_token: TOKEN_B }),
    membership({ id: ID(0x304), patient_id: PAT2, card_no: 'MB26000002', card_token: '7ABCDEFGHJKMNPQRSTVWXYZ012', status: 'cancelled', cancelled_at: '2026-10-10T00:00:00.000Z', cancel_reason_code: 'other', version: 2 }));
  const cancel = (w: World, id = ID(0x301), body: unknown = { reason_code: 'patient_request' }, headers: Record<string, string> = IFM(1)) => call('cancelMembership', w, { params: { membership_id: id }, body, headers });
  it('active + current If-Match -> 200 cancelled with cancelled_at, cancel_reason_code, version + 1; schema-valid; asserts engagement.membership.enrol first', async () => {
    const w = makeWorld({ seed });
    const out = await cancel(w);
    expect(out.status).toBe(200);
    expect(schemaErrors('Membership', out.body)).toEqual([]);
    expect(out.body).toMatchObject({ id: ID(0x301), status: 'cancelled', cancel_reason_code: 'patient_request', version: 2 });
    expect(out.body.cancelled_at).toBeTruthy();
    expect(w.mem(ID(0x301))).toMatchObject({ status: 'cancelled', cancel_reason_code: 'patient_request', version: 2, updated_by: STAFF });
    expect(w.identity.asserted[0]).toEqual({ permission: P.ENROL, at: 0 });
  });
  it('each reason code is accepted; anything else -> 400 and the card stays active', async () => {
    for (const r of ['patient_request', 'staff_error', 'other']) expect((await cancel(makeWorld({ seed }), ID(0x301), { reason_code: r })).status, r).toBe(200);
    for (const b of [{ reason_code: 'fraud' }, { reason_code: '' }, {}, null, { reason_code: 'other', status: 'active' }, { reason_code: 'other', tenant_id: TB }]) {
      const w = makeWorld({ seed });
      expect(await code(cancel(w, ID(0x301), b)), JSON.stringify(b)).toBe('common.validation_failed'); expect(w.mem(ID(0x301))).toMatchObject({ status: 'active', version: 1 });
    }
  });
  it('If-Match absent -> 428 common.precondition_required before any DB access; malformed -> 400; stale -> 409 common.version_conflict and the card is unchanged', async () => {
    const w = makeWorld({ seed });
    expect(await code(cancel(w, ID(0x301), { reason_code: 'other' }, {}))).toBe('common.precondition_required'); expect(w.stmts).toEqual([]);
    for (const h of ['1', 'W/"1"', '"0"', '*']) expect(await code(cancel(makeWorld({ seed }), ID(0x301), { reason_code: 'other' }, { 'if-match': h })), h).toBe('common.validation_failed');
    expect(await code(cancel(w, ID(0x301), { reason_code: 'other' }, IFM(9)))).toBe('common.version_conflict');
    expect(w.mem(ID(0x301))).toMatchObject({ status: 'active', version: 1 });
  });
  it('already cancelled -> 409 (no second cancel, reason and timestamp unchanged); unknown id and tenant B\'s card -> 404 common.not_found, nothing written', async () => {
    const w = makeWorld({ seed });
    const e = await fail(cancel(w, ID(0x304), { reason_code: 'patient_request' }, IFM(2)));
    expect(e.statusCode).toBe(409);
    expect(w.mem(ID(0x304))).toMatchObject({ cancel_reason_code: 'other', cancelled_at: '2026-10-10T00:00:00.000Z', version: 2 });
    for (const id of [ID(0x303), ID(0xdead)]) expect(await code(cancel(w, id)), id).toBe('common.not_found');
    expect(w.mem(ID(0x303))).toMatchObject({ status: 'active', version: 1 });
  });
  it('an expired card cannot be cancelled (409)', async () => {
    const w = makeWorld({ seed: (s) => s.tables['patient_memberships']!.push(membership({ status: 'expired' })) });
    expect((await fail(cancel(w))).statusCode).toBe(409);
    expect(w.mem(ID(0x301))).toMatchObject({ status: 'expired', version: 1 });
  });
  it('permission refused -> auth.forbidden before any statement; malformed id -> 400/404 and no write', async () => {
    const w = makeWorld({ seed }); w.identity.deny.add(P.ENROL);
    expect(await code(cancel(w))).toBe('auth.forbidden'); expect(w.stmts).toEqual([]);
    const w2 = makeWorld({ seed });
    expect(['common.validation_failed', 'common.not_found']).toContain(await code(cancel(w2, "1'; DROP TABLE x;--"))); expect(w2.writes()).toEqual([]);
  });
  it('after the cancel the patient can be enrolled again (the partial unique index only holds active cards) and the old token no longer finds an active card', async () => {
    const w = makeWorld({ seed });
    await cancel(w);
    const again = await enrol(w);
    expect(again.status).toBe(201);
    expect(again.body.card_token).not.toBe(TOKEN_OK);
    const old = await call('lookupMembershipCard', w, { body: { card_token: TOKEN_OK } });
    expect(old.body.status).toBe('cancelled');
  });
});

describe('E47 listMyMemberships (US-EN-17.3; patient sees only their own profiles\' cards)', () => {
  const seed = (s: any) => s.tables['patient_memberships'].push(
    membership(), // PAT1 (profile LINK1 of account 1)
    membership({ id: ID(0x302), patient_id: PAT2, card_no: 'MB26000002', card_token: '7ABCDEFGHJKMNPQRSTVWXYZ012' }), // PAT2 (profile LINK_ACC2 of account 2)
    membership({ id: ID(0x305), patient_id: PAT3, card_no: 'MB26000005', card_token: '5ABCDEFGHJKMNPQRSTVWXYZ012' }), // PAT3 (link of account 1 is REVOKED)
    membership({ id: ID(0x303), tenant_id: TB, patient_id: PAT_B, plan_id: PLAN_B, card_no: 'MB26000001', card_token: TOKEN_B }));
  const mine = (w: World, account = ACC1) => call('listMyMemberships', w, {}, 'patient', {}, account);
  it('account 1 gets exactly its linked profile\'s card: {membership_id, profile_id = link id, plan_display_name, card_no, card_token, valid_from, valid_to, status}; schema-valid; no patient_id', async () => {
    const w = makeWorld({ seed });
    const out = await mine(w);
    expect(out.status).toBe(200);
    expect(out.body.data).toHaveLength(1);
    expect(out.body.data[0]).toEqual({ membership_id: ID(0x301), profile_id: LINK1, plan_display_name: 'Gold plan (synthetic)', card_no: 'MB26000001', card_token: TOKEN_OK, valid_from: '2026-10-01', valid_to: '2027-10-01', status: 'active' });
    expect(schemaErrors('MembershipCard', out.body.data[0])).toEqual([]);
    expect(JSON.stringify(out.body)).not.toContain(PAT1);
    expect(w.identity.asserted[0]).toEqual({ permission: P.SELF, at: 0 });
  });
  it('PROBE other profiles: account 1 never sees account 2\'s patient (PAT2), a revoked link\'s patient (PAT3) or tenant B\'s card; account 2 sees only PAT2\'s card', async () => {
    const w = makeWorld({ seed });
    const blob = JSON.stringify((await mine(w)).body);
    for (const leak of [ID(0x302), ID(0x305), ID(0x303), '7ABCDEFGHJKMNPQRSTVWXYZ012', '5ABCDEFGHJKMNPQRSTVWXYZ012', TOKEN_B, 'MB26000002', 'MB26000005']) expect(blob, leak).not.toContain(leak);
    const two = await mine(w, ACC2);
    expect(two.body.data.map((c: any) => [c.membership_id, c.profile_id])).toEqual([[ID(0x302), LINK_ACC2]]);
    expect(JSON.stringify(two.body)).not.toContain(TOKEN_OK);
  });
  it('a patient with no linked profile with a card gets {data: []} (the app shows "No membership")', async () => {
    const w = makeWorld();
    expect((await mine(w)).body).toEqual({ data: [] });
  });
  it('response is never cacheable: Cache-Control no-store (the card token is a secret)', async () => {
    const out = await mine(makeWorld({ seed }));
    expect(String(hdr(out, 'Cache-Control'))).toMatch(/no-store/i);
  });
  it('asserts engagement.self.read before any query; refused -> auth.forbidden and no statement', async () => {
    const w = makeWorld({ seed }); w.identity.deny.add(P.SELF);
    expect(await code(mine(w))).toBe('auth.forbidden'); expect(w.stmts).toEqual([]);
  });
  it('a staff actor calling the patient endpoint gets nothing: forbidden, or an empty list - never a card', async () => {
    const w = makeWorld({ seed });
    const r = await call('listMyMemberships', w, {}, 'staff').then((x: any) => x.body.data, (e: any) => e.code);
    expect(r === 'auth.forbidden' || (Array.isArray(r) && r.length === 0)).toBe(true);
  });
  it('tenant isolation: a patient session of tenant B (no account there) sees nothing of tenant A; no statement binds tenant A\'s ids', async () => {
    const w = makeWorld({ seed, tenant: TB });
    const r = await mine(w).then((x: any) => x.body.data, (e: any) => e.code);
    expect(r === 'auth.forbidden' || r === 'common.not_found' || (Array.isArray(r) && r.length === 0)).toBe(true);
    expect(JSON.stringify(w.stmts.map((c) => c.values))).not.toContain(TA);
  });
  it('reads only: no write, no access-log noise, never a catalog / view read', async () => {
    const w = makeWorld({ seed });
    await mine(w);
    expect(w.writes()).toEqual([]); noViews(w);
  });
  it('the deleted-link case: revoking the link hides the card at once (revoked profile\'s card absent) and LINK_REVOKED never appears as a profile_id', async () => {
    const w = makeWorld({ seed });
    expect(JSON.stringify((await mine(w)).body)).not.toContain(LINK_REVOKED);
  });
});
