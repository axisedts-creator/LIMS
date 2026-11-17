// AUDIT-SMALL-1 (LD-224, audit RS-12 logging half; 02-TRD §6.4): every mapped database error writes ONE error-level log line
// carrying only the pg diagnostic coordinates, so a refusal like the platform_events RLS one is findable without exposing data.
//   fields (exact keys): request_id, sqlstate, schema, table, column, constraint, routine, operationId (operationId when known)
//   never: message, detail, hint, where, internalQuery, parameters/values, row values, the Error object itself
// The SQLSTATE -> status/code mapping does NOT change (42501 and 23503 stay common.not_found; no 42501 write-path remap).
// Seam: createDb({ pool, log: { info, warn, error }, ... }) from ../tx.js; the line is written where the error is mapped (all of requestTx/identityAuthTx).
// Expected now: nothing calls log.error, so every "writes one line" case fails; the mapping cases already pass.
import { describe, expect, it } from 'vitest';
import { mapDbError } from '../sqlstate.js';
import { createDb } from '../tx.js';
import { createFakePgBouncer, operation, pgError, recorder, REQ_ID, retryKnobs, txInput, IDENTITY_SYSTEM_ACTOR } from './helpers.js';

const SECRET = {
  message: 'new row violates row-level security policy for table "platform_events" MSG-SENTINEL',
  detail: 'Key (patient_id)=(PATIENT-SENTINEL-Ana-Demo) is not present in table "patients".',
  hint: 'HINT-SENTINEL',
  where: 'PL/pgSQL function app.audit() line 7 WHERE-SENTINEL',
  internalQuery: 'INSERT INTO platform_events VALUES (ROWVALUE-SENTINEL)',
  parameters: 'PARAM-SENTINEL',
};
const SENTINELS = ['MSG-SENTINEL', 'PATIENT-SENTINEL', 'Ana-Demo', 'HINT-SENTINEL', 'WHERE-SENTINEL', 'ROWVALUE-SENTINEL', 'PARAM-SENTINEL', 'row-level security policy'];
const COORDS = { schema: 'lims', table: 'platform_events', column: 'tenant_id', constraint: 'platform_events_tenant_fk', routine: 'ExecWithCheckOptions' };

const errLines = (r: ReturnType<typeof recorder>) => r.calls.filter((c) => c.level === 'error');
async function fail(code: string, extra: Record<string, unknown> = {}, input: Record<string, unknown> = {}) {
  const r = recorder();
  const db = createDb({ pool: createFakePgBouncer().pool, log: r.log, metrics: r.metrics, ...retryKnobs() } as any) as any;
  const e = await db.requestTx(txInput(input), async () => { throw pgError(code, SECRET.message, { ...SECRET, ...COORDS, ...extra } as any); }).then(() => undefined, (x: any) => x);
  return { r, e };
}

describe('one error-level line per mapped database error (RS-12)', () => {
  it('42501 RLS refusal: exactly one error line with every pg coordinate and the request id', async () => {
    const { r, e } = await fail('42501');
    expect(e).toMatchObject({ code: 'common.not_found', statusCode: 404 });
    const lines = errLines(r);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj).toMatchObject({ request_id: REQ_ID, sqlstate: '42501', ...COORDS, operationId: 'listTests' });
  });

  it.each(['23503', '23505', '23514', 'P0001', 'XX000', '22P02', '40001', '55P03', '57014', '08006'])('%s: exactly one error line carrying that sqlstate', async (code) => {
    const { r } = await fail(code);
    const lines = errLines(r);
    expect(lines, code).toHaveLength(1);
    expect(lines[0]!.obj.sqlstate).toBe(code);
    expect(lines[0]!.obj.request_id).toBe(REQ_ID);
  });

  it('a retried error that finally succeeds writes no error line; one that exhausts the retries writes exactly one', async () => {
    const r = recorder();
    const fake = createFakePgBouncer();
    const db = createDb({ pool: fake.pool, log: r.log, ...retryKnobs() } as any) as any;
    let n = 0;
    await db.requestTx(txInput(), async () => { if (n++ < 1) throw pgError('40001'); });
    expect(errLines(r)).toHaveLength(0);
    await db.requestTx(txInput(), async () => { throw pgError('40001'); }).catch(() => undefined);
    expect(errLines(r)).toHaveLength(1);
  });

  it('operationId is the one of the failing operation; absent coordinates are absent or null, never invented', async () => {
    const { r } = await fail('42501', { schema: undefined, table: undefined, column: undefined, constraint: undefined, routine: undefined }, { operation: operation({ operationId: 'enterResult' }) });
    const o = errLines(r)[0]!.obj;
    expect(o.operationId).toBe('enterResult');
    for (const k of ['schema', 'table', 'column', 'constraint', 'routine']) expect(o[k] ?? null, k).toBeNull();
  });

  it('identityAuthTx errors are logged the same way', async () => {
    const r = recorder();
    const db = createDb({ pool: createFakePgBouncer().pool, log: r.log, identitySystemActorId: IDENTITY_SYSTEM_ACTOR, identityAuthOps: ['loginStep'], ...retryKnobs() } as any) as any;
    const e = await db.identityAuthTx({ requestId: REQ_ID, clientIp: '203.0.113.9', operation: { module: 'identity', context: 'identity_auth', operationId: 'loginStep' } },
      async () => { throw pgError('42501', SECRET.message, { ...SECRET, ...COORDS } as any); }).then(() => undefined, (x: any) => x);
    expect(e).toMatchObject({ code: 'common.not_found' });
    expect(errLines(r)).toHaveLength(1);
    expect(errLines(r)[0]!.obj).toMatchObject({ request_id: REQ_ID, sqlstate: '42501', table: 'platform_events', operationId: 'loginStep' });
  });

  it('a non-database error (no SQLSTATE) writes no database error line', async () => {
    const r = recorder();
    const db = createDb({ pool: createFakePgBouncer().pool, log: r.log, ...retryKnobs() } as any) as any;
    await db.requestTx(txInput(), async () => { throw new TypeError('bug in handler'); }).catch(() => undefined);
    expect(errLines(r)).toHaveLength(0);
  });
});

describe('the log line never carries message, detail, hint, where, parameters or row values', () => {
  it.each(['42501', '23503', '23505', 'P0001', 'XX000', '40001'])('%s: nothing from the secret fields reaches any log call', async (code) => {
    const { r } = await fail(code, {}, { values: ['PARAM-SENTINEL'] });
    const all = JSON.stringify(r.calls);
    for (const s of SENTINELS) expect(all, `${code} leaked ${s}`).not.toContain(s);
    for (const line of errLines(r)) {
      for (const k of ['message', 'detail', 'hint', 'where', 'internalQuery', 'parameters', 'params', 'values', 'row', 'rows', 'query', 'error', 'err', 'stack']) {
        expect(Object.keys(line.obj), `${code} key ${k}`).not.toContain(k);
      }
      for (const v of Object.values(line.obj)) expect(v instanceof Error).toBe(false);
      expect(line.msg ?? '').not.toContain('SENTINEL');
    }
  });

  it('the error line has exactly the documented keys and nothing else', async () => {
    const { r } = await fail('23503');
    expect(Object.keys(errLines(r)[0]!.obj).sort()).toEqual(['column', 'constraint', 'operationId', 'request_id', 'routine', 'schema', 'sqlstate', 'table']);
  });

  it('the response error is unchanged: no coordinates, no message', async () => {
    const { e } = await fail('23503');
    const wire = JSON.stringify({ ...e, message: e.message });
    for (const s of [...SENTINELS, 'platform_events', 'tenant_id']) expect(wire).not.toContain(s);
  });
});

describe('the SQLSTATE -> code/status mapping is unchanged (LD-224: no 42501 write-path remap)', () => {
  const MAP: Array<[string, string, number]> = [
    ['P0001', 'common.internal', 500], ['42501', 'common.not_found', 404], ['23503', 'common.not_found', 404], ['23505', 'common.internal', 500],
    ['23514', 'common.validation_failed', 400], ['40001', 'common.dependency_unavailable', 503], ['40P01', 'common.dependency_unavailable', 503],
    ['55P03', 'common.dependency_unavailable', 503], ['57014', 'common.dependency_unavailable', 503], ['57P01', 'common.dependency_unavailable', 503],
    ['08006', 'common.dependency_unavailable', 503], ['ECONNREFUSED', 'common.dependency_unavailable', 503],
    ['XX000', 'common.internal', 500], ['22P02', 'common.internal', 500], ['42P01', 'common.internal', 500], ['23502', 'common.internal', 500],
  ];
  it.each(MAP)('%s -> %s %i, with and without a logger', (sqlstate, code, status) => {
    for (const deps of [undefined, recorder() as any, { log: { warn() {} } } as any]) {
      expect(mapDbError(pgError(sqlstate, 'x', COORDS as any), deps)).toMatchObject({ code, statusCode: status });
    }
  });
  it('P0001 immutable_row stays 409 common.immutable_record', () => {
    expect(mapDbError(pgError('P0001', 'immutable_row'))).toMatchObject({ code: 'common.immutable_record', statusCode: 409 });
  });
  it('42501 still increments lims_rls_denied_total exactly once and 23505 still logs unmapped_unique_violation', async () => {
    const r = recorder();
    mapDbError(pgError('42501'), r as any);
    expect(r.metrics.counts.get('lims_rls_denied_total')).toBe(1);
    const { r: r2 } = await fail('23505');
    expect(r2.calls.some((c) => JSON.stringify(c).includes('unmapped_unique_violation'))).toBe(true);
  });
});
