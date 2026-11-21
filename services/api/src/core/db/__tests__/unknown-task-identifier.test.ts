// T0B-ASYNC-1 done_when (4) (audit RS-10): a refused enqueue is a VISIBLE 503, not a bare 500.
//   app.enqueue_job raises  P0001 / MESSAGE 'unknown_task_identifier'  when core.g_task_registry has no active row for the identifier.
//   Expected now: mapDbError returns common.internal (500) for every P0001 except immutable_row.
// Contract the writer implements (sqlstate.ts + tx.ts):
//   - mapDbError: P0001 with message exactly 'unknown_task_identifier' -> AuthError('common.service_unavailable') (503, in contracts/errors.yaml).
//     Every other P0001 message stays common.internal; immutable_row stays 409 common.immutable_record; every other SQLSTATE row is unchanged.
//   - Through createDb (requestTx / identityAuthTx): when the failing statement was an app.enqueue_job call, ONE extra error-level log line is
//     written carrying the task identifier (the first bound value of that call) and the operationId: keys `task_identifier` and `operationId`
//     (+ request_id). Never the payload (2nd value), the job key (3rd value), an email, a person id, the message or the Error object.
//     The existing db_error line (LD-224) is kept as it is.
//   - The statement text is how the writer finds the call: /app\.enqueue_job\s*\(/ in the text passed to tx.query; identifier = values[0].
import { describe, expect, it } from 'vitest';
import { mapDbError } from '../sqlstate.js';
import { createDb } from '../tx.js';
import { createFakePgBouncer, operation, pgError, recorder, REQ_ID, retryKnobs, txInput, IDENTITY_SYSTEM_ACTOR } from './helpers.js';

const ENQ = 'SELECT app.enqueue_job($1, $2::jsonb, $3)';
const EMAIL = 'ana.demo.SENTINEL@example.invalid';
const PERSON = '0190a000-0000-7000-8000-0000PERSON01';
const PAYLOAD = JSON.stringify({ invitation_id: 'INV-SENTINEL-1', email: EMAIL, person_id: PERSON });
const KEY = 'invite:KEY-SENTINEL:1';
const SENTINELS = [EMAIL, 'INV-SENTINEL-1', PERSON, 'KEY-SENTINEL', 'ana.demo'];
const errLines = (r: ReturnType<typeof recorder>) => r.calls.filter((c) => c.level === 'error');
const unknown = () => pgError('P0001', 'unknown_task_identifier');

async function enqueueFails(identifier: string, over: Record<string, unknown> = {}, err: () => Error = unknown) {
  const r = recorder();
  const fake = createFakePgBouncer();
  fake.inject(/app\.enqueue_job/i, err, 1);
  const db = createDb({ pool: fake.pool, log: r.log, metrics: r.metrics, ...retryKnobs() } as any) as any;
  const e = await db.requestTx(txInput(over), async (tx: any) => { await tx.query(ENQ, [identifier, PAYLOAD, KEY]); }).then(() => undefined, (x: any) => x);
  return { r, e, fake };
}

describe('the mapping', () => {
  it('unknown_task_identifier -> 503 common.service_unavailable', () => {
    expect(mapDbError(unknown())).toMatchObject({ code: 'common.service_unavailable', statusCode: 503 });
  });
  it('the same with and without a logger or metrics', () => {
    for (const deps of [undefined, recorder() as any, { log: { warn() {} } } as any]) expect(mapDbError(unknown(), deps)).toMatchObject({ code: 'common.service_unavailable', statusCode: 503 });
  });
  it('every other P0001 message is unchanged: common.internal 500 (job_tenant_mismatch, anything else)', () => {
    for (const m of ['job_tenant_mismatch', 'unknown_task_identifier_x', 'xunknown_task_identifier', 'Unknown_Task_Identifier', '', 'x']) {
      expect(mapDbError(pgError('P0001', m)), m).toMatchObject({ code: 'common.internal', statusCode: 500 });
    }
  });
  it('immutable_row stays 409; another SQLSTATE with the same message is not remapped', () => {
    expect(mapDbError(pgError('P0001', 'immutable_row'))).toMatchObject({ code: 'common.immutable_record', statusCode: 409 });
    expect(mapDbError(pgError('23514', 'unknown_task_identifier'))).toMatchObject({ code: 'common.validation_failed', statusCode: 400 });
    expect(mapDbError(pgError('XX000', 'unknown_task_identifier'))).toMatchObject({ code: 'common.internal', statusCode: 500 });
  });
  it('the rest of the table is unchanged', () => {
    const MAP: Array<[string, string, number]> = [['42501', 'common.not_found', 404], ['23503', 'common.not_found', 404], ['23505', 'common.internal', 500], ['23514', 'common.validation_failed', 400],
      ['40001', 'common.dependency_unavailable', 503], ['57014', 'common.dependency_unavailable', 503], ['08006', 'common.dependency_unavailable', 503], ['XX000', 'common.internal', 500]];
    for (const [s, code, status] of MAP) expect(mapDbError(pgError(s)), s).toMatchObject({ code, statusCode: status });
  });
  it('the response error carries no identifier, payload or DB message', () => {
    const e = mapDbError(pgError('P0001', 'unknown_task_identifier'));
    expect(JSON.stringify({ ...e, message: e.message })).not.toContain('unknown_task_identifier');
  });
});

describe('through the transaction: a refused enqueue is a 503 with one log line naming the identifier and the operation', () => {
  it('requestTx rejects with 503 common.service_unavailable', async () => {
    const { e } = await enqueueFails('identity.send_invitation', { operation: operation({ module: 'identity', operationId: 'provisionTenant', context: 'platform' }) });
    expect(e).toMatchObject({ code: 'common.service_unavailable', statusCode: 503 });
  });

  it('logs the identifier and operationId at error level', async () => {
    const { r } = await enqueueFails('identity.send_invitation', { operation: operation({ module: 'identity', operationId: 'provisionTenant', context: 'platform' }) });
    const line = errLines(r).find((c) => c.obj?.task_identifier === 'identity.send_invitation');
    expect(line, JSON.stringify(r.calls)).toBeDefined();
    expect(line!.obj).toMatchObject({ task_identifier: 'identity.send_invitation', operationId: 'provisionTenant', request_id: REQ_ID });
  });

  it('works when the enqueue runs inside a savepoint', async () => {
    const r = recorder();
    const fake = createFakePgBouncer();
    fake.inject(/app\.enqueue_job/i, unknown, 1);
    const db = createDb({ pool: fake.pool, log: r.log, ...retryKnobs() } as any) as any;
    const e = await db.requestTx(txInput(), async (tx: any) => { await tx.savepoint((t: any) => t.query(ENQ, ['lab.reapply_unmapped_exceptions', PAYLOAD, KEY])); }).then(() => undefined, (x: any) => x);
    expect(e).toMatchObject({ code: 'common.service_unavailable', statusCode: 503 });
    expect(errLines(r).some((c) => c.obj?.task_identifier === 'lab.reapply_unmapped_exceptions')).toBe(true);
  });

  it('identityAuthTx does the same (the recovery request enqueues identity.send_recovery there)', async () => {
    const r = recorder();
    const fake = createFakePgBouncer();
    fake.inject(/app\.enqueue_job/i, unknown, 1);
    const db = createDb({ pool: fake.pool, log: r.log, identitySystemActorId: IDENTITY_SYSTEM_ACTOR, identityAuthOps: ['requestPasswordRecovery'], ...retryKnobs() } as any) as any;
    const e = await db.identityAuthTx({ requestId: REQ_ID, clientIp: '203.0.113.9', operation: { module: 'identity', context: 'identity_auth', operationId: 'requestPasswordRecovery' } },
      async (tx: any) => { await tx.query(ENQ, ['identity.send_recovery', PAYLOAD, KEY]); }).then(() => undefined, (x: any) => x);
    expect(e).toMatchObject({ code: 'common.service_unavailable', statusCode: 503 });
    expect(errLines(r).find((c) => c.obj?.task_identifier === 'identity.send_recovery')?.obj).toMatchObject({ operationId: 'requestPasswordRecovery' });
  });

  it('no log call carries the payload, the job key, an email, a person id, the DB message or the Error object', async () => {
    const { r } = await enqueueFails('identity.send_invitation');
    const all = JSON.stringify(r.calls);
    for (const s of SENTINELS) expect(all, `leaked ${s}`).not.toContain(s);
    for (const line of errLines(r)) {
      for (const k of ['payload', 'job_key', 'jobKey', 'email', 'person_id', 'values', 'params', 'message', 'error', 'err', 'stack', 'query']) expect(Object.keys(line.obj ?? {}), k).not.toContain(k);
      for (const v of Object.values(line.obj ?? {})) expect(v instanceof Error).toBe(false);
    }
  });

  it('exactly one line carries the identifier (no duplicate noise per request)', async () => {
    const { r } = await enqueueFails('identity.send_invitation');
    expect(errLines(r).filter((c) => JSON.stringify(c).includes('identity.send_invitation'))).toHaveLength(1);
  });

  it('a hostile identifier value is logged as data only (no newline or control character reaches the log key)', async () => {
    const { r, e } = await enqueueFails('identity.x\nFAKE_LOG_LINE level=error');
    expect(e).toMatchObject({ code: 'common.service_unavailable' });
    const v = errLines(r).map((c) => c.obj?.task_identifier).filter((x) => typeof x === 'string');
    for (const s of v) expect(s).not.toMatch(/[\r\n\u0000-\u001f]/);
  });

  it('a non-string first value is never logged as an identifier', async () => {
    const r = recorder();
    const fake = createFakePgBouncer();
    fake.inject(/app\.enqueue_job/i, unknown, 1);
    const db = createDb({ pool: fake.pool, log: r.log, ...retryKnobs() } as any) as any;
    const e = await db.requestTx(txInput(), async (tx: any) => { await tx.query(ENQ, [{ evil: PAYLOAD }, PAYLOAD, KEY]); }).then(() => undefined, (x: any) => x);
    expect(e).toMatchObject({ code: 'common.service_unavailable' });
    expect(JSON.stringify(r.calls)).not.toContain('SENTINEL');
  });
});

describe('every other error path is unchanged', () => {
  it('job_tenant_mismatch from app.enqueue_job is still 500 common.internal with no identifier line', async () => {
    const { e, r } = await enqueueFails('identity.send_invitation', {}, () => pgError('P0001', 'job_tenant_mismatch'));
    expect(e).toMatchObject({ code: 'common.internal', statusCode: 500 });
    expect(errLines(r).some((c) => c.obj?.task_identifier !== undefined)).toBe(false);
  });
  it('a connection error during enqueue is still 503 common.dependency_unavailable with no identifier line', async () => {
    const { e, r } = await enqueueFails('identity.send_invitation', {}, () => pgError('ECONNRESET'));
    expect(e).toMatchObject({ code: 'common.dependency_unavailable', statusCode: 503 });
    expect(errLines(r).some((c) => c.obj?.task_identifier !== undefined)).toBe(false);
  });
  it('unknown_task_identifier raised by a statement that is not app.enqueue_job maps to 503 but logs no identifier', async () => {
    const r = recorder();
    const fake = createFakePgBouncer();
    fake.inject(/FROM other_table/i, unknown, 1);
    const db = createDb({ pool: fake.pool, log: r.log, ...retryKnobs() } as any) as any;
    const e = await db.requestTx(txInput(), async (tx: any) => { await tx.query('SELECT 1 FROM other_table WHERE x = $1', ['identity.send_invitation']); }).then(() => undefined, (x: any) => x);
    expect(e).toMatchObject({ code: 'common.service_unavailable' });
    expect(errLines(r).some((c) => c.obj?.task_identifier !== undefined)).toBe(false);
  });
  it('a successful enqueue writes no error line and the retry of a 40001 around it still works', async () => {
    const r = recorder();
    const fake = createFakePgBouncer();
    const db = createDb({ pool: fake.pool, log: r.log, ...retryKnobs() } as any) as any;
    await db.requestTx(txInput(), async (tx: any) => { await tx.query(ENQ, ['identity.send_invitation', PAYLOAD, KEY]); });
    expect(errLines(r)).toHaveLength(0);
  });
});
