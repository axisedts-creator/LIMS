// Dead-letter capture on the final attempt (02-TRD §7.4; AC-0D-5.6; 08 A23.2 job_key copy; 07-SECURITY AB-22 payload leak).
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../../packages/shared-ts/src/errors/index.js';
import { CORE_ACTOR, EVENT_ID, ORDER_CREATED, PHI, TENANT_A, UUIDV7, evtId, orderCreatedEnvelope, rejects, setup } from './helpers.js';

const evtPayload = { event_id: EVENT_ID, tenant_id: TENANT_A, event_type: ORDER_CREATED };
const task = evtId('lab');
const alwaysThrows = (make: () => Error) => async () => { throw make(); };

async function labSetup(make: () => Error = () => new Error('consumer exploded')) {
  const s = await setup([{ module: 'lab', subscriptions: { [ORDER_CREATED]: alwaysThrows(make) } }]);
  s.world.seedEvent(orderCreatedEnvelope());
  return s;
}

/** Runs attempts 1..max like Graphile Worker (attempts counts the current run); every run rejects. */
async function exhaust(s: Awaited<ReturnType<typeof setup>>, identifier: string, payload: unknown, max: number, key: string | null = null) {
  for (let attempt = 1; attempt <= max; attempt++) await rejects(s.run(identifier, payload, { attempts: attempt, maxAttempts: max, key, id: '42' }));
}

describe('AC-0D-5.6: consumer that throws on every attempt', () => {
  it('writes exactly one core.dead_letters row at max_attempts (10 for evt.*) and none before', async () => {
    const s = await labSetup();
    for (let attempt = 1; attempt <= 9; attempt++) {
      await rejects(s.run(task, evtPayload, { attempts: attempt, key: `${EVENT_ID}:lab` }));
      expect(s.world.deadLetters).toHaveLength(0);
    }
    await rejects(s.run(task, evtPayload, { attempts: 10, key: `${EVENT_ID}:lab` }));
    expect(s.world.deadLetters).toHaveLength(1);
  });

  it('the row: tenant, task, attempts, open/v1, ids-only payload, copied job_key, timestamps', async () => {
    const s = await labSetup();
    await exhaust(s, task, evtPayload, 10, `${EVENT_ID}:lab`);
    const r = s.world.deadLetters[0];
    expect(r).toMatchObject({ tenant_id: TENANT_A, task_identifier: task, attempts: 10, state: 'open', last_error_code: 'common.internal', job_key: `${EVENT_ID}:lab` });
    expect(r.id).toMatch(UUIDV7);
    expect(r.job_payload).toEqual(evtPayload);                                  // ids only (P1); needed for replay
    expect(new Date(r.first_failed_at).getTime()).toBeLessThanOrEqual(new Date(r.dead_at).getTime());
    expect(r.last_error_message_redacted).toContain('consumer exploded');
  });

  it('a job without a key stores job_key NULL (08 A23.2)', async () => {
    const s = await labSetup();
    await exhaust(s, task, evtPayload, 10, null);
    expect(s.world.deadLetters[0].job_key).toBeNull();
  });

  it('increments lims_core_dead_letters_total{task} once, labelled by task only', async () => {
    const s = await labSetup();
    await exhaust(s, task, evtPayload, 10);
    expect(s.metrics.total('lims_core_dead_letters_total', { task })).toBe(1);
    expect(s.metrics.calls.filter((c) => c.name === 'lims_core_dead_letters_total').every((c) => Object.keys(c.labels).join() === 'task')).toBe(true);
  });

  it('the failed attempt itself is rolled back (no inbox row) while the dead letter is committed in its OWN tenant transaction', async () => {
    const s = await labSetup();
    await exhaust(s, task, evtPayload, 10);
    expect(s.world.inbox).toHaveLength(0);
    const dlTx = s.world.txLog.filter((t) => t.stmts.some((x) => /core\.dead_letters/i.test(x.text)));
    expect(dlTx).toHaveLength(1);
    expect(dlTx[0]!.outcome).toBe('commit');
    expect(dlTx[0]!.claims0).toMatchObject({ tenant_id: TENANT_A, actor_type: 'system' });
    expect(s.world.txLog.filter((t) => t.outcome === 'rollback').length).toBeGreaterThanOrEqual(10);
  });

  it('every attempt, including the final one, rethrows so Graphile Worker records the failure', async () => {
    const s = await labSetup(() => new Error('nope'));
    const e = await rejects(s.run(task, evtPayload, { attempts: 10 }));
    expect(String((e as Error).message)).toContain('nope');
  });

  it('a job that fails then succeeds before the last attempt writes no dead letter', async () => {
    let n = 0;
    const s = await setup([{ module: 'lab', subscriptions: { [ORDER_CREATED]: async () => { if (++n < 3) throw new Error('flaky'); } } }]);
    s.world.seedEvent(orderCreatedEnvelope());
    await rejects(s.run(task, evtPayload, { attempts: 1 })); await rejects(s.run(task, evtPayload, { attempts: 2 }));
    await s.run(task, evtPayload, { attempts: 3 });
    expect(s.world.deadLetters).toHaveLength(0);
    expect(s.metrics.total('lims_core_dead_letters_total')).toBe(0);
  });
});

describe('error code and redaction', () => {
  it('keeps LimsError.code as last_error_code', async () => {
    const s = await labSetup(() => new LimsError('common.version_conflict'));
    await exhaust(s, task, evtPayload, 10);
    expect(s.world.deadLetters[0].last_error_code).toBe('common.version_conflict');
  });

  it('applies the logger scrubber and caps the message at 2,000 chars (CHECK dead_letters__msg__ck)', async () => {
    const msg = `render failed otp 482913 for 9812345678 with Bearer abc123def456 ${'x'.repeat(5000)}`;
    const s = await labSetup(() => new Error(msg));
    await exhaust(s, task, evtPayload, 10);
    const m: string = s.world.deadLetters[0].last_error_message_redacted;
    expect(m.length).toBeLessThanOrEqual(2000);
    expect(m).not.toContain('482913'); expect(m).not.toContain('9812345678'); expect(m).not.toContain('abc123def456');
  });

  it('an empty error message still yields a non-empty NOT NULL message column', async () => {
    const s = await labSetup(() => new Error(''));
    await exhaust(s, task, evtPayload, 10);
    expect(typeof s.world.deadLetters[0].last_error_message_redacted).toBe('string');
  });
});

describe('AB-22: job payload never leaks outside core.dead_letters.job_payload', () => {
  it('a plain tenant task with a PHI-ish payload: stored for replay, absent from logs and metric labels', async () => {
    const task2 = async () => { throw new Error('rescan failed'); };
    const s = await setup([{ module: 'lab', tasks: { 'lab.rescan': task2 } }]);
    const p = { tenant_id: TENANT_A, patient_note: PHI };
    await exhaust(s, 'lab.rescan', p, 5, 'rescan:1');
    expect(s.world.deadLetters).toHaveLength(1);
    expect(s.world.deadLetters[0]).toMatchObject({ tenant_id: TENANT_A, task_identifier: 'lab.rescan', attempts: 5, job_key: 'rescan:1' });
    expect(s.world.deadLetters[0].job_payload).toEqual(p);
    expect(s.logs.text()).not.toContain(PHI);
    expect(JSON.stringify(s.metrics.calls)).not.toContain(PHI);
    expect(s.world.deadLetters[0].last_error_message_redacted).not.toContain(PHI);
  });
});

describe('platform-scope tasks (tenantScope: platform)', () => {
  it('core.retention_purge dies through app.dl_insert_platform with tenant_id NULL and the job_key copied; no direct INSERT', async () => {
    const s = await setup([]);
    s.world.failPurge('idempotency_keys', () => new Error('purge exploded'));
    s.world.seedPurge('idempotency_keys', 5);
    expect(s.entry('core.retention_purge')).toMatchObject({ scope: 'platform', maxAttempts: 5 });
    await exhaust(s, 'core.retention_purge', {}, 5, 'core.retention_purge:2026-11-07T21:30');
    expect(s.world.deadLetters).toHaveLength(1);
    const r = s.world.deadLetters[0];
    expect(r).toMatchObject({ tenant_id: null, task_identifier: 'core.retention_purge', attempts: 5, state: 'open', via: 'dl_insert_platform', job_key: 'core.retention_purge:2026-11-07T21:30' });
    expect(r.claims.tenant_id).toBeUndefined();
    expect(r.claims.sub).toBe(CORE_ACTOR);
    expect(s.world.stmtsMatching(/INSERT\s+INTO\s+core\.dead_letters/i)).toHaveLength(0);
    expect(s.metrics.total('lims_core_dead_letters_total', { task: 'core.retention_purge' })).toBe(1);
  });

  it('a platform task failing before its last attempt writes nothing', async () => {
    const s = await setup([]);
    s.world.failPurge('idempotency_keys', () => new Error('purge exploded'));
    await rejects(s.run('core.retention_purge', {}, { attempts: 4, maxAttempts: 5 }));
    expect(s.world.deadLetters).toHaveLength(0);
  });
});
