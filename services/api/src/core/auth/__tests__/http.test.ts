// T0D-02 — auth through the real bootstrap (security handlers wired). AC-0D-2.1, 2.2, 2.2a, 2.5, AB-26, REQ-SEC-066/067.
// Needs from impl: loadConfig reads LIMS_CORE_JWT_ALG/_ISSUER/_AUDIENCE/_KEY_FILE, LIMS_WEB_BFF_KEY_FILE / LIMS_PARTNER_BFF_KEY_FILE /
// LIMS_PORTAL_BFF_KEY_FILE (one key per line; two lines = rotation overlap) and LIMS_CORE_TRUSTED_PROXY_CIDRS (comma list);
// HandlerContext gains `clientIp`; `bearerJwt` operations run jwt -> claimsResolver; error bodies carry `code` (problem+json).
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../../bootstrap.js';
import { loadConfig } from '../../config.js';
import { AUD, ISS, SESSION_ID, SUB, TENANT_B, goodPayload, makeKeys, makeToken, noneToken, tmpFile, wrongKeyFor } from './helpers.js';

const APP = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'app');
const REJECTED_SESSION = '0190a000-0000-7000-8000-0000000000e2';
const WEB = 'http-web-key-0123456789abcdef0123456789abcdef01234567';
const PARTNER = 'http-partner-key-0123456789abcdef0123456789abcdef01234';
const PORTAL_OLD = 'http-portal-OLD-key-0123456789abcdef0123456789abcdef';
const PORTAL_NEW = 'http-portal-NEW-key-9876543210fedcba9876543210fedcba';
const NGINX_PEER = '172.20.0.2';
const OUTSIDE_PEER = '203.0.113.9';
const VICTIM = '198.51.100.7';

const ks = makeKeys('ES256');
const nowS = () => Math.floor(Date.now() / 1000);
const calls = (): Array<{ jwt: any; request: any }> => ((globalThis as any).__authCalls ??= []);
const bearer = (over: Record<string, unknown> = {}, o = {}) => `Bearer ${makeToken(ks, over, o, nowS())}`;

let app: FastifyInstance;
const apps: FastifyInstance[] = [];
async function boot(extra: Record<string, string> = {}): Promise<FastifyInstance> {
  const config = loadConfig({
    LIMS_CORE_ENV: 'ci',
    LIMS_CORE_JWT_ALG: 'ES256', LIMS_CORE_JWT_ISSUER: ISS, LIMS_CORE_JWT_AUDIENCE: AUD, LIMS_CORE_JWT_KEY_FILE: ks.verifyKeyFile,
    LIMS_WEB_BFF_KEY_FILE: tmpFile(WEB), LIMS_PARTNER_BFF_KEY_FILE: tmpFile(PARTNER), LIMS_PORTAL_BFF_KEY_FILE: tmpFile(`${PORTAL_OLD}\n${PORTAL_NEW}\n`),
    LIMS_CORE_TRUSTED_PROXY_CIDRS: '172.20.0.0/16',
    ...extra,
  });
  const a = await bootstrap({ config, repoRoot: APP, modulesDir: join(APP, 'modules') });
  apps.push(a);
  return a;
}
afterAll(async () => { await Promise.all(apps.map((a) => a.close())); });
beforeEach(() => { calls().length = 0; });

const get = (url: string, headers: Record<string, string> = {}, remoteAddress = OUTSIDE_PEER) =>
  app.inject({ method: 'GET', url, headers, remoteAddress });
const codeOf = (r: { body: string }): string | undefined => { try { return JSON.parse(r.body).code; } catch { return undefined; } };

describe('AC-0D-2.1 every broken token on a non-public operation is 401 with an auth.* code', () => {
  beforeEach(async () => { app ||= await boot(); });
  const ok = () => get('/v1/identity/whoami', { authorization: bearer() });

  it('valid token -> 200, resolver called once', async () => {
    const r = await ok();
    expect(r.statusCode).toBe(200);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.jwt.sessionId).toBe(SESSION_ID);
  });

  const bad: ReadonlyArray<[string, () => string, string]> = [
    ['alg none', () => `Bearer ${noneToken('none', goodPayload({}, nowS()))}`, 'auth.token_invalid'],
    ['alg None', () => `Bearer ${noneToken('None', goodPayload({}, nowS()))}`, 'auth.token_invalid'],
    ['HS256 token while ES256 is pinned', () => bearer({}, { header: { alg: 'HS256' }, signAlg: 'HS256', key: Buffer.from('k'.repeat(40)) }), 'auth.token_invalid'],
    ['signed with a different ES256 key', () => bearer({}, { key: wrongKeyFor('ES256') }), 'auth.token_invalid'],
    ['expired by 1 s', () => bearer({ exp: nowS() - 1 }), 'auth.token_expired'],
    ['expired long ago', () => bearer({ exp: 1 }), 'auth.token_expired'],
    ['wrong aud', () => bearer({ aud: 'service_role' }), 'auth.token_invalid'],
    ['wrong iss', () => bearer({ iss: 'https://evil.example' }), 'auth.token_invalid'],
    ['no session_id (AC-0D-2.2a)', () => bearer({}, { omit: ['session_id'] }), 'auth.token_invalid'],
    ['garbage', () => 'Bearer not.a.jwt', 'auth.token_invalid'],
  ];
  it.each(bad)('%s -> 401', async (_n, header, code) => {
    const r = await get('/v1/identity/whoami', { authorization: header() });
    expect(r.statusCode).toBe(401);
    expect(codeOf(r)).toBe(code);
    expect(calls()).toHaveLength(0); // a bad token never reaches the claimsResolver
  });

  it.each(['', 'Bearer', 'Bearer ', 'Basic dXNlcjpwdw==', 'bearer x y'])('Authorization %j -> 401 with an auth.* code', async (h) => {
    const r = await get('/v1/identity/whoami', h === '' ? {} : { authorization: h });
    expect(r.statusCode).toBe(401);
    expect(codeOf(r)).toMatch(/^auth\./);
  });

  it('resolver rejection (auth.session_expired) is relayed as 401', async () => {
    const r = await get('/v1/identity/whoami', { authorization: bearer({ session_id: REJECTED_SESSION }) });
    expect(r.statusCode).toBe(401);
    expect(codeOf(r)).toBe('auth.session_expired');
  });

  it('the 401 body does not echo the token or say which check failed beyond the auth.* code', async () => {
    const t = makeToken(ks, { iss: 'https://evil.example' }, {}, nowS());
    const r = await get('/v1/identity/whoami', { authorization: `Bearer ${t}` });
    expect(r.statusCode).toBe(401);
    expect(r.body).not.toContain(t);
    expect(r.body).not.toContain('evil.example');
  });
});

describe('AC-0D-2.2 / 2.2a tenant only from the identity claimsResolver', () => {
  beforeEach(async () => { app ||= await boot(); });

  it('JWT carrying its own tenant_id/membership_id/actor_type: the resolver never sees them', async () => {
    const r = await get('/v1/identity/whoami', { authorization: bearer({ tenant_id: TENANT_B, membership_id: 'x', actor_type: 'system' }) });
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(calls()[0]!.jwt)).not.toContain(TENANT_B);
    expect(Object.keys(calls()[0]!.jwt).sort()).toEqual(['aal', 'exp', 'iat', 'sessionId', 'sub']);
  });
  it('tenant_id in a request header is not read: resolver input unchanged', async () => {
    const r = await get('/v1/identity/whoami', { authorization: bearer(), 'x-tenant-id': TENANT_B, tenant_id: TENANT_B });
    expect(r.statusCode).toBe(200);
    expect(JSON.stringify(calls()[0])).not.toContain(TENANT_B);
  });
  it('tenant_id in the body -> 400 (unknown field rejected by spec validation)', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/identity/echo', remoteAddress: OUTSIDE_PEER,
      headers: { authorization: bearer(), 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'a', tenant_id: TENANT_B }) });
    expect(r.statusCode).toBe(400);
  });
  it('tenant_id in the query -> 400', async () => {
    const r = await get(`/v1/identity/whoami?tenant_id=${TENANT_B}`, { authorization: bearer() });
    expect(r.statusCode).toBe(400);
  });
});

describe('AC-0D-2.5 ctx.clientIp (P-61) and X-Lims-Bff-Key kinds (D-32, P-45)', () => {
  beforeEach(async () => { app ||= await boot(); });
  const ip = async (headers: Record<string, string>, peer = OUTSIDE_PEER) => (await get('/v1/identity/ping', headers, peer)).json().clientIp as string;

  it('AB-26: no BFF key, untrusted peer, spoofed XFF -> the TCP peer', async () => {
    expect(await ip({ 'x-forwarded-for': VICTIM })).toBe(OUTSIDE_PEER);
  });
  it('no XFF -> the TCP peer', async () => {
    expect(await ip({})).toBe(OUTSIDE_PEER);
  });
  it.each([['staff_web', WEB], ['partner', PARTNER], ['portal', PORTAL_NEW]])('valid %s key -> XFF honoured', async (_k, key) => {
    expect(await ip({ 'x-lims-bff-key': key, 'x-forwarded-for': VICTIM })).toBe(VICTIM);
  });
  it('rotation overlap: both the old and the new portal key are valid', async () => {
    expect(await ip({ 'x-lims-bff-key': PORTAL_OLD, 'x-forwarded-for': VICTIM })).toBe(VICTIM);
    expect(await ip({ 'x-lims-bff-key': PORTAL_NEW, 'x-forwarded-for': VICTIM })).toBe(VICTIM);
  });
  it('invalid / empty / near-miss BFF key -> XFF ignored', async () => {
    for (const k of ['wrong', '', WEB.slice(0, -1), WEB + 'x', WEB.toUpperCase()]) {
      expect(await ip({ 'x-lims-bff-key': k, 'x-forwarded-for': VICTIM })).toBe(OUTSIDE_PEER);
    }
  });
  it('peer inside LIMS_CORE_TRUSTED_PROXY_CIDRS (nginx on edge_net) without a key -> XFF honoured', async () => {
    expect(await ip({ 'x-forwarded-for': VICTIM }, NGINX_PEER)).toBe(VICTIM);
  });
  it('malformed XFF from a trusted peer -> the peer, no error', async () => {
    expect(await ip({ 'x-forwarded-for': 'not-an-ip; DROP' }, NGINX_PEER)).toBe(NGINX_PEER);
  });

  it('08 R10: the BFF key (not a client header) binds the session kind: the resolver receives bffKey', async () => {
    await get('/v1/identity/whoami', { authorization: bearer(), 'x-lims-bff-key': PARTNER });
    expect(calls()[0]!.request.bffKey).toBe('partner');
    expect(calls()[0]!.request.clientIp).toBeTruthy();
  });
  it('08 R10: no key / invalid key -> bffKey undefined; client-supplied X-Lims-Origin is not trusted', async () => {
    await get('/v1/identity/whoami', { authorization: bearer(), 'x-lims-origin': 'portal' });
    await get('/v1/identity/whoami', { authorization: bearer(), 'x-lims-bff-key': 'nope', 'x-lims-origin': 'staff_web' });
    expect(calls()).toHaveLength(2);
    for (const c of calls()) expect(c.request.bffKey).toBeUndefined();
  });
  it('an invalid BFF key does not by itself fail a bearerJwt request (it is only a binding / client-ip signal)', async () => {
    const r = await get('/v1/identity/whoami', { authorization: bearer(), 'x-lims-bff-key': 'nope' });
    expect(r.statusCode).toBe(200);
  });
});

describe('boot fails fast on bad auth config', () => {
  async function bootFails(extra: Record<string, string>): Promise<void> {
    let failed = false;
    try {
      await boot(extra);
    } catch {
      failed = true;
    }
    expect(failed, 'bootstrap must reject').toBe(true);
  }
  it('missing JWT key file -> bootstrap rejects', () => bootFails({ LIMS_CORE_JWT_KEY_FILE: '/nonexistent/lims/jwt.pub' }));
  it('invalid LIMS_CORE_TRUSTED_PROXY_CIDRS -> bootstrap rejects', () => bootFails({ LIMS_CORE_TRUSTED_PROXY_CIDRS: '172.20.0.0/99' }));
  it('unpinned / unsupported LIMS_CORE_JWT_ALG -> bootstrap rejects', () => bootFails({ LIMS_CORE_JWT_ALG: 'none' }));
});
