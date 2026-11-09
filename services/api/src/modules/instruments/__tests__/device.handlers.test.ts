// C7 API-T06 — HTTP wiring of E01/E02/E03/E07/E08 (02-TRD §7.2; contracts/openapi/instruments.yaml). The three services are mocked (behaviour: enrolment/releases/heartbeat.service.test.ts):
// these fix req -> service input mapping, status/headers passthrough, no stubs left, and fail-closed behaviour. Request shapes as delivered by the core pipeline after schema
// validation (params, lower-case headers, parsed JSON body); hctx = device ctx (tenantId, actor, claims, tx, ...) + operationId/clientIp/log.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_X, bundleBody, enrolInput, heartbeatBody, idN, makeDeviceCtx, rejection } from './device.helpers.js';

const OPS = ['enrolAgent', 'getAgentConfig', 'submitAgentHeartbeat', 'submitAgentLogBundle', 'downloadAgentRelease'] as const;
const svc: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('../service/enrolment.service.js', () => ({ createEnrolmentService: () => svc }));
vi.mock('../service/heartbeat.service.js', () => ({ createHeartbeatService: () => svc }));
vi.mock('../service/releases.service.js', () => ({ createReleasesService: () => svc }));
const { manifest } = await import('../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];
const hctx = (operationId: string, o: Parameters<typeof makeDeviceCtx>[0] = {}) => ({ operationId, ...makeDeviceCtx(o).ctx });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const REL = idN(0x7001);
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op } })); });

describe('no longer stubs; fail closed without an authenticated request context', () => {
  it.each(OPS)('%s has a real handler: no context -> auth.unauthenticated (the stub answers common.internal), service never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('a failed call echoes no request input or credential in code/message/details', async () => {
    const planted = 'lmsd_PLANTED-TOKEN-9f3a';
    svc['downloadAgentRelease']!.mockRejectedValueOnce(Object.assign(new Error('common.not_found'), { code: 'common.not_found' }));
    const e = await rejection(h('downloadAgentRelease')(req({ params: { release_id: planted }, headers: { authorization: `Bearer ${planted}` } }), hctx('downloadAgentRelease')));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail })).not.toContain(planted);
  });
});

describe('request -> service mapping and responses', () => {
  it('E01 enrolAgent: body -> camelCase input; 201 body passthrough, cache-control no-store, NO etag (secret shown once)', async () => {
    svc['enrolAgent']!.mockResolvedValueOnce({ status: 201, body: { device_token: 'lmsd_x' } });
    const r = await h('enrolAgent')(req({ body: { host_fingerprint_sha256: 'c'.repeat(64), agent_version: '1.2.3', launcher_version: '1.0.0', os_version: 'Windows 11 24H2' } }), hctx('enrolAgent', { kind: 'enrolment_code' }));
    expect(svc['enrolAgent']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String), claims: expect.objectContaining({ credential_kind: 'enrolment_code' }) }), enrolInput());
    expect(r.status).toBe(201); expect(r.body).toEqual({ device_token: 'lmsd_x' });
    expect(r.headers?.['cache-control']).toMatch(/no-store/); expect(r.headers?.etag).toBeUndefined();
  });
  it('E02 getAgentConfig: service called with the ctx only; 200 body passthrough', async () => {
    svc['getAgentConfig']!.mockResolvedValueOnce({ status: 200, body: { alg: 'Ed25519' } });
    const r = await h('getAgentConfig')(req(), hctx('getAgentConfig'));
    expect(svc['getAgentConfig']).toHaveBeenCalledWith(expect.objectContaining({ actor: expect.objectContaining({ id: AGENT_X, type: 'device' }) }));
    expect(r.status).toBe(200); expect(r.body).toEqual({ alg: 'Ed25519' });
  });
  it('E03 submitAgentHeartbeat: body passed through unchanged as { body }; 200 passthrough', async () => {
    const body = heartbeatBody();
    const r = await h('submitAgentHeartbeat')(req({ body }), hctx('submitAgentHeartbeat'));
    expect(svc['submitAgentHeartbeat']).toHaveBeenCalledWith(expect.objectContaining({ clientIp: expect.any(String) }), { body }); expect(r.status).toBe(200);
  });
  it('E07 submitAgentLogBundle: body passed through as { body }; 201 passthrough', async () => {
    const body = bundleBody(idN(0x8001)); svc['submitAgentLogBundle']!.mockResolvedValueOnce({ status: 201, body: { bundle_id: idN(0xb101) } });
    const r = await h('submitAgentLogBundle')(req({ body }), hctx('submitAgentLogBundle'));
    expect(svc['submitAgentLogBundle']).toHaveBeenCalledWith(expect.anything(), { body }); expect(r.status).toBe(201); expect(r.body).toEqual({ bundle_id: idN(0xb101) });
  });
  it('E08 downloadAgentRelease: path param -> releaseId; binary body and Content-Length / X-Package-Sha256 / content-type pass through untouched, no etag', async () => {
    const bytes = Buffer.from('PKG'); const headers = { 'content-type': 'application/octet-stream', 'content-length': '3', 'x-package-sha256': 'a'.repeat(64) };
    svc['downloadAgentRelease']!.mockResolvedValueOnce({ status: 200, body: bytes, headers });
    const r = await h('downloadAgentRelease')(req({ params: { release_id: REL } }), hctx('downloadAgentRelease'));
    expect(svc['downloadAgentRelease']).toHaveBeenCalledWith(expect.anything(), { releaseId: REL });
    expect(r.status).toBe(200); expect(Buffer.from(r.body).equals(bytes)).toBe(true);
    expect(r.headers).toMatchObject(headers); expect(r.headers?.etag).toBeUndefined();
  });
  it('service errors propagate unchanged (core renders the problem)', async () => {
    svc['getAgentConfig']!.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'auth.device_token_invalid' }));
    expect((await rejection(h('getAgentConfig')(req(), hctx('getAgentConfig')))).code).toBe('auth.device_token_invalid');
  });
});
