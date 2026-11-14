// C7 API-T04 — agents service E10-E21 (integration over an in-memory AgentsRepo + the REAL core access() validator; seams in agents.helpers.ts header).
// ACs: AC-01.1/.2/.3, AC-02.1/.2(issue half)/.3/.4, AC-16.1/.2/.3, AC-24.3 (command expiry stamp); done_when: access_log rows, secrets never in DTOs.
// 07-SECURITY: S-02 (cross-tenant/centre probes -> 404), S-04 (technologist/reader -> 403), S-06 (no secret after issuance), AB (BOLA: load under RLS THEN assertRole(centre_id)).
import { describe, expect, it } from 'vitest';
import { createAgentsService } from '../service/agents.service.js';
import {
  CENTRE_A1, CENTRE_A2, CENTRE_FRANCHISE, CENTRE_HOME, CENTRE_INACTIVE, NOW, SECRET_HEX, TENANT_A, TENANT_B, USER,
  agentRow, bundleRow, commandRow, credRow, forbidden, idN, makeCtx, makeRepo, onlyCentre, readerOnly, rejection, sha256, transitionRow,
  type FakeSeed,
} from './agents.helpers.js';

const AID = idN(0x1000);
const now = () => new Date(NOW);
function world(seed: FakeSeed = {}, ctxOver: Parameters<typeof makeCtx>[0] = {}) {
  const r = makeRepo({ agents: [agentRow({ id: AID })], ...seed });
  const c = makeCtx(ctxOver);
  const svc: any = createAgentsService({ repo: r.repo, now });
  return { ...r, ...c, svc };
}
const noSecrets = (x: unknown) => { const s = JSON.stringify(x); expect(s).not.toContain(SECRET_HEX); expect(s).not.toContain('secret_sha256'); expect(s).not.toContain(Buffer.from(SECRET_HEX, 'hex').toString('base64')); };
const ACTIVE_CRED = (n: number, kind = 'device_token') => credRow({ id: idN(n), kind });

describe('fail closed', () => {
  it.each(['listAgents', 'createAgent', 'getAgent', 'updateAgent', 'issueEnrolmentCode', 'revokeAgent', 'retireAgent', 'requestAgentCommand', 'listAgentCommands', 'listAgentHealthTransitions', 'getAgentLogBundle', 'listAgentReleases'])(
    '%s without tenant / actor / tx -> auth.unauthenticated, repo untouched', async (op) => {
      const w = world();
      for (const bad of [{}, { tenantId: 'x' }, { tenantId: TENANT_A, actor: { id: USER } }, { ...w.ctx, tx: undefined }, { ...w.ctx, tenantId: undefined }]) {
        const e = await rejection(w.svc[op](bad, { agentId: AID }));
        expect(e?.code, op).toBe('auth.unauthenticated');
      }
      expect(w.calls).toHaveLength(0);
    });
});

describe('E11 createAgent — AC-01.1 / AC-01.2', () => {
  const input = (o: Record<string, unknown> = {}) => ({ agentCode: 'HUB-PC-02', displayName: 'Hub PC 2', centreId: CENTRE_A1, ...o });
  it.each([['own', CENTRE_A1], ['franchise', CENTRE_FRANCHISE]])('AC-01.1 centre kind %s -> 201 Agent pending_enrolment, no credential, one insert, no access row', async (_k, centre) => {
    const w = world({ agents: [] });
    const r = await w.svc.createAgent(w.ctx, input({ centreId: centre }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ agent_code: 'HUB-PC-02', display_name: 'Hub PC 2', centre_id: centre, status: 'pending_enrolment', update_channel: 'stable', credentials: [], version: 1 });
    expect(r.version).toBe(1);
    expect(w.callsOf('insertAgent')).toHaveLength(1); expect(w.callsOf('insertCredential')).toHaveLength(0);
    expect(w.callsOf('insertAgent')[0]!.tenantId).toBe(TENANT_A);
    expect(w.accessRows()).toHaveLength(0);
    expect(w.asserted).toEqual([{ permission: 'instruments.agent.manage', centreId: centre }]);   // object-level rule: create asserts with the target centre from the body
  });
  it('passes update_channel and backlog_threshold through; id is server-generated (uuidv7), created_by = actor', async () => {
    const w = world({ agents: [] });
    await w.svc.createAgent(w.ctx, input({ updateChannel: 'beta', backlogThreshold: 500 }));
    const row = w.callsOf('insertAgent')[0]!.args[0] as any;
    expect(row).toMatchObject({ update_channel: 'beta', backlog_threshold: 500, created_by: USER, centre_id: CENTRE_A1, agent_code: 'HUB-PC-02' });
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it.each([['home_collection', CENTRE_HOME], ['inactive centre', CENTRE_INACTIVE], ['unknown centre', idN(0xdead)]])('AC-01.2 %s -> 400 common.validation_failed, errors[0].path = /centre_id, nothing inserted', async (_n, centre) => {
    const w = world({ agents: [] });
    const e = await rejection(w.svc.createAgent(w.ctx, input({ centreId: centre })));
    expect(e?.code).toBe('common.validation_failed');
    expect(e?.errors?.[0]?.path).toBe('/centre_id');
    expect(w.mutations()).toHaveLength(0);
  });
  it('duplicate agent_code in the tenant -> 409 instruments.code_duplicate (pg 23505 mapped), same code in another tenant is fine', async () => {
    const w = world();
    expect((await rejection(w.svc.createAgent(w.ctx, input({ agentCode: 'HUB-PC-01' }))))?.code).toBe('instruments.code_duplicate');
    const b = world({ agents: [agentRow({ id: AID })] }, { tenantId: TENANT_B });
    expect((await b.svc.createAgent(b.ctx, input({ agentCode: 'HUB-PC-01' }))).status).toBe(201);
  });
  it('S-04: a principal without agent.manage (reader) or without rights at the target centre gets 403 and nothing is written', async () => {
    const a = world({ agents: [] }, { roles: readerOnly });
    expect((await rejection(a.svc.createAgent(a.ctx, input())))?.code).toBe('auth.forbidden');
    const b = world({ agents: [] }, { roles: onlyCentre(CENTRE_A1) });
    expect((await rejection(b.svc.createAgent(b.ctx, input({ centreId: CENTRE_A2 }))))?.code).toBe('auth.forbidden');
    expect(a.mutations().length + b.mutations().length).toBe(0);
  });
  it('rejects a body that smuggles status / credentials / tenant_id (service builds the row itself)', async () => {
    const w = world({ agents: [] });
    await w.svc.createAgent(w.ctx, input({ status: 'active', tenantId: TENANT_B, credentials: [{ x: 1 }], version: 9 } as any));
    expect(w.callsOf('insertAgent')[0]!.tenantId).toBe(TENANT_A);
    expect(w.agents[0]).toMatchObject({ status: 'pending_enrolment', tenant_id: TENANT_A, version: 1 });
  });
});

describe('E14 issueEnrolmentCode — AC-01.3 / AC-02.3', () => {
  it('201 { enrolment_code, expires_at, credential_id }: lmse_ + 22 base64url, expires exactly 24 h from now, DB gets only sha256', async () => {
    const w = world();
    const r = await w.svc.issueEnrolmentCode(w.ctx, { agentId: AID });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['credential_id', 'enrolment_code', 'expires_at']);
    expect(r.body.enrolment_code).toMatch(/^lmse_[A-Za-z0-9_-]{22}$/);
    expect(new Date(r.body.expires_at).getTime()).toBe(new Date(NOW).getTime() + 24 * 3600 * 1000);
    const ins = w.callsOf('insertCredential')[0]!.args[0] as any;
    expect(ins).toMatchObject({ id: r.body.credential_id, agent_id: AID, centre_id: CENTRE_A1, kind: 'enrolment_code', issued_by: USER });
    expect(Buffer.from(ins.secret_sha256).equals(sha256(r.body.enrolment_code))).toBe(true);
    expect(new Date(ins.expires_at).getTime()).toBe(new Date(r.body.expires_at).getTime());
  });
  it('the plaintext code appears exactly once in the whole interaction: the response (not in repo args, access_log rows, logs)', async () => {
    const w = world(); const logs: unknown[] = []; w.ctx.log = { info: (o: unknown) => logs.push(o), warn: (o: unknown) => logs.push(o), error: (o: unknown) => logs.push(o) };
    const r = await w.svc.issueEnrolmentCode(w.ctx, { agentId: AID });
    const code = r.body.enrolment_code as string;
    for (const hay of [JSON.stringify(w.calls), JSON.stringify(w.accessRows()), JSON.stringify(w.inserts), JSON.stringify(logs), JSON.stringify(r.headers ?? {})]) expect(hay).not.toContain(code);
    expect(r.version).toBeUndefined();
  });
  it('writes exactly one access_log row: device_credential.issue / agent_credential / new credential id / allowed, centre of the agent', async () => {
    const w = world();
    const r = await w.svc.issueEnrolmentCode(w.ctx, { agentId: AID });
    expect(w.accessRows()).toEqual([expect.objectContaining({ action: 'device_credential.issue', entityType: 'agent_credential', entityId: r.body.credential_id, outcome: 'allowed', centreId: CENTRE_A1, tenantId: TENANT_A, actorId: USER })]);
  });
  it('revokes earlier UNUSED codes only (kinds [enrolment_code]); the live device token is untouched (A3 revokes it only at redemption)', async () => {
    const w = world({ agents: [agentRow({ id: AID, credentials: [ACTIVE_CRED(0x5001, 'device_token'), ACTIVE_CRED(0x5002, 'enrolment_code')] })] });
    await w.svc.issueEnrolmentCode(w.ctx, { agentId: AID });
    expect(w.callsOf('revokeCredentials')[0]!.args[1]).toMatchObject({ kinds: ['enrolment_code'] });
    const cs = w.credentials();
    expect(cs.find((c: any) => c.id === idN(0x5001))!.status).toBe('active');
    expect(cs.find((c: any) => c.id === idN(0x5002))!.status).toBe('revoked');
    expect(cs.filter((c: any) => c.kind === 'enrolment_code' && c.status === 'active')).toHaveLength(1);
  });
  it.each(['pending_enrolment', 'active', 'revoked'])('allowed for a %s agent (AC-02.3: re-enrolment after revoke)', async (status) => {
    const w = world({ agents: [agentRow({ id: AID, status })] });
    expect((await w.svc.issueEnrolmentCode(w.ctx, { agentId: AID })).status).toBe(201);
  });
  it('retired agent -> 409 instruments.agent_not_active, no credential, no access row', async () => {
    const w = world({ agents: [agentRow({ id: AID, status: 'retired', retired_at: NOW })] });
    expect((await rejection(w.svc.issueEnrolmentCode(w.ctx, { agentId: AID })))?.code).toBe('instruments.agent_not_active');
    expect(w.mutations()).toHaveLength(0); expect(w.accessRows()).toHaveLength(0);
  });
  it('race guard: locks the agent row (lockAgent, tenant-scoped) before revoking earlier codes and inserting the new one', async () => {
    const w = world();
    await w.svc.issueEnrolmentCode(w.ctx, { agentId: AID });
    const order = w.calls.map((c) => c.op);
    expect(order).toContain('lockAgent');
    expect(order.indexOf('lockAgent')).toBeLessThan(order.indexOf('revokeCredentials'));
    expect(order.indexOf('lockAgent')).toBeLessThan(order.indexOf('insertCredential'));
    expect(w.callsOf('lockAgent')[0]).toMatchObject({ tenantId: TENANT_A, args: [AID] });
  });
  it('race guard: status is re-checked on the LOCKED row — retired by a concurrent tx -> 409 agent_not_active, nothing written', async () => {
    const w = world();
    const lock = w.repo.lockAgent;
    w.repo.lockAgent = async (...a: Parameters<typeof lock>) => { const r = await lock(...a); return r && { ...r, status: 'retired' }; };
    expect((await rejection(w.svc.issueEnrolmentCode(w.ctx, { agentId: AID })))?.code).toBe('instruments.agent_not_active');
    expect(w.mutations()).toHaveLength(0); expect(w.accessRows()).toHaveLength(0);
  });
  it('two codes issued back to back differ (CSPRNG) and only the newest stays active', async () => {
    const w = world({ agents: [agentRow({ id: AID, credentials: [] })] });
    const a = await w.svc.issueEnrolmentCode(w.ctx, { agentId: AID }); const b = await w.svc.issueEnrolmentCode(w.ctx, { agentId: AID });
    expect(a.body.enrolment_code).not.toBe(b.body.enrolment_code);
    expect(w.credentials().filter((c: any) => c.status === 'active').map((c: any) => c.id)).toEqual([b.body.credential_id]);
  });
});

describe('E15 revokeAgent — AC-02.1', () => {
  const two = () => [agentRow({ id: AID, credentials: [ACTIVE_CRED(0x5001), ACTIVE_CRED(0x5002, 'enrolment_code'), credRow({ id: idN(0x5003), status: 'used', kind: 'enrolment_code' })] })];
  it('status -> revoked, ALL active credentials -> revoked with the reason, 200 Agent with ETag version', async () => {
    const w = world({ agents: two() });
    const r = await w.svc.revokeAgent(w.ctx, { agentId: AID, expectedVersion: 1, reasonCode: 'device_lost_or_stolen', reasonText: 'laptop stolen' });
    expect(r.status).toBe(200); expect(r.version).toBe(2);
    expect(r.body).toMatchObject({ status: 'revoked', revoke_reason_code: 'device_lost_or_stolen', version: 2 });
    expect(w.credentials().map((c: any) => [c.id, c.status])).toEqual([[idN(0x5001), 'revoked'], [idN(0x5002), 'revoked'], [idN(0x5003), 'used']]);
    expect(w.callsOf('revokeCredentials')[0]!.args[1]).toMatchObject({ kinds: expect.arrayContaining(['device_token', 'enrolment_code']), reasonCode: 'device_lost_or_stolen', actorId: USER });
    noSecrets(r.body);
  });
  it('writes one access_log row device_credential.revoke per revoked credential (entity = that credential), none for the already-used one', async () => {
    const w = world({ agents: two() });
    await w.svc.revokeAgent(w.ctx, { agentId: AID, expectedVersion: 1, reasonCode: 'device_lost_or_stolen' });
    const rows = w.accessRows();
    expect(rows.map((x: any) => x.entityId).sort()).toEqual([idN(0x5001), idN(0x5002)]);
    for (const x of rows) expect(x).toMatchObject({ action: 'device_credential.revoke', entityType: 'agent_credential', outcome: 'allowed', centreId: CENTRE_A1, tenantId: TENANT_A });
  });
  it('a pending_enrolment agent (A4) can be revoked; with no active credential there is no access row', async () => {
    const w = world({ agents: [agentRow({ id: AID, status: 'pending_enrolment', credentials: [] })] });
    expect((await w.svc.revokeAgent(w.ctx, { agentId: AID, expectedVersion: 1, reasonCode: 'other' })).body.status).toBe('revoked');
    expect(w.accessRows()).toHaveLength(0);
  });
  it.each(['revoked', 'retired'])('%s agent -> 409 instruments.invalid_transition, nothing changed', async (status) => {
    const w = world({ agents: [agentRow({ id: AID, status, credentials: [ACTIVE_CRED(0x5001)] })] });
    expect((await rejection(w.svc.revokeAgent(w.ctx, { agentId: AID, expectedVersion: 1, reasonCode: 'other' })))?.code).toBe('instruments.invalid_transition');
    expect(w.mutations()).toHaveLength(0); expect(w.accessRows()).toHaveLength(0);
  });
  it('missing If-Match -> 428; stale version -> 409 common.version_conflict and credentials stay active, no access rows', async () => {
    const w = world({ agents: two() });
    expect((await rejection(w.svc.revokeAgent(w.ctx, { agentId: AID, expectedVersion: undefined, reasonCode: 'other' })))?.code).toBe('common.precondition_required');
    expect((await rejection(w.svc.revokeAgent(w.ctx, { agentId: AID, expectedVersion: 7, reasonCode: 'other' })))?.code).toBe('common.version_conflict');
    expect(w.credentials().filter((c: any) => c.status === 'revoked')).toHaveLength(0); expect(w.accessRows()).toHaveLength(0);
  });
  it('reason_code outside instruments.g_cs_revoke_reasons -> 400 validation_failed path /reason_code, nothing changed', async () => {
    const w = world({ agents: two() });
    const e = await rejection(w.svc.revokeAgent(w.ctx, { agentId: AID, expectedVersion: 1, reasonCode: 'made_up' }));
    expect(e?.code).toBe('common.validation_failed'); expect(e?.errors?.[0]?.path).toBe('/reason_code');
    expect(w.mutations()).toHaveLength(0);
  });
  it('two managers revoking at the same version concurrently: exactly one wins, the other gets 409, access rows are not duplicated', async () => {
    const w = world({ agents: two() });
    const res = await Promise.allSettled([1, 2].map(() => w.svc.revokeAgent(w.ctx, { agentId: AID, expectedVersion: 1, reasonCode: 'device_lost_or_stolen' })));
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost: any = res.find((x) => x.status === 'rejected'); expect(['common.version_conflict', 'instruments.invalid_transition']).toContain(lost.reason.code);
    expect(w.accessRows()).toHaveLength(2);
  });
});

describe('E16 retireAgent — AC-02.4', () => {
  it('AC-02.4 non-retired instruments -> 409 instruments.agent_has_active_instruments, nothing changed, no access rows', async () => {
    const w = world({ agents: [agentRow({ id: AID, credentials: [ACTIVE_CRED(0x5001)] })], instruments: [{ tenant_id: TENANT_A, agent_id: AID, state: 'live' }, { tenant_id: TENANT_A, agent_id: AID, state: 'retired' }] });
    expect((await rejection(w.svc.retireAgent(w.ctx, { agentId: AID, expectedVersion: 1, reasonCode: 'decommissioned' })))?.code).toBe('instruments.agent_has_active_instruments');
    expect(w.mutations()).toHaveLength(0); expect(w.accessRows()).toHaveLength(0);
    expect(w.agents[0]!.status).toBe('active');
  });
  it('only retired instruments (or none), or instruments of ANOTHER tenant/agent, do not block; remaining credentials are revoked, one access row each', async () => {
    const w = world({ agents: [agentRow({ id: AID, credentials: [ACTIVE_CRED(0x5001), ACTIVE_CRED(0x5002, 'enrolment_code')] })], instruments: [{ tenant_id: TENANT_A, agent_id: AID, state: 'retired' }, { tenant_id: TENANT_B, agent_id: AID, state: 'live' }, { tenant_id: TENANT_A, agent_id: idN(0x1999), state: 'live' }] });
    const r = await w.svc.retireAgent(w.ctx, { agentId: AID, expectedVersion: 1, reasonCode: 'decommissioned' });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ status: 'retired', version: 2 }); expect(r.version).toBe(2);
    expect(w.credentials().every((c: any) => c.status === 'revoked')).toBe(true);
    expect(w.accessRows().map((x: any) => [x.action, x.entityType, x.entityId]).sort()).toEqual([['device_credential.revoke', 'agent_credential', idN(0x5001)], ['device_credential.revoke', 'agent_credential', idN(0x5002)]]);
    noSecrets(r.body);
  });
  it('a revoked agent can be retired (A6); an already retired one -> 409 instruments.invalid_transition', async () => {
    const a = world({ agents: [agentRow({ id: AID, status: 'revoked', credentials: [] })] });
    expect((await a.svc.retireAgent(a.ctx, { agentId: AID, expectedVersion: 1, reasonCode: 'decommissioned' })).body.status).toBe('retired');
    const b = world({ agents: [agentRow({ id: AID, status: 'retired' })] });
    expect((await rejection(b.svc.retireAgent(b.ctx, { agentId: AID, expectedVersion: 1, reasonCode: 'decommissioned' })))?.code).toBe('instruments.invalid_transition');
  });
  it('If-Match rules as E15: 428 / 409 version_conflict', async () => {
    const w = world();
    expect((await rejection(w.svc.retireAgent(w.ctx, { agentId: AID, expectedVersion: undefined, reasonCode: 'decommissioned' })))?.code).toBe('common.precondition_required');
    expect((await rejection(w.svc.retireAgent(w.ctx, { agentId: AID, expectedVersion: 3, reasonCode: 'decommissioned' })))?.code).toBe('common.version_conflict');
    expect(w.accessRows()).toHaveLength(0);
  });
});

describe('E10 listAgents — AC-16.1 / AC-16.2', () => {
  const many = () => [agentRow({ id: idN(0x1001), agent_code: 'HUB-A', centre_id: CENTRE_A1 }), agentRow({ id: idN(0x1002), agent_code: 'HUB-B', centre_id: CENTRE_A2, health: { ...agentRow().health, health_state: 'offline' } }),
    agentRow({ id: idN(0x1003), agent_code: 'HUB-C', tenant_id: TENANT_B })];
  it('AC-16.1 returns AgentSummary items (state chip data, heartbeat, version, queue depth, clock offset) + page; no credentials, no secrets', async () => {
    const w = world({ agents: many() });
    const r = await w.svc.listAgents(w.ctx, {});
    expect(r.status).toBe(200);
    expect(r.body.data.map((a: any) => a.agent_code).sort()).toEqual(['HUB-A', 'HUB-B']);        // tenant B never listed
    expect(r.body.data[0]).toMatchObject({ health: { state: expect.any(String), queue_depth: 4, clock_offset_seconds: 2, last_heartbeat_at: expect.any(String), agent_version: '1.2.3' }, version: 1 });
    expect(r.body.data[0]).not.toHaveProperty('credentials');
    expect(r.body.page.limit).toBe(50);
    noSecrets(r.body);
  });
  it('filters by centre, status csv and health_state csv are handed to the repo as arrays; permission = agent.read (centre-scoped when filtering)', async () => {
    const w = world({ agents: many() });
    const r = await w.svc.listAgents(w.ctx, { centreId: CENTRE_A2, status: ['active', 'revoked'], healthState: ['offline'] });
    expect(r.body.data.map((a: any) => a.agent_code)).toEqual(['HUB-B']);
    expect(w.callsOf('listAgents')[0]!.args[0]).toMatchObject({ centreId: CENTRE_A2, status: ['active', 'revoked'], healthState: ['offline'] });
    expect(w.asserted[0]).toMatchObject({ permission: 'instruments.agent.read' });
  });
  it('page.next_cursor is passed through only when the repo gives one; limit echoes the request', async () => {
    const w = world({ agents: many() });
    const orig = w.repo.listAgents.bind(w.repo); w.repo.listAgents = async (...a) => ({ ...(await orig(...a)), nextCursor: 'CUR2' });
    const r = await w.svc.listAgents(w.ctx, { limit: 1 });
    expect(r.body.page).toEqual({ limit: 1, next_cursor: 'CUR2' });
  });
  it('S-04: a principal without agent.read -> 403 and no repo read of agents', async () => {
    const w = world({ agents: many() }, { roles: () => { throw forbidden(); } });
    expect((await rejection(w.svc.listAgents(w.ctx, {})))?.code).toBe('auth.forbidden');
    expect(w.callsOf('listAgents')).toHaveLength(0);
  });
});

describe('E12 getAgent — AC-16.2 / AC-16.3', () => {
  it('200 Agent with credentials summary (kind, status, issued/used/revoked — never secrets) and ETag version; asserts agent.read at the AGENT centre', async () => {
    const w = world({ agents: [agentRow({ id: AID, version: 4, credentials: [ACTIVE_CRED(0x5001), credRow({ id: idN(0x5002), kind: 'enrolment_code', status: 'used', used_at: NOW })] })] });
    const r = await w.svc.getAgent(w.ctx, { agentId: AID });
    expect(r.status).toBe(200); expect(r.version).toBe(4);
    expect(r.body.credentials).toHaveLength(2); expect(r.body.credentials[1]).toMatchObject({ kind: 'enrolment_code', status: 'used', used_at: NOW });
    expect(w.asserted).toEqual([{ permission: 'instruments.agent.read', centreId: CENTRE_A1 }]);
    noSecrets(r.body);
  });
  it('AC-16.2 an agent the caller cannot see (other centre / other tenant / unknown / malformed id) -> 404 common.not_found, assertRole never reached', async () => {
    const w = world({ agents: [agentRow({ id: AID, tenant_id: TENANT_B })] });   // RLS hides tenant B's row from tenant A
    for (const id of [AID, idN(0xdead), 'not-a-uuid', '', undefined]) expect((await rejection(w.svc.getAgent(w.ctx, { agentId: id })))?.code).toBe('common.not_found');
    expect(w.asserted).toHaveLength(0);
  });
  it('visible but forbidden (BOLA second half): assertRole denial -> 403, body never built', async () => {
    const w = world({}, { roles: onlyCentre(CENTRE_A2) });
    expect((await rejection(w.svc.getAgent(w.ctx, { agentId: AID })))?.code).toBe('auth.forbidden');
  });
});

describe('E13 updateAgent', () => {
  it('patch display_name / update_channel / backlog_threshold -> 200 with version+1 and ETag; only whitelisted columns reach the repo', async () => {
    const w = world();
    const r = await w.svc.updateAgent(w.ctx, { agentId: AID, expectedVersion: 1, patch: { display_name: 'Renamed', update_channel: 'beta', backlog_threshold: 250, status: 'revoked', tenant_id: TENANT_B, agent_code: 'X-X' } });
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ display_name: 'Renamed', update_channel: 'beta', backlog_threshold: 250, status: 'active', agent_code: 'HUB-PC-01' });
    expect(Object.keys(w.callsOf('updateAgent')[0]!.args[2] as object).sort()).toEqual(['backlog_threshold', 'display_name', 'update_channel']);
    expect(w.asserted).toEqual([{ permission: 'instruments.agent.manage', centreId: CENTRE_A1 }]);
    expect(w.accessRows()).toHaveLength(0);
  });
  it('If-Match: missing -> 428; stale -> 409 common.version_conflict; row unchanged', async () => {
    const w = world();
    expect((await rejection(w.svc.updateAgent(w.ctx, { agentId: AID, expectedVersion: undefined, patch: { display_name: 'x' } })))?.code).toBe('common.precondition_required');
    expect((await rejection(w.svc.updateAgent(w.ctx, { agentId: AID, expectedVersion: 5, patch: { display_name: 'x' } })))?.code).toBe('common.version_conflict');
    expect(w.agents[0]).toMatchObject({ display_name: 'Hub PC 1', version: 1 });
  });
  it('retired agent -> 409 instruments.agent_not_active', async () => {
    const w = world({ agents: [agentRow({ id: AID, status: 'retired' })] });
    expect((await rejection(w.svc.updateAgent(w.ctx, { agentId: AID, expectedVersion: 1, patch: { display_name: 'x' } })))?.code).toBe('instruments.agent_not_active');
  });
  it('pinned_release_id: visible+active release is set; unknown or inactive release -> 404; unset ["pinned_release_id"] clears it', async () => {
    const w = world();
    expect((await w.svc.updateAgent(w.ctx, { agentId: AID, expectedVersion: 1, patch: { pinned_release_id: idN(0x7001) } })).body.pinned_release_id).toBe(idN(0x7001));
    for (const rel of [idN(0xdead), idN(0x7003)]) expect((await rejection(w.svc.updateAgent(w.ctx, { agentId: AID, expectedVersion: 2, patch: { pinned_release_id: rel } })))?.code).toBe('common.not_found');
    const cleared = await w.svc.updateAgent(w.ctx, { agentId: AID, expectedVersion: 2, patch: { unset: ['pinned_release_id'] } });
    expect(cleared.body).not.toHaveProperty('pinned_release_id');
    expect(w.agents[0]!.pinned_release_id).toBeNull();
  });
});

describe('E17 requestAgentCommand — AC-24.3 (expiry stamp; the expiry job itself is API-T14)', () => {
  it.each(['upload_logs', 'refresh_config', 'restart_service'])('%s -> 202 AgentCommand queued, expires_at = now + 24 h, requested_by = actor, params {}', async (kind) => {
    const w = world();
    const r = await w.svc.requestAgentCommand(w.ctx, { agentId: AID, kind });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ kind, state: 'queued', agent_id: AID, params: {}, requested_by_display: expect.any(String) });
    expect(new Date(r.body.expires_at).getTime() - new Date(r.body.requested_at).getTime()).toBe(24 * 3600 * 1000);
    expect(w.callsOf('insertCommand')[0]!.args[0]).toMatchObject({ agent_id: AID, centre_id: CENTRE_A1, kind, requested_by: USER });
    expect(w.asserted).toEqual([{ permission: 'instruments.agent.manage', centreId: CENTRE_A1 }]);
  });
  it('reupload_since needs params.since (400 /params/since), at most 72 h in the past (400), otherwise stored as {since}', async () => {
    const w = world();
    const bad = async (params: unknown) => { const e = await rejection(w.svc.requestAgentCommand(w.ctx, { agentId: AID, kind: 'reupload_since', params })); expect(e?.code).toBe('common.validation_failed'); expect(e?.errors?.[0]?.path).toBe('/params/since'); };
    await bad(undefined); await bad({}); await bad({ since: 'yesterday' }); await bad({ since: '2026-11-04T11:59:59.000Z' });   // > 72 h ago
    expect(w.callsOf('insertCommand')).toHaveLength(0);
    const ok = await w.svc.requestAgentCommand(w.ctx, { agentId: AID, kind: 'reupload_since', params: { since: '2026-11-04T12:00:01.000Z' } });
    expect(ok.body.params).toEqual({ since: '2026-11-04T12:00:01.000Z' });
  });
  it('params are dropped for kinds that take none (no arbitrary JSON reaches the agent_commands row)', async () => {
    const w = world();
    await w.svc.requestAgentCommand(w.ctx, { agentId: AID, kind: 'upload_logs', params: { since: NOW, cmd: 'rm -rf', nested: { a: 1 } } });
    expect((w.callsOf('insertCommand')[0]!.args[0] as any).params).toEqual({});
  });
  it('unknown kind -> 400; retired agent -> 409 instruments.agent_not_active; reader -> 403; nothing queued in any failure', async () => {
    const a = world(); expect((await rejection(a.svc.requestAgentCommand(a.ctx, { agentId: AID, kind: 'format_disk' })))?.code).toBe('common.validation_failed');
    const b = world({ agents: [agentRow({ id: AID, status: 'retired' })] }); expect((await rejection(b.svc.requestAgentCommand(b.ctx, { agentId: AID, kind: 'upload_logs' })))?.code).toBe('instruments.agent_not_active');
    const c = world({}, { roles: readerOnly }); expect((await rejection(c.svc.requestAgentCommand(c.ctx, { agentId: AID, kind: 'upload_logs' })))?.code).toBe('auth.forbidden');
    expect(a.callsOf('insertCommand').length + b.callsOf('insertCommand').length + c.callsOf('insertCommand').length).toBe(0);
  });
});

describe('E18 / E19 / E20 / E21', () => {
  it('E18 listAgentCommands: agent.read, AgentCommand items with command_id, page; unknown agent 404', async () => {
    const w = world({ commands: [commandRow(), commandRow({ id: idN(0x8002), state: 'completed', kind: 'upload_logs', log_bundle_id: idN(0xb001), completed_at: NOW, result_code: 'ok' })] });
    const r = await w.svc.listAgentCommands(w.ctx, { agentId: AID });
    expect(r.status).toBe(200); expect(r.body.data.map((c: any) => c.command_id)).toEqual([idN(0x8001), idN(0x8002)]); expect(r.body.data[1].log_bundle_id).toBe(idN(0xb001)); expect(r.body.page.limit).toBeGreaterThan(0);
    expect(w.asserted).toEqual([{ permission: 'instruments.agent.read', centreId: CENTRE_A1 }]);
    expect((await rejection(w.svc.listAgentCommands(w.ctx, { agentId: idN(0xdead) })))?.code).toBe('common.not_found');
  });
  it('E19 listAgentHealthTransitions: HealthTransition items (AC-16.3 timeline), default page size 50, from/to filters handed through, unknown agent 404', async () => {
    const w = world({ transitions: [transitionRow(), transitionRow({ id: idN(0x9002), health_version: 3, from_state: 'online', to_state: 'offline' })] });
    const r = await w.svc.listAgentHealthTransitions(w.ctx, { agentId: AID, changedAtFrom: '2026-11-01T00:00:00.000Z' });
    expect(r.body.data).toHaveLength(2); expect(r.body.data[0]).toMatchObject({ health_version: 2, to_state: 'online' }); expect(r.body.page.limit).toBe(50);
    expect(w.callsOf('listTransitions')[0]!.args[1]).toMatchObject({ limit: 50 });
    expect(JSON.stringify(w.callsOf('listTransitions')[0]!.args[1])).toContain('2026-11-01T00:00:00.000Z');
    expect((await rejection(w.svc.listAgentHealthTransitions(w.ctx, { agentId: idN(0xdead) })))?.code).toBe('common.not_found');
  });
  it('E20 getAgentLogBundle: agent.manage at the agent centre; 200 { bundle_id, lines, from_at_agent, to_at_agent, created_at }; other agent\'s bundle or unknown bundle -> 404; reader -> 403', async () => {
    const w = world({ bundles: [bundleRow()] });
    const r = await w.svc.getAgentLogBundle(w.ctx, { agentId: AID, bundleId: idN(0xb001) });
    expect(r.body).toEqual({ bundle_id: idN(0xb001), lines: ['line one', 'line two'], from_at_agent: '2026-11-07T10:00:00.000Z', to_at_agent: '2026-11-07T11:00:00.000Z', created_at: NOW });
    expect(w.asserted).toEqual([{ permission: 'instruments.agent.manage', centreId: CENTRE_A1 }]);
    expect((await rejection(w.svc.getAgentLogBundle(w.ctx, { agentId: AID, bundleId: idN(0xdead) })))?.code).toBe('common.not_found');
    const x = world({ agents: [agentRow({ id: AID }), agentRow({ id: idN(0x1001), agent_code: 'HUB-OTHER' })], bundles: [bundleRow({ agent_id: idN(0x1001) })] });
    expect((await rejection(x.svc.getAgentLogBundle(x.ctx, { agentId: AID, bundleId: idN(0xb001) })))?.code).toBe('common.not_found');
    const ro = world({ bundles: [bundleRow()] }, { roles: readerOnly });
    expect((await rejection(ro.svc.getAgentLogBundle(ro.ctx, { agentId: AID, bundleId: idN(0xb001) })))?.code).toBe('auth.forbidden');
  });
  it('E21 listAgentReleases: agent.read (tenant-wide), optional channel filter, AgentRelease items without signature/hash/key', async () => {
    const w = world();
    const all = await w.svc.listAgentReleases(w.ctx, {});
    expect(all.status).toBe(200); expect(all.body.data.length).toBeGreaterThanOrEqual(2);
    const beta = await w.svc.listAgentReleases(w.ctx, { channel: 'beta' });
    expect(beta.body.data.every((x: any) => x.channel === 'beta')).toBe(true);
    for (const rel of all.body.data) for (const k of ['signature', 'package_sha256', 'key_id', 'authenticode_publisher', 'package_file_name']) expect(rel).not.toHaveProperty(k);
    expect(JSON.stringify(all.body)).not.toContain('SIGNATURE-PLANTED');
    expect(w.asserted[0]).toMatchObject({ permission: 'instruments.agent.read' });
  });
});

describe('S-02 cross-tenant probe: tenant B sees none of tenant A\'s agents through any E12-E20 operation and nothing is written', () => {
  const calls: Array<[string, (w: any) => Promise<unknown>]> = [
    ['getAgent', (w) => w.svc.getAgent(w.ctx, { agentId: AID })],
    ['updateAgent', (w) => w.svc.updateAgent(w.ctx, { agentId: AID, expectedVersion: 1, patch: { display_name: 'x' } })],
    ['issueEnrolmentCode', (w) => w.svc.issueEnrolmentCode(w.ctx, { agentId: AID })],
    ['revokeAgent', (w) => w.svc.revokeAgent(w.ctx, { agentId: AID, expectedVersion: 1, reasonCode: 'other' })],
    ['retireAgent', (w) => w.svc.retireAgent(w.ctx, { agentId: AID, expectedVersion: 1, reasonCode: 'decommissioned' })],
    ['requestAgentCommand', (w) => w.svc.requestAgentCommand(w.ctx, { agentId: AID, kind: 'upload_logs' })],
    ['listAgentCommands', (w) => w.svc.listAgentCommands(w.ctx, { agentId: AID })],
    ['listAgentHealthTransitions', (w) => w.svc.listAgentHealthTransitions(w.ctx, { agentId: AID })],
    ['getAgentLogBundle', (w) => w.svc.getAgentLogBundle(w.ctx, { agentId: AID, bundleId: idN(0xb001) })],
  ];
  it.each(calls)('%s -> 404 common.not_found (not 403: existence is not leaked)', async (_op, call) => {
    const w = world({ commands: [commandRow()], bundles: [bundleRow()], transitions: [transitionRow()] }, { tenantId: TENANT_B });
    expect((await rejection(call(w)))?.code).toBe('common.not_found');
    expect(w.mutations()).toHaveLength(0); expect(w.accessRows()).toHaveLength(0); expect(w.asserted).toHaveLength(0);
    expect(w.agents[0]!.status).toBe('active'); expect(w.credentials().every((c: any) => c.status === 'active')).toBe(true);
  });
  it('every repo call carries the caller\'s tenant (explicit tenant predicate, REQ-SEC-026), never the one from input', async () => {
    const w = world({}, { tenantId: TENANT_B });
    await rejection(w.svc.getAgent(w.ctx, { agentId: AID, tenantId: TENANT_A } as any));
    expect(w.calls.filter((c: any) => c.tenantId !== undefined).every((c: any) => c.tenantId === TENANT_B)).toBe(true);
  });
});
