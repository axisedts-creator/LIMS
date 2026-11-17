// evt.<module>.<event_type> consumer wrapper + plain-task wrapper (02-TRD §7.2, §7.3; AC-0D-5.5; JobContext incl. T0D-17 storage/files/audit).
import { describe, expect, it, vi } from 'vitest';
import { EVENT_ID, ORDER_CREATED, ORDER_ID, TENANT_A, TENANT_B, evtId, orderCreatedEnvelope, rejects, rejectsBuild, setup, systemActorOf } from './helpers.js';

const evtPayload = { event_id: EVENT_ID, tenant_id: TENANT_A, event_type: ORDER_CREATED };
const task = evtId('lab');

async function labSetup(handler: (e: any, ctx: any) => Promise<void>, extra: Record<string, unknown> = {}) {
  const s = await setup([{ module: 'lab', subscriptions: { [ORDER_CREATED]: handler }, ...extra }]);
  s.world.seedEvent(orderCreatedEnvelope());
  return s;
}

describe('consumer wrapper: inbox (AC-0D-5.5)', () => {
  it('the same event delivered twice runs the handler body once; the second delivery completes successfully', async () => {
    const handler = vi.fn(async (_e: any, ctx: any) => { await ctx.tx.query('INSERT INTO lab.order_summary (tenant_id, order_id) VALUES ($1, $2)', [TENANT_A, ORDER_ID]); });
    const s = await labSetup(handler);
    await s.run(task, evtPayload);
    await expect(s.run(task, evtPayload, { attempts: 2 })).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(s.world.inbox).toEqual([{ module: 'lab', tenant_id: TENANT_A, event_id: EVENT_ID }]);
    expect(s.world.writes).toHaveLength(1);
    expect(s.world.txLog.at(-1)!.outcome).toBe('commit');                       // duplicate path commits, does not roll back
  });

  it('two concurrent deliveries of the same event still run the handler once', async () => {
    const handler = vi.fn(async () => undefined);
    const s = await labSetup(handler);
    await Promise.all([s.run(task, evtPayload, { id: '1' }), s.run(task, evtPayload, { id: '2' })]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(s.world.inbox).toHaveLength(1);
  });

  it('inbox is per module: reporting still processes an event lab already processed', async () => {
    const lab = vi.fn(async () => undefined); const reporting = vi.fn(async () => undefined);
    const s = await setup([{ module: 'lab', subscriptions: { [ORDER_CREATED]: lab } }, { module: 'reporting', subscriptions: { [ORDER_CREATED]: reporting } }]);
    s.world.seedEvent(orderCreatedEnvelope());
    await s.run(evtId('lab'), evtPayload); await s.run(evtId('reporting'), evtPayload);
    expect(lab).toHaveBeenCalledTimes(1); expect(reporting).toHaveBeenCalledTimes(1);
    expect(s.world.inbox.map((r) => r.module).sort()).toEqual(['lab', 'reporting']);
  });

  it('a throwing handler rolls back EVERYTHING incl. the inbox row; the retry runs the handler again and then sticks', async () => {
    let calls = 0;
    const handler = vi.fn(async (_e: any, ctx: any) => {
      await ctx.tx.query('INSERT INTO lab.order_summary (tenant_id, order_id) VALUES ($1, $2)', [TENANT_A, ORDER_ID]);
      if (++calls === 1) throw new Error('boom');
    });
    const s = await labSetup(handler);
    await rejects(s.run(task, evtPayload));
    expect(s.world.inbox).toHaveLength(0);
    expect(s.world.writes).toHaveLength(0);
    await s.run(task, evtPayload, { attempts: 2 });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(s.world.inbox).toHaveLength(1);
    expect(s.world.writes).toHaveLength(1);
  });

  it('inbox row is inserted BEFORE the handler runs, in the same transaction as the handler writes', async () => {
    const order: string[] = [];
    const handler = async (_e: any, ctx: any) => { order.push('handler'); await ctx.tx.query('INSERT INTO lab.order_summary (tenant_id) VALUES ($1)', [TENANT_A]); };
    const s = await labSetup(handler);
    await s.run(task, evtPayload);
    const tx = s.world.txLog.find((t) => t.stmts.some((x) => /lab\.order_summary/.test(x.text)))!;
    const texts = tx.stmts.map((x) => x.text);
    expect(texts.findIndex((x) => /lab\.event_inbox/i.test(x))).toBeGreaterThanOrEqual(0);
    expect(texts.findIndex((x) => /lab\.event_inbox/i.test(x))).toBeLessThan(texts.findIndex((x) => /lab\.order_summary/.test(x)));
    expect(order).toEqual(['handler']);
  });
});

describe('consumer wrapper: tenant tx, envelope, JobContext', () => {
  it("opens the transaction with the consuming module's system actor and the job tenant (step 1)", async () => {
    const s = await labSetup(async () => undefined);
    await s.run(task, evtPayload);
    const tx = s.world.txLog.find((t) => t.stmts.some((x) => /lab\.event_inbox/i.test(x.text)))!;
    expect(tx.claims0).toMatchObject({ sub: systemActorOf('lab'), tenant_id: TENANT_A, actor_type: 'system' });
    expect(tx.claims0.sub).not.toBe(systemActorOf('reporting'));
  });

  it('handler gets the envelope from core.event_log with unknown fields removed (known fields only, CV §7.2)', async () => {
    const seen: any[] = [];
    const s = await labSetup(async (e) => { seen.push(e); });
    s.world.seedEvent(orderCreatedEnvelope({ event_id: '0190a000-0000-7000-8000-00000000e010', future_envelope_field: 'x' }, { future_payload_field: 'y' }));
    await s.run(task, { ...evtPayload, event_id: '0190a000-0000-7000-8000-00000000e010' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('future_envelope_field');
    expect(seen[0].payload).not.toHaveProperty('future_payload_field');
    expect(seen[0]).toMatchObject({ event_id: '0190a000-0000-7000-8000-00000000e010', event_type: ORDER_CREATED, tenant_id: TENANT_A, aggregate: { type: 'order', seq: 1 } });
    expect(seen[0].payload.order_id).toBe(ORDER_ID);
  });

  it('an envelope that violates its schema is not handled, and its inbox row is rolled back', async () => {
    const handler = vi.fn(async () => undefined);
    const s = await labSetup(handler);
    const bad = orderCreatedEnvelope({ event_id: '0190a000-0000-7000-8000-00000000e011' }); delete bad.payload.items;
    s.world.seedEvent(bad);
    await rejects(s.run(task, { ...evtPayload, event_id: bad.event_id }));
    expect(handler).not.toHaveBeenCalled();
    expect(s.world.inbox).toHaveLength(0);
  });

  it("cross-tenant: tenant A's job cannot make a handler see tenant B's event", async () => {
    const handler = vi.fn(async () => undefined);
    const s = await labSetup(handler);
    s.world.seedEvent(orderCreatedEnvelope({ event_id: '0190a000-0000-7000-8000-00000000e012', tenant_id: TENANT_B }));
    await rejects(s.run(task, { ...evtPayload, event_id: '0190a000-0000-7000-8000-00000000e012' }));
    expect(handler).not.toHaveBeenCalled();
    expect(s.world.inbox.filter((r) => r.tenant_id === TENANT_B)).toHaveLength(0);
  });

  it('JobContext: tenantId, system actor, attempt, maxAttempts, jobId, same-tx, injected storage/files/audit (T0D-17)', async () => {
    let ctx: any;
    const s = await labSetup(async (_e, c) => { ctx = c; });
    await s.run(task, evtPayload, { id: '77', attempts: 3 });
    expect(ctx.tenantId).toBe(TENANT_A);
    expect(ctx.actor).toEqual({ type: 'system', id: systemActorOf('lab') });
    expect(ctx.attempt).toBe(3); expect(ctx.maxAttempts).toBe(10); expect(ctx.jobId).toBe('77');
    expect(typeof ctx.requestId).toBe('string');
    expect(typeof ctx.tx?.query).toBe('function');
    expect(ctx.storage).toBe(s.deps.storage); expect(ctx.files).toBe(s.deps.files); expect(ctx.audit).toBe(s.deps.audit);
    expect(ctx.events).toBe(s.deps.events); expect(ctx.core).toBe(s.deps.core);
    expect(typeof ctx.log?.info).toBe('function');
    expect(typeof ctx.db?.tx).toBe('function');
    expect(typeof ctx.now()).toBe('string');
  });

  it('JobContext.isNewer(lastAppliedSeq, seq): helper only, undefined means "never applied"', async () => {
    let ctx: any;
    const s = await labSetup(async (_e, c) => { ctx = c; });
    await s.run(task, evtPayload);
    expect(ctx.isNewer(undefined, 1)).toBe(true);
    expect(ctx.isNewer(4, 5)).toBe(true);
    expect(ctx.isNewer(5, 5)).toBe(false);
    expect(ctx.isNewer(6, 5)).toBe(false);
  });

  it('registry: a module with subscriptions gets one consumer entry per subscription, max_attempts 10, per_tenant', async () => {
    const s = await labSetup(async () => undefined);
    expect(s.entry(task)).toMatchObject({ module: 'lab', kind: 'consumer', scope: 'per_tenant', maxAttempts: 10 });
  });
});

describe('consumer wrapper: x-extensible enums (CV §7.2; review T0D-09 item 1)', () => {
  const CATALOG_CHANGED = 'catalog.changed.v1';
  const catalogEnvelope = (payloadOver: Record<string, unknown> = {}) => ({
    event_id: EVENT_ID, event_type: CATALOG_CHANGED, tenant_id: TENANT_A, occurred_at: '2026-11-07T12:00:00.000Z',
    actor: { type: 'user', id: '0190a000-0000-7000-8000-00000000a001' }, idempotency_key: 'catalog-changed-1', producer: 'catalog',
    aggregate: { type: 'catalog', id: '0190a000-0000-7000-8000-00000000ca01', seq: 1 },
    request_id: '0190a000-0000-7000-8000-0000000000f1',
    payload: { catalog_revision: 1, entity_type: 'test', entity_id: '0190a000-0000-7000-8000-00000000ca02', change_kind: 'updated',
      effective_from: '2026-11-07T12:00:00.000Z', ...payloadOver },
  });
  const catalogSetup = async (handler: (e: any, ctx: any) => Promise<void>, payloadOver: Record<string, unknown>) => {
    const s = await setup([{ module: 'lab', subscriptions: { [CATALOG_CHANGED]: handler } }]);
    s.world.seedEvent(catalogEnvelope(payloadOver));
    return s;
  };
  const payload = { event_id: EVENT_ID, tenant_id: TENANT_A, event_type: CATALOG_CHANGED };

  it('a future value of an x-extensible enum (entity_type) still reaches the handler exactly once', async () => {
    const seen: any[] = [];
    const s = await catalogSetup(async (e) => { seen.push(e); }, { entity_type: 'some_future_kind' });
    await s.run(evtId('lab', CATALOG_CHANGED), payload);
    expect(seen).toHaveLength(1);
    expect(seen[0].payload.entity_type).toBe('some_future_kind');
    expect(s.world.inbox).toEqual([{ module: 'lab', tenant_id: TENANT_A, event_id: EVENT_ID }]);
  });

  it('control: a known entity_type is handled', async () => {
    const handler = vi.fn(async () => undefined);
    const s = await catalogSetup(handler, {});
    await s.run(evtId('lab', CATALOG_CHANGED), payload);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('control: a NON-extensible enum (change_kind) with an unknown value is still rejected and its inbox row rolled back', async () => {
    const handler = vi.fn(async () => undefined);
    const s = await catalogSetup(handler, { change_kind: 'exploded' });
    await rejects(s.run(evtId('lab', CATALOG_CHANGED), payload));
    expect(handler).not.toHaveBeenCalled();
    expect(s.world.inbox).toHaveLength(0);
  });
});

describe('plain module tasks and manifest options', () => {
  const rescan = async (_p: any, _ctx: any) => undefined;

  it('a module task runs in a tenant tx with that module\'s system actor and the payload tenant', async () => {
    let seen: any;
    const s = await setup([{ module: 'reporting', tasks: { 'reporting.nightly_digest': async (p: any, ctx: any) => { seen = { p, ctx }; } } }]);
    await s.run('reporting.nightly_digest', { tenant_id: TENANT_A }, { id: '9', attempts: 2 });
    expect(seen.ctx.tenantId).toBe(TENANT_A);
    expect(seen.ctx.actor).toEqual({ type: 'system', id: systemActorOf('reporting') });
    expect(seen.ctx.attempt).toBe(2); expect(seen.ctx.jobId).toBe('9');
    expect(s.world.txLog.some((t) => t.claims0.tenant_id === TENANT_A && t.claims0.sub === systemActorOf('reporting'))).toBe(true);
  });

  it('manifest maxAttempts overrides the registry value (CV §7.5 classes)', async () => {
    const s = await setup([{ module: 'reporting', tasks: { 'reporting.send_message': rescan }, maxAttempts: { 'reporting.send_message': 8 } }]);
    expect(s.entry('reporting.send_message')).toMatchObject({ module: 'reporting', kind: 'task', maxAttempts: 8 });
  });

  it('taskOptions.statementTimeoutMs above 300000 is rejected at build time; 300000 is accepted', async () => {
    const mk = (ms: number) => ({ module: 'reporting', tasks: { 'reporting.render': rescan }, taskOptions: { 'reporting.render': { statementTimeoutMs: ms } } });
    await rejectsBuild([mk(300_001)]);
    const ok = await setup([mk(300_000)]);
    expect(ok.built.taskOptions['reporting.render']).toEqual({ statementTimeoutMs: 300000 });
  });

  it('a task identifier outside its module namespace is rejected at build time', async () => {
    await rejectsBuild([{ module: 'reporting', tasks: { 'lab.sneaky': rescan } }]);
  });
});
