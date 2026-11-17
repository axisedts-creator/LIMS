// C5 T-10 — printSpecimenLabels (#14) and requestOrderLabelPrint (#14a) over HTTP-shaped requests against the migrated database
// (06 row T-10; 02-TRD §4.6, §5.1 rows 14/14a, access-log table; 03-APP-FLOW §3.1; PRD AC-02.1, AC-02.3, AC-02.5; 07-SECURITY P-05, S-10, REQ-SEC-017; 08 A13 D-4, D-11; 08 A2.10).
// Same harness shape as specimen.handlers.integration.test.ts (T-07): needs tests/db/c5-t03/run.sh (LIMS_TEST_DATABASE_URL = role lims_api, RLS on;
// LIMS_TEST_ADMIN_DATABASE_URL = superuser). Without them the DB tests skip, except under LIMS_T03_REQUIRE_DB=1. The "contract" block needs no database.
//
// SEAMS (spec fixes behaviour, not names) — the writer adds handlers/printSpecimenLabels.ts and handlers/requestOrderLabelPrint.ts (each `export const handler`), wired in handlers/index.ts.
//   ctx = the T-07 convention plus ports.FrontdeskPort.{getPatientDemographics, getPatientDemographicsBatch} (CR-C5-003; purpose 'label_print'; returns { fullName, sex, birthOn?, ageAtOrder? }).
//   The label's patient_name / age_sex come from FrontdeskPort ONLY (never stored by C5, 02-TRD §4 patient_display); either Port method may be used.
//   audit entry = ctx.audit.access({ action: 'specimen_label.print', entityType: 'specimen', entityId, outcome: 'allowed', ... }) once per printed specimen (02-TRD access-log table).
// ASSUMED (spec silent):
//   - #14 with specimen_ids: an id not visible to the caller (other tenant) is a per-id error { id, code: 'common.not_found' } (07 P-04 for bulk ops); with order_id an invisible order -> 404.
//   - an order the caller cannot see (other tenant via RLS; centre A2 for an A1-only user, REQ-SEC-017) -> 404 common.not_found for #14 and #14a.
//   - #14a on an order that has a lab.orders row but no active/inactive specimen yet -> 409 as well ("specimens not created yet").
//   - label_print_count += 1 per print call per specimen (NOT per copy): "label data issued" (03-APP-FLOW E16); last_label_printed_at = ctx.now().
//   - test_codes = first 4 test codes of the specimen's order tests ordered by test_code, more_tests = rest (02-TRD §4.6 "up to 4 test codes then +n"); urgent = any order test urgent.
//   - age_sex is a non-empty string containing the sex initial ("F") for the seeded patient.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError, LimsError } from '../../../../core/errors.js';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { handlers } from '../index.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const MEM = '01a1a98a-ac40-7000-8000-00000000a500';
const BRANCH = { [A]: '01a1a98a-ac40-7000-8000-00000000a101', [B]: '01a1a98a-ac40-7000-8000-00000000b101' } as Record<string, string>;
const CENTRE = { [A]: '01a1a98a-ac40-7000-8000-00000000a201', [B]: '01a1a98a-ac40-7000-8000-00000000b201' } as Record<string, string>;
const CENTRE_A2 = '01a1a98a-ac40-7000-8000-00000000a202';
const BRANCH_A2 = '01a1a98a-ac40-7000-8000-00000000a102';
const u = (n: number) => `0190c607-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PATIENT = { [A]: u(0xa7), [B]: u(0xb7) } as Record<string, string>;
const NOW = new Date('2026-06-15T05:00:30.000Z');
const PRINT = 'lab.specimen.label_print';
const ACTION = 'specimen_label.print';

// ------------------------------------------------------------------ spec validators (lab.yaml)
const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'lab.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return v(x) ? [] : (v.errors ?? []).map((e: any) => `${e.instancePath} ${e.message}`);
};
const opOf = (id: string) => {
  for (const [path, item] of Object.entries<any>(spec.paths)) for (const [method, op] of Object.entries<any>(item)) if (op?.operationId === id) return { path, method, op };
  throw new Error(`no operation ${id}`);
};
const LABEL_KEYS = new Set(Object.keys(spec.components.schemas.LabelDataDto.properties));

// ================================================================== contract (no database)
describe('T-10 contract (lab.yaml)', () => {
  it('#14a requestOrderLabelPrint: POST /v1/lab/orders/{order_id}/label-prints, x-idempotency none, 200 + 409 common.version_conflict, no Idempotency-Key parameter, E3 justification (LD-10)', () => {
    const { path, method, op } = opOf('requestOrderLabelPrint');
    expect([path, method]).toEqual(['/v1/lab/orders/{order_id}/label-prints', 'post']);
    expect(op['x-idempotency']).toBe('none');
    expect(String(op['x-idempotency-justification'] ?? '')).not.toBe('');
    expect(op['x-permission']).toBe(PRINT);
    expect(op['x-error-codes']).toContain('common.version_conflict');
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['200', '409']));
    expect(JSON.stringify(op.parameters ?? [])).not.toMatch(/idempotency/i);
  });
  it('#14 printSpecimenLabels: POST /v1/lab/specimens/labels, optional key, per-id lab.specimen_inactive, response = PrintLabelsResponse', () => {
    const { path, method, op } = opOf('printSpecimenLabels');
    expect([path, method]).toEqual(['/v1/lab/specimens/labels', 'post']);
    expect(op['x-permission']).toBe(PRINT);
    expect(op['x-error-codes']).toContain('lab.specimen_inactive');
    expect(JSON.stringify(op.responses['200'])).toContain('PrintLabelsResponse');
  });
  it('response schemas accept the TRD shapes and reject extras (S-12 allowlist)', () => {
    const label = { specimen_id: u(1), barcode: 'E2600000101', patient_name: 'Test Patient', age_sex: '43Y/F', registration_no: 'REG1', specimen_type_code: 'WB', test_codes: ['CBC'], more_tests: 0, urgent: false, copies: 1 };
    expect(schemaErrors('PrintLabelsResponse', { labels: [label], errors: [{ id: u(2), code: 'lab.specimen_inactive' }], size: { width_mm: 50, height_mm: 25 }, label_copies_default: 1 })).toEqual([]);
    expect(schemaErrors('PrintLabelsResponse', { labels: [{ ...label, extra: 1 }], errors: [], size: { width_mm: 50, height_mm: 25 }, label_copies_default: 1 })).not.toEqual([]);
    expect(schemaErrors('OrderLabelPrintResponse', { order_id: u(3), specimens: [{ specimen_id: u(1), barcode: 'E2600000101', outcome: 'ready' }], labels_route: 'staff.lab.order_labels' })).toEqual([]);
  });
  it('route CR-C5-007: staff.lab.order_labels = /lab/orders/{order_id}/labels, owner C5, permission lab.specimen.label_print', () => {
    const routes = readFileSync(join(REPO_ROOT, 'contracts', 'routes.yaml'), 'utf8');
    expect(routes).toMatch(/id: staff\.lab\.order_labels,[^}]*path: "\/lab\/orders\/\{order_id\}\/labels"[^}]*owner: C5[^}]*permission: lab\.specimen\.label_print/);
  });
  it('the two operations are bound to REAL handlers (not the fail-closed stub)', async () => {
    for (const op of ['printSpecimenLabels', 'requestOrderLabelPrint']) {
      const e = await failure((handlers as any)[op]({ params: {}, query: {}, headers: {}, body: {} }, { operationId: op, clientIp: '127.0.0.1', log: { info() {}, warn() {}, error() {} } }));
      expect(isLimsError(e, 'common.internal'), `${op} is still a stub: ${e?.message}`).toBe(false);
    }
  });
});

// ------------------------------------------------------------------ database helpers
let api: pg.Pool;
let admin: pg.Pool;
const claims = (tenantId: string) => JSON.stringify({ tenant_id: tenantId, sub: SYS, actor_type: 'system' });
const sql = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;
const colsCache = new Map<string, Set<string>>();
async function asAdmin<T>(tenant: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenant)]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
}
async function ins(c: pg.PoolClient, table: string, row: Record<string, unknown>) {
  if (!colsCache.has(table)) {
    const [s, t] = table.split('.');
    colsCache.set(table, new Set((await c.query('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', [s, t])).rows.map((r) => r.column_name)));
  }
  const cols = colsCache.get(table)!;
  const r: Record<string, unknown> = { ...row };
  for (const a of ['created_by', 'updated_by']) if (cols.has(a) && !(a in r)) r[a] = SYS;
  const keys = Object.keys(r);
  await c.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => r[k]));
}

// ------------------------------------------------------------------ scenario seeding
let nextId = 0x7a00;
let barcodeN = (Date.now() + 7) % 90_000_000;
interface SpecIn { status?: string; active?: boolean; tests?: { code: string; priority?: 'routine' | 'urgent' }[]; type?: string; container?: string }
interface Seeded { id: string; barcode: string }
interface Scen { tenant: string; orderId: string; regNo: string; centre: string; branch: string; specimens: Seeded[] }

const seededOrders = new Map<string, { tenant: string; centre: string }>();   // what the FrontdeskPort fake can see
/** Phase 1: the frontdesk order (FK parent). Phase 2 (`seedLab`): lab.orders + specimens (+ order tests + results) — the consumer's work (04 §4.1). */
async function frontOrder(tenant: string, centre = CENTRE[tenant]): Promise<Scen> {
  const orderId = u(nextId++);
  const regNo = `RT10${orderId.slice(-6).toUpperCase()}`;
  const branch = centre === CENTRE_A2 ? BRANCH_A2 : BRANCH[tenant];
  await asAdmin(tenant, (c) => ins(c, 'frontdesk.orders', { id: orderId, tenant_id: tenant, branch_id: branch, centre_id: centre, patient_id: PATIENT[tenant], registration_no: regNo, status: 'registered',
    visit_type: 'opd', billing_mode: 'cash', priority: 'routine', collection_mode: 'walk_in', source: 'front_desk', is_first_order_of_patient: false, catalog_revision: 1, registered_at: '2026-06-15T04:00:00.000Z' }));
  seededOrders.set(orderId, { tenant, centre });
  return { tenant, orderId, regNo, centre, branch, specimens: [] };
}
async function seedLab(s: Scen, specs: SpecIn[], o: { labOrderOnly?: boolean } = {}): Promise<Scen> {
  const { tenant, orderId, regNo, centre, branch } = s;
  await asAdmin(tenant, async (c) => {
    await ins(c, 'lab.orders', { id: orderId, tenant_id: tenant, centre_id: centre, branch_id: branch, patient_id: PATIENT[tenant], registration_no: regNo, visit_type: 'opd', priority: 'routine',
      collection_mode: 'walk_in', source: 'front_desk', registered_at: '2026-06-15T04:00:00.000Z', patient_sex: 'female', patient_age_days: 10950, lab_status: 'active', last_order_seq: 1, items_version: 1 });
    if (o.labOrderOnly) return;
    for (const [i, sp] of specs.entries()) {
      const id = u(nextId++);
      const barcode = `T10${String(barcodeN++).padStart(8, '0')}`;
      const st = sp.status ?? 'ordered';
      await ins(c, 'lab.specimens', { id, tenant_id: tenant, centre_id: centre, order_id: orderId, patient_id: PATIENT[tenant], barcode, creation_key: `${orderId}:WB:EDTA:${i}`,
        specimen_type_code: sp.type ?? 'WB', container_code: sp.container ?? 'EDTA', priority: 'routine', patient_sex: 'female', patient_age_days: 10950, status: st, ordered_at: '2026-06-15T04:00:00.000Z',
        ...(st !== 'ordered' ? { collected_at: '2026-06-15T04:10:00.000Z', collected_by_membership_id: MEM } : {}),
        is_active: sp.active ?? true });
      for (const t of sp.tests ?? [{ code: `T10${i}` }]) {
        const itemId = u(nextId++); const otId = u(nextId++); const testId = u(nextId++);
        await ins(c, 'frontdesk.order_items', { id: itemId, tenant_id: tenant, order_id: orderId, centre_id: centre, orderable_id: u(nextId++), orderable_kind: 'test', code: t.code, name: `${t.code} (SYNTHETIC)`, test_ids: [testId],
          priority: t.priority ?? 'routine', unit_price_paisa: 1000, price_list_id: u(0x98), price_list_version: 1, price_source: 'tenant_default', vat_treatment: 'exempt', added_in_items_version: 1 });
        await ins(c, 'lab.order_tests', { id: otId, tenant_id: tenant, centre_id: centre, order_id: orderId, order_item_id: itemId, test_id: testId, test_code: t.code, test_revision: 1, catalog_revision: 1,
          department_id: u(0x901), workflow_type: 'standard', priority: t.priority ?? 'routine', specimen_id: id, status: 'awaiting_collection', ordered_at: '2026-06-15T04:00:00.000Z' });
      }
      s.specimens.push({ id, barcode });
    }
  });
  return s;
}
const scenario = async (tenant: string, specs: SpecIn[], centre?: string) => seedLab(await frontOrder(tenant, centre), specs);

const specimenRow = async (id: string) => (await sql('SELECT * FROM lab.specimens WHERE id = $1', [id]))[0];
const counterSum = async () => Number((await sql('SELECT COALESCE(sum(last_value), 0)::bigint AS n FROM lab.barcode_counters'))[0].n);
const snapshot = async (s: Scen) => JSON.stringify([
  await Promise.all(s.specimens.map(async (x) => specimenRow(x.id))),
  (await sql('SELECT count(*)::int AS n FROM lab.specimen_transitions WHERE specimen_id = ANY($1)', [s.specimens.map((x) => x.id)]))[0].n,
  await counterSum(),
]);

// ------------------------------------------------------------------ driving a handler
type Pub = { type: string; input: any };
interface Probe { events: Pub[]; audit: any[]; roleCalls: any[]; demographics: any[] }
interface Opts { grants?: readonly string[]; tenant?: string; scope?: { all?: boolean; centreIds?: readonly string[] }; now?: Date }
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined as unknown, ...o });
let reqN = 0;

async function call(operationId: string, r: ReturnType<typeof req>, o: Opts = {}): Promise<{ status: number; body: any; probe: Probe }> {
  const tenant = o.tenant ?? A;
  const probe: Probe = { events: [], audit: [], roleCalls: [], demographics: [] };
  const grants = o.grants ?? [PRINT];
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenant)]);
    const scope = o.scope ?? { all: false, centreIds: [CENTRE[tenant]] };
    const demo = (patientId: string) => ({ patientId, patientCode: 'P-T10', fullName: 'Test Patient T10', sex: 'female', birthOn: '1996-06-15', ageAtOrder: { years: 30, months: 0, days: 0 }, status: 'active',
      consents: { sms: false, whatsapp: false, email: false, shareWithReferrer: false, consentTextVersion: 'v1' } });
    const ctx: any = {
      operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, tenantId: tenant, tx: client, requestId: u(0x9a00 + reqN++), now: () => o.now ?? NOW,
      actor: { type: 'user', id: SYS, membershipId: MEM },
      ports: {
        IdentityPort: {
          async assertRole(_c: unknown, x: { permission: string; centreId?: string }) { probe.roleCalls.push(x); if (!grants.includes(x?.permission)) throw new LimsError('auth.forbidden'); },
          async getActor() { return { actor: { type: 'user', id: SYS }, permissions: [...grants], centreScope: scope, branchIds: [BRANCH[tenant]], isLocked: false }; },
          async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; },
        },
        FrontdeskPort: {
          async getPatientDemographics(_c: unknown, x: { patientId: string; purpose: string }) { probe.demographics.push(x); return demo(x.patientId); },
          async getPatientDemographicsBatch(_c: unknown, x: { patientIds: string[]; purpose: string }) { probe.demographics.push(x); return x.patientIds.map(demo); },
          // Contract (03-INTERFACE-CATALOG §4.3 FrontdeskPort): other tenant's order / other centre outside actor scope / unknown id -> common.not_found.
          async getOrderSummary(_c: unknown, x: { orderId: string }) {
            const seen = seededOrders.get(x.orderId);
            if (!seen || seen.tenant !== tenant || (!scope.all && !(scope.centreIds ?? []).includes(seen.centre))) throw new LimsError('common.not_found');
            return { orderId: x.orderId, registrationNo: 'REGX', patientId: PATIENT[tenant], items: [] };
          },
        },
      },
      events: { publish: async (_c: unknown, type: string, input: unknown) => { probe.events.push({ type, input }); return { eventId: u(0x8a00 + probe.events.length), duplicate: false }; } },
      audit: { access: async (e: unknown) => { probe.audit.push(e); } },
      core: { centres: { list: async () => [
        { id: CENTRE[tenant], branchId: BRANCH[tenant], branch_id: BRANCH[tenant] }, { id: CENTRE_A2, branchId: BRANCH_A2, branch_id: BRANCH_A2 }] } },
    };
    const out = await (handlers as unknown as Record<string, (r: unknown, c: unknown) => Promise<{ status: number; body?: any }>>)[operationId]!(r, ctx);
    await client.query('COMMIT');
    return { status: out.status, body: out.body, probe };
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
}
async function failure(p: Promise<unknown>): Promise<any> { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); }
const expectCode = (e: any, code: string, status: number) => { expect(isLimsError(e, code as never), `${e?.code ?? e}`).toBe(true); expect(e.statusCode).toBe(status); };
const print = (body: object, o: Opts = {}) => call('printSpecimenLabels', req({ body }), o);
const ready = (orderId: string, o: Opts = {}, extra: { headers?: object } = {}) => call('requestOrderLabelPrint', req({ params: { order_id: orderId }, body: {}, ...extra }), o);
const labelAudit = (p: Probe) => p.audit.filter((a) => a?.action === ACTION);

let savedSettings: Record<string, unknown> | undefined;
beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 12 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await asAdmin(t, async (c) => {
    const have = (await c.query('SELECT 1 FROM frontdesk.patients WHERE id = $1', [PATIENT[t]])).rowCount;
    if (!have) await ins(c, 'frontdesk.patients', { id: PATIENT[t], tenant_id: t, patient_code: 'P-T10', full_name: 'Test Patient T10', name_search: 'test patient t10', sex: 'female', registered_centre_id: CENTRE[t] });
  });
  savedSettings = (await sql('SELECT label_width_mm, label_height_mm, label_copies_default FROM lab.lab_settings WHERE tenant_id = $1', [A]))[0];
  // Ruling C5.T-10: no migration/seed creates the row -> upsert it (02-TRD #14: size + label_copies_default come from lab_settings).
  // created_by/updated_by are uuid NOT NULL, no DEFAULT, no FK (05-SCHEMA.md:178-185) -> fixed synthetic actor.
  const SETTINGS_ACTOR = '00000000-0000-4000-8000-0000000010aa';
  // lab.lab_settings is audited by the core row trigger -> needs request.jwt.claims with a sub (asAdmin), LD-111.
  await asAdmin(A, (c) => c.query('INSERT INTO lab.lab_settings (tenant_id, label_width_mm, label_height_mm, label_copies_default, created_by, updated_by) VALUES ($1, 60, 30, 2, $2, $2) ON CONFLICT (tenant_id) DO UPDATE SET label_width_mm = 60, label_height_mm = 30, label_copies_default = 2', [A, SETTINGS_ACTOR]));
}, 120_000);
afterAll(async () => {
  if (live) {
    if (savedSettings) await asAdmin(A, (c) => c.query('UPDATE lab.lab_settings SET label_width_mm = $1, label_height_mm = $2, label_copies_default = $3 WHERE tenant_id = $4',
      [savedSettings['label_width_mm'], savedSettings['label_height_mm'], savedSettings['label_copies_default'], A])).catch(() => undefined);
    else await asAdmin(A, (c) => c.query('DELETE FROM lab.lab_settings WHERE tenant_id = $1', [A])).catch(() => undefined);
  }
  await Promise.all([api?.end(), admin?.end()]);
});

describe('T-10 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

// ================================================================== #14 printSpecimenLabels
describe.skipIf(!live)('#14 printSpecimenLabels — label data + the ONLY counter / access-log point', () => {
  it('AC-02.1/02.4: order_id -> one LabelDataDto per active specimen, copies = label_copies_default (2), size from lab_settings (60x30), body validates PrintLabelsResponse', async () => {
    const s = await scenario(A, [{ status: 'collected', tests: [{ code: 'CBC' }, { code: 'ESR' }] }, { status: 'ordered', type: 'SER', container: 'SST', tests: [{ code: 'TSH' }] }]);
    const r = await print({ order_id: s.orderId });
    expect(r.status).toBe(200);
    expect(schemaErrors('PrintLabelsResponse', r.body)).toEqual([]);
    expect(r.body.errors).toEqual([]);
    expect(r.body.size).toEqual({ width_mm: 60, height_mm: 30 });
    expect(r.body.label_copies_default).toBe(2);
    expect(r.body.labels).toHaveLength(2);
    const by = Object.fromEntries(r.body.labels.map((l: any) => [l.specimen_id, l]));
    const l0 = by[s.specimens[0]!.id]; const l1 = by[s.specimens[1]!.id];
    expect(l0).toMatchObject({ barcode: s.specimens[0]!.barcode, registration_no: s.regNo, patient_name: 'Test Patient T10', specimen_type_code: 'WB', container_code: 'EDTA', test_codes: ['CBC', 'ESR'], more_tests: 0, urgent: false, copies: 2, collected_on: '2026-06-15' });
    expect(l0.age_sex).toMatch(/F/);
    expect(l1).toMatchObject({ specimen_type_code: 'SER', container_code: 'SST', test_codes: ['TSH'], copies: 2 });
    expect(l1.collected_on).toBeUndefined();                       // not collected -> no collection date (AC-02.4)
    for (const l of r.body.labels) for (const k of Object.keys(l)) expect(LABEL_KEYS.has(k), `unexpected key ${k}`).toBe(true);
  });

  it('AC-02.3 / S-10: each printed specimen gets label_print_count + 1 (not + copies) and last_label_printed_at = now; ONE access-log row specimen_label.print per specimen; no event, no barcode/name in the log', async () => {
    const s = await scenario(A, [{ status: 'collected' }, { status: 'collected' }, { status: 'ordered' }]);
    const before = await Promise.all(s.specimens.map((x) => specimenRow(x.id)));
    expect(before.every((b) => b.label_print_count === 0 && b.last_label_printed_at === null)).toBe(true);
    const r = await print({ order_id: s.orderId });
    expect(r.status).toBe(200);
    for (const x of s.specimens) {
      const row = await specimenRow(x.id);
      expect(row.label_print_count).toBe(1);
      expect(new Date(row.last_label_printed_at).toISOString()).toBe(NOW.toISOString());
      expect(labelAudit(r.probe).filter((a) => a.entityId === x.id)).toHaveLength(1);
    }
    expect(labelAudit(r.probe)).toHaveLength(3);
    expect(r.probe.audit.every((a) => a.action === ACTION && a.entityType === 'specimen' && a.outcome === 'allowed')).toBe(true);
    const logged = JSON.stringify(r.probe.audit);
    expect(logged).not.toContain('Test Patient');
    for (const x of s.specimens) expect(logged).not.toContain(x.barcode);
    expect(r.probe.events).toEqual([]);
    expect(r.probe.demographics.every((d) => d.purpose === 'label_print')).toBe(true);
    expect(r.probe.demographics.length).toBeGreaterThan(0);
  });

  it('reprint counts again (03-APP-FLOW E16): 2nd call -> label_print_count 2, two audit rows in total', async () => {
    const s = await scenario(A, [{ status: 'collected' }]);
    await print({ order_id: s.orderId });
    await print({ order_id: s.orderId });
    expect((await specimenRow(s.specimens[0]!.id)).label_print_count).toBe(2);
  });

  it('AC-02.5: inactive specimen -> per-id { id, code: lab.specimen_inactive }, no label, counter untouched, no access-log row for it; the active one is still printed (200)', async () => {
    const s = await scenario(A, [{ status: 'collected' }, { status: 'ordered', active: false }]);
    const [ok, dead] = [s.specimens[0]!, s.specimens[1]!];
    const r = await print({ order_id: s.orderId });
    expect(r.status).toBe(200);
    expect(r.body.errors).toEqual([{ id: dead.id, code: 'lab.specimen_inactive' }]);
    expect(r.body.labels.map((l: any) => l.specimen_id)).toEqual([ok.id]);
    expect((await specimenRow(dead.id)).label_print_count).toBe(0);
    expect((await specimenRow(dead.id)).last_label_printed_at).toBeNull();
    expect((await specimenRow(ok.id)).label_print_count).toBe(1);
    expect(labelAudit(r.probe).map((a) => a.entityId)).toEqual([ok.id]);
  });

  it('AC-02.5: only inactive specimens -> 200 with labels [] and the per-id errors; nothing written', async () => {
    const s = await scenario(A, [{ status: 'ordered', active: false }]);
    const before = await snapshot(s);
    const r = await print({ specimen_ids: [s.specimens[0]!.id] });
    expect(r.status).toBe(200);
    expect(r.body.labels).toEqual([]);
    expect(r.body.errors).toEqual([{ id: s.specimens[0]!.id, code: 'lab.specimen_inactive' }]);
    expect(await snapshot(s)).toBe(before);
    expect(r.probe.audit).toEqual([]);
  });

  it('copies: explicit 1..5 overrides the default on every label; absent = default', async () => {
    const s = await scenario(A, [{ status: 'collected' }]);
    expect((await print({ order_id: s.orderId, copies: 5 })).body.labels[0].copies).toBe(5);
    expect((await print({ specimen_ids: [s.specimens[0]!.id], copies: 1 })).body.labels[0].copies).toBe(1);
    expect((await print({ specimen_ids: [s.specimens[0]!.id] })).body.labels[0].copies).toBe(2);
  });

  it('up to 4 test codes then more_tests; urgent when ANY test on the specimen is urgent (AC-02.4)', async () => {
    const six = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'].map((code, i) => ({ code, priority: i === 4 ? 'urgent' as const : 'routine' as const }));
    const s = await scenario(A, [{ status: 'collected', tests: six }, { status: 'collected', tests: [{ code: 'ZZ' }] }]);
    const r = await print({ order_id: s.orderId });
    const by = Object.fromEntries(r.body.labels.map((l: any) => [l.specimen_id, l]));
    expect(by[s.specimens[0]!.id]).toMatchObject({ test_codes: ['A1', 'B2', 'C3', 'D4'], more_tests: 2, urgent: true });
    expect(by[s.specimens[1]!.id]).toMatchObject({ test_codes: ['ZZ'], more_tests: 0, urgent: false });
  });

  it('request validation: neither / both of order_id + specimen_ids, copies 0 / 6 / 1.5, > 200 ids, [] ids, unknown key -> 400 and nothing written', async () => {
    const s = await scenario(A, [{ status: 'collected' }]);
    const before = await snapshot(s);
    const id = s.specimens[0]!.id;
    const bad: object[] = [{}, { order_id: s.orderId, specimen_ids: [id] }, { order_id: s.orderId, copies: 0 }, { order_id: s.orderId, copies: 6 }, { order_id: s.orderId, copies: 1.5 },
      { specimen_ids: Array.from({ length: 201 }, (_, i) => u(0xf000 + i)) }, { specimen_ids: [] }, { order_id: s.orderId, barcode: 'X' }, { order_id: 'not-a-uuid' }];
    for (const body of bad) expectCode(await failure(print(body)), 'common.validation_failed', 400);
    expect(await snapshot(s)).toBe(before);
  });

  it('S-04: no lab.specimen.label_print -> 403 auth.forbidden (permission asserted on label_print), nothing written', async () => {
    const s = await scenario(A, [{ status: 'collected' }]);
    const before = await snapshot(s);
    expectCode(await failure(print({ order_id: s.orderId }, { grants: ['lab.specimen.read', 'lab.specimen.collect'] })), 'auth.forbidden', 403);
    expect(await snapshot(s)).toBe(before);
    const ok = await print({ order_id: s.orderId });
    expect(ok.probe.roleCalls.map((c) => c.permission)).toContain(PRINT);
  });

  it('P-05: order of tenant B -> 404 (no B data, B counters untouched); order of centre A2 for an A1-only user -> 404 (REQ-SEC-017), counters untouched', async () => {
    const b = await scenario(B, [{ status: 'collected' }]);
    const a2 = await scenario(A, [{ status: 'collected' }], CENTRE_A2);
    const bBefore = await snapshot(b); const a2Before = await snapshot(a2);
    const e1 = await failure(print({ order_id: b.orderId }));
    expectCode(e1, 'common.not_found', 404);
    expect(JSON.stringify(e1)).not.toContain(b.regNo);
    expectCode(await failure(print({ order_id: a2.orderId })), 'common.not_found', 404);
    expect(await snapshot(b)).toBe(bBefore);
    expect(await snapshot(a2)).toBe(a2Before);
  });

  it('P-04: specimen_ids mixing A and tenant-B ids -> B id is a per-id common.not_found, never a label, never counted; A processed', async () => {
    const a = await scenario(A, [{ status: 'collected' }]);
    const b = await scenario(B, [{ status: 'collected' }]);
    const r = await print({ specimen_ids: [a.specimens[0]!.id, b.specimens[0]!.id] });
    expect(r.status).toBe(200);
    expect(r.body.labels.map((l: any) => l.specimen_id)).toEqual([a.specimens[0]!.id]);
    expect(r.body.errors).toEqual([{ id: b.specimens[0]!.id, code: 'common.not_found' }]);
    expect((await specimenRow(b.specimens[0]!.id)).label_print_count).toBe(0);
    expect(JSON.stringify(r.body)).not.toContain(b.specimens[0]!.barcode);
    expect((await specimenRow(a.specimens[0]!.id)).label_print_count).toBe(1);
  });

  it('a failure after counting rolls the whole request back (count and audit are in the request tx): handler error -> label_print_count stays 0', async () => {
    const s = await scenario(A, [{ status: 'collected' }]);
    const e = await failure(print({ order_id: s.orderId, copies: 99 }));
    expectCode(e, 'common.validation_failed', 400);
    expect((await specimenRow(s.specimens[0]!.id)).label_print_count).toBe(0);
  });

  it('race: 5 concurrent prints of the same specimen -> label_print_count = 5 (no lost update), 5 access-log rows', async () => {
    const s = await scenario(A, [{ status: 'collected' }]);
    const runs = await Promise.all(Array.from({ length: 5 }, () => print({ specimen_ids: [s.specimens[0]!.id] })));
    expect(runs.every((r) => r.status === 200)).toBe(true);
    expect((await specimenRow(s.specimens[0]!.id)).label_print_count).toBe(5);
    expect(runs.reduce((n, r) => n + labelAudit(r.probe).length, 0)).toBe(5);
  });

  it('does not allocate barcodes or touch specimen status/transitions (read-and-count only)', async () => {
    const s = await scenario(A, [{ status: 'collected' }]);
    const c0 = await counterSum();
    const tr0 = (await sql('SELECT count(*)::int AS n FROM lab.specimen_transitions WHERE specimen_id = $1', [s.specimens[0]!.id]))[0].n;
    await print({ order_id: s.orderId });
    expect(await counterSum()).toBe(c0);
    expect((await sql('SELECT count(*)::int AS n FROM lab.specimen_transitions WHERE specimen_id = $1', [s.specimens[0]!.id]))[0].n).toBe(tr0);
    expect((await specimenRow(s.specimens[0]!.id)).status).toBe('collected');
  });
});

// ================================================================== #14a requestOrderLabelPrint
describe.skipIf(!live)('#14a requestOrderLabelPrint — readiness only: writes NOTHING (08 A13 D-4)', () => {
  it('specimens exist -> 200 { order_id, specimens:[{specimen_id, barcode, outcome ready|inactive}], labels_route } validates OrderLabelPrintResponse', async () => {
    const s = await scenario(A, [{ status: 'collected' }, { status: 'ordered', active: false }]);
    const r = await ready(s.orderId);
    expect(r.status).toBe(200);
    expect(schemaErrors('OrderLabelPrintResponse', r.body)).toEqual([]);
    expect(r.body.order_id).toBe(s.orderId);
    expect(r.body.labels_route).toBe('staff.lab.order_labels');
    const by = Object.fromEntries(r.body.specimens.map((x: any) => [x.specimen_id, x]));
    expect(by[s.specimens[0]!.id]).toEqual({ specimen_id: s.specimens[0]!.id, barcode: s.specimens[0]!.barcode, outcome: 'ready' });
    expect(by[s.specimens[1]!.id]).toEqual({ specimen_id: s.specimens[1]!.id, barcode: s.specimens[1]!.barcode, outcome: 'inactive' });
    expect(r.body.specimens).toHaveLength(2);
  });

  it('AC-02.3 / S-10: no counter, no last_label_printed_at, no access-log row, no event, no barcode counter, no demographics fetch — repeated calls leave the database unchanged', async () => {
    const s = await scenario(A, [{ status: 'collected' }, { status: 'ordered' }]);
    const before = await snapshot(s);
    for (let i = 0; i < 3; i++) {
      const r = await ready(s.orderId);
      expect(r.status).toBe(200);
      expect(r.probe.audit).toEqual([]);
      expect(r.probe.events).toEqual([]);
      expect(r.probe.demographics).toEqual([]);                    // PHI is not needed for a readiness call
    }
    expect(await snapshot(s)).toBe(before);
    for (const x of s.specimens) {
      const row = await specimenRow(x.id);
      expect(row.label_print_count).toBe(0);
      expect(row.last_label_printed_at).toBeNull();
    }
  });

  it('AC-02.2 / 08 A2.10: lab.orders row missing (consumer still running) -> 409 common.version_conflict, detail "specimens not created yet", writes nothing; the retry WITHOUT any key then returns 200', async () => {
    const s = await frontOrder(A);
    const e = await failure(ready(s.orderId));
    expectCode(e, 'common.version_conflict', 409);
    expect(String(e.detail ?? e.problem?.detail ?? e.message)).toMatch(/specimens not created yet/i);
    expect((await sql('SELECT count(*)::int AS n FROM lab.orders WHERE id = $1', [s.orderId]))[0].n).toBe(0);
    expect((await sql('SELECT count(*)::int AS n FROM lab.specimens WHERE order_id = $1', [s.orderId]))[0].n).toBe(0);
    await seedLab(s, [{ status: 'ordered' }]);                      // the consumer commits
    const retry = await ready(s.orderId, {}, { headers: {} });      // no idempotency-key, no if-match
    expect(retry.status).toBe(200);
    expect(retry.body.specimens).toHaveLength(1);
    expect(retry.body.specimens[0].outcome).toBe('ready');
  });

  it('lab.orders row exists but no specimen yet -> 409 common.version_conflict (still not ready)', async () => {
    const s = await seedLab(await frontOrder(A), [], { labOrderOnly: true });
    expectCode(await failure(ready(s.orderId)), 'common.version_conflict', 409);
  });

  it('a stray Idempotency-Key header is not required and is ignored (x-idempotency: none): same 200 twice, nothing recorded', async () => {
    const s = await scenario(A, [{ status: 'collected' }]);
    const a = await ready(s.orderId, {}, { headers: { 'idempotency-key': 'k-14a-0001' } });
    const b = await ready(s.orderId, {}, { headers: { 'idempotency-key': 'k-14a-0001' } });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body).toEqual(a.body);
  });

  it('S-04: no lab.specimen.label_print -> 403 auth.forbidden', async () => {
    const s = await scenario(A, [{ status: 'collected' }]);
    expectCode(await failure(ready(s.orderId, { grants: ['lab.specimen.read'] })), 'auth.forbidden', 403);
    expect((await ready(s.orderId)).probe.roleCalls.map((c) => c.permission)).toContain(PRINT);
  });

  it('P-05: order of tenant B -> 404; order of centre A2 for an A1-only user -> 404; no B data in the problem body', async () => {
    const b = await scenario(B, [{ status: 'collected' }]);
    const a2 = await scenario(A, [{ status: 'collected' }], CENTRE_A2);
    const e1 = await failure(ready(b.orderId));
    expectCode(e1, 'common.not_found', 404);
    expect(JSON.stringify(e1)).not.toContain(b.specimens[0]!.barcode);
    expectCode(await failure(ready(a2.orderId)), 'common.not_found', 404);
  });

  it('validation: non-uuid order_id, non-empty body -> 400', async () => {
    expectCode(await failure(call('requestOrderLabelPrint', req({ params: { order_id: 'nope' }, body: {} }))), 'common.validation_failed', 400);
    const s = await scenario(A, [{ status: 'collected' }]);
    expectCode(await failure(call('requestOrderLabelPrint', req({ params: { order_id: s.orderId }, body: { copies: 2 } }))), 'common.validation_failed', 400);
  });
});
