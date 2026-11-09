// worker:replay (02-TRD §7.1 replay.ts, line 791; 03-APP-FLOW E-10; LD-65). `pnpm worker:replay --event-type --since --module`:
// re-enqueues evt.<module>.<event_type> consumer jobs for stored events, stays within the 90-day event_log retention and enqueues
// ONLY through app.enqueue_job. Assumed exports of ../replay.js (the spec gives the CLI flags, not the functions):
//   parseReplayArgs(argv: string[]) -> { eventType: string; since: Date; module: string }     (throws on a missing/unknown flag or bad date)
//   replayEvents(deps: WorkerDeps, { eventType, since, module }) -> Promise<{ enqueued: number }>   (deps.now() is the retention clock)
// Job shape = the fan-out's (02-TRD §7.3): payload {event_id, tenant_id, event_type}, job_key '<event_id>:<module>' (same key as the original
// fan-out: a still-pending original dedupes, and the consumer inbox makes a re-delivery a no-op), under that tenant's claims for the
// module's system actor. Events are only visible per tenant (RLS), so the tenant list comes from app.cron_tenant_ids().
import { beforeEach, describe, expect, it } from 'vitest';
import { FIXED_NOW, ORDER_CREATED, TENANT_A, TENANT_B, TENANT_C, TENANT_OFF, makeLog, makeMetrics, rejects, systemActorOf } from './helpers.js';
import { makeReplayWorld, type EventRow, type ReplayWorld } from './replay-world.js';

const DAY = 86_400_000;
const CANCELLED = 'frontdesk.order.cancelled.v1';
const noop = async () => undefined;
const manifests = [
  { module: 'lab', subscriptions: { [ORDER_CREATED]: noop } },
  { module: 'reporting', subscriptions: { [ORDER_CREATED]: noop } },
];
const eid = (n: number) => `0190a000-0000-7000-8000-${String(0xe0000 + n).padStart(12, '0')}`;
const at = (daysAgo: number) => new Date(FIXED_NOW.getTime() - daysAgo * DAY).toISOString();
const ev = (n: number, tenant: string, daysAgo: number, type = ORDER_CREATED): EventRow => ({ tenant_id: tenant, event_id: eid(n), event_type: type, occurred_at: at(daysAgo) });

let world: ReplayWorld; let deps: any; let metrics: ReturnType<typeof makeMetrics>; let logs: ReturnType<typeof makeLog>;

beforeEach(async () => {
  const { buildTaskList } = await import('../tasklist.js');
  world = makeReplayWorld(); metrics = makeMetrics(); logs = makeLog();
  deps = {
    db: world.db, withTenantScope: world.withTenantScope, systemActorOf, coreActorId: '0190a000-0000-7000-8000-0000000c0000', metrics, log: logs.log, now: () => FIXED_NOW,
    events: {}, core: {}, storage: {}, files: {}, audit: {},
  };
  world.loadRegistry(buildTaskList(deps, manifests as any).registry as any);
  world.seedTenants([{ id: TENANT_A, status: 'active' }, { id: TENANT_B, status: 'suspended' }, { id: TENANT_C, status: 'active' }, { id: TENANT_OFF, status: 'offboarded' }]);
});

const args = (over: Record<string, string> = {}) => {
  const a = { '--event-type': ORDER_CREATED, '--since': at(10), '--module': 'lab', ...over };
  return Object.entries(a).flatMap(([k, v]) => [k, v]);
};

describe('parseReplayArgs', () => {
  it('parses --event-type, --since (ISO) and --module', async () => {
    const { parseReplayArgs } = await import('../replay.js');
    const out = parseReplayArgs(args({ '--since': '2026-11-01T00:00:00.000Z' }));
    expect(out).toMatchObject({ eventType: ORDER_CREATED, module: 'lab' });
    expect(out.since).toBeInstanceOf(Date);
    expect(out.since.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it.each(['--event-type', '--since', '--module'])('a missing %s is rejected', async (flag) => {
    const { parseReplayArgs } = await import('../replay.js');
    const argv = args(); const i = argv.indexOf(flag);
    argv.splice(i, 2);
    expect(() => parseReplayArgs(argv)).toThrow();
  });

  it('an unparseable --since and an unknown flag are rejected', async () => {
    const { parseReplayArgs } = await import('../replay.js');
    expect(() => parseReplayArgs(args({ '--since': 'last tuesday' }))).toThrow();
    expect(() => parseReplayArgs([...args(), '--all-tenants', 'yes'])).toThrow();
  });
});

describe('retention window (<= 90 days, E-10)', () => {
  it('refuses a range older than 90 days, before touching the database', async () => {
    const { replayEvents } = await import('../replay.js');
    const err = await rejects(replayEvents(deps, { eventType: ORDER_CREATED, module: 'lab', since: new Date(FIXED_NOW.getTime() - 90 * DAY - 1) }));
    expect(String(err?.message)).toMatch(/retention|90/i);
    expect(world.txLog).toHaveLength(0);
    expect(world.jobs).toHaveLength(0);
  });

  it('refuses a far-too-old range (a year)', async () => {
    const { replayEvents } = await import('../replay.js');
    await rejects(replayEvents(deps, { eventType: ORDER_CREATED, module: 'lab', since: new Date(FIXED_NOW.getTime() - 365 * DAY) }));
    expect(world.jobs).toHaveLength(0);
  });

  it('accepts exactly 90 days', async () => {
    const { replayEvents } = await import('../replay.js');
    world.seedEvents([ev(1, TENANT_A, 89)]);
    const out = await replayEvents(deps, { eventType: ORDER_CREATED, module: 'lab', since: new Date(FIXED_NOW.getTime() - 90 * DAY) });
    expect(out.enqueued).toBe(1);
  });
});

describe('what is enqueued', () => {
  beforeEach(() => {
    world.seedEvents([
      ev(1, TENANT_A, 5), ev(2, TENANT_A, 3), ev(3, TENANT_B, 4), ev(4, TENANT_C, 1),
      ev(5, TENANT_A, 2, CANCELLED),            // other event type
      ev(6, TENANT_A, 40),                      // older than --since
      ev(7, TENANT_OFF, 2),                     // offboarded tenant: not in app.cron_tenant_ids
    ]);
  });
  const since = () => new Date(FIXED_NOW.getTime() - 10 * DAY);

  it('one evt.<module>.<event_type> job per matching event in range, payload ids only, job_key <event_id>:<module>', async () => {
    const { replayEvents } = await import('../replay.js');
    const out = await replayEvents(deps, { eventType: ORDER_CREATED, module: 'lab', since: since() });
    expect(out.enqueued).toBe(4);
    expect(world.jobs.map((j) => j.identifier)).toEqual(Array(4).fill(`evt.lab.${ORDER_CREATED}`));
    expect(world.jobs.map((j) => j.payload.event_id).sort()).toEqual([eid(1), eid(2), eid(3), eid(4)]);
    for (const j of world.jobs) {
      expect(j.payload).toEqual({ event_id: j.payload.event_id, tenant_id: j.payload.tenant_id, event_type: ORDER_CREATED });
      expect(j.jobKey).toBe(`${j.payload.event_id}:lab`);
    }
  });

  it('each job is enqueued under that event tenant claims for the module system actor (tenant-match check holds)', async () => {
    const { replayEvents } = await import('../replay.js');
    await replayEvents(deps, { eventType: ORDER_CREATED, module: 'reporting', since: since() });
    expect(world.jobs).toHaveLength(4);
    for (const j of world.jobs) expect(j.claims).toEqual({ sub: systemActorOf('reporting'), tenant_id: j.payload.tenant_id, actor_type: 'system' });
  });

  it('only the requested module gets jobs', async () => {
    const { replayEvents } = await import('../replay.js');
    await replayEvents(deps, { eventType: ORDER_CREATED, module: 'lab', since: since() });
    expect(world.jobs.some((j) => j.identifier.startsWith('evt.reporting.'))).toBe(false);
  });

  it('enqueues only through app.enqueue_job (no direct write to the queue or any table)', async () => {
    const { replayEvents } = await import('../replay.js');
    await replayEvents(deps, { eventType: ORDER_CREATED, module: 'lab', since: since() });
    expect(world.stmts(/graphile_worker/i).filter((s) => !/app\.enqueue_job/i.test(s.text))).toHaveLength(0);
    expect(world.stmts(/\b(INSERT|UPDATE|DELETE)\b/i)).toHaveLength(0);
    expect(world.stmts(/app\.enqueue_job/i)).toHaveLength(4);
  });

  it('is idempotent: a second run enqueues no new job (same job_key)', async () => {
    const { replayEvents } = await import('../replay.js');
    await replayEvents(deps, { eventType: ORDER_CREATED, module: 'lab', since: since() });
    await replayEvents(deps, { eventType: ORDER_CREATED, module: 'lab', since: since() });
    expect(world.jobs).toHaveLength(4);
  });

  it('a module that does not consume the event type is refused and nothing is enqueued', async () => {
    const { replayEvents } = await import('../replay.js');
    await rejects(replayEvents(deps, { eventType: ORDER_CREATED, module: 'instruments', since: since() }));
    expect(world.jobs).toHaveLength(0);
  });

  it('an event type with no stored events enqueues nothing and succeeds', async () => {
    const { replayEvents } = await import('../replay.js');
    const out = await replayEvents(deps, { eventType: 'frontdesk.order.items_changed.v1', module: 'lab', since: since() });
    expect(out.enqueued).toBe(0);
  });

  it('log lines and metrics carry no event payload (ids/counts only)', async () => {
    const { replayEvents } = await import('../replay.js');
    await replayEvents(deps, { eventType: ORDER_CREATED, module: 'lab', since: since() });
    expect(logs.text()).not.toMatch(/Sita|patient|SENTINEL/i);
  });

  it('pages through a large range: every matching event exactly once', async () => {
    const { replayEvents } = await import('../replay.js');
    const many: EventRow[] = Array.from({ length: 1200 }, (_v, i) => ev(1000 + i, TENANT_A, 2));
    world.seedEvents(many);
    const out = await replayEvents(deps, { eventType: ORDER_CREATED, module: 'lab', since: since() });
    expect(out.enqueued).toBe(1204);
    expect(new Set(world.jobs.map((j) => j.jobKey)).size).toBe(1204);
  }, 30_000);
});

describe('failure', () => {
  it('an enqueue failure surfaces (no silent partial success) and the failing event leaves no job', async () => {
    const { replayEvents } = await import('../replay.js');
    world.seedEvents([ev(1, TENANT_A, 2), ev(2, TENANT_A, 1)]);
    world.failOn(/app\.enqueue_job/i, () => Object.assign(new Error('boom'), { code: '57P01' }), { times: 1 });
    await rejects(replayEvents(deps, { eventType: ORDER_CREATED, module: 'lab', since: new Date(FIXED_NOW.getTime() - 10 * DAY) }));
    expect(world.jobs.filter((j) => j.payload.event_id === eid(1) || j.payload.event_id === eid(2)).length).toBeLessThan(2);
  });
});
