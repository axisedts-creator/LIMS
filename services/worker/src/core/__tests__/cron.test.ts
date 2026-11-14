// Cron (02-TRD §7.2 tenantScope, §7.6; AC-0D-5.15; 08 A13 P-6, A23.1). Ticks go through built.cronTick(identifier, tickDate);
// the crontab itself is built.cronItems (Graphile-style items with `task` and 5-field UTC `match`).
import { describe, expect, it } from 'vitest';
import { CORE_ACTOR, TENANT_A, TENANT_B, TENANT_C, TENANT_OFF, TENANT_PROV, rejects, rejectsBuild, setup, systemActorOf } from './helpers.js';

const digest = async () => undefined;
const manifest = { module: 'reporting', tasks: { 'reporting.nightly_digest': digest }, crontab: [{ identifier: 'reporting.nightly_digest', schedule: '0 2 * * *', tenantScope: 'per_tenant', maxAttempts: 4 }] };
const TICK = new Date('2026-11-07T21:30:45.123Z');
const MINUTE = '2026-11-07T21:30';

async function cronSetup() {
  const s = await setup([manifest]);
  s.world.seedTenants([
    { id: TENANT_A, status: 'active' }, { id: TENANT_B, status: 'suspended' }, { id: TENANT_C, status: 'active' },
    { id: TENANT_PROV, status: 'provisioning' }, { id: TENANT_OFF, status: 'offboarded' },
  ]);
  return s;
}

describe('AC-0D-5.15: per_tenant crontab entry', () => {
  it('enqueues exactly one job per active or suspended tenant with payload {tenant_id} and job_key <identifier>:<tenant_id>:<tick ISO minute>', async () => {
    const s = await cronSetup();
    await s.built.cronTick('reporting.nightly_digest', TICK);
    const jobs = s.world.jobs.filter((j) => j.identifier === 'reporting.nightly_digest');
    expect(jobs.map((j) => j.payload.tenant_id).sort()).toEqual([TENANT_A, TENANT_B, TENANT_C].sort());
    for (const j of jobs) {
      expect(j.payload).toEqual({ tenant_id: j.payload.tenant_id });
      expect(j.jobKey).toBe(`reporting.nightly_digest:${j.payload.tenant_id}:${MINUTE}`);
    }
  });

  it('none for provisioning / offboarded tenants', async () => {
    const s = await cronSetup();
    await s.built.cronTick('reporting.nightly_digest', TICK);
    const ids = s.world.jobs.map((j) => j.payload.tenant_id);
    expect(ids).not.toContain(TENANT_PROV);
    expect(ids).not.toContain(TENANT_OFF);
  });

  it('a repeated tick for the same minute enqueues nothing new; the next minute enqueues again', async () => {
    const s = await cronSetup();
    await s.built.cronTick('reporting.nightly_digest', TICK);
    await s.built.cronTick('reporting.nightly_digest', new Date('2026-11-07T21:30:59.999Z'));
    expect(s.world.jobs).toHaveLength(3);
    await s.built.cronTick('reporting.nightly_digest', new Date('2026-11-07T21:31:00.000Z'));
    expect(s.world.jobs).toHaveLength(6);
  });

  it('the tenant list is read under core system-actor claims with NO tenant (app.cron_tenant_ids)', async () => {
    const s = await cronSetup();
    await s.built.cronTick('reporting.nightly_digest', TICK);
    const list = s.world.stmtsMatching(/app\.cron_tenant_ids/i);
    expect(list).toHaveLength(1);
    expect(list[0]!.claims).toMatchObject({ sub: CORE_ACTOR });
    expect(list[0]!.claims.tenant_id).toBeUndefined();
  });

  it("each tenant's enqueue runs in its OWN transaction under withTenantScope(tenant, module system actor)", async () => {
    const s = await cronSetup();
    await s.built.cronTick('reporting.nightly_digest', TICK);
    const jobs = s.world.jobs;
    expect(new Set(jobs.map((j) => j.txId)).size).toBe(3);
    for (const j of jobs) expect(j.claims).toMatchObject({ sub: systemActorOf('reporting'), tenant_id: j.payload.tenant_id, actor_type: 'system' });
  });

  it('passes the crontab entry maxAttempts to the enqueue', async () => {
    const s = await cronSetup();
    await s.built.cronTick('reporting.nightly_digest', TICK);
    expect(s.world.jobs.every((j) => j.maxAttempts === 4)).toBe(true);
  });

  it("one tenant's failed enqueue does not roll back another tenant's committed job (separate transactions)", async () => {
    const s = await cronSetup();
    s.world.failOn(/app\.enqueue_job/i, () => new Error('db hiccup'), { when: (c) => c.tenant_id === TENANT_B });
    await s.built.cronTick('reporting.nightly_digest', TICK).catch(() => undefined);
    const ids = s.world.jobs.map((j) => j.payload.tenant_id);
    expect(ids).toContain(TENANT_A);
    expect(ids).not.toContain(TENANT_B);
  });

  it('an identifier that is not a crontab entry is rejected', async () => {
    const s = await cronSetup();
    await rejects(s.built.cronTick('reporting.not_scheduled', TICK));
    expect(s.world.jobs).toHaveLength(0);
  });
});

describe('crontab assembly (in code, REQ-ARCH-042)', () => {
  it('contains the core entries with their UTC schedules and the manifest entry', async () => {
    const s = await cronSetup();
    const by = (task: string) => s.built.cronItems.filter((i: any) => i.task === task || i.identifier === task);
    expect(by('core.retention_purge').map((i: any) => i.match)).toEqual(['30 21 * * *']);
    expect(by('core.queue_depth_probe').map((i: any) => i.match)).toEqual(['* * * * *']);
    expect(JSON.stringify(s.built.cronItems)).toContain('reporting.nightly_digest');
    expect(JSON.stringify(s.built.cronItems)).toContain('0 2 * * *');
  });

  it('a crontab entry whose identifier is not a declared task of the module is rejected at build time', async () => {
    await rejectsBuild([{ module: 'reporting', tasks: {}, crontab: [{ identifier: 'reporting.ghost', schedule: '0 2 * * *', tenantScope: 'platform' }] }]);
  });

  it('a malformed schedule (not 5 fields) is rejected at build time', async () => {
    await rejectsBuild([{ module: 'reporting', tasks: { 'reporting.t': digest }, crontab: [{ identifier: 'reporting.t', schedule: '0 2 * *', tenantScope: 'platform' }] }]);
  });

  it('registry scope follows tenantScope: per_tenant entry -> per_tenant, core cron tasks -> platform', async () => {
    const s = await cronSetup();
    expect(s.entry('reporting.nightly_digest')).toMatchObject({ scope: 'per_tenant' });
    expect(s.entry('core.queue_depth_probe')).toMatchObject({ kind: 'core', scope: 'platform' });
  });
});

describe('core.queue_depth_probe', () => {
  it('exports app.queue_depth() as lims_queue_depth{task}, no payload or key labels', async () => {
    const s = await setup([]);
    s.world.setQueueDepth([{ task_identifier: 'evt.lab.frontdesk.order.created.v1', ready: 4, locked: 1, failed: 2 }, { task_identifier: 'core.event_fanout', ready: 0, locked: 0, failed: 0 }]);
    await s.run('core.queue_depth_probe', {});
    expect(s.metrics.last('set', 'lims_queue_depth', { task: 'evt.lab.frontdesk.order.created.v1' })).toBeDefined();
    expect(s.metrics.last('set', 'lims_queue_depth', { task: 'core.event_fanout' })?.value).toBe(0);
    expect(s.metrics.calls.filter((c) => c.name === 'lims_queue_depth').every((c) => Object.keys(c.labels).join() === 'task')).toBe(true);
  });
});
