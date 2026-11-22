// T0D-FIX-1 item 4 (LD-446, CR DEPLOY-AXIS-012 item 5): the contract validator injects `limit` as the NUMBER 50 (default or coercion), so
// listSmartSummaries must accept a number as well as a numeric string (library.ts:43 already does). Same harness as summary.handlers.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../repository/summaries.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).summariesRepoFake);
vi.mock('../../repository/reviews.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).reviewsRepoFake);
vi.mock('../../repository/codedSets.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).codedSetsRepoFake);
vi.mock('../../repository/bindings.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).bindingsRepoFake);
vi.mock('../../repository/library.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).libraryRepoFake);
vi.mock('../../repository/blocks.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).blocksRepoFake);
vi.mock('../../repository/rules.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).rulesRepoFake);
vi.mock('../../repository/mappings.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).mappingsRepoFake);
vi.mock('../../repository/groups.repo.js', async () => (await import('../../__tests__/t15.fakes.js')).groupsRepoFake);

import { buildOrGet } from '../../summary.service.js';
import { request, responseProblems } from '../../__tests__/t11.helpers.js';
import { makeCtx as sysCtx, run } from '../../__tests__/t12.fakes.js';
import { ORDER, ORDER3, inTx, makeCtx, seedWorld, w, type Persona } from '../../__tests__/t15.fakes.js';
import { handlers } from '../index.js';

type Row = Record<string, any>;
const LIST = 'listSmartSummaries';
const list = (query: object, persona: Persona = 'pathologist') => {
  const c = makeCtx(persona, LIST, 'A', {});
  const h = (handlers as Record<string, (r: unknown, x: unknown) => Promise<any>>)[LIST]!;
  return () => inTx(c.ctx, () => h(request({ query }), c.ctx), { shared: false });
};
const fails = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected the operation to be refused, but it answered'); };
const mk = async (orderId: string): Promise<Row> => { const c = sysCtx(); return (await run(c, () => buildOrGet(c, { orderId } as any))).summary; };
async function threeDrafts(): Promise<Row[]> {
  const s = [await mk(ORDER.a), await mk(ORDER.a2), await mk(ORDER3)];
  s.forEach((x, i) => { w.summaries.find((r) => r.id === x.id)!.built_at = `2026-11-1${i}T04:00:00.000Z`; });
  return s;
}
beforeEach(() => { seedWorld(); vi.clearAllMocks(); });

describe('listSmartSummaries limit: number or numeric string (item 4)', () => {
  it('limit 50 as a number (what the pipeline injects) -> 200, contract valid, page.limit 50', async () => {
    await threeDrafts();
    const r = await list({ limit: 50 })();
    expect(r.status).toBe(200);
    expect(responseProblems(LIST, r)).toEqual([]);
    expect(r.body.data).toHaveLength(3);
    expect(r.body.page.limit).toBe(50);
  });
  it('limit "50" as a numeric string still answers 200', async () => {
    await threeDrafts();
    const r = await list({ limit: '50' })();
    expect(r.status).toBe(200);
    expect(r.body.page.limit).toBe(50);
  });
  it('no limit at all -> 200 with the default 50', async () => {
    await threeDrafts();
    const r = await list({})();
    expect(r.status).toBe(200);
    expect(r.body.page.limit).toBe(50);
  });
  it('a numeric limit pages: limit 2 gives two rows and a next_cursor, the cursor gives the last one', async () => {
    const [a, b, c] = await threeDrafts();
    const p1 = await list({ limit: 2 })();
    expect(p1.body.data.map((i: Row) => i.id)).toEqual([a!.id, b!.id]);
    expect(p1.body.page.next_cursor).toEqual(expect.any(String));
    const p2 = await list({ limit: 2, cursor: p1.body.page.next_cursor })();
    expect(p2.body.data.map((i: Row) => i.id)).toEqual([c!.id]);
  });
  it('bounds hold for numbers too: 1 and 200 pass; 0, 201, 2.5, -1, NaN, Infinity -> 400 common.validation_failed and nothing is read', async () => {
    await threeDrafts();
    for (const ok of [1, 200]) expect((await list({ limit: ok })()).status, String(ok)).toBe(200);
    w.calls.length = 0;
    for (const bad of [0, 201, 2.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await fails(list({ limit: bad })())).code, String(bad)).toBe('common.validation_failed');
    }
    expect(w.calls.filter((c) => c.fn === 'listReviewQueue')).toEqual([]);
  });
  it('non numeric types are still refused: "abc", "", true, null, an array, an object', async () => {
    await threeDrafts();
    for (const bad of ['abc', '', true, null, [50], { n: 50 }]) {
      expect((await fails(list({ limit: bad as never })())).code, JSON.stringify(bad)).toBe('common.validation_failed');
    }
  });
});
