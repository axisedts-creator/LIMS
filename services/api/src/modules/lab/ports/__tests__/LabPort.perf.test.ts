// C5 T-24 — performance of the LabPort host query (AC-20.2: getPendingTestsForBarcode p95 <= 300 ms at reference load, warm code-map cache, 20 analytes; 02-TRD §10; 07-SECURITY REQ-SEC-025:
// host query measured at 1x and 10x seed across two tenants) and the worklist page (02-TRD §10: p95 <= 300 ms for a page of 50) on the REAL impl over real PG17 under RLS.
// Reference load: 1x = 300 received specimens (+ 150 in tenant B), each with one order test and 20 pending results, 10% of the specimens already approved; 10x = 3000 (+1500).
// The measured call includes the transaction round-trips of the harness (BEGIN, claims, COMMIT) but not the event spy. Needs the database of tests/db/c5-t03/run.sh.
// Rows are written by the superuser with session_replication_role = replica (no audit trigger / FK cost, so 60k rows seed in seconds); the frontdesk parents are therefore absent, the impl must not need them.
// Fails now: ../LabPort.impl.ts does not exist.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { admin, asAdmin, BRANCH, cleanup, closePools, live, MEMBERSHIP, PERF_NS, requireDb, SYS, TENANT } from './harness.js';
import { realLabPortHarness, type RealHarness } from './labPort.harness.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
afterAll(async () => { if (live) await cleanup(PERF_NS); await closePools(); });

const PCEN = { A: '01900000-0000-7000-8000-d00000000001', B: '01900000-0000-7000-8000-d00000000002' };
const PINS = '01900000-0000-7000-8000-d00000000003';
const PPAT = { A: '01900000-0000-7000-8000-d00000000004', B: '01900000-0000-7000-8000-d00000000005' };
const DEPT = '01900000-0000-7000-8000-d00000000006';
const TEST = '01900000-0000-7000-8000-d00000000007';
const ANALYTES = Array.from({ length: 20 }, (_, i) => `01900000-0000-7000-8000-d1000000${(i + 1).toString(16).padStart(4, '0')}`);
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * 0.95) - 1)]!;

describe('T-24 perf harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => { if (requireDb) expect(live).toBe(true); });
});

/** set-based seed of `count` received specimens of tenant `t`, each: 1 order, 1 specimen, 1 order test, 20 results (every 10th specimen: approved) */
async function seedLoad(t: 'A' | 'B', count: number): Promise<void> {
  await asAdmin(async (c) => {
    await c.query(`CREATE OR REPLACE FUNCTION pg_temp.pid(kind int, n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('01900000-0000-7000-8000-d' || lpad(kind::text, 3, '0') || lpad(n::text, 8, '0'))::uuid $$`);
    const P = [TENANT[t], PCEN[t], BRANCH[t], PPAT[t], SYS, t === 'A' ? 0 : 100000, count];   // $1 tenant, $2 centre, $3 branch, $4 patient, $5 actor, $6 id base, $7 count
    await c.query(`INSERT INTO lab.orders (id, tenant_id, centre_id, branch_id, patient_id, registration_no, visit_type, priority, source, registered_at, patient_sex, patient_age_days, last_order_seq, created_by, updated_by)
      SELECT pg_temp.pid(10, $6::int + n), $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'R-PERF-' || ($6::int + n), 'opd', 'routine', 'front_desk', now(), 'female', 12000, 1, $5::uuid, $5::uuid
      FROM generate_series(1, $7::int) n`, P);
    await c.query(`INSERT INTO lab.specimens (id, tenant_id, centre_id, processing_centre_id, processing_branch_id, order_id, patient_id, barcode, creation_key, specimen_type_code, priority, patient_sex, patient_age_days, status, ordered_at, received_at, created_by, updated_by)
      SELECT pg_temp.pid(11, $6::int + n), $1::uuid, $2::uuid, $2::uuid, $3::uuid, pg_temp.pid(10, $6::int + n), $4::uuid, 'PF' || $8::text || lpad(($6::int + n)::text, 7, '0'), 'ck-perf-' || $8::text || ($6::int + n), 'BLOOD', 'routine', 'female', 12000,
             CASE WHEN n % 10 = 0 THEN 'approved' ELSE 'received' END, now(), now() - interval '1 hour', $5::uuid, $5::uuid
      FROM generate_series(1, $7::int) n`, [...P, t]);
    await c.query(`INSERT INTO lab.order_tests (id, tenant_id, centre_id, processing_centre_id, processing_branch_id, order_id, order_item_id, test_id, test_code, test_revision, catalog_revision, department_id, workflow_type, priority,
        specimen_id, status, ordered_at, received_at, created_by, updated_by)
      SELECT pg_temp.pid(12, $6::int + n), $1::uuid, $2::uuid, $2::uuid, $3::uuid, pg_temp.pid(10, $6::int + n), pg_temp.pid(13, $6::int + n), $8::uuid, 'PERF', 1, 1, $9::uuid, 'standard', 'routine', pg_temp.pid(11, $6::int + n),
             CASE WHEN n % 10 = 0 THEN 'approved' ELSE 'in_process' END, now(), now() - interval '1 hour', $5::uuid, $5::uuid
      FROM generate_series(1, $7::int) n WHERE $4::uuid IS NOT NULL`, [...P, TEST, DEPT]);
    await c.query(`INSERT INTO lab.results (id, tenant_id, centre_id, processing_centre_id, processing_branch_id, order_id, order_item_id, order_test_id, specimen_id, patient_id, test_id, analyte_id, analyte_code, department_id,
        is_reportable, result_type, status, origin, value_numeric, resulted_at, first_resulted_at, approved_at, approved_by_membership_id, created_by, updated_by)
      SELECT pg_temp.pid(14 + a.k, $6::int + n), $1::uuid, $2::uuid, $2::uuid, $3::uuid, pg_temp.pid(10, $6::int + n), pg_temp.pid(13, $6::int + n), pg_temp.pid(12, $6::int + n), pg_temp.pid(11, $6::int + n), $4::uuid, $8::uuid,
             ($10::uuid[])[a.k + 1], 'A' || a.k, $9::uuid, true, 'numeric', CASE WHEN n % 10 = 0 THEN 'approved' ELSE 'pending' END, CASE WHEN n % 10 = 0 THEN 'manual' END, CASE WHEN n % 10 = 0 THEN 5.0 END,
             CASE WHEN n % 10 = 0 THEN now() END, CASE WHEN n % 10 = 0 THEN now() END, CASE WHEN n % 10 = 0 THEN now() END, CASE WHEN n % 10 = 0 THEN $11::uuid END, $5::uuid, $5::uuid
      FROM generate_series(1, $7::int) n CROSS JOIN generate_series(0, 19) AS a(k)`, [...P, TEST, DEPT, ANALYTES, MEMBERSHIP[t]]);
  }, true);
}

describe.skipIf(!live).each([1, 10])('host query + worklist at %ix seed', (mult) => {
  let h: RealHarness;
  const N = 300 * mult;
  beforeAll(async () => {
    await cleanup(PERF_NS);
    await seedLoad('A', N);
    await seedLoad('B', N / 2);
    await admin().query('ANALYZE lab.orders; ANALYZE lab.specimens; ANALYZE lab.order_tests; ANALYZE lab.results');
    h = await realLabPortHarness()();
    h.world.mappings.push(...ANALYTES.map((analyteId, i) => ({ id: `01900000-0000-7000-8000-d2000000${i.toString(16).padStart(4, '0')}`, tenantId: TENANT.A, instrumentId: PINS, instrumentCode: `P${i}`, analyteId, testId: TEST })));
  }, 600_000);

  const device = () => h.deviceAt(h.ctxFor('A:device'), PCEN.A);
  const barcodeOf = (n: number) => `PFA${n.toString().padStart(7, '0')}`;

  it(`AC-20.2: getPendingTestsForBarcode p95 <= 300 ms (100 calls over ${N} specimens, 20 analytes each, warm cache); every answer lists the 20 mapped analytes`, async () => {
    for (let i = 1; i <= 9; i++) await h.call('getPendingTestsForBarcode', device(), { instrumentId: PINS, barcode: barcodeOf(i) }, { spy: false });   // warm-up (code-map cache, plans)
    const ms: number[] = [];
    let x = 12345;
    while (ms.length < 100) {   // <= 100 distinct specimens are picked up (S6 moves them out of the worklist); the worklist test below still has >= 100 received rows at 1x
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      const n = (x % N) + 1;
      if (n % 10 === 0) continue;                                            // approved specimens carry no pending work
      const t0 = performance.now();
      const r = await h.call('getPendingTestsForBarcode', device(), { instrumentId: PINS, barcode: barcodeOf(n) }, { spy: false });
      ms.push(performance.now() - t0);
      expect(r.tests).toHaveLength(1);
      expect(r.tests[0].analyteIds).toHaveLength(20);
    }
    console.info(`T-24 perf ${mult}x host query: p50 ${[...ms].sort((a, b) => a - b)[50]!.toFixed(1)} ms, p95 ${p95(ms).toFixed(1)} ms, max ${Math.max(...ms).toFixed(1)} ms`);
    expect(p95(ms)).toBeLessThanOrEqual(300);
  });

  it('worklist: listPendingForInstrument page of 50 p95 <= 300 ms (first page and a cursor page), 50 rows each', async () => {
    const ms: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      const first = await h.call('listPendingForInstrument', device(), { instrumentId: PINS, limit: 50 }, { spy: false });
      ms.push(performance.now() - t0);
      expect(first.items).toHaveLength(50);
      expect(first.nextCursor).toBeTruthy();
      if (i % 3 === 0) {
        const t1 = performance.now();
        const second = await h.call('listPendingForInstrument', device(), { instrumentId: PINS, limit: 50, cursor: first.nextCursor }, { spy: false });
        ms.push(performance.now() - t1);
        expect(second.items).toHaveLength(50);
        const firstIds = new Set(first.items.map((s: any) => s.specimenId));
        expect(second.items.some((s: any) => firstIds.has(s.specimenId))).toBe(false);
      }
    }
    console.info(`T-24 perf ${mult}x worklist page: p95 ${p95(ms).toFixed(1)} ms`);
    expect(p95(ms)).toBeLessThanOrEqual(300);
  });

  it('tenant B load does not leak into the answers: a tenant-B barcode asked in tenant A is lab.specimen_not_found', async () => {
    let c: string | undefined;
    try { await h.call('getPendingTestsForBarcode', device(), { instrumentId: PINS, barcode: 'PFB' + String(100001).padStart(7, '0') }, { spy: false }); } catch (e: any) { c = e.code; }
    expect(c).toBe('lab.specimen_not_found');
  });
});
