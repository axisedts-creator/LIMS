// core.event_fanout (02-TRD §7.3 / 7.5; AC-0D-5.4). Goes through buildTaskList(): the fan-out reads subscribers from the loaded manifests.
import { beforeEach, describe, expect, it } from 'vitest';
import { CORE_ACTOR, EVENT_ID, ORDER_CREATED, TENANT_A, TENANT_B, evtId, orderCreatedEnvelope, rejects, rejectsBuild, setup, type Setup } from './helpers.js';

const noop = async () => undefined;
const labManifest = { module: 'lab', subscriptions: { [ORDER_CREATED]: noop } };
const reportingManifest = { module: 'reporting', subscriptions: { [ORDER_CREATED]: noop } };
const billingManifest = { module: 'billing', subscriptions: { 'catalog.changed.v1': noop } };
const payload = { event_id: EVENT_ID, tenant_id: TENANT_A };

describe('core.event_fanout', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup([labManifest, reportingManifest, billingManifest]);
    s.world.seedEvent(orderCreatedEnvelope());
  });

  it('AC-0D-5.4: enqueues exactly one job per subscribed module, evt.<module>.<event_type>, job_key <event_id>:<module>', async () => {
    await s.run('core.event_fanout', payload);
    expect(s.world.jobs.map((j) => j.identifier).sort()).toEqual([evtId('lab'), evtId('reporting')]);
    for (const m of ['lab', 'reporting']) {
      const j = s.world.jobs.find((x) => x.identifier === evtId(m))!;
      expect(j.jobKey).toBe(`${EVENT_ID}:${m}`);
      expect(j.maxAttempts).toBe(10);                                          // CV §7.5: evt.* = 10
    }
  });

  it('job payloads hold ids only: {event_id, tenant_id, event_type} - no envelope, no PHI (P1)', async () => {
    s.world.seedEvent(orderCreatedEnvelope());
    await s.run('core.event_fanout', payload);
    for (const j of s.world.jobs) {
      expect(Object.keys(j.payload).sort()).toEqual(['event_id', 'event_type', 'tenant_id']);
      expect(j.payload).toEqual({ event_id: EVENT_ID, tenant_id: TENANT_A, event_type: ORDER_CREATED });
      expect(JSON.stringify(j)).not.toContain('0190a000-0000-7000-8000-00000000ba7e');   // the envelope's patient_id
    }
  });

  it('runs in one tenant transaction with the core system actor and the event tenant (step 1)', async () => {
    await s.run('core.event_fanout', payload);
    const txs = s.world.txLog.filter((t) => t.stmts.some((x) => /app\.enqueue_job|core\.event_log/i.test(x.text)));
    expect(txs).toHaveLength(1);
    expect(txs[0]!.claims0).toMatchObject({ sub: CORE_ACTOR, tenant_id: TENANT_A, actor_type: 'system' });
    expect(txs[0]!.outcome).toBe('commit');
  });

  it('a re-run fan-out does not duplicate jobs (job_key dedupe)', async () => {
    await s.run('core.event_fanout', payload);
    await s.run('core.event_fanout', payload);
    expect(s.world.jobs).toHaveLength(2);
  });

  it('an event nobody subscribes to enqueues nothing and completes', async () => {
    const lonely = orderCreatedEnvelope({ event_id: '0190a000-0000-7000-8000-00000000e002', event_type: 'catalog.changed.v1' });
    const other = await setup([labManifest]);
    other.world.seedEvent(lonely);
    await other.run('core.event_fanout', { event_id: lonely.event_id, tenant_id: TENANT_A });
    expect(other.world.jobs).toHaveLength(0);
  });

  it('missing event (after retention purge): logs fanout_event_missing, completes, enqueues nothing', async () => {
    await s.run('core.event_fanout', { event_id: '0190a000-0000-7000-8000-00000000e999', tenant_id: TENANT_A });
    expect(s.logs.has('fanout_event_missing')).toBe(true);
    expect(s.world.jobs).toHaveLength(0);
  });

  it('cross-tenant: an event of tenant B is invisible to a fan-out job of tenant A (RLS / tenant filter)', async () => {
    s.world.seedEvent(orderCreatedEnvelope({ event_id: '0190a000-0000-7000-8000-00000000e003', tenant_id: TENANT_B }));
    await s.run('core.event_fanout', { event_id: '0190a000-0000-7000-8000-00000000e003', tenant_id: TENANT_A });
    expect(s.world.jobs).toHaveLength(0);
    expect(s.logs.has('fanout_event_missing')).toBe(true);
  });

  it('lims_core_event_fanout_lag_seconds = now - occurred_at (step 4)', async () => {
    await s.run('core.event_fanout', payload);
    expect(s.metrics.last('observe', 'lims_core_event_fanout_lag_seconds')?.value).toBe(30);
  });

  it('atomic: when one enqueue fails, no consumer job is left behind and the task rethrows (Graphile retries)', async () => {
    s.world.failOn(/app\.enqueue_job/i, () => new Error('db down'), { when: (_c, v) => v[0] === evtId('reporting') });
    const e = await rejects(s.run('core.event_fanout', payload));
    expect(e).toBeInstanceOf(Error);
    expect(s.world.jobs).toHaveLength(0);
  });

  it('registry: core.event_fanout is a core task with max_attempts 25; evt tasks exist only for subscriptions', async () => {
    expect(s.entry('core.event_fanout')).toMatchObject({ kind: 'core', maxAttempts: 25 });
    expect(s.entry(evtId('lab'))).toMatchObject({ kind: 'consumer', module: 'lab', scope: 'per_tenant', maxAttempts: 10 });
    expect(s.entry(evtId('billing', 'catalog.changed.v1'))).toBeDefined();
    expect(s.entry(evtId('billing'))).toBeUndefined();                          // billing does not subscribe to order.created
    expect(s.built.taskList[evtId('analytics')]).toBeUndefined();
  });

  it('subscription outside EVENT_CONSUMERS for that module fails at build time (manifest check)', async () => {
    const bad = { module: 'instruments', subscriptions: { [ORDER_CREATED]: noop } };    // instruments consumes catalog.changed only
    const e = await rejectsBuild([bad]);
    expect(String((e as Error).message)).toMatch(/instruments/);
  });

  it('log lines never carry the envelope payload (patient id)', async () => {
    await s.run('core.event_fanout', payload);
    expect(s.logs.text()).not.toContain('0190a000-0000-7000-8000-00000000ba7e');
  });
});
