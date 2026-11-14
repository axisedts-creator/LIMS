// C8 AN-T14 — requestAnalyticsRefresh (POST /v1/analytics/refresh, TRD §5 #19, §9.7; PRD US-19.1–2; 08 A17 P-22; 07-SECURITY §3 "Manual refresh").
// The fake transaction (./helpers.t14.ts) emulates analytics.refresh_state ('_manual' upsert with the §9.7 WHERE guard, atomically per statement),
// analytics.dirty_partitions and app.enqueue_job by SQL text. Handler + service + refresh.repo (markDirty) are real.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN, D1, D2, FAMILIES, FINANCE, LAB_MANAGER, NO_PERM, OWNER_A109, PARTNER, SNAPSHOT, TA, TB, NOW, NOW_EARLY,
  advance, call14, db, expectLims, makeCtx14, marksOf, ok14, rejection, seedT14, stateOf, w14, writes,
} from './helpers.t14.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('./helpers.t14.js')).rollupsMock14);
vi.mock('../../repository/labels.repo.js', async () => (await import('./helpers.t14.js')).labelsRepoMock14);

const OP = 'requestAnalyticsRefresh' as const;
const post = async (ctx: any, body: unknown = {}) => call14(OP, ctx, { body });
const accepted = (ctx: any, body: unknown = {}) => ok14(OP, ctx, { body }, 202);
const DATE_FAMILIES = FAMILIES.filter((f) => f !== 'report_backlog');
const plus = (iso: string, s: number) => new Date(Date.parse(iso) + s * 1000).toISOString();
const keys = (tenant = TA) => marksOf(tenant).map((m) => `${m.family}@${m.date}`).sort();

beforeEach(() => { seedT14(); vi.clearAllMocks(); });

describe('US-19.1 — first manual refresh on a fresh tenant → 202', () => {
  it('no body fields: 202 {queued_families: all 16, next_allowed_at = now + 5 min}; contract-valid', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const body = await accepted(ctx);
    expect([...body.queued_families].sort()).toEqual([...FAMILIES].sort());
    expect(body.next_allowed_at).toBe(plus(NOW, 300));
    expect(Object.keys(body).sort()).toEqual(['next_allowed_at', 'queued_families']);
    expect(body.queued_families.every((f: unknown) => typeof f === 'string')).toBe(true);
    expect(body.queued_families.length).toBeLessThanOrEqual(20);
  });

  it('works without any request body at all (families default = all)', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const r = await call14(OP, ctx, { body: undefined });
    expect(r.status).toBe(202);
    expect(r.body.queued_families.length).toBe(FAMILIES.length);
  });

  it('inserts the `_manual` row by itself (no seeding step): last_manual_at = db now, created_by = the actor', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    expect(stateOf(TA, '_manual')).toBeUndefined();
    await accepted(ctx);
    expect(stateOf(TA, '_manual')).toMatchObject({ tenant: TA, family: '_manual', last_manual_at: NOW, created_by: ctx.actor.id });
  });

  it('families subset: only those families are queued and marked', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const body = await accepted(ctx, { families: ['income', 'results'] });
    expect([...body.queued_families].sort()).toEqual(['income', 'results']);
    expect(keys()).toEqual([`income@${D2}`, `results@${D2}`]);
  });

  it('duplicates in `families` are queued once', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    const body = await accepted(ctx, { families: ['income', 'income'] });
    expect(body.queued_families).toEqual(['income']);
    expect(keys()).toEqual([`income@${D2}`]);
  });

  it('a dashboard.read holder restricted to one centre may request it (the refresh is tenant-wide, not scoped)', async () => {
    const { ctx } = await makeCtx14(OWNER_A109);
    expect((await post(ctx)).status).toBe(202);
  });

  it('lab_manager (dashboard.read only) may request it', async () => {
    const { ctx } = await makeCtx14(LAB_MANAGER);
    expect((await post(ctx)).status).toBe(202);
  });
});

describe('US-19.1 — what is marked dirty and enqueued', () => {
  it('after 06:00 Nepal time: every date family @ today only, with reason "manual"; report_backlog @ the snapshot sentinel date', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    await accepted(ctx);
    expect(keys()).toEqual([...DATE_FAMILIES.map((f) => `${f}@${D2}`), `report_backlog@${SNAPSHOT}`].sort());
    for (const m of marksOf()) { expect(m.reason).toBe('manual'); expect(m.actor).toBe(ctx.actor.id); }
  });

  it('before 06:00 Nepal time (04:45): yesterday is marked too — date families only', async () => {
    const { ctx } = await makeCtx14(ADMIN, { now: () => NOW_EARLY });
    w14.clock.now = NOW_EARLY;
    await accepted(ctx);
    expect(keys()).toEqual([...DATE_FAMILIES.flatMap((f) => [`${f}@${D1}`, `${f}@${D2}`]), `report_backlog@${SNAPSHOT}`].sort());
  });

  it('06:00 sharp is "after" (yesterday no longer marked); 05:59 is "before"', async () => {
    for (const [iso, yesterday] of [['2026-11-06T00:14:00.000Z', true], ['2026-11-06T00:15:00.000Z', false]] as const) {   // 05:59 / 06:00 NPT
      seedT14();
      w14.clock.now = iso;
      const { ctx } = await makeCtx14(ADMIN, { now: () => iso });
      await accepted(ctx, { families: ['income'] });
      expect(keys().includes(`income@${D1}`), iso).toBe(yesterday);
      expect(keys().includes(`income@${D2}`), iso).toBe(true);
    }
  });

  it('exactly one refresh_tenant job is enqueued for the tenant, in the same transaction (tx.query), payload {tenant_id}', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    await accepted(ctx);
    expect(w14.jobs.length).toBe(1);
    expect(w14.jobs[0]).toMatchObject({ identifier: 'analytics.refresh_tenant', payload: { tenant_id: TA } });
  });

  it('marks are written before the job is enqueued (the worker must find them)', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    await accepted(ctx);
    const order = w14.log.map((l) => (/app\.enqueue_job/i.test(l.text) ? 'job' : /dirty_partitions/i.test(l.text) && /INSERT/i.test(l.text) ? 'mark' : ''));
    expect(order.lastIndexOf('mark')).toBeLessThan(order.indexOf('job'));
  });

  it('an existing mark is kept (first_marked_at unchanged), only last_marked_at is bumped', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    w14.marks.set(`${TA}|income|${D2}`, { tenant: TA, family: 'income', date: D2, first: '2026-11-06T05:00:00.000Z', last: '2026-11-06T05:30:00.000Z', reason: 'event', actor: 'x' });
    await accepted(ctx, { families: ['income'] });
    expect(marksOf()[0]).toMatchObject({ first: '2026-11-06T05:00:00.000Z', last: NOW });
  });
});

describe('US-19.2 / P-22 — throttle: one manual refresh per tenant per 5 min', () => {
  it('second request right after the first → 429 common.rate_limited, Retry-After = 300 s; nothing marked, nothing enqueued', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    await accepted(ctx);
    const jobs = w14.jobs.length, marks = marksOf().length;
    const e = await expectLims(post((await makeCtx14(ADMIN)).ctx), 'common.rate_limited', 429);
    expect(e.retryAfterSeconds).toBe(300);
    expect(w14.jobs.length).toBe(jobs);
    expect(marksOf().length).toBe(marks);
  });

  it('Retry-After counts down: after 120 s it is 180', async () => {
    await accepted((await makeCtx14(ADMIN)).ctx);
    advance(120_000);
    const e = await expectLims(post((await makeCtx14(ADMIN)).ctx), 'common.rate_limited', 429);
    expect(e.retryAfterSeconds).toBe(180);
  });

  it('a 429 does not extend the window (last_manual_at stays at the accepted request)', async () => {
    await accepted((await makeCtx14(ADMIN)).ctx);
    advance(200_000);
    await expectLims(post((await makeCtx14(ADMIN)).ctx), 'common.rate_limited', 429);
    expect(stateOf(TA, '_manual')!.last_manual_at).toBe(NOW);
  });

  it('boundary: still throttled at 299 s (Retry-After 1), accepted again at 301 s, and the new window starts there', async () => {
    await accepted((await makeCtx14(ADMIN)).ctx);
    advance(299_000);
    expect((await expectLims(post((await makeCtx14(ADMIN)).ctx), 'common.rate_limited', 429)).retryAfterSeconds).toBe(1);
    advance(2_000);
    const again = await accepted((await makeCtx14(ADMIN)).ctx);
    expect(again.next_allowed_at).toBe(plus(NOW, 301 + 300));
    expect(stateOf(TA, '_manual')!.last_manual_at).toBe(plus(NOW, 301));
  });

  it('per tenant, not per user: another user of the same tenant is throttled by the first one', async () => {
    await accepted((await makeCtx14(ADMIN)).ctx);
    await expectLims(post((await makeCtx14(OWNER_A109)).ctx), 'common.rate_limited', 429);
  });

  it('per tenant: a recent tenant-B `_manual` row does not throttle tenant A', async () => {
    w14.state.set(`${TB}|_manual`, { tenant: TB, family: '_manual', last_manual_at: NOW });
    expect((await post((await makeCtx14(ADMIN)).ctx)).status).toBe(202);
    expect(stateOf(TB, '_manual')!.last_manual_at).toBe(NOW);
  });

  it('an existing `_manual` row with last_manual_at NULL is treated as "never" → 202', async () => {
    w14.state.set(`${TA}|_manual`, { tenant: TA, family: '_manual' });
    expect((await post((await makeCtx14(ADMIN)).ctx)).status).toBe(202);
    expect(stateOf(TA, '_manual')!.last_manual_at).toBe(NOW);
  });

  it('the throttle is ONE statement: INSERT … ON CONFLICT (tenant_id, family) DO UPDATE … WHERE … RETURNING last_manual_at, bound [tenant, 5 minutes, actor] (TRD §9.7)', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    await accepted(ctx);
    const stmt = w14.log.find((l) => /INSERT\s+INTO\s+analytics\.refresh_state/i.test(l.text))!;
    expect(stmt, 'throttle statement').toBeDefined();
    expect(stmt.text).toMatch(/'_manual'/);
    expect(stmt.text).toMatch(/ON\s+CONFLICT\s*\(\s*tenant_id\s*,\s*family\s*\)\s*DO\s+UPDATE/i);
    expect(stmt.text).toMatch(/\bWHERE\b[\s\S]*last_manual_at\s+IS\s+NULL[\s\S]*\bOR\b[\s\S]*last_manual_at\s*<\s*now\(\)\s*-\s*make_interval\(\s*mins\s*=>\s*\$2\s*\)/i);
    expect(stmt.text).toMatch(/RETURNING\s+last_manual_at/i);
    expect(stmt.values).toEqual([TA, 5, ctx.actor.id]);
  });

  it('only the `_manual` family of refresh_state is ever written by a user (P7), and only by that one statement (no UPDATE, no SELECT-then-INSERT seeding)', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    await accepted(ctx);
    await rejection(post((await makeCtx14(ADMIN)).ctx));
    const stateWrites = writes().filter((w) => /analytics\.refresh_state/i.test(w.text));
    expect(stateWrites.length).toBe(2);                                     // accepted + throttled attempt: the same single upsert
    for (const w of stateWrites) { expect(w.text).toMatch(/'_manual'/); expect(w.text).not.toMatch(/^\s*UPDATE/i); }
    expect([...w14.state.values()].filter((s) => s.tenant === TA).map((s) => s.family)).toEqual(['_manual']);
  });

  it('10 parallel requests from one tenant: exactly one 202, nine 429, exactly one job enqueued', async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, async () => post((await makeCtx14(ADMIN)).ctx)));
    const ok = results.filter((r) => r.status === 'fulfilled' && (r.value as any).status === 202);
    const limited = results.filter((r) => r.status === 'rejected' && (r.reason as any).code === 'common.rate_limited');
    expect(ok.length).toBe(1);
    expect(limited.length).toBe(9);
    expect(w14.jobs.length).toBe(1);
    expect(keys().length).toBe(DATE_FAMILIES.length + 1);
  });
});

describe('failure handling', () => {
  it('invalid input never consumes the throttle slot: bad families → 400, then a valid request is 202', async () => {
    await expectLims(post((await makeCtx14(ADMIN)).ctx, { families: ['not_a_family'] }), 'common.validation_failed', 400);
    expect(stateOf(TA, '_manual')).toBeUndefined();
    expect(writes()).toEqual([]);
    expect((await post((await makeCtx14(ADMIN)).ctx)).status).toBe(202);
  });

  it('enqueue failure surfaces as an error (not a 202); the core rolls the transaction back', async () => {
    const { ctx } = await makeCtx14(ADMIN);
    w14.failOn = (t) => (/app\.enqueue_job/i.test(t) ? new Error('enqueue down') : undefined);
    await rejection(post(ctx));
  });

  it('a throttled request returns before touching dirty_partitions or the queue (no side effect at all)', async () => {
    await accepted((await makeCtx14(ADMIN)).ctx);
    w14.log.length = 0;
    await rejection(post((await makeCtx14(ADMIN)).ctx));
    expect(w14.log.some((l) => /dirty_partitions|enqueue_job/i.test(l.text))).toBe(false);
  });
});

describe('permission', () => {
  it.each([['no analytics permission', NO_PERM], ['finance (collections.read only)', FINANCE], ['partner', PARTNER]])('%s → 403 auth.forbidden; no throttle row, no mark, no job', async (_n, actor) => {
    const { ctx, touched } = await makeCtx14(actor);
    await expectLims(post(ctx), 'auth.forbidden', 403);
    expect(touched).toEqual([]);
    expect(w14.log).toEqual([]);
    expect(stateOf(TA, '_manual')).toBeUndefined();
    expect(w14.jobs).toEqual([]);
    expect(db.calls).toEqual([]);
  });
});
