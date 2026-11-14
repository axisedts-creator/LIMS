// C5 T-03 — repositories for the lab tables: explicit tenant filter, optimistic version updates, index use (06-IMPLEMENTATION-PLAN row T-03).
// done_when: "integration tests on migrated DB pass; every query uses an index from 05 §5 (EXPLAIN check in test for worklist, history, lookup)".
// Security: REQ-SEC-022/023/024 (07-SECURITY): "repos add tenant_id = $tenant explicitly"; probe P-01 (404 parity, tenant A never reads/changes tenant B).
// Needs the migrated+seeded database that tests/db/c5-t03/run.sh starts (LIMS_TEST_DATABASE_URL = role lims_api, RLS on; LIMS_TEST_ADMIN_DATABASE_URL = superuser, RLS bypassed).
// Without them the DB tests skip, except under LIMS_T03_REQUIRE_DB=1 (set by run.sh) where the "database is provided" test fails.
//
// SEAMS the spec does not fix (writer must provide exactly these; rows in/out use the DDL's snake_case column names verbatim, mappers do DTOs):
//   RepoCtx  = { tx: { query(text, values?): Promise<{ rows: any[] }> }, tenantId: string, actorId: string }   (tx = the request transaction, 02-TRD §3.2)
//   Every statement binds tenant_id = $n explicitly (value from rc.tenantId, never from a row/patch/arg) and is schema-qualified `lab.`; values are bound, never interpolated.
//   insertX(rc, row)            -> inserted row (tenant_id := rc.tenantId, created_by/updated_by := rc.actorId, version 1); a row carrying tenant_id/created_by/updated_by/version/id-of-other-tenant is REJECTED (throws).
//   getX(rc, id)                -> row | null          (unknown id or other tenant's id -> null: 404 parity)
//   updateX(rc, id, expectedVersion, patch) -> updated row. UPDATE ... SET <patch cols>, version = version + 1, updated_at = now(), updated_by = rc.actorId
//                                  WHERE tenant_id = $t AND id = $id AND version = $expected. 0 rows -> LimsError `common.version_conflict` if the row exists for this tenant, else `common.not_found`.
//                                  patch keys must be existing mutable column names of that table; anything else (tenant_id, id, version, created_*, updated_*, unknown, SQL text) -> throws, nothing written.
//   specimens.repo.ts      insertSpecimen getSpecimen findSpecimenByBarcode(rc, barcode) listSpecimensByOrder(rc, orderId) listSpecimensRecent(rc,{limit}) [created_at DESC]
//                          listReceiveQueue(rc,{limit}) [status in received|aliquoted|in_process|resulted|verified] updateSpecimen insertSpecimenTransition(rc,row) listSpecimenTransitions(rc, specimenId)
//   orders.repo.ts         insertOrder getOrder findOrdersByRegistrationNo(rc, registrationNo) updateOrder
//   orderTests.repo.ts     insertOrderTest getOrderTest listOrderTestsByOrder(rc, orderId)
//                          listWorklist(rc,{departmentId, limit}) [status in in_process|resulted|verified] listPending(rc,{limit}) [status in awaiting_collection|awaiting_receipt|in_process|resulted|verified, ordered_at ASC] updateOrderTest
//   results.repo.ts        insertResult getResult listResultsByOrder(rc, orderId)
//                          listResultHistory(rc,{patientId, analyteId, limit}) [status approved, approved_at DESC]  listVerificationQueue(rc,{status, departmentId, limit}) [status resulted|verified] updateResult
//   labSettings.repo.ts    getLabSettings(rc) -> row | null (one row per tenant, PK tenant_id)  updateLabSettings(rc, expectedVersion, patch)
//   barcodeCounters.repo.ts allocateBarcodeSeq(rc) -> next value (number-coercible); `UPDATE lab.barcode_counters SET last_value = last_value + 1 ... WHERE tenant_id = $1 RETURNING last_value`;
//                          first use inserts the row with 0 ON CONFLICT DO NOTHING first (02-TRD §6.1)
//   deltaRules.repo.ts     getActiveDeltaRule(rc, analyteId) [effective_to IS NULL AND is_active]  updateDeltaRule(rc, id, expectedVersion, patch)
// Tables without a named function here are only covered by repository.static.test.ts (every lab table is touched by some *.repo.ts).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import * as barcodeCounters from '../barcodeCounters.repo.js';
import * as deltaRules from '../deltaRules.repo.js';
import * as labSettings from '../labSettings.repo.js';
import * as orders from '../orders.repo.js';
import * as orderTests from '../orderTests.repo.js';
import * as results from '../results.repo.js';
import * as specimens from '../specimens.repo.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);

const A = '01a1a98a-ac40-7000-8000-00000000a001';
const B = '01a1a98a-ac40-7000-8000-00000000b001';
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const CENTRE_A1 = '01a1a98a-ac40-7000-8000-00000000a201';
const uid = (n: number) => `0190c503-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SQL_INJECTION = `x'; DROP TABLE lab.specimens; --`;

type Row = Record<string, any>;
interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
interface Stmt { text: string; values: unknown[] }
interface Rc { tx: Tx; tenantId: string; actorId: string }

let api: pg.Pool;
let admin: pg.Pool;

const claims = (tenantId: string) => JSON.stringify({ tenant_id: tenantId, sub: SYS, actor_type: 'system' });

/** One request-shaped transaction (claims set transaction-locally like core/db/tx.ts OPEN_SQL); records every statement the repository sends. COMMITs on success, ROLLBACKs on throw. */
async function inTx<T>(pool: pg.Pool, tenantId: string, fn: (rc: Rc, stmts: Stmt[]) => Promise<T>, claimTenant = tenantId): Promise<T> {
  const client = await pool.connect();
  const stmts: Stmt[] = [];
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims(claimTenant)]);
    if (pool === admin) await client.query("SET LOCAL search_path = ''");     // the superuser session must not rescue unqualified names
    const tx: Tx = { query: async (text, values = []) => { stmts.push({ text, values: [...values] }); return client.query(text, values); } };
    const out = await fn({ tx, tenantId, actorId: SYS }, stmts);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { client.release(); }
}
const asApi = <T>(t: string, fn: (rc: Rc, s: Stmt[]) => Promise<T>) => inTx(api, t, fn);
/** RLS bypassed: only the repositories' explicit tenant filter stands between ctx tenant and the other tenant's rows. */
const asAdmin = <T>(t: string, fn: (rc: Rc, s: Stmt[]) => Promise<T>, claimTenant = t) => inTx(admin, t, fn, claimTenant);
const sql = async (text: string, values: unknown[] = []): Promise<Row[]> => (await admin.query(text, values)).rows;
async function rejection(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected rejection, but it resolved');
}
const ids = (rows: Row[]) => rows.map((r) => r['id']);

beforeAll(async () => {
  if (!live) return;
  api = new pg.Pool({ connectionString: API_URL, max: 4 });
  admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  const fixtures = readFileSync(fileURLToPath(new URL('../../../../../../../tests/db/c5-t03/fixtures.sql', import.meta.url)), 'utf8');
  await admin.query(fixtures);       // fresh migrated + seeded database (run.sh)
}, 120_000);
afterAll(async () => { await Promise.all([api?.end(), admin?.end()]); });

describe('T-03 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => {
    if (process.env['LIMS_T03_REQUIRE_DB'] === '1') expect(live).toBe(true);
  });
});

describe.skipIf(!live)('T-03 explicit tenant filter (REQ-SEC-024; RLS bypassed so only the repository query protects)', () => {
  it('reads: another tenant\'s id and barcode are invisible (null / empty), own rows are returned', async () => {
    const own = await asAdmin(A, (rc) => specimens.getSpecimen(rc, uid(31)));
    expect(own?.['tenant_id']).toBe(A);
    expect(await asAdmin(B, (rc) => specimens.getSpecimen(rc, uid(31)))).toBeNull();            // A's specimen through B's ctx
    expect(await asAdmin(A, (rc) => specimens.getSpecimen(rc, uid(35)))).toBeNull();            // B's specimen through A's ctx
    expect(await asAdmin(A, (rc) => specimens.getSpecimen(rc, uid(99999)))).toBeNull();         // unknown id: same answer (404 parity)
    expect(await asAdmin(B, (rc) => orders.getOrder(rc, uid(11)))).toBeNull();
    expect(await asAdmin(B, (rc) => orderTests.getOrderTest(rc, uid(41)))).toBeNull();
    expect(await asAdmin(B, (rc) => results.getResult(rc, uid(2003)))).toBeNull();
    expect(await asAdmin(A, (rc) => results.getResult(rc, uid(4001)))).toBeNull();
  });

  it('the same barcode in two tenants resolves to each tenant\'s own specimen', async () => {
    const a = await asAdmin(A, (rc) => specimens.findSpecimenByBarcode(rc, 'E2600000001'));
    const b = await asAdmin(B, (rc) => specimens.findSpecimenByBarcode(rc, 'E2600000001'));
    expect(a?.['id']).toBe(uid(31));
    expect(b?.['id']).toBe(uid(35));
    expect(await asAdmin(B, (rc) => specimens.findSpecimenByBarcode(rc, 'E2600000002'))).toBeNull();   // A-only barcode
  });

  it('lists never cross tenants: history, worklist, pending, queue, by-order, registration lookup, receive queue, recent', async () => {
    const hist = await asAdmin(A, (rc) => results.listResultHistory(rc, { patientId: uid(2), analyteId: uid(5001), limit: 50 }));   // B's patient, A's ctx
    expect(hist).toEqual([]);
    const histB = await asAdmin(B, (rc) => results.listResultHistory(rc, { patientId: uid(2), analyteId: uid(5001), limit: 50 }));
    expect(ids(histB)).toEqual([uid(4001)]);
    const wl = await asAdmin(B, (rc) => orderTests.listWorklist(rc, { departmentId: uid(100), limit: 500 }));
    expect(ids(wl)).toEqual([uid(42)]);                                                          // dept uid(100) also has 20 tenant-A tests
    expect((await asAdmin(B, (rc) => orderTests.listPending(rc, { limit: 500 }))).every((r) => r['tenant_id'] === B)).toBe(true);
    expect((await asAdmin(B, (rc) => results.listVerificationQueue(rc, { status: 'resulted', departmentId: uid(100), limit: 500 }))).length).toBe(0);
    expect(await asAdmin(B, (rc) => specimens.listSpecimensByOrder(rc, uid(11)))).toEqual([]);
    expect(await asAdmin(B, (rc) => orders.findOrdersByRegistrationNo(rc, 'R-REG-777'))).toEqual([]);
    expect((await asAdmin(B, (rc) => specimens.listReceiveQueue(rc, { limit: 500 }))).every((r) => r['tenant_id'] === B)).toBe(true);
    expect(ids(await asAdmin(B, (rc) => specimens.listSpecimensRecent(rc, { limit: 500 })))).toEqual([uid(35)]);
    expect(await asAdmin(B, (rc) => specimens.listSpecimenTransitions(rc, uid(31)))).toEqual([]);
  });

  it('singleton tables: settings, delta rule and counter are the ctx tenant\'s own', async () => {
    expect((await asAdmin(A, (rc) => labSettings.getLabSettings(rc)))?.['tenant_id']).toBe(A);
    expect((await asAdmin(B, (rc) => labSettings.getLabSettings(rc)))?.['tenant_id']).toBe(B);
    expect((await asAdmin(A, (rc) => deltaRules.getActiveDeltaRule(rc, uid(5001))))?.['id']).toBe(uid(8001));
    expect((await asAdmin(B, (rc) => deltaRules.getActiveDeltaRule(rc, uid(5001))))?.['id']).toBe(uid(8002));
  });

  it('writes: ctx tenant B cannot update tenant A\'s rows (not_found, row untouched), for every updatable repository', async () => {
    const cases: Array<[string, string, string, () => Promise<unknown>]> = [
      ['lab.specimens', 'id', uid(32), () => asAdmin(B, (rc) => specimens.updateSpecimen(rc, uid(32), 1, { storage_location: 'HIJACK' }))],
      ['lab.orders', 'id', uid(12), () => asAdmin(B, (rc) => orders.updateOrder(rc, uid(12), 1, { items_version: 9 }))],
      ['lab.order_tests', 'id', uid(41), () => asAdmin(B, (rc) => orderTests.updateOrderTest(rc, uid(41), 1, { tat_target_seconds: 1 }))],
      ['lab.results', 'id', uid(2003), () => asAdmin(B, (rc) => results.updateResult(rc, uid(2003), 1, { comment_text: 'HIJACK' }))],
      ['lab.delta_check_rules', 'id', uid(8001), () => asAdmin(B, (rc) => deltaRules.updateDeltaRule(rc, uid(8001), 1, { pct_threshold: 1 }))],
    ];
    for (const [table, col, id, run] of cases) {
      const before = (await sql(`SELECT version, updated_by FROM ${table} WHERE ${col} = $1`, [id]))[0];
      const e = await rejection(run());
      expect(isLimsError(e, 'common.not_found'), `${table}: ${String(e)}`).toBe(true);
      expect((await sql(`SELECT version, updated_by FROM ${table} WHERE ${col} = $1`, [id]))[0]).toEqual(before);
    }
  });

  it('inserts: a row carrying a foreign tenant_id (or created_by/updated_by/version) is refused and nothing is written', async () => {
    const base = { id: uid(5100), centre_id: CENTRE_A1, order_id: uid(11), patient_id: uid(1), barcode: 'E2600000990', creation_key: 'ck-990',
      specimen_type_code: 'serum', priority: 'routine', patient_sex: 'female', status: 'ordered', ordered_at: new Date().toISOString() };
    for (const extra of [{ tenant_id: B }, { tenant_id: A }, { created_by: uid(1) }, { updated_by: uid(1) }, { version: 7 }]) {
      await rejection(asAdmin(A, (rc) => specimens.insertSpecimen(rc, { ...base, ...extra })));
    }
    expect(await sql('SELECT 1 FROM lab.specimens WHERE barcode = $1', ['E2600000990'])).toEqual([]);
  });
});

describe.skipIf(!live)('T-03 statement hygiene (recorded on the real request path as lims_api)', () => {
  const CALLS: Array<[string, (rc: Rc) => Promise<unknown>, string[]]> = [
    ['getSpecimen', (rc) => specimens.getSpecimen(rc, uid(31)), [uid(31)]],
    ['findSpecimenByBarcode', (rc) => specimens.findSpecimenByBarcode(rc, 'E2600000001'), ['E2600000001']],
    ['listSpecimensByOrder', (rc) => specimens.listSpecimensByOrder(rc, uid(11)), [uid(11)]],
    ['listSpecimensRecent', (rc) => specimens.listSpecimensRecent(rc, { limit: 5 }), []],
    ['listReceiveQueue', (rc) => specimens.listReceiveQueue(rc, { limit: 5 }), []],
    ['listSpecimenTransitions', (rc) => specimens.listSpecimenTransitions(rc, uid(31)), [uid(31)]],
    ['getOrder', (rc) => orders.getOrder(rc, uid(11)), [uid(11)]],
    ['findOrdersByRegistrationNo', (rc) => orders.findOrdersByRegistrationNo(rc, 'R-REG-777'), ['R-REG-777']],
    ['getOrderTest', (rc) => orderTests.getOrderTest(rc, uid(41)), [uid(41)]],
    ['listOrderTestsByOrder', (rc) => orderTests.listOrderTestsByOrder(rc, uid(11)), [uid(11)]],
    ['listWorklist', (rc) => orderTests.listWorklist(rc, { departmentId: uid(103), limit: 20 }), [uid(103)]],
    ['listPending', (rc) => orderTests.listPending(rc, { limit: 20 }), []],
    ['getResult', (rc) => results.getResult(rc, uid(2003)), [uid(2003)]],
    ['listResultsByOrder', (rc) => results.listResultsByOrder(rc, uid(11)), [uid(11)]],
    ['listResultHistory', (rc) => results.listResultHistory(rc, { patientId: uid(1), analyteId: uid(5001), limit: 10 }), [uid(1), uid(5001)]],
    ['listVerificationQueue', (rc) => results.listVerificationQueue(rc, { status: 'resulted', departmentId: uid(103), limit: 10 }), [uid(103)]],
    ['getLabSettings', (rc) => labSettings.getLabSettings(rc), []],
    ['getActiveDeltaRule', (rc) => deltaRules.getActiveDeltaRule(rc, uid(5001)), [uid(5001)]],
    ['updateSpecimen', (rc) => specimens.updateSpecimen(rc, uid(33), 1, { storage_location: 'HYGIENE' }), [uid(33), 'HYGIENE']],
    ['allocateBarcodeSeq', (rc) => barcodeCounters.allocateBarcodeSeq(rc), []],
  ];

  it.each(CALLS)('%s: every statement is lab-qualified, binds tenant_id and the tenant value as a parameter, interpolates no value, never DELETEs', async (_n, call, literals) => {
    const stmts = await asApi(A, async (rc, s) => { await call(rc); return s.map((x) => ({ ...x })); });
    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) {
      expect(s.text, 'explicit tenant column').toMatch(/\btenant_id\b/);
      expect(s.values, 'tenant value bound').toContain(A);
      expect(s.text, 'tenant value not interpolated').not.toContain(A);
      for (const l of literals) expect(s.text, `value ${l} must be a parameter`).not.toContain(l);
      expect(s.text).toMatch(/\blab\.\w+/);
      expect(s.text).not.toMatch(/\bdelete\b/i);
      expect(s.text).not.toMatch(/\b(?:from|join|into|update)\s+(?!lab\.)[a-z_]+\.[a-z_]/i);   // SQL only for schema lab (02-TRD §3.1)
    }
  });

  it('a hostile string argument is data: lookup returns null and the table survives', async () => {
    expect(await asApi(A, (rc) => specimens.findSpecimenByBarcode(rc, SQL_INJECTION))).toBeNull();
    expect(await asApi(A, (rc) => orders.findOrdersByRegistrationNo(rc, SQL_INJECTION))).toEqual([]);
    expect((await sql('SELECT count(*)::int AS n FROM lab.specimens'))[0]?.['n']).toBeGreaterThanOrEqual(4);
  });
});

describe.skipIf(!live)('T-03 index use (05-SCHEMA §5; EXPLAIN on the statements the repositories really send)', () => {
  const EXPECT: Array<[string, string, (rc: Rc) => Promise<unknown>]> = [
    ['barcode lookup', 'specimens__tenant_id_barcode__uq', (rc) => specimens.findSpecimenByBarcode(rc, 'E2600000001')],
    ['registration no lookup', 'orders__tenant_id_registration_no__idx', (rc) => orders.findOrdersByRegistrationNo(rc, 'R-REG-777')],
    ['specimens list sort=-created_at', 'specimens__tenant_id_created__idx', (rc) => specimens.listSpecimensRecent(rc, { limit: 10 })],
    ['specimens of an order', 'specimens__tenant_id_order__idx', (rc) => specimens.listSpecimensByOrder(rc, uid(11))],
    ['receive queue / lab hot set', 'specimens__tenant_id_status__p_idx', (rc) => specimens.listReceiveQueue(rc, { limit: 10 })],
    ['worklist', 'order_tests__tenant_id_worklist__p_idx', (rc) => orderTests.listWorklist(rc, { departmentId: uid(103), limit: 20 })],
    ['pending list', 'order_tests__tenant_id_pending__p_idx', (rc) => orderTests.listPending(rc, { limit: 20 })],
    ['order test grid', 'order_tests__tenant_id_order__idx', (rc) => orderTests.listOrderTestsByOrder(rc, uid(11))],
    ['order result grid', 'results__tenant_id_order__idx', (rc) => results.listResultsByOrder(rc, uid(11))],
    ['previous results / trend (history)', 'results__tenant_id_history__p_idx', (rc) => results.listResultHistory(rc, { patientId: uid(1), analyteId: uid(5001), limit: 10 })],
    ['verification queue', 'results__tenant_id_queue__p_idx', (rc) => results.listVerificationQueue(rc, { status: 'resulted', departmentId: uid(103), limit: 10 })],
    ['active delta rule', 'delta_check_rules__tenant_id_analyte__p_uq', (rc) => deltaRules.getActiveDeltaRule(rc, uid(5001))],
  ];

  // LD-92 (2026-11-11): the named index must be able to serve the statement whatever the planner's tie-break between equal-cost sibling indexes;
  // sibling non-constraint indexes of its table are dropped inside the transaction (DDL is transactional; ROLLBACK restores them).
  async function explainAll(stmts: Stmt[], expectedIndex?: string): Promise<{ indexes: Set<string>; seqScans: string[] }> {
    const indexes = new Set<string>();
    const seqScans: string[] = [];
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');       // tiny tables: make "an index exists and fits the predicate" the only way to avoid a Seq Scan
      await client.query("SET LOCAL search_path = ''");
      if (expectedIndex) {
        const sib = await client.query(
          `SELECT format('%I.%I', n.nspname, c.relname) AS idx
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indexrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE i.indrelid = (SELECT x.indrelid FROM pg_index x JOIN pg_class xc ON xc.oid = x.indexrelid
                                  JOIN pg_namespace xn ON xn.oid = xc.relnamespace
                                 WHERE xc.relname = $1 AND xn.nspname = 'lab')
              AND c.relname <> $1
              AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)`, [expectedIndex]);
        for (const r of sib.rows) await client.query(`DROP INDEX ${r.idx}`);
      }
      for (const s of stmts) {
        const plan = (await client.query(`EXPLAIN (FORMAT JSON) ${s.text}`, s.values)).rows[0]['QUERY PLAN'][0].Plan;
        const walk = (n: any) => {
          if (n['Index Name']) indexes.add(n['Index Name']);
          if (/Seq Scan/.test(n['Node Type']) && n['Schema'] === 'lab') seqScans.push(n['Relation Name']);
          for (const c of n['Plans'] ?? []) walk(c);
        };
        walk(plan);
      }
      await client.query('ROLLBACK');
    } finally { client.release(); }
    return { indexes, seqScans };
  }

  it.each(EXPECT)('%s uses %s and no Seq Scan on a lab table', async (name, index, call) => {
    const stmts = await asApi(A, async (rc, s) => { await call(rc); return s.map((x) => ({ ...x })); });
    const { indexes, seqScans } = await explainAll(stmts, index);
    expect([...indexes], `plan indexes for ${name}: indexes=[${[...indexes].join(', ')}] seqScans=[${seqScans.join(', ')}]`).toContain(index);
    expect(seqScans).toEqual([]);
  });

  it('lookups by primary key (getSpecimen/getOrder/getOrderTest/getResult) and the singletons never Seq Scan', async () => {
    const calls: Array<(rc: Rc) => Promise<unknown>> = [
      (rc) => specimens.getSpecimen(rc, uid(31)), (rc) => orders.getOrder(rc, uid(11)), (rc) => orderTests.getOrderTest(rc, uid(41)),
      (rc) => results.getResult(rc, uid(2003)), (rc) => labSettings.getLabSettings(rc), (rc) => specimens.listSpecimenTransitions(rc, uid(31)),
    ];
    for (const c of calls) {
      const stmts = await asApi(A, async (rc, s) => { await c(rc); return s.map((x) => ({ ...x })); });
      expect((await explainAll(stmts)).seqScans).toEqual([]);
    }
  });
});

describe.skipIf(!live)('T-03 query semantics (oracle = independent admin SQL)', () => {
  it('worklist: the department\'s in_process/resulted/verified tests of this tenant, nothing else', async () => {
    const want = ids(await sql(`SELECT id FROM lab.order_tests WHERE tenant_id = $1 AND department_id = $2 AND status IN ('in_process','resulted','verified')`, [A, uid(103)]));
    expect(want.length).toBeGreaterThan(3);
    const got = ids(await asApi(A, (rc) => orderTests.listWorklist(rc, { departmentId: uid(103), limit: 500 })));
    expect([...got].sort()).toEqual([...want].sort());
  });

  it('worklist honours limit', async () => {
    expect((await asApi(A, (rc) => orderTests.listWorklist(rc, { departmentId: uid(103), limit: 2 }))).length).toBe(2);
  });

  it('pending: the pending statuses of this tenant ordered by ordered_at ASC, limit honoured', async () => {
    const want = (await sql(`SELECT count(*)::int AS n FROM lab.order_tests WHERE tenant_id = $1 AND status IN ('awaiting_collection','awaiting_receipt','in_process','resulted','verified')`, [A]))[0]?.['n'];
    const all = await asApi(A, (rc) => orderTests.listPending(rc, { limit: 1000 }));
    expect(all.length).toBe(want);
    const at = all.map((r) => new Date(r['ordered_at']).getTime());
    expect(at).toEqual([...at].sort((x, y) => x - y));
    expect((await asApi(A, (rc) => orderTests.listPending(rc, { limit: 3 }))).length).toBe(3);
  });

  it('history: approved results of the patient+analyte, newest approval first (fixture: i = 120, 240, 360 hours ago)', async () => {
    const got = await asApi(A, (rc) => results.listResultHistory(rc, { patientId: uid(1), analyteId: uid(5001), limit: 10 }));
    expect(ids(got)).toEqual([uid(2120), uid(2240), uid(2360)]);
    expect(got.every((r) => r['status'] === 'approved')).toBe(true);
    expect(ids(await asApi(A, (rc) => results.listResultHistory(rc, { patientId: uid(1), analyteId: uid(5001), limit: 2 })))).toEqual([uid(2120), uid(2240)]);
  });

  it('verification queue: resulted results of the department, none approved/pending', async () => {
    const want = ids(await sql(`SELECT id FROM lab.results WHERE tenant_id = $1 AND status = 'resulted' AND department_id = $2`, [A, uid(103)]));
    expect(want.length).toBeGreaterThan(0);
    const got = await asApi(A, (rc) => results.listVerificationQueue(rc, { status: 'resulted', departmentId: uid(103), limit: 500 }));
    expect(ids(got).sort()).toEqual([...want].sort());
  });

  it('recent specimens are created_at DESC; receive queue holds only the received..verified statuses', async () => {
    expect(ids(await asApi(A, (rc) => specimens.listSpecimensRecent(rc, { limit: 10 })))).toEqual([uid(33), uid(32), uid(31)]);
    const q = await asApi(A, (rc) => specimens.listReceiveQueue(rc, { limit: 10 }));
    expect(ids(q)).toEqual([uid(31)]);
  });

  it('lookups: barcode, registration no, by order', async () => {
    expect((await asApi(A, (rc) => specimens.findSpecimenByBarcode(rc, 'E2600000002')))?.['id']).toBe(uid(32));
    expect(await asApi(A, (rc) => specimens.findSpecimenByBarcode(rc, 'E2699999999'))).toBeNull();
    expect(ids(await asApi(A, (rc) => orders.findOrdersByRegistrationNo(rc, 'R-REG-777')))).toEqual([uid(14)]);
    expect(ids(await asApi(A, (rc) => specimens.listSpecimensByOrder(rc, uid(11)))).sort()).toEqual([uid(31), uid(32)]);
  });

  it('settings and delta rule: own rows; no active rule for an unknown analyte', async () => {
    const s = await asApi(A, (rc) => labSettings.getLabSettings(rc));
    expect(s?.['version']).toBe(1);
    const r = await asApi(A, (rc) => deltaRules.getActiveDeltaRule(rc, uid(5001)));
    expect(r?.['effective_to']).toBeNull();
    expect(await asApi(A, (rc) => deltaRules.getActiveDeltaRule(rc, uid(5999)))).toBeNull();
  });
});

describe.skipIf(!live)('T-03 inserts and the append-only transition record', () => {
  it('insertSpecimen: tenant and actor come from the ctx, version starts at 1, row is readable back', async () => {
    const row = await asApi(A, (rc) => specimens.insertSpecimen(rc, { id: uid(5101), centre_id: CENTRE_A1, order_id: uid(14), patient_id: uid(1), barcode: 'E2600000101', creation_key: 'ck-101',
      specimen_type_code: 'serum', priority: 'routine', patient_sex: 'female', status: 'ordered', ordered_at: new Date().toISOString() }));
    expect(row).toMatchObject({ id: uid(5101), tenant_id: A, version: 1, created_by: SYS, updated_by: SYS, barcode: 'E2600000101' });
    expect((await asApi(A, (rc) => specimens.findSpecimenByBarcode(rc, 'E2600000101')))?.['id']).toBe(uid(5101));
    expect(await asApi(B, (rc) => specimens.findSpecimenByBarcode(rc, 'E2600000101'))).toBeNull();
  });

  it('insertSpecimenTransition + listSpecimenTransitions: ordered by occurred_at, tenant scoped', async () => {
    const t = (n: number, code: string, from: string | null, to: string, at: string) => ({ id: uid(5200 + n), centre_id: CENTRE_A1, specimen_id: uid(33), transition_code: code,
      from_status: from, to_status: to, specimen_version: n, occurred_at: at, actor_type: 'user', actor_id: SYS });
    await asApi(A, (rc) => specimens.insertSpecimenTransition(rc, t(2, 'S3', 'collected', 'in_transit', '2026-11-07T10:05:00Z')));
    await asApi(A, (rc) => specimens.insertSpecimenTransition(rc, t(1, 'S2', 'ordered', 'collected', '2026-11-07T10:00:00Z')));
    const got = await asApi(A, (rc) => specimens.listSpecimenTransitions(rc, uid(33)));
    expect(got.map((r) => r['transition_code'])).toEqual(['S2', 'S3']);
    expect(got.every((r) => r['tenant_id'] === A)).toBe(true);
    expect(await asApi(B, (rc) => specimens.listSpecimenTransitions(rc, uid(33)))).toEqual([]);
  });
});

describe.skipIf(!live)('T-03 optimistic version updates', () => {
  // table-driven: [label, table, key SQL, id/key value, update(rc, expectedVersion, patch), patch column]
  const CASES: Array<[string, string, string, unknown[], (rc: Rc, v: number, p: Row) => Promise<Row>, Row]> = [
    ['specimens', 'lab.specimens', 'id = $2', [uid(32)], (rc, v, p) => specimens.updateSpecimen(rc, uid(32), v, p), { storage_location: 'FRIDGE-1' }],
    ['orders', 'lab.orders', 'id = $2', [uid(12)], (rc, v, p) => orders.updateOrder(rc, uid(12), v, p), { items_version: 2 }],
    ['order_tests', 'lab.order_tests', 'id = $2', [uid(1001)], (rc, v, p) => orderTests.updateOrderTest(rc, uid(1001), v, p), { tat_target_seconds: 7200 }],
    ['results (pending)', 'lab.results', 'id = $2', [uid(2002)], (rc, v, p) => results.updateResult(rc, uid(2002), v, p), { comment_text: 'checked' }],
    ['lab_settings', 'lab.lab_settings', 'true', [], (rc, v, p) => labSettings.updateLabSettings(rc, v, p), { label_copies_default: 2 }],
    ['delta_check_rules', 'lab.delta_check_rules', 'id = $2', [uid(8001)], (rc, v, p) => deltaRules.updateDeltaRule(rc, uid(8001), v, p), { pct_threshold: 25 }],
  ];
  const current = async (table: string, where: string, extra: unknown[]) => (await sql(`SELECT * FROM ${table} WHERE tenant_id = $1 AND ${where}`, [A, ...extra]))[0]!;

  it.each(CASES)('%s: matching version -> patch applied, version+1, updated_by = actor, updated_at moves', async (_l, table, where, extra, update, patch) => {
    const before = await current(table, where, extra);
    const out = await asApi(A, (rc) => update(rc, before['version'], patch));
    expect(out['version']).toBe(before['version'] + 1);
    for (const [k, v] of Object.entries(patch)) expect(String(out[k])).toBe(String(v));       // numeric columns arrive as strings
    const after = await current(table, where, extra);
    expect(after['version']).toBe(before['version'] + 1);
    expect(after['updated_by']).toBe(SYS);
    expect(new Date(after['updated_at']).getTime()).toBeGreaterThanOrEqual(new Date(before['updated_at']).getTime());
    for (const [k, v] of Object.entries(patch)) expect(String(after[k])).toBe(String(v));
  });

  it.each(CASES)('%s: stale version -> common.version_conflict and the row is unchanged', async (_l, table, where, extra, update, patch) => {
    const before = await current(table, where, extra);
    const e = await rejection(asApi(A, (rc) => update(rc, before['version'] - 1, { ...patch })));
    expect(isLimsError(e, 'common.version_conflict'), String(e)).toBe(true);
    expect(await current(table, where, extra)).toEqual(before);
  });

  it('unknown id -> common.not_found (not a conflict)', async () => {
    const e = await rejection(asApi(A, (rc) => specimens.updateSpecimen(rc, uid(99999), 1, { storage_location: 'X' })));
    expect(isLimsError(e, 'common.not_found'), String(e)).toBe(true);
  });

  it('two writers with the same expected version: exactly one wins, the other gets version_conflict (no lost update)', async () => {
    const v = (await current('lab.specimens', 'id = $2', [uid(33)]))['version'];
    const w = (loc: string) => asApi(A, (rc) => specimens.updateSpecimen(rc, uid(33), v, { storage_location: loc }));
    const out = await Promise.allSettled([w('RACE-1'), w('RACE-2')]);
    expect(out.filter((o) => o.status === 'fulfilled').length).toBe(1);
    const lost = out.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(isLimsError(lost.reason, 'common.version_conflict'), String(lost.reason)).toBe(true);
    const after = await current('lab.specimens', 'id = $2', [uid(33)]);
    expect(after['version']).toBe(v + 1);
    expect(['RACE-1', 'RACE-2']).toContain(after['storage_location']);
  });

  it('a patch may only name mutable columns of the table: tenant_id, id, version, created_*, updated_*, unknown and SQL-looking keys are refused, nothing written', async () => {
    const before = await current('lab.specimens', 'id = $2', [uid(32)]);
    const bad: Row[] = [{ tenant_id: B }, { id: uid(7) }, { version: 99 }, { created_by: uid(1) }, { updated_by: uid(1) }, { barcode: 'E2600000777' },
      { no_such_column: 1 }, { [`storage_location = 'x', tenant_id`]: 'y' }, { 'storage_location"; DROP TABLE lab.specimens; --': 'z' }];
    for (const patch of bad) await rejection(asApi(A, (rc) => specimens.updateSpecimen(rc, uid(32), before['version'], patch)));
    expect(await current('lab.specimens', 'id = $2', [uid(32)])).toEqual(before);
    expect((await sql(`SELECT count(*)::int AS n FROM lab.specimens WHERE barcode = 'E2600000777'`))[0]?.['n']).toBe(0);
  });

  it('a patch value is data: a hostile string is stored verbatim', async () => {
    const v = (await current('lab.specimens', 'id = $2', [uid(32)]))['version'];
    await asApi(A, (rc) => specimens.updateSpecimen(rc, uid(32), v, { storage_location: SQL_INJECTION }));
    expect((await current('lab.specimens', 'id = $2', [uid(32)]))['storage_location']).toBe(SQL_INJECTION);
  });

  it('a DB-level rejection (frozen/invalid) surfaces as an error and the version does not move', async () => {
    const before = await current('lab.specimens', 'id = $2', [uid(31)]);
    await rejection(asApi(A, (rc) => specimens.updateSpecimen(rc, uid(31), before['version'], { status: 'not_a_status' })));      // specimens__status__ck
    expect(await current('lab.specimens', 'id = $2', [uid(31)])).toEqual(before);
  });
});

describe.skipIf(!live)('T-03 barcode counter allocation (atomic last_value + 1; tenant scoped)', () => {
  it('increments by exactly 1 per call from the tenant\'s own counter; first use (no row) starts at 1; the other tenant is untouched', async () => {
    const a0 = Number((await sql('SELECT last_value FROM lab.barcode_counters WHERE tenant_id = $1', [A]))[0]?.['last_value']);
    expect((await sql('SELECT 1 FROM lab.barcode_counters WHERE tenant_id = $1', [B])).length).toBe(0);
    const a1 = Number(await asApi(A, (rc) => barcodeCounters.allocateBarcodeSeq(rc)));
    const a2 = Number(await asApi(A, (rc) => barcodeCounters.allocateBarcodeSeq(rc)));
    expect([a1, a2]).toEqual([a0 + 1, a0 + 2]);
    expect(Number(await asApi(B, (rc) => barcodeCounters.allocateBarcodeSeq(rc)))).toBe(1);
    expect(Number(await asApi(B, (rc) => barcodeCounters.allocateBarcodeSeq(rc)))).toBe(2);
    expect(Number((await sql('SELECT last_value FROM lab.barcode_counters WHERE tenant_id = $1', [A]))[0]?.['last_value'])).toBe(a0 + 2);
  });

  it('concurrent allocations in separate transactions never repeat a value', async () => {
    const got = await Promise.all(Array.from({ length: 8 }, () => asApi(A, (rc) => barcodeCounters.allocateBarcodeSeq(rc))));
    const n = got.map(Number);
    expect(new Set(n).size).toBe(8);
  });
});
