// C8 AN-T13 — cross-cutting security checks for getPendingTestsSummary / listPendingTests (07-SECURITY P1 tenant isolation / no person data, P3 authz, P4 centre scope,
// injection through filters, REQ-SEC-013/017/081; TRD §6.7 live-read guard: statement timeout 57014 -> 503 common.dependency_unavailable). Emulators: ./helpers.t13.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import {
  A1, ADMIN, NO_PERM, OWNER_A1, PARTNER, SENTINEL, TA, calls13, call13, contractErrors13, db, expectLims, items13, makeCtx13, ok13, seedT13, summary13, t13, type Op13,
} from './helpers.t13.js';

vi.mock('../../repository/sourceViews.repo.js', async () => (await import('./helpers.t13.js')).sourceViewsMockT13);
vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.t13.js')).rollupsMockT13);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.t13.js')).labelsRepoMockT13);

beforeEach(() => { seedT13(); vi.clearAllMocks(); });
const OPS: readonly Op13[] = ['getPendingTestsSummary', 'listPendingTests'];

describe('both operations are implemented (not the AN-T01 stub)', () => {
  it.each(OPS)('%s answers 200 for an authorised caller', async (op) => {
    const body = await ok13(op, (await makeCtx13(ADMIN)).ctx);
    expect(body).toBeTypeOf('object');
  });
});

describe('P3 — authorisation first (analytics.dashboard.read)', () => {
  it.each(OPS.flatMap((op) => [NO_PERM, PARTNER].map((who) => [op, who] as const)))('%s as %s: 403 auth.forbidden, nothing touched', async (op, who) => {
    const { ctx, touched } = await makeCtx13(who);
    await expectLims(call13(op, ctx), 'auth.forbidden', 403);
    expect(touched).toEqual([]);
    expect(calls13).toEqual([]);
  });

  it.each(OPS)('%s: an unauthorised caller gets 403 even for an invalid / hostile query', async (op) => {
    for (const q of [{ priority: 'x' }, { cursor: '%%%' }, { limit: 9999 }, { centre_id: [A1] }, { item_status: ['bogus'] }]) {
      const { ctx, touched } = await makeCtx13(NO_PERM);
      await expectLims(call13(op, ctx, q), 'auth.forbidden', 403);
      expect(touched).toEqual([]);
    }
    expect(calls13).toEqual([]);
  });
});

describe('P1 / REQ-SEC-013 — tenant isolation', () => {
  it.each(OPS)('%s: every repo call carries ctx.tenantId; the tenant B sentinel never reaches the body', async (op) => {
    const { ctx } = await makeCtx13(ADMIN);
    const body = await ok13(op, ctx);
    expect(calls13.length).toBeGreaterThan(0);
    for (const c of calls13) expect(c.args.tenantId).toBe(ctx.tenantId);
    expect(ctx.tenantId).toBe(TA);
    expect(JSON.stringify(body)).not.toContain(String(SENTINEL));
  });

  it.each(OPS)('%s: client-supplied tenant_id / scope / all_centres / unknown parameters are ignored and never forwarded', async (op) => {
    const { ctx } = await makeCtx13(OWNER_A1);
    await ok13(op, ctx, { tenant_id: '00000000-0000-4000-8000-00000000beef', scope: 'all', all_centres: true, rls: 'off', include_patient: true });
    for (const c of calls13) expect(JSON.stringify(c.args)).not.toMatch(/beef|include_patient|"rls"/);
    for (const c of calls13.filter((x) => x.fn === 'backlogRows')) expect(c.args.scope).toEqual({ all: false, centreIds: [A1] });
  });
});

describe('P1 / REQ-SEC-081 — no person data in either response (US-10.3)', () => {
  it('list: no patient name, registration no, barcode, result or specimen id, at any level, and the body equals the contract allow-list', async () => {
    const body = await items13((await makeCtx13(ADMIN)).ctx);
    expect(JSON.stringify(body)).not.toMatch(/PLANTED|patient|registration|barcode|result_value|specimen/i);
    expect(contractErrors13('listPendingTests', body)).toEqual([]);
    expect(contractErrors13('listPendingTests', { ...body, data: [{ ...body.data[0], patient_name: 'x' }] })).not.toEqual([]); // the schema would catch a leaked column
  });

  it('summary: aggregates only — no item or order id appears', async () => {
    const text = JSON.stringify(await summary13((await makeCtx13(ADMIN)).ctx));
    expect(text).not.toMatch(/order_item_id|order_id|PLANTED|patient|barcode|registration/i);
  });
});

describe('P4 / REQ-SEC-017 — D-49: live scope is the caller\'s RLS, never widened', () => {
  it('a restricted caller can neither widen the live list by filters nor reach rows the policy hides', async () => {
    const { ctx } = await makeCtx13(OWNER_A1);
    const body = await items13(ctx, { priority: 'urgent' });
    expect(body.data.map((d: any) => d.priority)).toEqual(['urgent']);                       // P2 only: P6 (A3) is invisible
    expect(JSON.stringify(body)).not.toContain(String(SENTINEL));
  });

  it('interleaved all-centre and {A1} requests never share figures (many users at once)', async () => {
    const jobs = Array.from({ length: 16 }, async (_, i) => {
      const who = i % 2 ? OWNER_A1 : ADMIN;
      return { who, s: await summary13((await makeCtx13(who)).ctx), l: await items13((await makeCtx13(who)).ctx) };
    });
    for (const r of await Promise.all(jobs)) {
      expect(r.s.total, r.who).toBe(r.who === ADMIN ? 8 : 5);
      expect(r.l.data, r.who).toHaveLength(r.who === ADMIN ? 8 : 5);
    }
  });

  it('the live read never runs outside the request tx: a tx without an RLS context makes the read fail (no silent system-actor fallback)', async () => {
    const { ctx, tx } = await makeCtx13(ADMIN);
    delete tx.rls;
    const e = await call13('getPendingTestsSummary', ctx).then(() => undefined, (x) => x);
    expect(e?.message).toMatch(/no RLS context/);   // the emulator's own failure: the service really read through ctx.tx
  });
});

describe('injection — filters are data, never SQL', () => {
  it('sort / item_status / priority outside their closed lists → 400 before any read', async () => {
    for (const q of [{ sort: "age_seconds; DROP TABLE lab.order_tests" }, { sort: 'order_id' }, { item_status: ["verified' OR 1=1"] }, { priority: "urgent' --" }]) {
      await expectLims(call13('listPendingTests', (await makeCtx13(ADMIN)).ctx, q), 'common.validation_failed', 400);
    }
    expect(calls13).toEqual([]);
  });

  it('non-uuid department_id / processing_branch_id / centre_id elements → 400 (never reach a query)', async () => {
    for (const op of OPS) for (const q of [{ department_id: ["x') OR 1=1 --"] }, { processing_branch_id: ['nope'] }, { centre_id: ["' OR 1=1"] }]) {
      const e = await call13(op, (await makeCtx13(ADMIN)).ctx, q).then(() => undefined, (x) => x);
      expect(e, `${op} ${JSON.stringify(q)}`).toBeInstanceOf(LimsError);
      expect(['common.validation_failed', 'common.not_found']).toContain((e as LimsError).code);
    }
    for (const c of calls13) expect(JSON.stringify(c.args)).not.toMatch(/OR 1=1/);
  });
});

describe('TRD §6.7 live-read guard — statement timeout (57014) becomes 503 common.dependency_unavailable', () => {
  const timeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

  it.each(OPS)('%s: a dependency error from the live read propagates as 503, never an empty 200', async (op) => {
    db.fail = new LimsError('common.dependency_unavailable');
    await expectLims(call13(op, (await makeCtx13(ADMIN)).ctx), 'common.dependency_unavailable', 503);
  });

  it.each(OPS)('%s: a raw pg 57014 from the view read is not swallowed and not shown as data (rejects; the core maps it to 503)', async (op) => {
    db.fail = timeout();
    const e: any = await call13(op, (await makeCtx13(ADMIN)).ctx).then(() => undefined, (x) => x);
    expect(e).toBeDefined();
    expect(e.code === '57014' || e.code === 'common.dependency_unavailable').toBe(true);
    expect(JSON.stringify({ m: e.message, d: e.details })).not.toContain('PLANTED');
  });

  it('no partial 200: when the live summary fails the backlog is not returned alone', async () => {
    db.fail = new LimsError('common.dependency_unavailable');
    const r = await call13('getPendingTestsSummary', (await makeCtx13(ADMIN)).ctx).then((x) => x, (x) => x);
    expect(r).toBeInstanceOf(LimsError);
    expect((r as LimsError).code).toBe('common.dependency_unavailable');
  });
});

describe('abuse — large pages and replayed cursors stay bounded and tenant-bound', () => {
  it('limit is capped at 200 (201 refused) and the repo never receives more than limit + 1', async () => {
    await items13((await makeCtx13(ADMIN)).ctx, { limit: 200 });
    expect(Math.max(...calls13.filter((c) => c.fn === 'pendingItems').map((c) => c.args.limit))).toBe(201);
    await expectLims(call13('listPendingTests', (await makeCtx13(ADMIN)).ctx, { limit: 201 }), 'common.validation_failed', 400);
  });

  it('a cursor minted for one caller replays under another caller\'s RLS: still only that caller\'s rows, no foreign tenant data', async () => {
    const first = await items13((await makeCtx13(ADMIN)).ctx, { limit: 2 });
    const body = await items13((await makeCtx13(OWNER_A1)).ctx, { limit: 50, cursor: first.page.next_cursor });
    expect(JSON.stringify(body)).not.toContain(String(SENTINEL));
    const visible = new Set(t13.items.filter((i) => i.tenantId === TA && i.n !== 3 && i.n !== 4 && i.n !== 6).map((i) => i.n));   // what {A1} may see (D-13)
    expect(body.data.length).toBeLessThanOrEqual(visible.size);
    expect(body.data.every((d: any) => d.centre_id === A1 || d.centre_id === t13.items.find((i) => i.n === 5)!.centreId)).toBe(true);
  });
});
