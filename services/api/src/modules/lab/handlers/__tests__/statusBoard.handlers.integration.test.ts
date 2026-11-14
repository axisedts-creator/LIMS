// C5 T-27 — handler #17 getStatusBoard against the migrated database (06 row T-27; 02-TRD §5.2 row 17; 03-APP-FLOW §1.5 board projection, E18; PRD AC-18.1, AC-18.2, AC-18.3, AC-18.4;
// 07-SECURITY P-02, P-03, REQ-SEC-017/024/100, S-11). Needs the DB of tests/db/c5-t03/run.sh (see .orchestra/notes/C5.T-27-verify.cmd): LIMS_TEST_DATABASE_URL = lims_api (RLS on),
// LIMS_TEST_ADMIN_DATABASE_URL = superuser. Without them the DB tests skip, except under LIMS_T03_REQUIRE_DB=1 where "database is provided" fails.
//
// SEAMS — handlers/getStatusBoard.ts (`export const handler: Handler`, wired in handlers/index.ts); tests drive handlers.getStatusBoard(req, ctx), req = { params, query, headers, body }.
//   ctx as in specimen.handlers.integration.test.ts (one request tx under RLS) + ports.FrontdeskPort.getPatientDemographicsBatch(ctx, { patientIds, purpose }) — purpose 'lab_display'
//   (CR-C5-003), ≤ 200 ids, ONE call per page; patient_display = { full_name, age_sex, patient_code } from it, never stored (02-TRD §4).
// BEHAVIOUR (03-APP-FLOW §1.5, derived on read, per order of the actor's centre scope, registered_at in [registered_at_from, registered_at_to]):
//   waiting  = no specimen collected yet (all ordered);  collected = ≥1 collected/in_transit, none received;  in_lab = ≥1 received, not all lab items approved;
//   ready    = all non-excluded items approved and no release at/after the latest approval;  printed = a lab.report_releases row (any report_kind: final, partial, preliminary, ...) at or after the
//              latest approval (the row has no kind field in lab.yaml: the qualifier "(partial)/(preliminary)" cannot be carried by the contract — see notes);
//   rejected_specimens = number of rejected specimens whose recollection is not yet received (replacement specimen = replaces_specimen_id);  last_released_at = latest released_at of the order.
// ASSUMED (spec silent): "latest approval" = max(lab.order_tests.approved_at) of the order; specimens in status `reported` count as approved; a specimen counts as received from status received on
//   (received, aliquoted, in_process, resulted, verified, approved, reported, stored); `priority` is the order priority code; rows are not ordered by contract (tests compare sets).
import { createRequire } from 'node:module';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError, LimsError } from '../../../../core/errors.js';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';
import { handle as releasedConsumer } from '../../../../../../worker/src/jobs/lab/consumers/reporting.report.released.v1.js';
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
const u = (n: number) => `0190c60b-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const PATIENT = { [A]: u(0xa9), [B]: u(0xb9) } as Record<string, string>;
const NOW = new Date('2026-06-15T05:00:30.000Z');
const HOUR = 3_600_000, MIN = 60_000;
const iso = (d: unknown) => new Date(d as string | Date).toISOString();
const PERM = 'lab.status_board.read';

// ------------------------------------------------------------------ spec validators (lab.yaml)
const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'lab.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return v(x) ? [] : (v.errors ?? []).map((e: any) => `${e.instancePath} ${e.message}`);
};

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
let nextId = 0x7000;
let barcodeN = Date.now() % 90_000_000;
let slotN = Math.floor(Math.random() * 40_000);
/** every test gets its own hour so a test only ever sees its own orders (window = [slot, slot + 1 h]) */
const newSlot = () => Date.UTC(2027, 0, 1) + (slotN++) * 2 * HOUR;
const win = (slot: number) => ({ registered_at_from: new Date(slot).toISOString(), registered_at_to: new Date(slot + HOUR).toISOString() });

interface UnitIn { st: string; replaces?: number }
interface OrderIn { units: UnitIn[]; centre?: string; priority?: 'routine' | 'urgent'; excludedItems?: number; approvedAt?: string; at?: number; tenant?: string }
interface Seeded { id: string; itemId: string; orderTestId: string }
interface Scen { tenant: string; orderId: string; regNo: string; centre: string; units: Seeded[] }
const OT_STATUS: Record<string, string> = { ordered: 'awaiting_collection', collected: 'awaiting_receipt', in_transit: 'awaiting_receipt', received: 'in_process', in_process: 'in_process', aliquoted: 'in_process',
  resulted: 'resulted', verified: 'verified', approved: 'approved', reported: 'approved', rejected: 'awaiting_collection', recollection_ordered: 'awaiting_collection', stored: 'approved' };
const PRE_RECEIPT = new Set(['ordered', 'collected', 'in_transit', 'rejected', 'recollection_ordered']);
const APPROVED_AT = '2027-06-15T01:00:00.000Z';

async function seedOrder(slot: number, k: number, o: OrderIn): Promise<Scen> {
  const tenant = o.tenant ?? A;
  const orderId = u(nextId++);
  const centre = o.centre ?? CENTRE[tenant]!;
  const branch = centre === CENTRE_A2 ? BRANCH_A2 : BRANCH[tenant]!;
  const reg = `RT27${orderId.slice(-6).toUpperCase()}`;
  const registeredAt = new Date(slot + (o.at ?? k) * MIN).toISOString();
  const out: Scen = { tenant, orderId, regNo: reg, centre, units: [] };
  const approvedAt = o.approvedAt ?? APPROVED_AT;
  await asAdmin(tenant, async (c) => {
    await ins(c, 'frontdesk.orders', { id: orderId, tenant_id: tenant, branch_id: branch, centre_id: centre, patient_id: PATIENT[tenant], registration_no: reg, status: 'registered', visit_type: 'opd',
      billing_mode: 'cash', priority: o.priority ?? 'routine', collection_mode: 'walk_in', source: 'front_desk', is_first_order_of_patient: false, catalog_revision: 1, registered_at: registeredAt });
    await ins(c, 'lab.orders', { id: orderId, tenant_id: tenant, centre_id: centre, branch_id: branch, patient_id: PATIENT[tenant], registration_no: reg, visit_type: 'opd', priority: o.priority ?? 'routine',
      collection_mode: 'walk_in', source: 'front_desk', registered_at: registeredAt, patient_sex: 'female', patient_age_days: 10950, lab_status: 'active', last_order_seq: 1, items_version: 1 });
    const item = async (code: string, testId: string) => {
      const id = u(nextId++);
      await ins(c, 'frontdesk.order_items', { id, tenant_id: tenant, order_id: orderId, centre_id: centre, orderable_id: u(nextId++), orderable_kind: 'test', code, name: `${code} (SYNTHETIC)`, test_ids: [testId],
        priority: o.priority ?? 'routine', unit_price_paisa: 1000, price_list_id: u(0x98), price_list_version: 1, price_source: 'tenant_default', vat_treatment: 'exempt', added_in_items_version: 1 });
      return id;
    };
    for (const [i, un] of o.units.entries()) {
      const st = un.st;
      const id = u(nextId++); const orderTestId = u(nextId++); const resultId = u(nextId++); const testId = u(nextId++);
      const itemId = await item(`T27B${i}`, testId);
      const received = !PRE_RECEIPT.has(st);
      const approved = ['approved', 'reported', 'stored'].includes(st);
      const rejected = st === 'rejected' || st === 'recollection_ordered';
      await ins(c, 'lab.specimens', { id, tenant_id: tenant, centre_id: centre, order_id: orderId, patient_id: PATIENT[tenant], barcode: `T27${String(barcodeN++).padStart(8, '0')}`,
        creation_key: `${orderId}:WB:EDTA:${i}`, specimen_type_code: 'WB', container_code: 'EDTA', priority: o.priority ?? 'routine', patient_sex: 'female', patient_age_days: 10950, status: st,
        ordered_at: registeredAt, ...(un.replaces !== undefined ? { replaces_specimen_id: out.units[un.replaces]!.id } : {}),
        ...(st !== 'ordered' ? { collected_at: registeredAt, collected_by_membership_id: MEM } : {}), ...(st === 'in_transit' ? { in_transit_at: registeredAt } : {}),
        ...(received ? { in_transit_at: registeredAt, received_at: registeredAt, received_by_membership_id: MEM, processing_centre_id: centre, processing_branch_id: branch } : {}),
        ...(rejected ? { rejected_at: registeredAt, rejection_reason_code: 'HEMOLYZED', rejection_comment: 'Synthetic comment' } : {}),
        ...(approved ? { all_approved_at: approvedAt } : {}), ...(st === 'reported' ? { reported_at: approvedAt } : {}), is_active: true });
      await ins(c, 'lab.order_tests', { id: orderTestId, tenant_id: tenant, centre_id: centre, order_id: orderId, order_item_id: itemId, test_id: testId, test_code: `T27B${i}`, test_revision: 1, catalog_revision: 1,
        department_id: u(0x901), workflow_type: 'standard', priority: o.priority ?? 'routine', specimen_id: id, status: OT_STATUS[st], ordered_at: registeredAt,
        ...(received ? { received_at: registeredAt, processing_centre_id: centre, processing_branch_id: branch } : {}), ...(approved ? { approved_at: approvedAt } : {}) });
      await ins(c, 'lab.results', { id: resultId, tenant_id: tenant, centre_id: centre, order_id: orderId, order_item_id: itemId, order_test_id: orderTestId, specimen_id: id, patient_id: PATIENT[tenant],
        test_id: testId, analyte_id: u(nextId++), analyte_code: `T27B${i}A`, department_id: u(0x901), is_reportable: true, result_type: 'numeric',
        ...(approved ? { status: 'approved', origin: 'manual', value_numeric: '5.0', unit_code: 'g/dL', approved_at: approvedAt, approved_by_membership_id: MEM } : { status: 'pending' }) });
      out.units.push({ id, itemId, orderTestId });
    }
    for (let e = 0; e < (o.excludedItems ?? 0); e++) {
      const testId = u(nextId++);
      const itemId = await item(`T27X${e}`, testId);
      await ins(c, 'lab.order_tests', { id: u(nextId++), tenant_id: tenant, centre_id: centre, order_id: orderId, order_item_id: itemId, test_id: testId, test_code: `T27X${e}`, test_revision: 1, catalog_revision: 1,
        department_id: u(0x901), workflow_type: 'narrative', priority: o.priority ?? 'routine', status: 'excluded', ordered_at: registeredAt });
    }
  });
  return out;
}
/** a release row as the consumer would have written it (seeded directly so each board rule is tested on its own) */
async function seedRelease(s: Scen, kind: string, releasedAt: string, version = 1) {
  await asAdmin(s.tenant, (c) => ins(c, 'lab.report_releases', { id: u(nextId++), tenant_id: s.tenant, order_id: s.orderId, report_id: u(nextId++), version_no: version, report_kind: kind,
    released_at: releasedAt, release_basis: 'paid_in_full', event_id: u(nextId++) }));
}

// ------------------------------------------------------------------ driving the handler
type Pub = { type: string; input: any };
interface Probe { events: Pub[]; audit: any[]; roleCalls: any[]; demographics: { patientIds: string[]; purpose: string }[] }
interface Opts { grants?: readonly string[]; tenant?: string; scope?: { all?: boolean; centreIds?: readonly string[] } }
let reqN = 0;
async function board(query: Record<string, unknown>, o: Opts = {}): Promise<{ status: number; body: any; probe: Probe }> {
  const tenant = o.tenant ?? A;
  const probe: Probe = { events: [], audit: [], roleCalls: [], demographics: [] };
  const grants = o.grants ?? [PERM];
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(tenant)]);
    const scope = o.scope ?? { all: false, centreIds: [CENTRE[tenant], CENTRE_A2] };
    const ctx: any = {
      operationId: 'getStatusBoard', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, tenantId: tenant, tx: client, requestId: u(0x9000 + reqN++), now: () => NOW,
      actor: { type: 'user', id: SYS, membershipId: MEM },
      ports: {
        IdentityPort: {
          async assertRole(_c: unknown, x: { permission: string }) { probe.roleCalls.push(x); if (!grants.includes(x?.permission)) throw new LimsError('auth.forbidden'); },
          async getActor() { return { actor: { type: 'user', id: SYS }, permissions: [...grants], centreScope: scope, branchIds: [BRANCH[tenant]], isLocked: false }; },
          async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; },
        },
        FrontdeskPort: {
          async getPatientDemographicsBatch(_c: unknown, x: { patientIds: string[]; purpose: string }) {
            probe.demographics.push(x);
            return x.patientIds.map((patientId) => ({ patientId, patientCode: 'P-T27B', fullName: 'Test Patient T27', sex: 'female', ageAtOrder: { years: 30, months: 0, days: 0 }, status: 'active',
              consents: { sms: false, whatsapp: false, email: false, shareWithReferrer: false, consentTextVersion: '1' } }));
          },
        },
      },
      events: { publish: async (_c: unknown, type: string, input: unknown) => { probe.events.push({ type, input }); return { eventId: u(0x8000 + probe.events.length), duplicate: false }; } },
      audit: { access: async (e: unknown) => { probe.audit.push(e); } },
      core: { centres: { list: async () => [{ id: CENTRE[tenant], branchId: BRANCH[tenant], branch_id: BRANCH[tenant] }, { id: CENTRE_A2, branchId: BRANCH_A2, branch_id: BRANCH_A2 }] } },
    };
    const out = await (handlers as unknown as Record<string, (r: unknown, c: unknown) => Promise<{ status: number; body?: any }>>)['getStatusBoard']!({ params: {}, query, headers: {}, body: undefined }, ctx);
    await client.query('COMMIT');
    return { status: out.status, body: out.body, probe };
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
}
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, but it resolved'); };
const rowOf = (res: { body: any }, s: Scen) => res.body.data.find((r: any) => r.order_id === s.orderId);
const statusOf = async (s: Scen, slot: number, extra: Record<string, unknown> = {}) => { const r = await board({ ...win(slot), ...extra }); expect(r.status).toBe(200); return rowOf(r, s); };

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 12 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await asAdmin(t, (c) => ins(c, 'frontdesk.patients', { id: PATIENT[t], tenant_id: t, patient_code: 'P-T27B', full_name: 'Test Patient T27', name_search: 'test patient t27',
    sex: 'female', registered_centre_id: CENTRE[t] }));
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-27 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

describe.skipIf(!live)('T-27 AC-18.1 board_status projection (03-APP-FLOW §1.5)', () => {
  const CASES: [string, UnitIn[], string, Partial<OrderIn>?][] = [
    ['nothing collected yet -> waiting', [{ st: 'ordered' }, { st: 'ordered' }], 'waiting'],
    ['collected, none received -> collected', [{ st: 'collected' }, { st: 'ordered' }], 'collected'],
    ['in_transit counts as collected', [{ st: 'in_transit' }, { st: 'collected' }], 'collected'],
    ['≥1 received, not all approved -> in_lab', [{ st: 'received' }, { st: 'collected' }], 'in_lab'],
    ['some approved, some in process -> in_lab', [{ st: 'approved' }, { st: 'in_process' }], 'in_lab'],
    ['resulted / verified but not approved -> in_lab', [{ st: 'verified' }, { st: 'resulted' }], 'in_lab'],
    ['all lab items approved, no release seen -> ready', [{ st: 'approved' }, { st: 'approved' }], 'ready'],
    ['excluded (narrative) items do not block ready (E18)', [{ st: 'approved' }], 'ready', { excludedItems: 2 }],
  ];
  for (const [name, units, expected, extra] of CASES) {
    it(name, async () => {
      const slot = newSlot();
      const s = await seedOrder(slot, 1, { units, ...extra });
      const r = await statusOf(s, slot);
      expect(r, 'the order must be on the board').toBeDefined();
      expect(r.board_status).toBe(expected);
      expect(r.rejected_specimens).toBe(0);
      expect(r.last_released_at).toBeUndefined();
    });
  }

  it('each row fits the closed StatusBoardRow/Page schema; registration_no, centre_id, priority and patient_display come through; the patient lookup is ONE lab_display batch call', async () => {
    const slot = newSlot();
    const s1 = await seedOrder(slot, 1, { units: [{ st: 'collected' }], priority: 'urgent' });
    const s2 = await seedOrder(slot, 2, { units: [{ st: 'approved' }] });
    const r = await board(win(slot));
    expect(schemaErrors('StatusBoardPage', r.body)).toEqual([]);
    expect(r.body.data).toHaveLength(2);
    expect(rowOf(r, s1)).toMatchObject({ registration_no: s1.regNo, centre_id: CENTRE[A], board_status: 'collected', rejected_specimens: 0, priority: 'urgent' });
    expect(rowOf(r, s2)).toMatchObject({ registration_no: s2.regNo, board_status: 'ready', priority: 'routine' });
    expect(rowOf(r, s1).patient_display).toMatchObject({ full_name: 'Test Patient T27', patient_code: 'P-T27B' });
    expect(rowOf(r, s1).patient_display.age_sex).toMatch(/30/);
    expect(rowOf(r, s1).patient_display.age_sex).toMatch(/F/i);
    expect(r.probe.demographics).toHaveLength(1);
    expect(r.probe.demographics[0]!.purpose).toBe('lab_display');
    expect([...new Set(r.probe.demographics[0]!.patientIds)]).toEqual([PATIENT[A]]);
    expect(r.probe.roleCalls.map((x) => x.permission)).toContain(PERM);
    expect(r.probe.events).toHaveLength(0);
  });

  describe('rejected badge: rejected specimens whose recollection is not yet received', () => {
    it('a rejected specimen without recollection -> rejected_specimens = 1 (the Sample rejected badge)', async () => {
      const slot = newSlot();
      const s = await seedOrder(slot, 1, { units: [{ st: 'received' }, { st: 'rejected' }] });
      const r = await statusOf(s, slot);
      expect(r).toMatchObject({ board_status: 'in_lab', rejected_specimens: 1 });
    });
    it('a rejected specimen whose recollection is ordered/collected but NOT received -> still 1 (and the order is collected, not in_lab)', async () => {
      const slot = newSlot();
      const s = await seedOrder(slot, 1, { units: [{ st: 'recollection_ordered' }, { st: 'collected', replaces: 0 }] });
      const r = await statusOf(s, slot);
      expect(r).toMatchObject({ board_status: 'collected', rejected_specimens: 1 });
    });
    it('once the recollection is received the badge is gone (rejected_specimens = 0)', async () => {
      const slot = newSlot();
      const s = await seedOrder(slot, 1, { units: [{ st: 'recollection_ordered' }, { st: 'received', replaces: 0 }] });
      const r = await statusOf(s, slot);
      expect(r).toMatchObject({ board_status: 'in_lab', rejected_specimens: 0 });
    });
    it('two rejected specimens, one recollected-and-received -> 1', async () => {
      const slot = newSlot();
      const s = await seedOrder(slot, 1, { units: [{ st: 'recollection_ordered' }, { st: 'received', replaces: 0 }, { st: 'rejected' }] });
      expect((await statusOf(s, slot)).rejected_specimens).toBe(1);
    });
  });

  describe('printed: a release at or after the latest approval/amendment (any report_kind)', () => {
    for (const kind of ['final', 'amended', 'addendum', 'partial', 'preliminary', 'corrected_by_c6']) {
      it(`a ${kind} release after approval -> printed with last_released_at`, async () => {
        const slot = newSlot();
        const s = await seedOrder(slot, 1, { units: [{ st: 'reported' }, { st: 'reported' }] });
        await seedRelease(s, kind, '2027-06-15T02:00:00.000Z');
        const r = await statusOf(s, slot);
        expect(r.board_status).toBe('printed');
        expect(iso(r.last_released_at)).toBe('2027-06-15T02:00:00.000Z');
      });
    }
    it('a release at exactly the approval time counts (at or after)', async () => {
      const slot = newSlot();
      const s = await seedOrder(slot, 1, { units: [{ st: 'approved' }] });
      await seedRelease(s, 'final', APPROVED_AT);
      expect((await statusOf(s, slot)).board_status).toBe('printed');
    });
    it('a release BEFORE the latest approval/amendment does not count: the order is ready again (amended after release)', async () => {
      const slot = newSlot();
      const s = await seedOrder(slot, 1, { units: [{ st: 'approved' }] });
      await seedRelease(s, 'final', '2027-06-15T00:30:00.000Z');                 // released 30 min BEFORE the approval at 01:00
      const r = await statusOf(s, slot);
      expect(r.board_status).toBe('ready');
    });
    it('two releases: last_released_at is the latest', async () => {
      const slot = newSlot();
      const s = await seedOrder(slot, 1, { units: [{ st: 'reported' }] });
      await seedRelease(s, 'final', '2027-06-15T02:00:00.000Z', 1);
      await seedRelease(s, 'amended', '2027-06-15T03:00:00.000Z', 2);
      expect(iso((await statusOf(s, slot)).last_released_at)).toBe('2027-06-15T03:00:00.000Z');
    });
  });

  describe('board_status filter (csv)', () => {
    it('returns only the requested statuses', async () => {
      const slot = newSlot();
      const waiting = await seedOrder(slot, 1, { units: [{ st: 'ordered' }] });
      const collected = await seedOrder(slot, 2, { units: [{ st: 'collected' }] });
      const inLab = await seedOrder(slot, 3, { units: [{ st: 'received' }] });
      const ready = await seedOrder(slot, 4, { units: [{ st: 'approved' }] });
      const printed = await seedOrder(slot, 5, { units: [{ st: 'reported' }] });
      await seedRelease(printed, 'final', '2027-06-15T02:00:00.000Z');
      const ids = async (bs?: string) => { const r = await board({ ...win(slot), ...(bs ? { board_status: bs } : {}) }); expect(r.status).toBe(200); return r.body.data.map((x: any) => x.order_id).sort(); };
      expect(await ids()).toEqual([waiting, collected, inLab, ready, printed].map((x) => x.orderId).sort());
      expect(await ids('ready,printed')).toEqual([ready, printed].map((x) => x.orderId).sort());
      expect(await ids('waiting')).toEqual([waiting.orderId]);
      expect(await ids('collected,in_lab')).toEqual([collected, inLab].map((x) => x.orderId).sort());
    });
  });

  describe('window and pagination', () => {
    it('only orders with registered_at inside [from, to] are returned', async () => {
      const slot = newSlot();
      const inside = await seedOrder(slot, 10, { units: [{ st: 'collected' }] });
      const before = await seedOrder(slot, -30, { units: [{ st: 'collected' }] });
      const after = await seedOrder(slot, 90, { units: [{ st: 'collected' }] });
      const ids = (await board(win(slot))).body.data.map((x: any) => x.order_id);
      expect(ids).toContain(inside.orderId);
      expect(ids).not.toContain(before.orderId);
      expect(ids).not.toContain(after.orderId);
    });
    it('limit + cursor walk every order exactly once; a garbage cursor -> common.invalid_cursor (400)', async () => {
      const slot = newSlot();
      const made = await Promise.all([1, 2, 3, 4, 5].map((k) => seedOrder(slot, k, { units: [{ st: 'collected' }] })));
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 6; i++) {
        const r = await board({ ...win(slot), limit: 2, ...(cursor ? { cursor } : {}) });
        expect(r.body.data.length).toBeLessThanOrEqual(2);
        seen.push(...r.body.data.map((x: any) => x.order_id));
        cursor = r.body.page.next_cursor;
        if (!cursor) break;
      }
      expect(seen.sort()).toEqual(made.map((x) => x.orderId).sort());
      expect(new Set(seen).size).toBe(seen.length);
      const e = await failure(board({ ...win(slot), cursor: 'not-a-cursor' }));
      expect(isLimsError(e, 'common.invalid_cursor' as never), `${e?.code ?? e}`).toBe(true);
      expect(e.statusCode).toBe(400);
    });
  });
});

describe.skipIf(!live)('T-27 AC-18.2 + AC-18.3 end to end: the released event moves the board once', () => {
  async function release(s: Scen, o: { kind?: string; itemIds?: string[]; eventId?: string; reportId?: string }) {
    const reportId = o.reportId ?? u(nextId++);
    const env = { event_id: o.eventId ?? u(nextId++), event_type: 'reporting.report.released.v1', tenant_id: s.tenant, producer: 'reporting', occurred_at: NOW.toISOString(),
      aggregate: { type: 'report', id: reportId, seq: 1 }, idempotency_key: `${reportId}:1:released`,
      payload: { report_id: reportId, version_no: 1, order_id: s.orderId, patient_id: PATIENT[s.tenant], centre_id: s.centre, report_kind: o.kind ?? 'final', ...(o.itemIds ? { order_item_ids: o.itemIds } : {}),
        released_at: '2027-06-15T02:00:00.000Z', release_basis: 'paid_in_full', audiences: ['patient'] } };
    const client = await api.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(s.tenant)]);
      await releasedConsumer(env as never, { tenantId: s.tenant, actor: { type: 'system', id: SYS }, requestId: u(0x9500 + reqN++), tx: client, now: () => NOW.toISOString(), attempt: 1, maxAttempts: 10, jobId: '1',
        log: { info() {}, warn() {}, error() {}, child() { return this; } }, events: { publish: async () => ({ eventId: u(0x8f00 + reqN++), duplicate: false }) },
        ports: { IdentityPort: { async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; } } } } as never);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
    return env;
  }
  const s10 = async (s: Scen) => (await sql('SELECT 1 FROM lab.specimen_transitions WHERE specimen_id = ANY($1) AND transition_code = $2', [s.units.map((x) => x.id), 'S10'])).length;

  it('ready -> (final released) printed with the release time; the same event twice changes the board and the specimens once', async () => {
    const slot = newSlot();
    const s = await seedOrder(slot, 1, { units: [{ st: 'approved' }, { st: 'approved' }] });
    expect((await statusOf(s, slot)).board_status).toBe('ready');
    const env = await release(s, { kind: 'final' });
    const first = await statusOf(s, slot);
    expect(first.board_status).toBe('printed');
    expect(iso(first.last_released_at)).toBe('2027-06-15T02:00:00.000Z');
    expect(await s10(s)).toBe(2);
    const releases = (await sql('SELECT 1 FROM lab.report_releases WHERE order_id = $1', [s.orderId])).length;
    await release(s, { kind: 'final', eventId: env.event_id, reportId: env.payload.report_id });
    expect(await statusOf(s, slot)).toEqual(first);
    expect(await s10(s)).toBe(2);
    expect((await sql('SELECT 1 FROM lab.report_releases WHERE order_id = $1', [s.orderId])).length).toBe(releases);
  });

  it('partial without order_item_ids: board Printed (row printed), no specimen moves; preliminary: row printed, no specimen moves', async () => {
    for (const kind of ['partial', 'preliminary']) {
      const slot = newSlot();
      const s = await seedOrder(slot, 1, { units: [{ st: 'approved' }] });
      await release(s, { kind });
      expect((await statusOf(s, slot)).board_status).toBe('printed');
      expect(await s10(s)).toBe(0);
      expect((await sql('SELECT status FROM lab.specimens WHERE id = $1', [s.units[0]!.id]))[0].status).toBe('approved');
    }
  });
});

describe.skipIf(!live)('T-27 AC-18.4 centre scope, tenant isolation, permission (07-SECURITY P-02, P-03, REQ-SEC-017/024)', () => {
  it('a centre-scoped user sees only the orders of their centres', async () => {
    const slot = newSlot();
    const mine = await seedOrder(slot, 1, { units: [{ st: 'collected' }] });
    const other = await seedOrder(slot, 2, { units: [{ st: 'collected' }], centre: CENTRE_A2 });
    const scoped = await board(win(slot), { scope: { all: false, centreIds: [CENTRE[A]] } });
    expect(scoped.body.data.map((x: any) => x.order_id)).toEqual([mine.orderId]);
    const both = await board(win(slot), { scope: { all: false, centreIds: [CENTRE[A], CENTRE_A2] } });
    expect(both.body.data.map((x: any) => x.order_id).sort()).toEqual([mine.orderId, other.orderId].sort());
    const all = await board(win(slot), { scope: { all: true, centreIds: [] } });
    expect(all.body.data.map((x: any) => x.order_id).sort()).toEqual([mine.orderId, other.orderId].sort());
  });

  it('no centre in scope -> an empty board (fail closed, never everything)', async () => {
    const slot = newSlot();
    await seedOrder(slot, 1, { units: [{ st: 'collected' }] });
    const r = await board(win(slot), { scope: { all: false, centreIds: [] } });
    expect(r.body.data).toEqual([]);
  });

  it('centre_id filter naming a centre outside the scope: zero rows or common.not_found, never the rows (P-02)', async () => {
    const slot = newSlot();
    await seedOrder(slot, 1, { units: [{ st: 'collected' }], centre: CENTRE_A2 });
    const e = await board({ ...win(slot), centre_id: CENTRE_A2 }, { scope: { all: false, centreIds: [CENTRE[A]] } }).then((r) => ({ rows: r.body.data as unknown[] }), (x) => ({ err: x }));
    if ('rows' in e) expect(e.rows).toEqual([]); else expect(isLimsError(e.err, 'common.not_found' as never)).toBe(true);
  });

  it('centre_id filter inside the scope narrows the board', async () => {
    const slot = newSlot();
    const a1 = await seedOrder(slot, 1, { units: [{ st: 'collected' }] });
    await seedOrder(slot, 2, { units: [{ st: 'collected' }], centre: CENTRE_A2 });
    const r = await board({ ...win(slot), centre_id: CENTRE[A] });
    expect(r.body.data.map((x: any) => x.order_id)).toEqual([a1.orderId]);
  });

  it('tenant B orders of the same window and centre scope never appear for tenant A (P-03); tenant B sees its own', async () => {
    const slot = newSlot();
    const a = await seedOrder(slot, 1, { units: [{ st: 'collected' }] });
    const b = await seedOrder(slot, 2, { units: [{ st: 'collected' }], tenant: B });
    const ra = await board(win(slot), { scope: { all: true, centreIds: [] } });
    expect(ra.body.data.map((x: any) => x.order_id)).toEqual([a.orderId]);
    const rb = await board(win(slot), { tenant: B, scope: { all: true, centreIds: [] } });
    expect(rb.body.data.map((x: any) => x.order_id)).toEqual([b.orderId]);
    expect(JSON.stringify(ra.body)).not.toContain(b.regNo);
  });

  it('a caller without lab.status_board.read gets auth.forbidden', async () => {
    const slot = newSlot();
    await seedOrder(slot, 1, { units: [{ st: 'collected' }] });
    const e = await failure(board(win(slot), { grants: ['lab.specimen.read', 'lab.worklist.read'] }));
    expect(isLimsError(e, 'auth.forbidden' as never)).toBe(true);
    expect(e.statusCode).toBe(403);
  });

  it('S-11: a window longer than 7 days -> common.validation_failed (400), nothing read', async () => {
    const slot = newSlot();
    const e = await failure(board({ registered_at_from: new Date(slot).toISOString(), registered_at_to: new Date(slot + 7 * 24 * HOUR + 1000).toISOString() }));
    expect(isLimsError(e, 'common.validation_failed' as never)).toBe(true);
    expect(e.statusCode).toBe(400);
  });
});
