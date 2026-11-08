// C7 API-T06 — E01 enrolAgent (02-TRD §7.1/§7.2; 03-APP-FLOW A2/A3/A5; 01-PRD AC-01.4-01.7, AC-02.2, AC-02.3; 07-SECURITY S-01, S-05, E01 row).
// Fails now because ../service/enrolment.service.js does not exist. SEAMS: device.helpers.ts header.
import { describe, expect, it } from 'vitest';
import { responseViolations } from './agents.contract.js';
import { AGENT_B, AGENT_X, AGENT_Y, CENTRE_A1, CODE_ID, FINGERPRINT, NOW, OLD_TOKEN_ID, TENANT_A, TENANT_B, Y_TOKEN_ID, activeAgent, agentRow, credRow, enrolCtx, enrolInput, idN, makeDeviceCtx, makeRepo, rejection, sha } from './device.helpers.js';

const { createEnrolmentService } = await import('../service/enrolment.service.js');
const mk = (seed?: Parameters<typeof makeRepo>[0]) => { const f = makeRepo(seed); return { f, svc: createEnrolmentService({ repo: f.repo as any, now: () => new Date(NOW) }) }; };
const TOKEN = /^lmsd_[A-Za-z0-9_-]{43}$/;
const code = (o: Record<string, unknown> = {}) => credRow({ id: CODE_ID, kind: 'enrolment_code', agent_id: AGENT_X, expires_at: '2026-11-08T08:00:00.000Z', ...o });
const pending = (o: Record<string, unknown> = {}) => agentRow({ id: AGENT_X, status: 'pending_enrolment', health: null, enrolled_at: null, credentials: [code()], ...o });

describe('A2 pending_enrolment -> active (AC-01.4)', () => {
  it('201 {agent_id, centre_id, device_token, server_time, config_version}: schema-valid, token lmsd_ + 43 base64url', async () => {
    const { f, svc } = mk({ agents: [pending()] });
    const r = await svc.enrolAgent(enrolCtx().ctx, enrolInput());
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['agent_id', 'centre_id', 'config_version', 'device_token', 'server_time']);
    expect(r.body).toMatchObject({ agent_id: AGENT_X, centre_id: CENTRE_A1, server_time: NOW, config_version: 1 });
    expect(r.body.device_token).toMatch(TOKEN);
    expect(responseViolations('enrolAgent', '201', r.body)).toEqual([]);
    expect(f.agent(AGENT_X).latest_config_version).toBe(1);        // E01 never creates a config version (TRD §5.10)
  });
  it('code -> used (used_at), new device_token credential stored as sha256 only, agent active with enrolled_at, host fingerprint and versions', async () => {
    const { f, svc } = mk({ agents: [pending()] });
    const r = await svc.enrolAgent(enrolCtx().ctx, enrolInput());
    expect(f.cred(CODE_ID)).toMatchObject({ status: 'used', used_at: NOW });
    const tok = f.allCreds().find((c) => c.kind === 'device_token')!;
    expect(tok).toMatchObject({ status: 'active', agent_id: AGENT_X, centre_id: CENTRE_A1, issued_by: AGENT_X });
    expect(Buffer.from(tok.secret_sha256).equals(sha(r.body.device_token))).toBe(true);
    expect(f.agent(AGENT_X)).toMatchObject({ status: 'active', enrolled_at: NOW, host_fingerprint_sha256: FINGERPRINT });
    expect(f.agent(AGENT_X).health).toMatchObject({ agent_version: '1.2.3', launcher_version: '1.0.0', os_version: 'Windows 11 24H2' });
  });
  it('the token appears exactly once — in the response; never in a repo argument, access row or tx statement (S-06)', async () => {
    const { f, svc } = mk({ agents: [pending()] });
    const c = enrolCtx();
    const r = await svc.enrolAgent(c.ctx, enrolInput());
    const seen = JSON.stringify(f.calls) + JSON.stringify(c.inserts) + JSON.stringify(c.accessRows());
    expect(seen).not.toContain(r.body.device_token);
    expect(JSON.stringify(f.calls)).not.toContain(Buffer.from(r.body.device_token).toString('base64'));
  });
  it('two enrolments get two different tokens (256-bit random, AC-01.7)', async () => {
    const a = mk({ agents: [pending()] }), b = mk({ agents: [pending()] });
    const t1 = (await a.svc.enrolAgent(enrolCtx().ctx, enrolInput())).body.device_token, t2 = (await b.svc.enrolAgent(enrolCtx().ctx, enrolInput())).body.device_token;
    expect(t1).not.toBe(t2);
  });
});

describe('A3 active -> active: moving to a new PC (AC-02.2)', () => {
  const seed = () => ({ agents: [activeAgent({ credentials: [credRow({ id: OLD_TOKEN_ID, kind: 'device_token', agent_id: AGENT_X }), code()] })] });
  it('previous active token revoked in the same call with replaced_by_credential_id = the new token; same agent row, enrolled_at kept', async () => {
    const { f, svc } = mk(seed());
    const before = f.agent(AGENT_X).enrolled_at;
    const r = await svc.enrolAgent(enrolCtx().ctx, enrolInput());
    const fresh = f.allCreds().find((c) => c.kind === 'device_token' && c.id !== OLD_TOKEN_ID)!;
    expect(f.cred(OLD_TOKEN_ID)).toMatchObject({ status: 'revoked', replaced_by_credential_id: fresh.id, revoke_reason_code: 'device_replaced' });
    expect(fresh.status).toBe('active');
    expect(f.agents).toHaveLength(1); expect(r.body.agent_id).toBe(AGENT_X);
    expect(f.agent(AGENT_X)).toMatchObject({ status: 'active', enrolled_at: before });
  });
  it('writes exactly one access_log row device_credential.issue / agent_credential / new credential id (TRD §7.5)', async () => {
    const { f, svc } = mk(seed()); const c = enrolCtx();
    await svc.enrolAgent(c.ctx, enrolInput());
    const fresh = f.allCreds().find((x) => x.kind === 'device_token' && x.id !== OLD_TOKEN_ID)!;
    expect(c.accessRows()).toHaveLength(1);
    expect(c.accessRows()[0]).toMatchObject({ action: 'device_credential.issue', entityType: 'agent_credential', entityId: fresh.id, tenantId: TENANT_A, centreId: CENTRE_A1 });
  });
  it('AC-01.7: another agent of the same centre keeps its token', async () => {
    const y = agentRow({ id: AGENT_Y, agent_code: 'HUB-PC-02', status: 'active', credentials: [credRow({ id: Y_TOKEN_ID, kind: 'device_token', agent_id: AGENT_Y })] });
    const { f, svc } = mk({ agents: [...seed().agents, y] });
    await svc.enrolAgent(enrolCtx().ctx, enrolInput());
    expect(f.cred(Y_TOKEN_ID).status).toBe('active'); expect(f.agent(AGENT_Y).status).toBe('active');
  });
});

describe('A5 revoked -> active (AC-02.3)', () => {
  it('a code issued after revocation re-activates the same agent', async () => {
    const { f, svc } = mk({ agents: [agentRow({ id: AGENT_X, status: 'revoked', revoked_at: NOW, revoke_reason_code: 'device_lost_or_stolen', credentials: [credRow({ id: OLD_TOKEN_ID, kind: 'device_token', status: 'revoked', agent_id: AGENT_X }), code()] })] });
    const r = await svc.enrolAgent(enrolCtx().ctx, enrolInput());
    expect(r.status).toBe(201); expect(f.agent(AGENT_X).status).toBe('active'); expect(r.body.agent_id).toBe(AGENT_X);
    expect(f.cred(CODE_ID).status).toBe('used');
  });
});

describe('uniform 401 for every unusable code (AC-01.5, S-05, E01 threat row)', () => {
  const cases: Array<[string, Parameters<typeof makeRepo>[0], Parameters<typeof enrolCtx>[0]?]> = [
    ['used', { agents: [pending({ credentials: [code({ status: 'used', used_at: NOW })] })] }],
    ['expired by time', { agents: [pending({ credentials: [code({ expires_at: NOW })] })] }],
    ['status expired', { agents: [pending({ credentials: [code({ status: 'expired' })] })] }],
    ['revoked', { agents: [pending({ credentials: [code({ status: 'revoked' })] })] }],
    ['unknown credential id', { agents: [pending({ credentials: [] })] }],
    ['credential is a device_token row', { agents: [pending({ credentials: [code({ kind: 'device_token' })] })] }],
    ['credential belongs to another agent', { agents: [pending({ credentials: [code({ agent_id: AGENT_Y })] })] }],
    ['agent retired', { agents: [pending({ status: 'retired' })] }],
    ['agent unknown', { agents: [] }],
    ['agent of another tenant (S-01)', { agents: [pending({ tenant_id: TENANT_B })] }],
  ];
  it.each(cases)('%s -> 401 auth.device_token_invalid, no state change', async (_n, seed, ctxOpts) => {
    const { f, svc } = mk(seed);
    const e = await rejection(svc.enrolAgent(enrolCtx(ctxOpts).ctx, enrolInput()));
    expect(e.code).toBe('auth.device_token_invalid'); expect(e.statusCode).toBe(401);
    expect(f.callsOf('insertCredential')).toHaveLength(0); expect(f.callsOf('completeEnrolment')).toHaveLength(0); expect(f.callsOf('revokeCredential')).toHaveLength(0);
    expect(JSON.stringify([e.code, e.message, e.detail, e.details])).not.toMatch(/used|expired|retired|tenant|unknown/i);   // identical for all cases, says nothing about why
  });
  it('error is byte-identical across the cases (no oracle)', async () => {
    const seen = new Set<string>();
    for (const [, seed] of cases) { const e = await rejection(mk(seed).svc.enrolAgent(enrolCtx().ctx, enrolInput())); seen.add(JSON.stringify([e.code, e.message, e.statusCode, e.detail ?? null])); }
    expect(seen.size).toBe(1);
  });
  it.each([['device_token', 'a device token'], [null, 'no claims at all'], ['something_else', 'an unknown kind']])('credential kind %s (%s) -> 401 before any repo access (AC-01.6)', async (kind) => {
    const { f, svc } = mk({ agents: [pending()] });
    const e = await rejection(svc.enrolAgent(makeDeviceCtx({ kind: kind as any, credentialId: CODE_ID, agentId: AGENT_X }).ctx, enrolInput()));
    expect(e.code).toBe('auth.device_token_invalid'); expect(f.calls).toHaveLength(0);
  });
});

describe('input validation (400 before the code is consumed)', () => {
  it.each([
    ['upper-case fingerprint', { hostFingerprintSha256: 'C'.repeat(64) }, '/host_fingerprint_sha256'],
    ['63-char fingerprint', { hostFingerprintSha256: 'c'.repeat(63) }, '/host_fingerprint_sha256'],
    ['fingerprint with trailing newline', { hostFingerprintSha256: `${'c'.repeat(64)}\n` }, '/host_fingerprint_sha256'],
    ['non-string fingerprint', { hostFingerprintSha256: 12 }, '/host_fingerprint_sha256'],
    ['empty agent_version', { agentVersion: '' }, '/agent_version'],
    ['33-char agent_version', { agentVersion: 'v'.repeat(33) }, '/agent_version'],
    ['empty launcher_version', { launcherVersion: '' }, '/launcher_version'],
    ['65-char os_version', { osVersion: 'o'.repeat(65) }, '/os_version'],
    ['missing os_version', { osVersion: undefined }, '/os_version'],
  ])('%s -> common.validation_failed at %s', async (_n, bad, path) => {
    const { f, svc } = mk({ agents: [pending()] });
    const e = await rejection(svc.enrolAgent(enrolCtx().ctx, enrolInput(bad)));
    expect(e.code).toBe('common.validation_failed');
    expect(JSON.stringify(e.details ?? e.errors ?? e.fields ?? e)).toContain(path);
    expect(f.cred(CODE_ID).status).toBe('active'); expect(f.mutations()).toHaveLength(0);
  });
  it('fails closed without a request context', async () => {
    const { svc } = mk({ agents: [pending()] });
    expect((await rejection(svc.enrolAgent({ ...enrolCtx().ctx, tx: undefined }, enrolInput()))).code).toBe('auth.unauthenticated');
    expect((await rejection(svc.enrolAgent({ ...enrolCtx().ctx, actor: undefined }, enrolInput()))).code).toBe('auth.unauthenticated');
  });
});

describe('single use, atomicity, tenancy', () => {
  it('two concurrent redemptions of one code: exactly one 201, one 401, one device token exists (AC-01.4 single use)', async () => {
    const { f, svc } = mk({ agents: [pending()] });
    const res = await Promise.allSettled([svc.enrolAgent(enrolCtx().ctx, enrolInput()), svc.enrolAgent(enrolCtx().ctx, enrolInput())]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('auth.device_token_invalid');
    expect(f.allCreds().filter((c) => c.kind === 'device_token')).toHaveLength(1);
  });
  it('a failing insert is not swallowed and no token is returned (the core rolls the tx back)', async () => {
    const { f, svc } = mk({ agents: [pending()] });
    f.repo.insertCredential = async () => { throw new Error('db down'); };
    const e = await rejection(svc.enrolAgent(enrolCtx().ctx, enrolInput()));
    expect(e.message).toBe('db down');
  });
  it('every repo call carries the caller tenant and only the caller agent id (no id from input)', async () => {
    const { f, svc } = mk({ agents: [pending(), pending({ id: AGENT_B, tenant_id: TENANT_B, credentials: [code({ id: idN(0x6b01), agent_id: AGENT_B })] })] });
    await svc.enrolAgent(enrolCtx().ctx, enrolInput());
    for (const c of f.calls) expect(c.tenantId, c.op).toBe(TENANT_A);
    expect(f.agent(AGENT_B).status).toBe('pending_enrolment');
  });
});
