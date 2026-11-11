// C2-T11 worker module base: identity WorkerManifest + retry / dead-letter behaviour through the REAL worker core (02-TRD §3 tree, §10; C0 02-TRD §7.2, §7.4).
// ASSUMED seam: ../index.ts exports `manifest: WorkerManifest` (same name as jobs/analytics/index.ts), module 'identity', subscriptions {} (C2 consumes no events),
//   tasks = every implemented identity task (T11: gotrue_signout, send_invitation, send_recovery, remove_mfa_factors, build_audit_export; later tasks add themselves),
//   maxAttempts per the §10 table. The manifest must not boot any GoTrue/DB client at import time.
// NOT covered (spec gap, see notes): core registers a non-cron task as per_tenant, so platform-kind payloads ({user_id} / {invitation_id} / {email_norm}) have no tenant_id and
//   `taskRun` (core/consumer.ts tenantOf) would refuse them; the manifest/core need a way to declare a task platform-scoped. Handlers are tested directly for that shape.
import { describe, expect, it, vi } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { setup } from '../../../core/__tests__/helpers.js';
import { manifest } from '../index.js';
import { createGotrueSignout } from '../tasks/gotrue_signout.js';
import { createSendInvitation } from '../tasks/send_invitation.js';
import { createRemoveMfaFactors } from '../tasks/remove_mfa_factors.js';
import { TENANT, idN, down, gt, err } from './t11.helpers.js';

const IDS = ['identity.gotrue_signout', 'identity.send_invitation', 'identity.send_recovery', 'identity.remove_mfa_factors', 'identity.build_audit_export'] as const;
const ATTEMPTS: Record<string, number> = { 'identity.gotrue_signout': 10, 'identity.send_invitation': 8, 'identity.send_recovery': 8, 'identity.remove_mfa_factors': 10, 'identity.build_audit_export': 5 };

describe('identity WorkerManifest', () => {
  it('is module identity, passes the core manifest validator, subscribes to nothing', () => {
    expect(manifest.module).toBe('identity'); expect(() => validateManifests([manifest])).not.toThrow(); expect(Object.keys(manifest.subscriptions ?? {})).toEqual([]);
  });
  it.each(IDS)('declares task %s as a function with the §10 max_attempts', (id) => {
    expect(typeof manifest.tasks?.[id]).toBe('function'); expect(manifest.maxAttempts?.[id]).toBe(ATTEMPTS[id]);
  });
  it('every task id is identity.<snake_task> and every maxAttempts / crontab key refers to a declared task', () => {
    for (const id of Object.keys(manifest.tasks ?? {})) expect(id).toMatch(/^identity\.[a-z0-9_]+$/);
    for (const id of Object.keys(manifest.maxAttempts ?? {})) expect(Object.keys(manifest.tasks ?? {})).toContain(id);
  });
  it('registers in the worker core with the §10 attempts (registry rows)', async () => {
    const s = await setup([manifest]); for (const id of IDS) expect(s.entry(id)?.maxAttempts).toBe(ATTEMPTS[id]);
  });
});

// ---- failures -> dead letters, through buildTaskList + withDeadLetter + taskRun (tenant tasks), with the handlers' own deps faked
const FAILING = {
  signout: { id: 'identity.gotrue_signout', max: 10, key: `signout:${idN(1)}:lock`, payload: { user_id: idN(1), tenant_id: TENANT },
    mk: (e: () => unknown) => createGotrueSignout({ gotrue: { adminSignOutUser: async () => { throw e(); }, signOut: async () => { throw e(); } }, repo: { sessionAccessToken: async () => 'a.b.c' } } as any) },
  invite: { id: 'identity.send_invitation', max: 8, key: `invite:${idN(2)}:1`, payload: { tenant_id: TENANT, invitation_id: idN(2) },
    mk: (e: () => unknown) => createSendInvitation({ gotrue: { sendInvite: async () => { throw e(); } }, repo: { loadInvitation: async () => ({ id: idN(2), status: 'pending', email: 'x@lims-test.example', expires_at: '2099-01-01T00:00:00Z' }), markSent: async () => undefined, markFailed: async () => undefined } } as any) },
  mfa: { id: 'identity.remove_mfa_factors', max: 10, key: `mfa_reset:${idN(3)}:4`, payload: { tenant_id: TENANT, user_id: idN(1), membership_id: idN(3) },
    mk: (e: () => unknown) => createRemoveMfaFactors({ gotrue: { adminDeleteFactor: async () => { throw e(); } }, repo: { listFactors: async () => [{ id: idN(8), gotrue_factor_id: idN(9), status: 'verified' }], markRemoved: async () => undefined } } as any) },
} as const;

describe.each(Object.entries(FAILING))('%s: failure behaviour through the worker core', (_name, f) => {
  const boot = (e: () => unknown) => setup([{ module: 'identity', tasks: { [f.id]: f.mk(e) }, maxAttempts: { [f.id]: f.max } } as any]);
  it(`attempt 1 of ${f.max}: the error propagates (queue retries) and NO dead letter is written`, async () => {
    const s = await boot(down); expect(await err(s.run(f.id, f.payload, { attempts: 1, key: f.key }))).toBeDefined(); expect(s.world.deadLetters).toHaveLength(0);
  });
  it('the final attempt writes exactly one core.dead_letters row (task, tenant, error code, attempts, job_key, payload) and still rethrows', async () => {
    const s = await boot(down); const e = await err(s.run(f.id, f.payload, { attempts: f.max, key: f.key })); expect(e).toBeDefined();
    expect(s.world.deadLetters).toHaveLength(1); const r = s.world.deadLetters[0];
    expect(r).toMatchObject({ task_identifier: f.id, tenant_id: TENANT, last_error_code: 'common.dependency_unavailable', attempts: f.max, job_key: f.key, state: 'open' }); expect(r.job_payload).toEqual(f.payload);
  });
  it('a non-LimsError failure (GoTrue 500) also dead-letters on the final attempt, with the generic code', async () => {
    const s = await boot(() => gt('x', 500, 'unexpected_failure')); await err(s.run(f.id, f.payload, { attempts: f.max, key: f.key })); expect(s.world.deadLetters).toHaveLength(1); expect(s.world.deadLetters[0].last_error_code).toBe('common.internal');
  });
});

describe('success and permanent-skip paths never dead-letter', () => {
  it('send_invitation: a permanent GoTrue 4xx marks the row failed and the job completes (no dead letter, even on the last attempt)', async () => {
    const markFailed = vi.fn(async () => undefined);
    const task = createSendInvitation({ gotrue: { sendInvite: async () => { throw gt('sendInvite', 422, 'email_exists'); } }, repo: { loadInvitation: async () => ({ id: idN(2), status: 'pending', email: 'x@lims-test.example', expires_at: '2099-01-01T00:00:00Z' }), markSent: async () => undefined, markFailed } } as any);
    const s = await setup([{ module: 'identity', tasks: { 'identity.send_invitation': task } } as any]);
    await s.run('identity.send_invitation', { tenant_id: TENANT, invitation_id: idN(2) }, { attempts: 8, maxAttempts: 8 }); expect(markFailed).toHaveBeenCalledTimes(1); expect(s.world.deadLetters).toHaveLength(0);
  });
  it('gotrue_signout: already-gone user/session and a normal run complete with no dead letter', async () => {
    const task = createGotrueSignout({ gotrue: { adminSignOutUser: async () => { throw gt('adminSignOutUser', 404, 'user_not_found'); }, signOut: async () => undefined }, repo: { sessionAccessToken: async () => null } } as any);
    const s = await setup([{ module: 'identity', tasks: { 'identity.gotrue_signout': task } } as any]);
    await s.run('identity.gotrue_signout', { user_id: idN(1), tenant_id: TENANT }, { attempts: 10, maxAttempts: 10 }); expect(s.world.deadLetters).toHaveLength(0);
  });
  it('a malformed payload (bug in an enqueuer) is NOT silently acked: it fails every attempt and lands in the dead letters at the end', async () => {
    const task = createGotrueSignout({ gotrue: { adminSignOutUser: async () => undefined, signOut: async () => undefined }, repo: { sessionAccessToken: async () => null } } as any);
    const s = await setup([{ module: 'identity', tasks: { 'identity.gotrue_signout': task }, maxAttempts: { 'identity.gotrue_signout': 10 } } as any]);
    const p = { tenant_id: TENANT, nonsense: true }; expect(await err(s.run('identity.gotrue_signout', p, { attempts: 10, maxAttempts: 10 }))).toBeDefined(); expect(s.world.deadLetters).toHaveLength(1);
  });
});
