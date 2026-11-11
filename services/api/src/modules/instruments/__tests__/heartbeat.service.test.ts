// C7 API-T06 — E03 submitAgentHeartbeat + E07 submitAgentLogBundle (02-TRD §7.2/§7.4; 03-APP-FLOW §2.4/§2.5; 01-PRD AC-13.1, AC-24.1, AC-24.3; 07-SECURITY S-01, S-02, S-05).
// Fails now because ../service/heartbeat.service.js does not exist. SEAMS: device.helpers.ts header.
import { describe, expect, it } from 'vitest';
import { responseViolations, violations } from './agents.contract.js';
import { AGENT_B, AGENT_X, AGENT_Z, CENTRE_A1, CENTRE_A2, CLIENT_IP, NOW, TENANT_A, TENANT_B, activeAgent, agentRow, bundleBody, cmd, heartbeatBody, idN, makeDeviceCtx, makeRepo, rejection } from './device.helpers.js';

const { createHeartbeatService } = await import('../service/heartbeat.service.js');
const mk = (seed?: Parameters<typeof makeRepo>[0]) => { const f = makeRepo({ agents: [activeAgent()], ...seed }); return { f, svc: createHeartbeatService({ repo: f.repo as any, now: () => new Date(NOW) }) }; };
const dev = (o: Parameters<typeof makeDeviceCtx>[0] = {}) => makeDeviceCtx(o).ctx;

describe('fixtures are valid against the contract', () => {
  it('heartbeatBody() satisfies #/components/schemas/Heartbeat (so failures below are not fixture noise)', () => { expect(violations('Heartbeat', heartbeatBody())).toEqual([]); });
});

describe('E03 submitAgentHeartbeat — recording (AC-13.1)', () => {
  it('200 {server_time, latest_config_version, health_state, commands}: schema-valid, health_state = the STORED state (heartbeat never writes it)', async () => {
    const { f, svc } = mk({ agents: [activeAgent({ latest_config_version: 4 })] });
    const r = await svc.submitAgentHeartbeat(dev(), { body: heartbeatBody() });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ server_time: NOW, latest_config_version: 4, health_state: 'offline', commands: [] });
    expect(responseViolations('submitAgentHeartbeat', '200', r.body)).toEqual([]);
    expect(f.agent(AGENT_X).health).toMatchObject({ health_state: 'offline', health_version: 3 });
  });
  it('recordHeartbeat gets only heartbeat-owned columns; never health_state/health_version/state_changed_at/silent_instrument_ids', async () => {
    const { f, svc } = mk();
    await svc.submitAgentHeartbeat(dev(), { body: heartbeatBody() });
    const [, row] = f.callsOf('recordHeartbeat')[0]!.args as [string, Record<string, unknown>];
    for (const k of ['health_state', 'health_version', 'state_changed_at', 'silent_instrument_ids']) expect(row, k).not.toHaveProperty(k);
  });
  it('maps the body to agent_status: versions, queue, disk, clock, config, update, auth, counters, last_ip from the request', async () => {
    const { f, svc } = mk();
    await svc.submitAgentHeartbeat(dev(), { body: heartbeatBody({ update: { state: 'failed', target_version: '1.3.0', error_code: 'sig_bad' }, config: { applied_version: 3, state: 'signature_invalid' }, auth_state: 'rejected' }) });
    expect(f.agent(AGENT_X).health).toMatchObject({
      last_heartbeat_at: NOW, agent_version: '1.2.4', launcher_version: '1.0.1', os_version: 'Windows 11 24H2', queue_depth: 4, oldest_pending_age_seconds: 12, queue_rejected: 2, queue_oversize: 1,
      disk_free_mb: 40960, clock_offset_ms: 1500, clock_offset_uncertainty_ms: 50, config_version_applied: 3, config_state: 'signature_invalid', update_state: 'failed', update_target_version: '1.3.0',
      update_error_code: 'sig_bad', auth_state: 'rejected', last_ip: CLIENT_IP,
    });
    expect(f.agent(AGENT_X).health.counters).toMatchObject({ astm_naks_sent: 0, host_query_unavailable: 0 });
  });
  it('last_heartbeat_at is the SERVER clock, not the agent-supplied sent_at_agent (a skewed or hostile clock cannot fake liveness)', async () => {
    const { f, svc } = mk();
    await svc.submitAgentHeartbeat(dev(), { body: heartbeatBody({ sent_at_agent: '2030-01-01T00:00:00.000Z' }) });
    expect(f.agent(AGENT_X).health.last_heartbeat_at).toBe(NOW);
  });
  it('first heartbeat of an agent without an agent_status row works (health stays offline until the evaluator runs)', async () => {
    const { f, svc } = mk({ agents: [activeAgent({ health: null })] });
    const r = await svc.submitAgentHeartbeat(dev(), { body: heartbeatBody() });
    expect(r.body.health_state).toBe('offline'); expect(f.agent(AGENT_X).health.last_heartbeat_at).toBe(NOW);
  });
});

describe('E03 command delivery (AC-24.1, 03-APP-FLOW §2.5)', () => {
  it('a queued command rides the next heartbeat response {command_id, kind, params, expires_at} and becomes delivered', async () => {
    const { f, svc } = mk({ commands: [cmd(1, { kind: 'upload_logs' })] });
    const r = await svc.submitAgentHeartbeat(dev(), { body: heartbeatBody() });
    expect(r.body.commands).toEqual([{ command_id: idN(0x8001), kind: 'upload_logs', params: {}, expires_at: '2026-11-08T12:00:00.000Z' }]);
    expect(responseViolations('submitAgentHeartbeat', '200', r.body)).toEqual([]);
    expect(f.commands[0]).toMatchObject({ state: 'delivered', delivered_at: NOW });
  });
  it('reupload_since keeps its params.since; a delivered command is re-sent in EVERY heartbeat until a result arrives', async () => {
    const { svc } = mk({ commands: [cmd(1, { kind: 'reupload_since', params: { since: '2026-11-06T12:00:00.000Z' } })] });
    const a = await svc.submitAgentHeartbeat(dev(), { body: heartbeatBody() }), b = await svc.submitAgentHeartbeat(dev(), { body: heartbeatBody() });
    expect(a.body.commands).toHaveLength(1); expect(b.body.commands).toEqual(a.body.commands);
    expect(a.body.commands[0].params).toEqual({ since: '2026-11-06T12:00:00.000Z' });
  });
  it('delivered_at is stamped once (first delivery), oldest requested_at first', async () => {
    const { f, svc } = mk({ commands: [cmd(2, { kind: 'restart_service' }), cmd(1, { kind: 'refresh_config' })] });
    const r = await svc.submitAgentHeartbeat(dev(), { body: heartbeatBody() });
    expect(r.body.commands.map((c: any) => c.kind)).toEqual(['refresh_config', 'restart_service']);
    expect(f.commands.every((c) => c.delivered_at === NOW)).toBe(true);
  });
  it('expired (expires_at <= now), completed, failed and expired-state commands are NOT delivered (AC-24.3)', async () => {
    const { svc } = mk({ commands: [cmd(1, { expires_at: NOW }), cmd(2, { expires_at: '2026-11-07T11:59:59.999Z' }), cmd(3, { state: 'completed' }), cmd(4, { state: 'failed' }), cmd(5, { state: 'expired' })] });
    expect((await svc.submitAgentHeartbeat(dev(), { body: heartbeatBody() })).body.commands).toEqual([]);
  });
  it('commands of another agent (same tenant, S-02) and of another tenant (S-01) are never delivered nor changed', async () => {
    const z = agentRow({ id: AGENT_Z, centre_id: CENTRE_A2, agent_code: 'HUB-PC-Z' }), b = agentRow({ id: AGENT_B, tenant_id: TENANT_B, agent_code: 'HUB-B' });
    const { f, svc } = mk({ agents: [activeAgent(), z, b], commands: [cmd(1, { agent_id: AGENT_Z, centre_id: CENTRE_A2 }), cmd(2, { agent_id: AGENT_X, tenant_id: TENANT_B })] });
    expect((await svc.submitAgentHeartbeat(dev(), { body: heartbeatBody() })).body.commands).toEqual([]);
    expect(f.commands.map((c) => c.state)).toEqual(['queued', 'queued']);
    for (const c of f.calls) expect(c.tenantId).toBe(TENANT_A);
  });
});

describe('E03 command_results', () => {
  const res = (id: string, state: string, result_code?: string) => ({ command_id: id, state, ...(result_code ? { result_code } : {}) });
  it('delivered -> completed / failed with result_code and completed_at; the finished command is not in the same response', async () => {
    const { f, svc } = mk({ commands: [cmd(1, { state: 'delivered' }), cmd(2, { state: 'delivered' })] });
    const r = await svc.submitAgentHeartbeat(dev(), { body: heartbeatBody({ command_results: [res(idN(0x8001), 'completed'), res(idN(0x8002), 'failed', 'disk_full')] }) });
    expect(f.commands.map((c) => [c.state, c.result_code, c.completed_at])).toEqual([['completed', null, NOW], ['failed', 'disk_full', NOW]]);
    expect(r.body.commands).toEqual([]);
  });
  it('is idempotent: a repeated result changes nothing and does not fail the heartbeat (agent retries by command_id)', async () => {
    const { f, svc } = mk({ commands: [cmd(1, { state: 'completed', completed_at: '2026-11-07T11:00:00.000Z', result_code: 'ok' })] });
    const r = await svc.submitAgentHeartbeat(dev(), { body: heartbeatBody({ command_results: [res(idN(0x8001), 'failed', 'late')] }) });
    expect(r.status).toBe(200); expect(f.commands[0]).toMatchObject({ state: 'completed', result_code: 'ok', completed_at: '2026-11-07T11:00:00.000Z' });
  });
  it('unknown, queued (never delivered), foreign-agent and foreign-tenant command ids are ignored — heartbeat still 200 and nothing else changes', async () => {
    const z = agentRow({ id: AGENT_Z, centre_id: CENTRE_A2, agent_code: 'HUB-PC-Z' });
    const { f, svc } = mk({ agents: [activeAgent(), z], commands: [cmd(1, { state: 'queued' }), cmd(2, { state: 'delivered', agent_id: AGENT_Z, centre_id: CENTRE_A2 }), cmd(3, { state: 'delivered', tenant_id: TENANT_B })] });
    const r = await svc.submitAgentHeartbeat(dev(), { body: heartbeatBody({ command_results: [res(idN(0x8001), 'completed'), res(idN(0x8002), 'completed'), res(idN(0x8003), 'completed'), res(idN(0x80ff), 'completed')] }) });
    expect(r.status).toBe(200);
    expect(f.commands.slice(1).map((c) => c.state)).toEqual(['delivered', 'delivered']);
    expect(f.commands[0]!.state).not.toBe('completed');
  });
});

describe('E03 authorisation', () => {
  it.each([['enrolment_code'], [null], ['x']])('credential kind %s -> 401 auth.device_token_invalid before any repo access (AC-01.6/S-05)', async (kind) => {
    const { f, svc } = mk();
    const e = await rejection(svc.submitAgentHeartbeat(dev({ kind: kind as any }), { body: heartbeatBody() }));
    expect(e.code).toBe('auth.device_token_invalid'); expect(f.calls).toHaveLength(0);
  });
  it.each([['revoked'], ['retired'], ['pending_enrolment']])('agent status %s -> 401, no heartbeat recorded, no command delivered', async (status) => {
    const { f, svc } = mk({ agents: [activeAgent({ status })], commands: [cmd(1)] });
    const e = await rejection(svc.submitAgentHeartbeat(dev(), { body: heartbeatBody() }));
    expect(e.code).toBe('auth.device_token_invalid'); expect(f.mutations()).toHaveLength(0);
  });
  it('agent of another tenant / unknown -> 401 (S-01)', async () => {
    expect((await rejection(mk({ agents: [activeAgent({ tenant_id: TENANT_B })] }).svc.submitAgentHeartbeat(dev(), { body: heartbeatBody() }))).code).toBe('auth.device_token_invalid');
  });
  it('fails closed without a request context', async () => {
    const { svc } = mk();
    expect((await rejection(svc.submitAgentHeartbeat({ ...dev(), tx: undefined }, { body: heartbeatBody() }))).code).toBe('auth.unauthenticated');
  });
  it('a failing write is not swallowed (the core rolls the tx back; the agent retries)', async () => {
    const { f, svc } = mk({ commands: [cmd(1)] });
    f.repo.recordHeartbeat = async () => { throw new Error('db down'); };
    expect((await rejection(svc.submitAgentHeartbeat(dev(), { body: heartbeatBody() }))).message).toBe('db down');
  });
});

describe('E07 submitAgentLogBundle (AC-24.1)', () => {
  const delivered = (o: Record<string, unknown> = {}) => cmd(1, { kind: 'upload_logs', state: 'delivered', delivered_at: '2026-11-07T11:30:00.000Z', ...o });
  const CID = idN(0x8001);
  it('201 {bundle_id}: stores lines/from/to with the agent, centre and command ids; schema-valid', async () => {
    const { f, svc } = mk({ commands: [delivered()] });
    const r = await svc.submitAgentLogBundle(dev(), { body: bundleBody(CID) });
    expect(r.status).toBe(201); expect(Object.keys(r.body)).toEqual(['bundle_id']);
    expect(responseViolations('submitAgentLogBundle', '201', r.body)).toEqual([]);
    expect(f.bundles).toHaveLength(1);
    expect(f.bundles[0]).toMatchObject({ id: r.body.bundle_id, tenant_id: TENANT_A, agent_id: AGENT_X, centre_id: CENTRE_A1, command_id: CID, lines: ['synthetic log line one', 'synthetic log line two'],
      from_at_agent: '2026-11-06T12:00:00.000Z', to_at_agent: '2026-11-07T11:00:00.000Z' });
    expect(Number.isInteger(f.bundles[0]!.size_bytes) && f.bundles[0]!.size_bytes > 0).toBe(true);
  });
  it('tenant, centre and agent come from the authenticated device, never from the body', async () => {
    const { f, svc } = mk({ commands: [delivered()] });
    await svc.submitAgentLogBundle(dev(), { body: { ...bundleBody(CID), tenant_id: TENANT_B, agent_id: AGENT_Z, centre_id: CENTRE_A2 } as any });
    expect(f.bundles[0]).toMatchObject({ tenant_id: TENANT_A, agent_id: AGENT_X, centre_id: CENTRE_A1 });
  });
  it.each([
    ['unknown command id', () => ({ commands: [] as any[] })],
    ['command of another agent in the same tenant (S-02)', () => ({ agents: [activeAgent(), agentRow({ id: AGENT_Z, centre_id: CENTRE_A2, agent_code: 'HUB-PC-Z' })], commands: [delivered({ agent_id: AGENT_Z, centre_id: CENTRE_A2 })] })],
    ['command of another tenant (S-01)', () => ({ commands: [delivered({ tenant_id: TENANT_B })] })],
  ])('%s -> 404 common.not_found, nothing stored', async (_n, seed) => {
    const { f, svc } = mk(seed());
    const e = await rejection(svc.submitAgentLogBundle(dev(), { body: bundleBody(CID) }));
    expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404); expect(f.bundles).toHaveLength(0);
  });
  it.each([
    ['queued (never delivered)', { state: 'queued', delivered_at: null }],
    ['completed', { state: 'completed' }],
    ['failed', { state: 'failed' }],
    ['expired state', { state: 'expired' }],
    ['delivered but past expires_at', { expires_at: NOW }],
  ])('command %s -> 409 instruments.invalid_transition, nothing stored', async (_n, over) => {
    const { f, svc } = mk({ commands: [delivered(over)] });
    const e = await rejection(svc.submitAgentLogBundle(dev(), { body: bundleBody(CID) }));
    expect(e.code).toBe('instruments.invalid_transition'); expect(e.statusCode).toBe(409); expect(f.bundles).toHaveLength(0);
  });
  it.each([['enrolment_code'], [null]])('credential kind %s -> 401 (AC-01.6)', async (kind) => {
    const { f, svc } = mk({ commands: [delivered()] });
    expect((await rejection(svc.submitAgentLogBundle(dev({ kind: kind as any }), { body: bundleBody(CID) }))).code).toBe('auth.device_token_invalid'); expect(f.calls).toHaveLength(0);
  });
  it.each([['revoked'], ['retired']])('agent status %s -> 401, nothing stored', async (status) => {
    const { f, svc } = mk({ agents: [activeAgent({ status })], commands: [delivered()] });
    expect((await rejection(svc.submitAgentLogBundle(dev(), { body: bundleBody(CID) }))).code).toBe('auth.device_token_invalid'); expect(f.bundles).toHaveLength(0);
  });
  it('a failing insert is not swallowed', async () => {
    const { f, svc } = mk({ commands: [delivered()] });
    f.repo.insertLogBundle = async () => { throw new Error('db down'); };
    expect((await rejection(svc.submitAgentLogBundle(dev(), { body: bundleBody(CID) }))).message).toBe('db down');
  });
});
