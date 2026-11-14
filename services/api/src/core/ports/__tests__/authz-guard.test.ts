// T0D-07: AC-0D-2.4; 07-SECURITY AB-5; 02-TRD §6.2 stage 9 (08 A25 D-212 identity_auth exemption).
// Assumed API from ../authz-guard.js:
//   createAuthzGuard({ env, log, metrics }) -> { forRequest(): RequestAuthz; check(req, { operationId, public, identityAuth?, status }): void }
//   RequestAuthz: { asserted: boolean; identity<T extends { assertRole(...a: any[]): any }>(port: T): T }   // wrapper records the call, never decides
//   check throws an Error with .code === 'common.internal' (pipeline turns it into 500) when it fires; production never throws.
import { describe, expect, it } from 'vitest';
import { createAuthzGuard } from '../authz-guard.js';
import { LENIENT, makeLog, makeMetrics } from './helpers.js';

function setup(env: string) {
  const l = makeLog();
  const m = makeMetrics();
  const guard = createAuthzGuard({ env, log: l.log, metrics: m.metrics } as never);
  const calls: unknown[][] = [];
  const identity = {
    assertRole: async (...a: unknown[]) => { calls.push(a); return 'ok'; },
    other: () => 'untouched',
  };
  return { guard, l, m, identity, calls };
}
const op = (over: Record<string, unknown> = {}) => ({ operationId: 'createWidget', public: false, status: 201, ...over });
function thrown(fn: () => unknown): any { try { fn(); } catch (e) { return e; } return undefined; }

describe.each([...LENIENT, 'staging'] as const)('%s (AC-0D-2.4)', (env) => {
  it('non-public 2xx without assertRole -> common.internal + log authz_not_asserted{operationId}', () => {
    const { guard, l } = setup(env);
    const req = guard.forRequest();
    const err = thrown(() => guard.check(req, op()));
    expect(err?.code).toBe('common.internal');
    const ev = l.events('authz_not_asserted');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ operationId: 'createWidget' });
  });

  it('assertRole called through the wrapper -> passes, no log', async () => {
    const { guard, l, identity, calls } = setup(env);
    const req = guard.forRequest();
    const id = req.identity(identity);
    await expect(id.assertRole('lab.order.read')).resolves.toBe('ok');
    expect(calls).toEqual([['lab.order.read']]);
    expect(req.asserted).toBe(true);
    expect(() => guard.check(req, op())).not.toThrow();
    expect(l.events('authz_not_asserted')).toHaveLength(0);
  });

  it('assertRole that throws (denied) still counts as asserted, and the error is propagated unchanged', async () => {
    const { guard, calls } = setup(env);
    const denied = Object.assign(new Error('nope'), { code: 'auth.forbidden' });
    const req = guard.forRequest();
    const id = req.identity({ assertRole: async (...a: unknown[]) => { calls.push(a); throw denied; } });
    await expect(id.assertRole('x')).rejects.toBe(denied);
    expect(req.asserted).toBe(true);
  });

  it('wrapper does not mark asserted for other methods and passes them through', () => {
    const { guard, identity } = setup(env);
    const req = guard.forRequest();
    expect(req.identity(identity).other()).toBe('untouched');
    expect(req.asserted).toBe(false);
    expect(thrown(() => guard.check(req, op()))?.code).toBe('common.internal');
  });

  it('assertion state is per request: request A asserting does not satisfy request B', async () => {
    const { guard, identity } = setup(env);
    const a = guard.forRequest();
    const b = guard.forRequest();
    await a.identity(identity).assertRole('x');
    expect(() => guard.check(a, op())).not.toThrow();
    expect(thrown(() => guard.check(b, op()))?.code).toBe('common.internal');
  });

  it.each([200, 201, 204, 302, 399])('status %i is checked', (status) => {
    const { guard } = setup(env);
    expect(thrown(() => guard.check(guard.forRequest(), op({ status })))?.code).toBe('common.internal');
  });

  it.each([400, 401, 403, 404, 409, 422, 500, 503])('status %i is not checked (errors need no assertion)', (status) => {
    const { guard, l } = setup(env);
    expect(() => guard.check(guard.forRequest(), op({ status }))).not.toThrow();
    expect(l.events('authz_not_asserted')).toHaveLength(0);
  });

  it('x-public operation is exempt', () => {
    const { guard, l } = setup(env);
    expect(() => guard.check(guard.forRequest(), op({ public: true, status: 200 }))).not.toThrow();
    expect(l.events('authz_not_asserted')).toHaveLength(0);
  });

  it('x-context identity_auth operation is exempt (08 A25 D-212)', () => {
    const { guard } = setup(env);
    expect(() => guard.check(guard.forRequest(), op({ public: true, identityAuth: true, operationId: 'loginStaff', status: 200 }))).not.toThrow();
  });

  it('identityAuth flag on a NON-public operation does not grant an exemption', () => {
    const { guard } = setup(env);
    expect(thrown(() => guard.check(guard.forRequest(), op({ public: false, identityAuth: true })))?.code).toBe('common.internal');
  });
});

describe.each(['production'] as const)('%s', (env) => {
  it('non-public 2xx without assertRole -> does NOT throw; logs authz_not_asserted and counts lims_core_authz_not_asserted_total', () => {
    const { guard, l, m } = setup(env);
    expect(() => guard.check(guard.forRequest(), op())).not.toThrow();
    expect(l.events('authz_not_asserted')).toHaveLength(1);
    expect(l.events('authz_not_asserted')[0]).toMatchObject({ operationId: 'createWidget' });
    expect(m.counter('lims_core_authz_not_asserted_total')).toBe(1);
    expect(m.labelsOf('lims_core_authz_not_asserted_total')).toEqual([{ operation_id: 'createWidget' }]);
  });

  it('asserted request: no log, no metric', async () => {
    const { guard, l, m, identity } = setup(env);
    const req = guard.forRequest();
    await req.identity(identity).assertRole('x');
    guard.check(req, op());
    expect(l.events('authz_not_asserted')).toHaveLength(0);
    expect(m.counter('lims_core_authz_not_asserted_total')).toBe(0);
  });
});

describe('metric only counts when the guard actually fires', () => {
  it.each(LENIENT)('%s: counter untouched for exempt/error responses', (env) => {
    const { guard, m } = setup(env);
    guard.check(guard.forRequest(), op({ public: true }));
    guard.check(guard.forRequest(), op({ status: 403 }));
    expect(m.counter('lims_core_authz_not_asserted_total')).toBe(0);
  });
});
