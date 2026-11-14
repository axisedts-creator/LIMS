// AN-T21 — P1, P2, P3, P5, X3 for the pending-tests operations (#11 getPendingTestsSummary, #12 listPendingTests) over the AN-T13 world: tenant B items with
// SENTINEL counts, A2 items, NULL-centre rows. Centre scope here is C5's RLS carried by the caller's tx (08 A17 D-49), emulated by the world.
import { describe, expect, it, vi } from 'vitest';
import { A1, A2, B1, BR1, BRB, LABMGR, LABMGR_A1, SENTINEL, makeCtx13, seedT13 } from '../../handlers/__tests__/helpers.t13.js';
import { callOp, runReportBattery, type World } from './battery.js';
import { op } from './spec.js';

vi.mock('../../repository/sourceViews.repo.js', async () => (await import('../../handlers/__tests__/helpers.t13.js')).sourceViewsMockT13);
vi.mock('../../repository/rollups.repo.js', async () => (await import('../../handlers/__tests__/helpers.t13.js')).rollupsMockT13);
vi.mock('../../repository/labels.repo.js', async () => (await import('../../handlers/__tests__/helpers.t13.js')).labelsRepoMockT13);

const world: World = {
  name: 'pending',
  seed: seedT13,
  makeCtx: (actor) => makeCtx13(actor),
  actorsFor: () => ({ all: LABMGR, a1: LABMGR_A1 }),
  window: {},
  centres: { a1: A1, a2: A2, b: B1 },
  branches: { containsA1andA2: BR1, b: BRB },
  forbidden: [String(SENTINEL), B1, BRB],
  receivedAtCentres: true,
};
runReportBattery(world, ['getPendingTestsSummary', 'listPendingTests']);

describe('P2 listPendingTests with tenant B data present returns zero tenant B rows (also across pages)', () => {
  it('walks every page as the all-centre manager: no row belongs to tenant B or carries a tenant B centre', async () => {
    seedT13();
    const { ctx } = await makeCtx13(LABMGR);
    const seen: any[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await callOp(op('listPendingTests'), ctx, { limit: 5, ...(cursor ? { cursor } : {}) });
      expect(r.status).toBe(200);
      seen.push(...r.body.data);
      cursor = r.body.next_cursor ?? r.body.page?.next_cursor;
      if (!cursor) break;
    }
    expect(seen.length).toBeGreaterThan(0);
    const text = JSON.stringify(seen);
    for (const s of [String(SENTINEL), B1, BRB]) expect(text).not.toContain(s);
  });
  it('a cursor minted for one caller is useless to another scope: A1-only caller replaying an all-centre cursor never sees A2 rows', async () => {
    seedT13();
    const all = await makeCtx13(LABMGR);
    const first = await callOp(op('listPendingTests'), all.ctx, { limit: 1 });
    const cursor = first.body.next_cursor ?? first.body.page?.next_cursor;
    const a1 = await makeCtx13(LABMGR_A1);
    const r = await callOp(op('listPendingTests'), a1.ctx, { limit: 50, ...(cursor ? { cursor } : {}) }).then((v) => v, () => undefined);
    if (r) expect(r.body.data.some((d: any) => d.centre_id === A2 || d.centre_id === B1)).toBe(false); // (A3 rows received at A1 are the D-49 exception)
  });
});
