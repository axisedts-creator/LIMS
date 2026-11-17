// T-37 (C3) — 02-TRD §12 targets for ordinary API calls, in-process over the masters SQL fake (RLS, row locks, real createEvents + revision.service):
//   "Other reads p95 <= 200 ms", "Writes p95 (incl. revision lock + outbox) <= 300 ms", "Revision lock hold time <= 50 ms per write tx" (all [CONV]).
// Tested at 1x and 10x of a master table size (100 / 1,000 departments per tenant: the §12 sizes bound orderables/prices, masters are far smaller, so 10x is generous).
// The fake bounds algorithmic cost and round trips (not Postgres); real-DB p95 comes from the k6-style compose run [PIN-C0].
// A write's lock hold is bounded by the wall time of the whole write transaction (the revision row is locked inside it and released at COMMIT).
import { describe, expect, it } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { createMastersService } from '../../service/masters.service.js';
import { ROOT_A, TENANT_A, TENANT_B } from '../helpers/catalogDb.js';
import { dept, makeMastersDb } from '../helpers/mastersDb.js';

type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

describe.each([[1, 100], [10, 1_000]])('masters reads/writes at %ix (%i departments per tenant + the same again for another tenant)', (_factor, count) => {
  function setup() {
    const rows = {
      departments: [
        ...Array.from({ length: count }, (_v, i) => dept(i + 1, TENANT_A, { code: `D${i}` })),
        ...Array.from({ length: count }, (_v, i) => dept(count + i + 1, TENANT_B, { code: `D${i}` })),
      ],
    };
    const db = makeMastersDb({ rows, catalog: { state: { [TENANT_A]: { rootId: ROOT_A, revision: 1 } } } });
    const svc = createMastersService({ events: createEvents({ producer: 'catalog' } as never) } as never) as unknown as Svc;
    return { db, svc };
  }

  it('list p95 <= 200 ms; the page is bounded and never holds the other tenant', { timeout: 120_000 }, async () => {
    const { db, svc } = setup();
    await db.run((ctx) => svc['listDepartments']!(ctx, {}));                               // warm-up
    const t: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      const r = await db.run((ctx) => svc['listDepartments']!(ctx, { limit: 50 }));
      t.push(performance.now() - t0);
      expect(r.data.length).toBeLessThanOrEqual(50);
      expect(JSON.stringify(r)).not.toContain(TENANT_B);
    }
    expect(p95(t), `list p95 ${p95(t).toFixed(1)} ms`).toBeLessThanOrEqual(200);
  });

  it('create + update p95 <= 300 ms including revision bump and outbox; lock hold (whole write tx) p95 <= 50 ms; one revision bump per write', { timeout: 120_000 }, async () => {
    const { db, svc } = setup();
    const created: number[] = []; const updated: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      const c = await db.run((ctx) => svc['createDepartment']!(ctx, { code: `NEW${i}`, name: `New department ${i}`, report_order: i }));
      created.push(performance.now() - t0);
      const t1 = performance.now();
      await db.run((ctx) => svc['updateDepartment']!(ctx, { id: c.id, expectedVersion: c.version, patch: { name: `Renamed ${i}` } }));
      updated.push(performance.now() - t1);
    }
    const all = [...created, ...updated];
    expect(p95(all), `write p95 ${p95(all).toFixed(1)} ms`).toBeLessThanOrEqual(300);
    expect(p95(all), `write-tx (lock hold bound) p95 ${p95(all).toFixed(1)} ms`).toBeLessThanOrEqual(50);
    expect(db.revisionOf(TENANT_A)).toBe(1 + 60);                                           // exactly one bump per write (02-TRD §3 revision rule)
  });
});
