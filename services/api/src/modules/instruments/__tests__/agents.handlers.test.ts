// C7 API-T04 — HTTP wiring of E10-E21 (02-TRD §6.4/§7.3; contracts/openapi/instruments.yaml). The agents SERVICE is mocked here (its behaviour is in agents.service.test.ts):
// these tests fix req -> service input mapping, status codes, ETag, If-Match handling, and fail-closed behaviour.
// Request shapes as delivered by the core pipeline after schema validation: params {agent_id, bundle_id}; query arrays already split (style form, explode:false);
// headers lower-case; body parsed JSON. hctx = service ctx (tenantId, actor, tx, ...) + operationId/clientIp/log (as reporting handlers).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { idN, makeCtx, rejection } from './agents.helpers.js';

const svc: Record<string, ReturnType<typeof vi.fn>> = {};
const OPS = ['listAgents', 'createAgent', 'getAgent', 'updateAgent', 'issueEnrolmentCode', 'revokeAgent', 'retireAgent', 'requestAgentCommand', 'listAgentCommands', 'listAgentHealthTransitions', 'getAgentLogBundle', 'listAgentReleases'];
vi.mock('../service/agents.service.js', () => ({ createAgentsService: () => svc }));
const { manifest } = await import('../index.js');
const h = (op: string): any => (manifest.handlers as any)[op];

const AID = idN(0x1000), BID = idN(0xb001), CID = idN(0xc1);
const hctx = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', ...makeCtx().ctx });
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
beforeEach(() => { for (const op of OPS) svc[op] = vi.fn(async () => ({ status: 200, body: { ok: op }, version: 3 })); });

describe('no longer stubs; fail closed without an authenticated request context', () => {
  it.each(OPS)('%s has a real handler: no context -> auth.unauthenticated (the stub answers common.internal), service never called', async (op) => {
    const e = await rejection(h(op)(req(), { operationId: op, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc[op]).not.toHaveBeenCalled();
  });
  it('a failed call echoes no request input in code/message/details', async () => {
    const planted = 'PLANTED-TOKEN-9f3a'; svc['getAgent']!.mockRejectedValueOnce(Object.assign(new Error('common.not_found'), { code: 'common.not_found' }));
    const e = await rejection(h('getAgent')(req({ params: { agent_id: planted }, headers: { authorization: planted } }), hctx('getAgent')));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail })).not.toContain(planted);
  });
});

describe('request -> service mapping and responses', () => {
  it('E10 listAgents: query -> filters; 200 body passthrough, no ETag', async () => {
    const r = await h('listAgents')(req({ query: { centre_id: CID, status: ['active', 'revoked'], health_state: ['offline'], sort: '-last_heartbeat_at', cursor: 'C1', limit: 25 } }), hctx('listAgents'));
    expect(svc['listAgents']).toHaveBeenCalledWith(expect.objectContaining({ tenantId: expect.any(String) }), { centreId: CID, status: ['active', 'revoked'], healthState: ['offline'], sort: '-last_heartbeat_at', cursor: 'C1', limit: 25 });
    expect(r.status).toBe(200); expect(r.headers?.etag).toBeUndefined();
  });
  it('E11 createAgent: body -> camelCase input; 201 + ETag of the new version', async () => {
    svc['createAgent']!.mockResolvedValueOnce({ status: 201, body: { id: AID }, version: 1 });
    const r = await h('createAgent')(req({ body: { agent_code: 'HUB-PC-02', display_name: 'Hub 2', centre_id: CID, update_channel: 'beta', backlog_threshold: 50 } }), hctx('createAgent'));
    expect(svc['createAgent']).toHaveBeenCalledWith(expect.anything(), { agentCode: 'HUB-PC-02', displayName: 'Hub 2', centreId: CID, updateChannel: 'beta', backlogThreshold: 50 });
    expect(r.status).toBe(201); expect(r.headers?.etag).toBe('"1"');
  });
  it('E12 getAgent: 200 + ETag "<version>"', async () => {
    const r = await h('getAgent')(req({ params: { agent_id: AID } }), hctx('getAgent'));
    expect(svc['getAgent']).toHaveBeenCalledWith(expect.anything(), { agentId: AID }); expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('E13 updateAgent: If-Match + body -> expectedVersion + patch (unset passed through); 200 + ETag', async () => {
    const r = await h('updateAgent')(req({ params: { agent_id: AID }, headers: ifm(2), body: { display_name: 'N', unset: ['pinned_release_id'] } }), hctx('updateAgent'));
    expect(svc['updateAgent']).toHaveBeenCalledWith(expect.anything(), { agentId: AID, expectedVersion: 2, patch: { display_name: 'N', unset: ['pinned_release_id'] } });
    expect(r.headers?.etag).toBe('"3"');
  });
  it('E14 issueEnrolmentCode: 201 body passthrough and NO ETag, no caching (secret shown once): cache-control no-store', async () => {
    svc['issueEnrolmentCode']!.mockResolvedValueOnce({ status: 201, body: { enrolment_code: 'lmse_x', expires_at: 'x', credential_id: 'y' } });
    const r = await h('issueEnrolmentCode')(req({ params: { agent_id: AID }, body: {} }), hctx('issueEnrolmentCode'));
    expect(svc['issueEnrolmentCode']).toHaveBeenCalledWith(expect.anything(), { agentId: AID });
    expect(r.status).toBe(201); expect(r.headers?.etag).toBeUndefined(); expect(r.headers?.['cache-control']).toMatch(/no-store/);
  });
  it.each([['revokeAgent'], ['retireAgent']])('E15/E16 %s: If-Match + {reason_code, reason_text} -> service; 200 + ETag', async (op) => {
    const r = await h(op)(req({ params: { agent_id: AID }, headers: ifm(4), body: { reason_code: 'device_lost_or_stolen', reason_text: 'x' } }), hctx(op));
    expect(svc[op]).toHaveBeenCalledWith(expect.anything(), { agentId: AID, expectedVersion: 4, reasonCode: 'device_lost_or_stolen', reasonText: 'x' });
    expect(r.status).toBe(200); expect(r.headers?.etag).toBe('"3"');
  });
  it('E17 requestAgentCommand: body -> {kind, params}; 202 passthrough', async () => {
    svc['requestAgentCommand']!.mockResolvedValueOnce({ status: 202, body: { command_id: 'c' } });
    const r = await h('requestAgentCommand')(req({ params: { agent_id: AID }, body: { kind: 'reupload_since', params: { since: '2026-11-06T12:00:00.000Z' } } }), hctx('requestAgentCommand'));
    expect(svc['requestAgentCommand']).toHaveBeenCalledWith(expect.anything(), { agentId: AID, kind: 'reupload_since', params: { since: '2026-11-06T12:00:00.000Z' } });
    expect(r.status).toBe(202);
  });
  it('E18/E19/E20/E21 read operations map params + query', async () => {
    await h('listAgentCommands')(req({ params: { agent_id: AID }, query: { cursor: 'C', limit: 10 } }), hctx('listAgentCommands'));
    expect(svc['listAgentCommands']).toHaveBeenCalledWith(expect.anything(), { agentId: AID, cursor: 'C', limit: 10 });
    await h('listAgentHealthTransitions')(req({ params: { agent_id: AID }, query: { changed_at_from: '2026-11-01T00:00:00.000Z', changed_at_to: '2026-11-07T00:00:00.000Z', limit: 50 } }), hctx('listAgentHealthTransitions'));
    expect(svc['listAgentHealthTransitions']).toHaveBeenCalledWith(expect.anything(), { agentId: AID, changedAtFrom: '2026-11-01T00:00:00.000Z', changedAtTo: '2026-11-07T00:00:00.000Z', cursor: undefined, limit: 50 });
    await h('getAgentLogBundle')(req({ params: { agent_id: AID, bundle_id: BID } }), hctx('getAgentLogBundle'));
    expect(svc['getAgentLogBundle']).toHaveBeenCalledWith(expect.anything(), { agentId: AID, bundleId: BID });
    await h('listAgentReleases')(req({ query: { channel: 'beta' } }), hctx('listAgentReleases'));
    expect(svc['listAgentReleases']).toHaveBeenCalledWith(expect.anything(), { channel: 'beta' });
  });
  it('E20 log bundle bodies are never cached (no-store)', async () => {
    const r = await h('getAgentLogBundle')(req({ params: { agent_id: AID, bundle_id: BID } }), hctx('getAgentLogBundle'));
    expect(r.headers?.['cache-control']).toMatch(/no-store/);
  });
});

describe('If-Match (02-CV §4.2) on E13/E15/E16', () => {
  const cases: Array<[string, object]> = [['updateAgent', { display_name: 'x' }], ['revokeAgent', { reason_code: 'other' }], ['retireAgent', { reason_code: 'other' }]];
  it.each(cases)('%s: absent header -> service gets expectedVersion undefined (it answers 428)', async (op, body) => {
    await h(op)(req({ params: { agent_id: AID }, body }), hctx(op));
    expect(svc[op]).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ expectedVersion: undefined }));
  });
  it.each(cases)('%s: malformed header (W/"1", 1, "0", "01", "1x") -> 400 common.validation_failed, service not called', async (op, body) => {
    for (const v of ['W/"1"', '1', '"0"', '"01"', '"1x"', '""']) {
      expect((await rejection(h(op)(req({ params: { agent_id: AID }, headers: { 'if-match': v }, body }), hctx(op))))?.code, v).toBe('common.validation_failed');
    }
    expect(svc[op]).not.toHaveBeenCalled();
  });
});
