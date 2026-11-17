// T24 HTTP wiring of listDeadLetters, getDeadLetter, replayDeadLetter, discardDeadLetter (02-TRD s5.10; contracts/openapi/identity.yaml; 08 A6.4, A9.2, A10.2).
// The SERVICE is mocked (behaviour: dead-letter.service.test.ts): these tests fix req -> service input mapping, status codes, ETag / If-Match, mass-assignment,
// query strictness and fail-closed behaviour. Platform authz is the service's; the handlers only refuse a context with no authenticated platform request.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../../core/errors.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { PSESSION, REQ_ID, STAFF_ID, STAFF_USER, TENANT_A, TENANT_B, idN, rejection } from './dead-letter.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
const OPS = ['listDeadLetters', 'getDeadLetter', 'replayDeadLetter', 'discardDeadLetter'];
vi.mock('../dead-letter.service.js', () => ({ createDeadLetterService: () => svc }));
const { manifest } = await import('../../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];

const DL = idN(0x801);
const noop = { info() {}, warn() {}, error() {} };
const core = { deadLetters: { list: vi.fn(), get: vi.fn(), replay: vi.fn(), discard: vi.fn() } };
const hctx = (operationId: string, o: Record<string, unknown> = {}) => ({
  operationId, clientIp: '203.0.113.9', log: noop, actor: { type: 'user', id: STAFF_USER }, platformRole: 'platform_superadmin', platformStaffId: STAFF_ID, platformSessionId: PSESSION,
  aal: 'aal2', requestId: REQ_ID, tx: { __tx: 1 }, core, ...o,
});
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op }, version: 3 })); });
const input = (op: string) => svc[op]!.mock.calls[0]![1];

describe('no longer stubs; fail closed without an authenticated platform request context', () => {
  it.each(OPS)('%s: no actor/tx -> auth.unauthenticated (the stub answers common.internal); service never called', async (op) => {
    const e = await rejection(h(op)(req({ params: { dead_letter_id: DL } }), { operationId: op, clientIp: '203.0.113.9', log: noop }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('service errors propagate unchanged and echo no request input', async () => {
    const planted = 'PLANTED-TOKEN-9f3a'; svc['replayDeadLetter']!.mockRejectedValueOnce(new LimsError('common.version_conflict'));
    const e = await rejection(h('replayDeadLetter')(req({ params: { dead_letter_id: DL }, headers: { authorization: planted, 'if-match': '"1"' }, body: { reason_text: planted } }), hctx('replayDeadLetter')));
    expect(e.code).toBe('common.version_conflict'); expect(JSON.stringify({ c: e.code, m: e.message, d: e.detail })).not.toContain(planted);
  });
  it('the platform ctx (incl. ctx.core) is passed to the service untouched', async () => {
    const c = hctx('getDeadLetter'); await h('getDeadLetter')(req({ params: { dead_letter_id: DL } }), c);
    expect(svc['getDeadLetter']!.mock.calls[0]![0]).toMatchObject({ platformRole: 'platform_superadmin', platformStaffId: STAFF_ID, actor: { id: STAFF_USER } });
    expect(svc['getDeadLetter']!.mock.calls[0]![0].core).toBe(core);
  });
});

describe('listDeadLetters', () => {
  const Q = { state: 'open', platform_rows: 'false', tenant_id: TENANT_A, task_identifier: 'billing.recompute_balance', dead_at_from: '2026-11-02T00:00:00.000Z', dead_at_to: '2026-11-09T00:00:00.000Z', cursor: 'c1', limit: '10' };
  it('query (snake) -> filters (camel) 1:1: platform_rows "false" -> false, limit "10" -> 10; 200 body passthrough, no ETag', async () => {
    const r = await h('listDeadLetters')(req({ query: Q }), hctx('listDeadLetters'));
    expect(input('listDeadLetters')).toEqual({ state: 'open', platformRows: false, tenantId: TENANT_A, taskIdentifier: 'billing.recompute_balance', deadAtFrom: Q.dead_at_from, deadAtTo: Q.dead_at_to, cursor: 'c1', limit: 10 });
    expect(r.status).toBe(200); expect(r.body).toEqual({ ok: 'listDeadLetters' }); expect(r.headers?.etag).toBeUndefined();
  });
  it('platform_rows "true" -> true; absent -> undefined (the service defaults it to false); a non-boolean string is NOT coerced (service answers 400)', async () => {
    await h('listDeadLetters')(req({ query: { platform_rows: 'true' } }), hctx('listDeadLetters')); expect(input('listDeadLetters').platformRows).toBe(true);
    svc['listDeadLetters']!.mockClear(); await h('listDeadLetters')(req({ query: {} }), hctx('listDeadLetters')); expect(input('listDeadLetters').platformRows).toBeUndefined();
    for (const bad of ['yes', '1', 'TRUE', '', 'on']) {
      svc['listDeadLetters']!.mockClear(); await h('listDeadLetters')(req({ query: { platform_rows: bad } }), hctx('listDeadLetters'));
      expect(typeof input('listDeadLetters').platformRows).not.toBe('boolean');
    }
  });
  it('platform_rows=true with tenant_id is forwarded untouched (the service answers 400 and does not call core); a non-numeric limit is not turned into a valid integer', async () => {
    await h('listDeadLetters')(req({ query: { platform_rows: 'true', tenant_id: TENANT_A } }), hctx('listDeadLetters'));
    expect(input('listDeadLetters')).toMatchObject({ platformRows: true, tenantId: TENANT_A });
    for (const bad of ['abc', '1.5', '', '10x', '1e2', '-1']) {
      svc['listDeadLetters']!.mockClear(); await h('listDeadLetters')(req({ query: { limit: bad } }), hctx('listDeadLetters'));
      const l = input('listDeadLetters').limit; expect(Number.isInteger(l) && l >= 1 && l <= 200).toBe(false);
    }
  });
  it('an unknown query parameter -> 400 common.validation_failed, service not called (D-T15)', async () => {
    for (const q of [{ foo: 'bar' }, { state: 'open', tenantId: TENANT_A }, { 'tenant_id[]': TENANT_A }, { job_payload: '1' }]) {
      svc['listDeadLetters']!.mockClear();
      expect((await rejection(h('listDeadLetters')(req({ query: q }), hctx('listDeadLetters'))))?.code).toBe('common.validation_failed'); expect(svc['listDeadLetters']).not.toHaveBeenCalled();
    }
  });
  it('a repeated (array) query value is never forwarded as an array', async () => {
    await Promise.resolve(h('listDeadLetters')(req({ query: { state: ['open', 'discarded'] } }), hctx('listDeadLetters'))).catch(() => undefined);   // reject (400) or forward a non-array
    if (svc['listDeadLetters']!.mock.calls.length) expect(Array.isArray(input('listDeadLetters').state)).toBe(false);
  });
});

describe('getDeadLetter', () => {
  it('path id -> { deadLetterId }; 200 + ETag "<version>"; query/body ignored', async () => {
    const r = await h('getDeadLetter')(req({ params: { dead_letter_id: DL }, query: { tenant_id: TENANT_B }, body: { state: 'discarded' } }), hctx('getDeadLetter'));
    expect(input('getDeadLetter')).toEqual({ deadLetterId: DL }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
});

describe.each([['replayDeadLetter', 'reason_text optional'], ['discardDeadLetter', 'reason_text required']])('%s (%s)', (op) => {
  it('path id + If-Match "<n>" + body.reason_text -> { deadLetterId, expectedVersion: n, reasonText }; 200 + new ETag', async () => {
    const r = await h(op)(req({ params: { dead_letter_id: DL }, headers: { 'if-match': '"7"' }, body: { reason_text: 'duplicate of replayed job' } }), hctx(op));
    expect(input(op)).toEqual({ deadLetterId: DL, expectedVersion: 7, reasonText: 'duplicate of replayed job' }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('If-Match absent -> expectedVersion undefined (the service answers 428); malformed -> 0 or undefined, never a crash or a valid-looking version', async () => {
    await h(op)(req({ params: { dead_letter_id: DL }, body: { reason_text: 'x' } }), hctx(op)); expect(input(op).expectedVersion).toBeUndefined();
    for (const bad of ['7', 'W/"7"', '"0"', '"-1"', '"1.5"', '"abc"', '"99999999999"', '"2147483648"', '*', '', '"07"', ['"1"', '"2"']]) {
      svc[op]!.mockClear(); await h(op)(req({ params: { dead_letter_id: DL }, headers: { 'if-match': bad }, body: { reason_text: 'x' } }), hctx(op));
      expect([0, undefined]).toContain(input(op).expectedVersion);
    }
  });
  it('mass assignment: only the path id, If-Match and reason_text reach the service (no tenant_id, state, version, resolved_by, job_payload from body/query/headers)', async () => {
    await h(op)(req({ params: { dead_letter_id: DL, tenant_id: TENANT_B }, headers: { 'if-match': '"7"', 'x-tenant-id': TENANT_B }, query: { tenant_id: TENANT_B, state: 'open' },
      body: { reason_text: 'r', state: 'open', version: 99, resolved_by: TENANT_B, tenant_id: TENANT_B, job_payload: { x: 1 }, resolution_note: 'forged' } }), hctx(op));
    expect(Object.keys(input(op)).sort()).toEqual(['deadLetterId', 'expectedVersion', 'reasonText']); expect(input(op).reasonText).toBe('r');
  });
  it('a missing / non-object body reaches the service as reasonText undefined (service: 400 for discard, ok for replay), never a crash', async () => {
    for (const b of [undefined, null, 'x', 5, [], {}]) { svc[op]!.mockClear(); await h(op)(req({ params: { dead_letter_id: DL }, headers: { 'if-match': '"1"' }, body: b }), hctx(op)); expect(input(op).reasonText).toBeUndefined(); }
  });
  it('a non-string reason_text is forwarded as-is (never coerced to a string) so the service can reject it', async () => {
    for (const v of [5, null, ['x'], { a: 1 }, true]) { svc[op]!.mockClear(); await h(op)(req({ params: { dead_letter_id: DL }, headers: { 'if-match': '"1"' }, body: { reason_text: v } }), hctx(op)); expect(typeof input(op).reasonText).not.toBe('string'); }
  });
});

describe('registration + contract', () => {
  const spec = parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'), 'utf8'));
  const ops = (): Array<[string, string, any]> => Object.entries<any>(spec.paths).flatMap(([p, item]) => Object.entries<any>(item).filter(([, o]) => OPS.includes(o?.operationId)).map(([m, o]) => [p, m, o] as [string, string, any]));
  it('the four operations exist in the contract with x-permission platform.dead_letter.manage and x-context platform; replay/discard require If-Match', () => {
    expect(ops().map(([, , o]) => o.operationId).sort()).toEqual([...OPS].sort());
    for (const [, , o] of ops()) { expect(o['x-permission']).toBe('platform.dead_letter.manage'); expect(o['x-context']).toBe('platform'); }
    for (const [, , o] of ops().filter(([, , x]) => ['replayDeadLetter', 'discardDeadLetter'].includes(x.operationId))) expect(JSON.stringify(o.parameters)).toContain('IfMatch');
  });
  it('the DeadLetterRow schema has no job_payload and requires version', () => {
    const s = spec.components.schemas.DeadLetterRow; expect(Object.keys(s.properties).join()).not.toMatch(/payload/i); expect(s.required).toContain('version'); expect(s.additionalProperties).toBe(false);
  });
  it.each(OPS)('%s is a real handler (not the common.internal stub)', async (op) => {
    expect(typeof h(op)).toBe('function');
    const e = await rejection(h(op)(req({ params: { dead_letter_id: DL } }), hctx(op, { actor: undefined, tx: undefined })));
    expect(e?.code).not.toBe('common.internal');
  });
});
