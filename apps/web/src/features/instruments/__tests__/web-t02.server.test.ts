// WEB-T02 — BFF server functions for SCR-01/02/03 (02-CONVENTIONS §2.4: server/<operationId>.server.ts, "server-only" guard).
// MSW stands in for the C7 API (contracts/openapi/instruments.yaml). Synthetic data only.
// ASSUMED signatures (spec gives only file naming + operationIds):
//   listAgents({centreId?, status?: string[], healthState?: string[], sort?, cursor?, limit?}) → {data, page}
//   getAgent(agentId) → Agent            createAgent({agent_code, display_name, centre_id, update_channel?, backlog_threshold?}) → Agent
//   issueEnrolmentCode(agentId) → {enrolment_code, expires_at, credential_id}
//   listAgentHealthTransitions(agentId, {limit?, cursor?}) → {data, page}
// Errors surface as core ApiError (status + problem.code) — same class serverFetch throws.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => undefined }));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;

const AGENT_ID = '01a1a98a-ac40-7000-8000-0000000d0101';
const A2_AGENT_ID = '01a1a98a-ac40-7000-8000-0000000d0202';
const CENTRE_A1 = '01a1a98a-ac40-7000-8000-0000000c0001';
const SECRET = 'lmse_SYNTHETICSECRET0123456'; // pretend enrolment code

const seen: { url: URL; method: string; headers: Headers; body?: unknown }[] = [];
const server = setupServer(
  http.get(`${ORIGIN}/v1/instruments/agents`, ({ request }) => {
    seen.push({ url: new URL(request.url), method: request.method, headers: request.headers });
    return HttpResponse.json({ data: [], page: { limit: 50 } });
  }),
  http.get(`${ORIGIN}/v1/instruments/agents/:id`, ({ params, request }) => {
    seen.push({ url: new URL(request.url), method: request.method, headers: request.headers });
    // AC-16.2: another centre's agent is a plain 404 common.not_found (never 403).
    if (params.id === A2_AGENT_ID)
      return HttpResponse.json({ type: 'urn:lims:error:common.not_found', title: 'Not found', status: 404, code: 'common.not_found' }, { status: 404 });
    return HttpResponse.json({ id: AGENT_ID, agent_code: 'SYN-AGENT-1', display_name: 'Synthetic bench PC', centre_id: CENTRE_A1, status: 'active', update_channel: 'stable', backlog_threshold: 100, version: 3, latest_config_version: 1, health: { state: 'online', health_version: 1, queue_depth: 0, oldest_pending_age_seconds: 0, queue_rejected: 0, queue_oversize: 0 }, credentials: [] });
  }),
  http.post(`${ORIGIN}/v1/instruments/agents/:id/enrolment-codes`, async ({ request }) => {
    seen.push({ url: new URL(request.url), method: request.method, headers: request.headers, body: await request.json() });
    return HttpResponse.json({ enrolment_code: SECRET, expires_at: '2026-11-08T04:05:00.000Z', credential_id: '01a1a98a-ac40-7000-8000-0000000a0002' }, { status: 201 });
  }),
  http.post(`${ORIGIN}/v1/instruments/agents`, async ({ request }) => {
    seen.push({ url: new URL(request.url), method: request.method, headers: request.headers, body: await request.json() });
    return HttpResponse.json({ id: AGENT_ID, agent_code: 'HUB-PC-01' }, { status: 201 });
  }),
  http.get(`${ORIGIN}/v1/instruments/agents/:id/health-transitions`, ({ request }) => {
    seen.push({ url: new URL(request.url), method: request.method, headers: request.headers });
    return HttpResponse.json({ data: [], page: { limit: 50 } });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); seen.length = 0; });
afterAll(() => server.close());

describe('WEB-T02 server functions', () => {
  it('listAgents → GET E10 with bearer from the session; filters map to contract query names (comma-separated arrays)', async () => {
    const { listAgents } = await import('../server/listAgents.server');
    const res = await listAgents({ centreId: CENTRE_A1, status: ['pending_enrolment', 'active'], healthState: ['offline', 'backlog'], sort: '-last_heartbeat_at', limit: 50 });
    expect(res).toEqual({ data: [], page: { limit: 50 } });
    const r = seen[0]!;
    expect(r.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(r.url.searchParams.get('centre_id')).toBe(CENTRE_A1);
    expect(r.url.searchParams.get('status')).toBe('pending_enrolment,active');
    expect(r.url.searchParams.get('health_state')).toBe('offline,backlog');
    expect(r.url.searchParams.get('sort')).toBe('-last_heartbeat_at');
    expect(r.url.searchParams.get('limit')).toBe('50');
  });

  it('listAgents omits unset filters (no "undefined" / empty params)', async () => {
    const { listAgents } = await import('../server/listAgents.server');
    await listAgents({});
    expect(seen[0]!.url.search).not.toMatch(/undefined|null|=(&|$)/);
  });

  it('listAgents rejects tampered enum input before it reaches the API (status=retired,evil)', async () => {
    const { listAgents } = await import('../server/listAgents.server');
    await expect(listAgents({ status: ['retired', "x'; drop table"] as never })).rejects.toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  it('getAgent: other-centre agent → ApiError 404 common.not_found (AC-16.2)', async () => {
    const { getAgent } = await import('../server/getAgent.server');
    await expect(getAgent(A2_AGENT_ID)).rejects.toMatchObject({ status: 404, problem: { code: 'common.not_found' } });
  });

  it('getAgent rejects a non-uuid id without calling the API (path injection)', async () => {
    const { getAgent } = await import('../server/getAgent.server');
    await expect(getAgent('../../v1/admin')).rejects.toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  it('issueEnrolmentCode → POST E14, empty JSON body, NO Idempotency-Key (x-idempotency: none, secret must not be stored for replay); returns the code (AC-01.3)', async () => {
    const { issueEnrolmentCode } = await import('../server/issueEnrolmentCode.server');
    const res = await issueEnrolmentCode(AGENT_ID);
    expect(res).toMatchObject({ enrolment_code: SECRET, expires_at: '2026-11-08T04:05:00.000Z' });
    const r = seen[0]!;
    expect(r.method).toBe('POST');
    expect(r.url.pathname).toBe(`/v1/instruments/agents/${AGENT_ID}/enrolment-codes`);
    expect(r.body).toEqual({});
    expect(r.headers.get('idempotency-key')).toBeNull();
  });

  it('issueEnrolmentCode never logs the code', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { issueEnrolmentCode } = await import('../server/issueEnrolmentCode.server');
    await issueEnrolmentCode(AGENT_ID);
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(SECRET);
  });

  it('issueEnrolmentCode propagates API errors with their code (agent_not_active, mfa_required) and nothing else leaks', async () => {
    const { issueEnrolmentCode } = await import('../server/issueEnrolmentCode.server');
    for (const [status, code] of [[409, 'instruments.agent_not_active'], [403, 'auth.mfa_required']] as const) {
      server.use(http.post(`${ORIGIN}/v1/instruments/agents/:id/enrolment-codes`, () => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 't', status, code }, { status })));
      await expect(issueEnrolmentCode(AGENT_ID)).rejects.toMatchObject({ status, problem: { code } });
    }
  });

  it('createAgent → POST E11 with a fresh Idempotency-Key per call (x-idempotency: required) and the contract body', async () => {
    const { createAgent } = await import('../server/createAgent.server');
    const input = { agent_code: 'HUB-PC-01', display_name: 'Hub PC', centre_id: CENTRE_A1, update_channel: 'stable' as const };
    await createAgent(input);
    await createAgent(input);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.body).toEqual(input);
    const k = seen.map((s) => s.headers.get('idempotency-key'));
    expect(k[0]).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(k[1]).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('createAgent rejects an agent_code that breaks ^[A-Z0-9-]{2,32}$ before calling the API', async () => {
    const { createAgent } = await import('../server/createAgent.server');
    await expect(createAgent({ agent_code: 'bad code!', display_name: 'x', centre_id: CENTRE_A1 })).rejects.toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  // review #7: one Idempotency-Key per dialog open, minted by the client and passed through. ASSUMED: createAgent(input, idempotencyKey?).
  it('createAgent uses the caller-supplied Idempotency-Key (same key on a retry of the same dialog)', async () => {
    const { createAgent } = await import('../server/createAgent.server');
    const input = { agent_code: 'HUB-PC-01', display_name: 'Hub PC', centre_id: CENTRE_A1 };
    await createAgent(input, 'dialog-key_0123');
    await createAgent(input, 'dialog-key_0123');
    expect(seen.map((s) => s.headers.get('idempotency-key'))).toEqual(['dialog-key_0123', 'dialog-key_0123']);
  });

  it('createAgent rejects a malformed Idempotency-Key (^[A-Za-z0-9_-]{1,64}$) before calling the API (header injection)', async () => {
    const { createAgent } = await import('../server/createAgent.server');
    const input = { agent_code: 'HUB-PC-01', display_name: 'Hub PC', centre_id: CENTRE_A1 };
    for (const k of ['', 'a'.repeat(65), 'bad key', 'x\r\nX-Evil: 1']) await expect(createAgent(input, k), JSON.stringify(k)).rejects.toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  // review #4: SCR-02 Instruments tab is fed by E21. ASSUMED: server/listInstruments.server.ts → listInstruments({agentId, limit?, cursor?}) → {data, page}.
  it('listInstruments → GET E21 /v1/instruments/instruments?agent_id= with the bearer', async () => {
    server.use(http.get(`${ORIGIN}/v1/instruments/instruments`, ({ request }) => {
      seen.push({ url: new URL(request.url), method: request.method, headers: request.headers });
      return HttpResponse.json({ data: [{ id: '01a1a98a-ac40-7000-8000-0000000e0001', instrument_code: 'SIM-CHEM-1' }], page: { limit: 50 } });
    }));
    const { listInstruments } = await import('../server/listInstruments.server');
    const res = await listInstruments({ agentId: AGENT_ID });
    expect(res.data).toHaveLength(1);
    expect(seen[0]!.url.pathname).toBe('/v1/instruments/instruments');
    expect(seen[0]!.url.searchParams.get('agent_id')).toBe(AGENT_ID);
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
  });

  it('listInstruments rejects a non-uuid agent id without calling the API', async () => {
    const { listInstruments } = await import('../server/listInstruments.server');
    await expect(listInstruments({ agentId: '../../v1/admin' })).rejects.toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  it('listAgentHealthTransitions → GET E19 for the agent, limit 50 by default (AC-16.3 "last 50")', async () => {
    const { listAgentHealthTransitions } = await import('../server/listAgentHealthTransitions.server');
    await listAgentHealthTransitions(AGENT_ID);
    expect(seen[0]!.url.pathname).toBe(`/v1/instruments/agents/${AGENT_ID}/health-transitions`);
    expect(seen[0]!.url.searchParams.get('limit')).toBe('50');
  });
});
