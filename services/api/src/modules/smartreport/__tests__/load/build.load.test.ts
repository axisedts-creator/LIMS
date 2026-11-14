// C14 T25 — load: buildSummary p95 at 1x and 10x seed, two tenants (06-PLAN row T25; 02-TRD §11; 07-SECURITY row 025; risk R9 storage).
// done_when: p95 <= 300 ms new build, <= 120 ms cached. Real service + engine over the T12 repository/port emulators with VIRTUAL latency (see load.helpers.ts header).
// Seed: 1x = 500 summaries per tenant (02-TRD §11: 500 orders/lab/day), 10x = 5,000 per tenant; two tenants (A, B) so isolation is exercised under load.
// Worst-case order: 40 results over 40 distinct tests (getTest x 40 at 2 ms), trend history on, library follow-up rule absent.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../repository/summaries.repo.js', async () => (await import('./load.helpers.js')).latent.summaries);
vi.mock('../../repository/bindings.repo.js', async () => (await import('./load.helpers.js')).latent.bindings);
vi.mock('../../repository/library.repo.js', async () => (await import('./load.helpers.js')).latent.library);
vi.mock('../../repository/blocks.repo.js', async () => (await import('./load.helpers.js')).latent.blocks);
vi.mock('../../repository/rules.repo.js', async () => (await import('./load.helpers.js')).latent.rules);
vi.mock('../../repository/mappings.repo.js', async () => (await import('./load.helpers.js')).latent.mappings);
vi.mock('../../repository/groups.repo.js', async () => (await import('./load.helpers.js')).latent.groups);
vi.mock('../../repository/codedSets.repo.js', async () => (await import('./load.helpers.js')).latent.codedSets);

import { buildOrGet } from '../../summary.service.js';
import { loadLibrary, reid } from '../t11.fakes.js';
import {
  AN, TA, TB, VER, ac081, amend, approveLibrary, enableTrend, libOf, lib, makeCtx, portCallsOf, result, run, seed, setResults, uid, w, withRange,
} from '../t12.fakes.js';
import { fmt, latentPorts, pct, sim, timed } from './load.helpers.js';

type Row = Record<string, any>;
const KEYS = ['HGB', 'WBC', 'PLT', 'ALT', 'AST', 'CREAT'] as const;
const NEW_PER_TENANT = 50, SENS_PER_TENANT = 5;
const BUDGET = { newBuild: 300, cached: 120 };
const BASE = { a: 0x200000, b: 0x300000 };

/** 40 approved results over 40 distinct tests (TRD §11 worst case k = 40); HGB carries a range so trend history is requested. */
const worstCase = (): Row[] => Array.from({ length: 40 }, (_, i) => {
  const key = KEYS[i % 6]!;
  const r = result(100 + i, key, i % 7 === 0 ? 'L' : 'N', { testId: uid(0xe000 + i) });
  return key === 'HGB' ? withRange(r) : r;
});

function addOrders(tenant: 'A' | 'B', from: number, n: number): string[] {
  const tenantId = tenant === 'A' ? TA : TB;
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const orderId = uid((tenant === 'A' ? BASE.a : BASE.b) + from + i);
    w.orders.push({ tenantId, orderId, patientId: uid(0x400000 + from + i + (tenant === 'A' ? 0 : 0x10000)), centreId: uid(tenant === 'A' ? 0xa201 : 0xb201) });
    setResults(orderId, worstCase());
    ids.push(orderId);
  }
  return ids;
}

/** Fresh world with an approved library per tenant, the 40 catalog tests, trend on, and `perTenant` seeded summaries per tenant. */
function seedWorld(perTenant: number): { typicalBytes: number } {
  seed(); approveLibrary(1);
  loadLibrary(TB, VER(90), reid(libOf(), 90), { groups: true, status: 'approved', version_no: 1, content_sha256: createHash('sha256').update('vB').digest('hex'),
    approved_at: new Date('2026-11-01T00:00:00.000Z'), approved_by_membership_id: uid(0x7501) });
  enableTrend('HGB');
  for (const v of lib.versions) v.trend_enabled = true;
  for (const t of [TA, TB]) for (let i = 0; i < 40; i++) {
    w.tests.set(`${t}:${uid(0xe000 + i)}`, { id: uid(0xe000 + i), code: `T${i}`, name: `Test ${i}`, isActive: true, departmentId: uid(0xd001), departmentCode: 'LAB', specimenTypeCodes: ['BLOOD'],
      workflowType: 'standard', revision: 1, analytes: KEYS.map((k, j) => ({ id: AN[k], code: k, name: k, resultType: 'numeric', reportable: true, sortOrder: (j + 1) * 10 })) });
  }
  return { typicalBytes: 0 };
}

/** Bulk-seeds `n` summary rows per tenant by cloning a really built one (fast; unique order ids; mixed statuses). */
async function seedSummaries(perTenant: number): Promise<number> {
  // one real build of the typical AC-08.1 order (6 results) = the storage measurement for R9
  const typicalOrder = uid(0x100001);
  w.orders.push({ tenantId: TA, orderId: typicalOrder, patientId: uid(0x100002), centreId: uid(0xa201) });
  setResults(typicalOrder, ac081());
  const ctx = makeCtx('A');
  const { summary } = await run(ctx, () => buildOrGet(ctx, { orderId: typicalOrder }));
  const bytes = Buffer.byteLength(JSON.stringify(summary.content));
  const statuses = ['draft', 'draft', 'draft', 'draft', 'draft', 'draft', 'draft', 'approved', 'approved', 'superseded'];
  for (const [tenantId, base] of [[TA, 0x500000], [TB, 0x600000]] as const) {
    for (let i = 0; i < perTenant; i++) {
      const status = statuses[i % 10]!;
      w.summaries.push({ ...structuredClone(summary), id: uid(base + i), tenant_id: tenantId, order_id: uid(base + 0x80000 + i), status,
        approved_set_hash: createHash('sha256').update(`${tenantId}:${i}`).digest('hex'), library_version_id: tenantId === TA ? VER(1) : VER(90),
        built_at: new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString(), superseded_at: status === 'superseded' ? '2026-11-02T00:00:00.000Z' : null });
    }
  }
  w.summaries = w.summaries.filter((s) => s.order_id !== typicalOrder);        // the probe build is not part of the seed
  return bytes;
}

const ctxFor = (tenant: 'A' | 'B') => latentPorts(makeCtx(tenant));
const buildTimed = (tenant: 'A' | 'B', orderId: string, extra: Row = {}): Promise<number> => {
  const ctx = ctxFor(tenant);
  return timed(() => run(ctx, () => buildOrGet(ctx, { orderId, reportVersionNo: 1, ...extra } as any)));
};

describe.each([[1, 500], [10, 5000]] as const)('C14-T25 build load — %dx seed (%d summaries per tenant, tenants A + B)', (x, perTenant) => {
  let typicalBytes = 0;
  let newA: string[] = [], newB: string[] = [], sensA: string[] = [], sensB: string[] = [];
  const timedNew: number[] = [], timedCached: number[] = [], timedSuper: number[] = [];

  beforeAll(async () => {
    seedWorld(perTenant);
    typicalBytes = await seedSummaries(perTenant);
    newA = addOrders('A', 0, NEW_PER_TENANT); newB = addOrders('B', 0, NEW_PER_TENANT);
    sensA = addOrders('A', 1000, SENS_PER_TENANT); sensB = addOrders('B', 1000, SENS_PER_TENANT);
    sim.scale = 1;
    w.calls = []; w.portCalls = []; w.writes = [];                              // measure from a clean log
  }, 300000);
  afterAll(() => { sim.scale = 1; });

  it('seed is in place: two tenants, 1x/10x row counts, nothing live for the timed orders', () => {
    expect(w.summaries.filter((s) => s.tenant_id === TA)).toHaveLength(perTenant);
    expect(w.summaries.filter((s) => s.tenant_id === TB)).toHaveLength(perTenant);
    expect(w.summaries.some((s) => newA.includes(s.order_id) || newB.includes(s.order_id))).toBe(false);
  });

  it('NEW build (worst case: 40 tests, trend history): p95 <= 300 ms  [done_when]', async () => {
    for (let i = 0; i < NEW_PER_TENANT; i++) for (const [t, ids] of [['A', newA], ['B', newB]] as const) {
      const before = w.summaries.length;
      timedNew.push(await buildTimed(t, ids[i]!));
      expect(w.summaries.length).toBe(before + 1);                              // really built, not served from cache
    }
    console.log(`[T25 ${x}x] new build   ${fmt(timedNew)}  (budget p95 <= ${BUDGET.newBuild})`);
    expect(pct(timedNew, 0.95)).toBeLessThanOrEqual(BUDGET.newBuild);
  }, 300000);

  it('a new build makes exactly one getOrderSummary + one getOrderResults, <= 40 getTest (one per distinct test), <= 1 getAnalyteHistory (no N+1)', async () => {
    const p0 = w.portCalls.length;
    await buildTimed('A', sensA[0]!);
    const calls = w.portCalls.slice(p0).map((c) => c.fn);
    const n = (fn: string) => calls.filter((c) => c === fn).length;
    expect(n('getOrderSummary')).toBe(1);
    expect(n('getOrderResults')).toBe(1);
    expect(n('getTest')).toBeLessThanOrEqual(40);
    expect(n('getAnalyteHistory')).toBeLessThanOrEqual(1);
  });

  it('CACHED build (live summary, same approved set): p95 <= 120 ms, no insert, no catalog/history calls  [done_when]', async () => {
    const tests0 = portCallsOf('getTest').length, hist0 = portCallsOf('getAnalyteHistory').length, w0 = w.writes.length, rows0 = w.summaries.length;
    for (let i = 0; i < NEW_PER_TENANT; i++) for (const [t, ids] of [['A', newA], ['B', newB]] as const) timedCached.push(await buildTimed(t, ids[i]!));
    console.log(`[T25 ${x}x] cached      ${fmt(timedCached)}  (budget p95 <= ${BUDGET.cached})`);
    expect(pct(timedCached, 0.95)).toBeLessThanOrEqual(BUDGET.cached);
    expect(portCallsOf('getTest').length).toBe(tests0);
    expect(portCallsOf('getAnalyteHistory').length).toBe(hist0);
    expect(w.summaries.length).toBe(rows0);
    expect(w.writes.slice(w0).filter((n) => n !== 'insertBinding')).toEqual([]);   // only the idempotent binding write
  }, 300000);

  it('REBUILD after an amendment (supersede + successor + S6): p95 <= 300 ms', async () => {
    for (let i = 0; i < NEW_PER_TENANT; i++) for (const [t, ids] of [['A', newA], ['B', newB]] as const) {
      amend(ids[i]!, w.results.get(ids[i]!)![0]!.resultId);
      timedSuper.push(await buildTimed(t, ids[i]!));
    }
    console.log(`[T25 ${x}x] supersede   ${fmt(timedSuper)}  (budget p95 <= ${BUDGET.newBuild})`);
    expect(pct(timedSuper, 0.95)).toBeLessThanOrEqual(BUDGET.newBuild);
    expect(w.summaries.filter((s) => newA.includes(s.order_id) && s.status === 'superseded')).toHaveLength(NEW_PER_TENANT);
  }, 300000);

  it('harness sensitivity: the same builds with every call 3x slower must FAIL the 300 ms budget (the check is not vacuous)', async () => {
    sim.scale = 3;
    const slow: number[] = [];
    for (let i = 0; i < SENS_PER_TENANT; i++) for (const [t, ids] of [['A', sensA], ['B', sensB]] as const) if (i > 0 || t === 'B') slow.push(await buildTimed(t, ids[i]!));
    sim.scale = 1;
    expect(pct(slow, 0.95)).toBeGreaterThan(BUDGET.newBuild);
  });

  it('storage (R9): typical AC-08.1 summary content <= 10 KB (02-TRD §11 assumption 5-10 KB)', () => {
    console.log(`[T25 ${x}x] typical content ${typicalBytes} bytes`);
    expect(typicalBytes).toBeGreaterThan(0);
    expect(typicalBytes).toBeLessThanOrEqual(10 * 1024);
  });

  it('tenant isolation under load: every port/repo call carries the tenant of the order it served; no row crossed tenants', () => {
    const tenantOfOrder = new Map(w.orders.map((o) => [o.orderId as string, o.tenantId as string]));
    const bad = portCallsOf('getOrderResults').concat(portCallsOf('getOrderSummary')).filter((c) => tenantOfOrder.get(c.input.orderId) !== c.tenantId);
    expect(bad).toEqual([]);
    for (const s of w.summaries) if (tenantOfOrder.has(s.order_id)) expect(s.tenant_id).toBe(tenantOfOrder.get(s.order_id));
    const repoCalls = w.calls.filter((c) => c.tenantId !== undefined);
    expect(repoCalls.length).toBeGreaterThan(0);
    expect(new Set(repoCalls.map((c) => c.tenantId))).toEqual(new Set([TA, TB]));
  });
});
