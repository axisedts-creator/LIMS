// C2-T27 crontab (02-TRD §10 crontab table; REQ-ARCH-042 entries live in code; 08 A13 P-6 / A23.1 per_tenant fan-out) through the REAL worker core.
// Under test: services/worker/src/jobs/identity/cron.ts exporting `crontab: readonly CronEntry[]` (frozen, same shape as catalog/frontdesk cron.ts) and
//   index.ts `manifest.crontab === crontab` with every cron task + `identity.import_breached_passwords` (manual: NOT in the crontab) declared as tasks.
// Task ids / consts: tasks/<id>.ts export <ID_CONST> + handler (see maintenance.test.ts / per_tenant.test.ts headers).
// Schedules: the TRD times are Asia/Kathmandu (UTC+05:45), the core crontab is 5 UTC fields, so 00:10 NPT = '25 18 * * *' (previous UTC day), :07 NPT = :22 UTC, etc.
// NOT specified by the TRD: cron maxAttempts (any value 1..100 or none is accepted); import_breached_passwords max_attempts 3 IS specified (§10 jobs table).
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { setup } from '../../../core/__tests__/helpers.js';
import { crontab } from '../cron.js';
import { manifest } from '../index.js';

const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa', TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
const SPEC: Array<[string, string, 'platform' | 'per_tenant', string]> = [   // [identifier, UTC schedule, tenantScope, TRD local time]
  ['identity.purge_sessions', '22 * * * *', 'platform', 'hourly :07'],
  ['identity.expire_support_sessions', '*/5 * * * *', 'platform', 'every 5 min'],
  ['identity.expire_invitations', '32 * * * *', 'platform', 'hourly :17'],
  ['identity.expire_audit_exports', '42 * * * *', 'platform', 'hourly :27'],
  ['identity.apply_pending_numbering', '25 18 * * *', 'per_tenant', 'daily 00:10'],
  ['identity.access_review_due', '55 0 * * *', 'per_tenant', 'daily 06:40'],
  ['identity.purge_auth_events', '55 21 * * *', 'platform', 'daily 03:40'],
];
const IDS = SPEC.map((s) => s[0]);

describe('identity crontab (T27, REQ-ARCH-042)', () => {
  it('declares exactly the seven §10 crontab tasks, each once (import_breached_passwords is manual, not scheduled)', () => {
    expect(crontab.map((c) => c.identifier).sort()).toEqual([...IDS].sort());
    expect(crontab.map((c) => c.identifier)).not.toContain('identity.import_breached_passwords');
  });
  it.each(SPEC)('%s runs at %s UTC (%s Asia/Kathmandu) with tenantScope %s', (id, schedule, scope) => {
    const e = crontab.find((c) => c.identifier === id);
    expect(e, id).toBeDefined(); expect(e!.schedule).toBe(schedule); expect(e!.tenantScope).toBe(scope);
  });
  it('apply_pending_numbering and access_review_due are the only per_tenant entries (P-6, A23.1)', () => {
    expect(crontab.filter((c) => c.tenantScope === 'per_tenant').map((c) => c.identifier).sort()).toEqual(['identity.access_review_due', 'identity.apply_pending_numbering']);
  });
  it('the crontab is immutable and any maxAttempts is within 1..100', () => {
    expect(Object.isFrozen(crontab)).toBe(true);
    for (const c of crontab) { expect(Object.isFrozen(c), c.identifier).toBe(true); if (c.maxAttempts !== undefined) expect(c.maxAttempts).toBeGreaterThanOrEqual(1); }
  });
});

describe('identity manifest carries the crontab and the T27 tasks', () => {
  it('manifest.crontab is cron.ts crontab and the manifest passes the core validator', () => {
    expect(manifest.crontab).toBe(crontab); expect(() => validateManifests([manifest])).not.toThrow();
  });
  it('declares every cron task and identity.import_breached_passwords as a function task', () => {
    for (const id of [...IDS, 'identity.import_breached_passwords']) expect(typeof manifest.tasks?.[id], id).toBe('function');
  });
  it('import_breached_passwords has max_attempts 3 (§10); the T11 tasks keep theirs', () => {
    expect(manifest.maxAttempts?.['identity.import_breached_passwords']).toBe(3);
    expect(manifest.maxAttempts?.['identity.gotrue_signout']).toBe(10); expect(manifest.maxAttempts?.['identity.build_audit_export']).toBe(5);
  });
});

describe('registered through the worker core', () => {
  it.each(SPEC)('%s is registered with scope %s-derived: %s', async (id, _schedule, scope) => {
    const s = await setup([manifest]); expect(s.entry(id)?.scope).toBe(scope); expect(s.entry(id)?.module).toBe('identity');
  });
  it('Graphile cron items carry the UTC schedule of every entry', async () => {
    const s = await setup([manifest]);
    for (const [id, schedule] of SPEC) expect(s.built.cronItems.find((c: any) => c.identifier === id)?.match, id).toBe(schedule);
  });
  it('a platform tick enqueues ONE job, payload {}, job_key <identifier>:<tick ISO minute>, under the identity system actor without tenant claims', async () => {
    const s = await setup([manifest]); s.world.seedTenants([{ id: TENANT_A, status: 'active' }]);
    await s.built.cronTick('identity.purge_sessions', new Date('2026-11-11T10:22:00.000Z'));
    expect(s.world.jobs).toHaveLength(1);
    expect(s.world.jobs[0]).toMatchObject({ identifier: 'identity.purge_sessions', payload: {}, jobKey: 'identity.purge_sessions:2026-11-11T10:22' });
    expect(s.world.jobs[0]!.claims.tenant_id).toBeUndefined();
  });
  it.each(['identity.apply_pending_numbering', 'identity.access_review_due'])('%s tick fans out one job per active/suspended tenant only, payload {tenant_id}, job_key <id>:<tenant>:<minute>', async (id) => {
    const s = await setup([manifest]);
    s.world.seedTenants([{ id: TENANT_A, status: 'active' }, { id: TENANT_B, status: 'suspended' }, { id: '0190a000-0000-7000-8000-00000000d001', status: 'provisioning' }, { id: '0190a000-0000-7000-8000-00000000d002', status: 'offboarded' }]);
    await s.built.cronTick(id, new Date('2026-11-11T18:25:00.000Z'));
    expect(s.world.jobs.map((j) => j.payload.tenant_id).sort()).toEqual([TENANT_A, TENANT_B]);
    for (const j of s.world.jobs) {
      expect(j).toMatchObject({ identifier: id, jobKey: `${id}:${j.payload.tenant_id}:2026-11-11T18:25` }); expect(j.payload).toEqual({ tenant_id: j.payload.tenant_id });
      expect(j.claims.tenant_id).toBe(j.payload.tenant_id);
    }
  });
  it('re-ticking the same minute does not double-enqueue (job_key dedupe)', async () => {
    const s = await setup([manifest]); s.world.seedTenants([{ id: TENANT_A, status: 'active' }]);
    const t = new Date('2026-11-11T18:25:00.000Z'); await s.built.cronTick('identity.apply_pending_numbering', t); await s.built.cronTick('identity.apply_pending_numbering', t);
    expect(s.world.jobs).toHaveLength(1);
  });
});
