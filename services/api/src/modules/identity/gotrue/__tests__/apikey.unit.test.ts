// IDGW-APIKEY-1 (LD-199): hosted Supabase Auth needs an `apikey` header. Fake fetch, no network, synthetic keys only.
// Admin calls (/admin/*, /invite): apikey AND authorization = the service key. Every other call: apikey = the OPTIONAL publishable key
// LIMS_IDENTITY_GOTRUE_PUBLISHABLE_KEY when non-empty, never the service key; unset/empty = no apikey header (today's behaviour).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLimsError } from '../../../../core/errors.js';
import { GoTrueError } from '../gateway.js';
import { createHttpGoTrueGateway, gotrueGatewayFromEnv } from '../gateway.http.js';
import { bindIdentityMetrics } from '../../metrics.js';

const SERVICE_KEY = 'synthetic-service';
const PUB_KEY = 'synthetic-publishable';
const ENV_NAME = 'LIMS_IDENTITY_GOTRUE_PUBLISHABLE_KEY';
const URL_ = 'http://gotrue:9999';
const UID = '0190a000-0000-7000-8000-00000000a001';
const SID = '0190a000-0000-7000-8000-00000000b001';
const EXP = Math.floor(Date.now() / 1000) + 3600;
const jwt = (c: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(c)).toString('base64url')}.s`;
const tokenBody = () => ({
  access_token: jwt({ sub: UID, session_id: SID, aal: 'aal1', exp: EXP }), refresh_token: 'rt-1', token_type: 'bearer', expires_in: 3600, expires_at: EXP,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Fetch = typeof fetch;
interface Seen { method: string; path: string; admin: boolean; headers: Headers }

/** Answers every GoTrue path well enough for all gateway methods to complete; records each request. */
function recorder() {
  const seen: Seen[] = [];
  const f = vi.fn<Fetch>(async (input, init) => {
    const u = new URL(String(input));
    const path = u.pathname.replace(/^\/+/, '/');
    const method = init?.method ?? 'GET';
    seen.push({ method, path, admin: /^\/(admin\/|invite$)/.test(path), headers: new Headers(init?.headers) });
    if (path === '/admin/generate_link') return json(200, { hashed_token: 'th' });
    if (/^\/admin\/users\/[^/]+$/.test(path) && method === 'GET') return json(200, { id: UID, email: 'a@b.example', last_sign_in_at: '2026-01-01T00:00:00Z' });
    if (path === '/admin/users' && method === 'GET') return json(200, { users: [] });
    if (path === '/admin/users' && method === 'POST') return json(200, { id: UID });
    if (path === '/factors') return json(200, { id: 'f1', totp: { secret: 'S', uri: 'otpauth://x' } });
    if (/\/factors\/[^/]+\/challenge$/.test(path)) return json(200, { id: 'ch1' });
    if (path === '/user') return json(200, { factors: [] });
    if (path === '/token' || path === '/verify' || /\/factors\/[^/]+\/verify$/.test(path)) return json(200, tokenBody());
    return json(200, {});
  });
  return { f, seen };
}

/** Drives all 14 gateway methods (and the internal calls they make) through the fake fetch. */
async function exerciseAll(g: ReturnType<typeof createHttpGoTrueGateway>) {
  await g.signInWithPassword('a@b.example', 'pw');
  await g.refresh('rt');
  await g.signOut('user-access-token', 'local');
  await g.adminCreateUser({ email: 'a@b.example', emailConfirm: true });
  await g.adminUpdatePassword(UID, 'Abcdef-12345');
  await g.adminSignOutUser(UID);
  await g.adminFindUserByEmail('a@b.example');
  await g.adminDeleteFactor(UID, 'f1');
  await g.sendInvite('a@b.example', '/auth/confirm');
  await g.sendRecovery('a@b.example', '/auth/confirm');
  await g.verifyEmailToken('th', 'recovery');
  await g.mfaEnrollTotp('user-access-token');
  await g.mfaChallengeAndVerify('user-access-token', 'f1', '123456');
  await g.mfaListFactors('user-access-token');
}

const names = (h: Headers) => [...h.keys()].sort();
/** The check used below; the planted-failure test proves it can fail. */
function assertNoApikey(h: Headers) { expect(h.has('apikey')).toBe(false); }

afterEach(() => { bindIdentityMetrics(undefined); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('admin calls send apikey and authorization = service key', () => {
  it.each([undefined, '', PUB_KEY])('publishableKey=%j: every /admin/* and /invite call has apikey = authorization key = service key', async (pub) => {
    const { f, seen } = recorder();
    const g = createHttpGoTrueGateway({ url: URL_, serviceKey: SERVICE_KEY, ...(pub === undefined ? {} : { publishableKey: pub }), fetch: f });
    await exerciseAll(g);
    const admin = seen.filter((s) => s.admin);
    // create, update-password, user get, generate_link, find (list), delete-factor, invite (+ the get/list inside sign-out/find)
    expect(new Set(admin.map((s) => `${s.method} ${s.path.replace(UID, ':id').replace(/factors\/f1/, 'factors/:f')}`))).toEqual(new Set([
      'POST /admin/users', 'PUT /admin/users/:id', 'GET /admin/users/:id', 'POST /admin/generate_link', 'GET /admin/users', 'DELETE /admin/users/:id/factors/:f', 'POST /invite',
    ]));
    for (const s of admin) {
      expect(s.headers.get('apikey'), `${s.method} ${s.path}`).toBe(SERVICE_KEY);
      expect(s.headers.get('authorization'), `${s.method} ${s.path}`).toBe(`Bearer ${SERVICE_KEY}`);
      expect(JSON.stringify([...s.headers])).not.toContain(PUB_KEY);   // the publishable key is never mixed into an admin call
    }
  });
});

describe('non-admin calls: apikey = publishable key when set, never the service key', () => {
  it('with the publishable key set, every non-admin call carries apikey = publishable key and no header holds the service key', async () => {
    const { f, seen } = recorder();
    await exerciseAll(createHttpGoTrueGateway({ url: URL_, serviceKey: SERVICE_KEY, publishableKey: PUB_KEY, fetch: f }));
    const non = seen.filter((s) => !s.admin);
    expect(new Set(non.map((s) => s.path.replace(/factors\/f1/, 'factors/:f')))).toEqual(new Set([
      '/token', '/logout', '/verify', '/recover', '/factors', '/factors/:f/challenge', '/factors/:f/verify', '/user',
    ]));
    for (const s of non) {
      expect(s.headers.get('apikey'), `${s.method} ${s.path}`).toBe(PUB_KEY);
      expect(JSON.stringify([...s.headers])).not.toContain(SERVICE_KEY);
    }
  });
  it('user-token calls keep the user access token as the bearer next to the apikey', async () => {
    const { f, seen } = recorder();
    const g = createHttpGoTrueGateway({ url: URL_, serviceKey: SERVICE_KEY, publishableKey: PUB_KEY, fetch: f });
    await g.mfaListFactors('user-access-token');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer user-access-token');
    expect(seen[0]!.headers.get('apikey')).toBe(PUB_KEY);
  });
  it.each([undefined, ''])('publishableKey=%j: no apikey header on any non-admin call; header names exactly as before', async (pub) => {
    const { f, seen } = recorder();
    await exerciseAll(createHttpGoTrueGateway({ url: URL_, serviceKey: SERVICE_KEY, ...(pub === undefined ? {} : { publishableKey: pub }), fetch: f }));
    const non = seen.filter((s) => !s.admin);
    expect(non.length).toBeGreaterThan(8);
    for (const s of non) {
      assertNoApikey(s.headers);
      expect(JSON.stringify([...s.headers])).not.toContain(SERVICE_KEY);
      // today: accept, content-type (calls with a body), authorization (bearer calls only)
      const bearer = /^\/(logout|factors|user)/.test(s.path);
      const body = s.method !== 'GET' && s.path !== '/logout';
      expect(names(s.headers), `${s.method} ${s.path}`).toEqual(['accept', ...(bearer ? ['authorization'] : []), ...(body ? ['content-type'] : [])].sort());
    }
  });
  it('planted failure: the no-apikey check really fails when an apikey header is present', () => {
    expect(() => assertNoApikey(new Headers({ accept: 'application/json', apikey: SERVICE_KEY }))).toThrow();
    expect(() => assertNoApikey(new Headers({ accept: 'application/json', apikey: PUB_KEY }))).toThrow();
  });
  it('admin headers with the publishable key unset are today\'s plus apikey only', async () => {
    const { f, seen } = recorder();
    const g = createHttpGoTrueGateway({ url: URL_, serviceKey: SERVICE_KEY, fetch: f });
    await g.adminUpdatePassword(UID, 'Abcdef-12345');
    await g.adminFindUserByEmail('a@b.example');
    expect(names(seen[0]!.headers)).toEqual(['accept', 'apikey', 'authorization', 'content-type']);
    expect(names(seen[1]!.headers)).toEqual(['accept', 'apikey', 'authorization']);
  });
});

describe('neither key leaks into errors, thrown values or metric labels', () => {
  const KEYS = [SERVICE_KEY, PUB_KEY];
  const flat = (e: unknown) => String((e as Error)?.message) + String((e as Error)?.stack) + JSON.stringify(e, Object.getOwnPropertyNames(Object(e)));
  const gw = (fetchImpl: Fetch) => createHttpGoTrueGateway({ url: URL_, serviceKey: SERVICE_KEY, publishableKey: PUB_KEY, fetch: fetchImpl });

  it('GoTrueError (admin 401 and user 4xx) whose response body echoes both keys', async () => {
    const echo: Fetch = async () => json(401, { error_code: 'no_authorization', msg: `bad key ${SERVICE_KEY} / ${PUB_KEY}`, hint: SERVICE_KEY });
    const g = gw(echo);
    const e1 = await g.adminUpdatePassword(UID, 'Abcdef-12345').catch((x: unknown) => x);
    const e2 = await g.mfaListFactors('user-access-token').catch((x: unknown) => x);
    for (const e of [e1, e2]) { expect(e).toBeInstanceOf(GoTrueError); for (const k of KEYS) expect(flat(e)).not.toContain(k); }
  });
  it('LimsError on 5xx and on a network error whose cause names both keys (admin and non-admin)', async () => {
    for (const impl of [async () => json(503, { msg: `${SERVICE_KEY} ${PUB_KEY}` }), async () => { throw new TypeError(`fetch failed ${SERVICE_KEY} ${PUB_KEY}`); }] as Fetch[]) {
      const g = gw(impl);
      const e1 = await g.adminSignOutUser(UID).catch((x: unknown) => x);
      const e2 = await g.signInWithPassword('a@b.example', 'pw').catch((x: unknown) => x);
      for (const e of [e1, e2]) { expect(isLimsError(e, 'common.dependency_unavailable')).toBe(true); for (const k of KEYS) expect(flat(e)).not.toContain(k); }
    }
  });
  it('metric names, labels and values recorded by the gateway never contain a key', async () => {
    const rec: unknown[] = [];
    bindIdentityMetrics({ inc: (...a) => rec.push(['inc', ...a]), set: (...a) => rec.push(['set', ...a]), observe: (...a) => rec.push(['observe', ...a]) });
    const ok = recorder();
    await exerciseAll(gw(ok.f));
    const bad = gw(async () => json(401, { error_code: 'x', msg: `${SERVICE_KEY} ${PUB_KEY}` }));
    await bad.adminUpdatePassword(UID, 'Abcdef-12345').catch(() => undefined);
    await bad.mfaListFactors('t').catch(() => undefined);
    expect(rec.length).toBeGreaterThan(10);
    for (const k of KEYS) expect(JSON.stringify(rec)).not.toContain(k);
  });
});

describe('env reader scope (LD-199)', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const ROOT = join(HERE, '..', '..', '..', '..', '..', '..', '..');
  const SRC = join(ROOT, 'services', 'api', 'src');
  const GATEWAY = join(SRC, 'modules', 'identity', 'gotrue', 'gateway.http.ts');
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : [p];
  });
  const isTest = (p: string) => /__tests__|\.(test|spec)\.[cm]?[jt]sx?$/.test(p);

  it('gotrueGatewayFromEnv reads LIMS_IDENTITY_GOTRUE_PUBLISHABLE_KEY and passes it on; blank env = no apikey on non-admin calls', async () => {
    const { f, seen } = recorder();
    vi.stubGlobal('fetch', f);
    vi.stubEnv('LIMS_IDENTITY_GOTRUE_URL', URL_);
    vi.stubEnv('LIMS_IDENTITY_GOTRUE_SERVICE_KEY', SERVICE_KEY);
    vi.stubEnv(ENV_NAME, PUB_KEY);
    const g = gotrueGatewayFromEnv();
    await g.sendRecovery('a@b.example', '/x'); await g.adminUpdatePassword(UID, 'Abcdef-12345');
    expect(seen[0]!.headers.get('apikey')).toBe(PUB_KEY);
    expect(seen[1]!.headers.get('apikey')).toBe(SERVICE_KEY);
    vi.stubEnv(ENV_NAME, '');
    seen.length = 0;
    await gotrueGatewayFromEnv().sendRecovery('a@b.example', '/x');
    assertNoApikey(seen[0]!.headers);
    vi.stubEnv(ENV_NAME, undefined as unknown as string);   // unset
    seen.length = 0;
    await gotrueGatewayFromEnv().sendRecovery('a@b.example', '/x');
    assertNoApikey(seen[0]!.headers);
  });
  it('the variable name appears in no production source under services/api/src except inside gotrueGatewayFromEnv', () => {
    const hits = walk(SRC).filter((p) => /\.[cm]?[jt]sx?$/.test(p) && !isTest(p) && readFileSync(p, 'utf8').includes(ENV_NAME)).map((p) => relative(SRC, p).replace(/\\/g, '/'));
    expect(hits).toEqual(['modules/identity/gotrue/gateway.http.ts']);
    const src = readFileSync(GATEWAY, 'utf8');
    const start = src.indexOf('export function gotrueGatewayFromEnv');
    const end = src.indexOf('export function createHttpGoTrueGateway');
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
    const occ = [...src.matchAll(new RegExp(ENV_NAME, 'g'))].map((m) => m.index!);
    expect(occ.length).toBeGreaterThan(0);
    for (const i of occ) { expect(i).toBeGreaterThan(start); expect(i).toBeLessThan(end); }
    // the option, not process.env, is what the factory consumes
    expect(src.slice(end)).not.toContain('process.env');
  });
  it('no other workspace source (worker, web, packages) reads the new variable', () => {
    for (const d of ['services/worker/src', 'apps/web/src', 'packages']) {
      const dir = join(ROOT, d);
      if (!existsSync(dir)) continue;
      const hits = walk(dir).filter((p) => /\.[cm]?[jt]sx?$/.test(p) && !isTest(p) && readFileSync(p, 'utf8').includes(ENV_NAME));
      expect(hits.map((p) => relative(ROOT, p))).toEqual([]);
    }
  });
});

describe('variable name is declared without a value; docs + CR exist', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', '..');
  it('.env.example has the name with an empty value', () => {
    expect(readFileSync(join(ROOT, '.env.example'), 'utf8')).toMatch(new RegExp(`^${ENV_NAME}=[ \\t]*\\r?$`, 'm'));
  });
  it('render.yaml declares it with sync: false and no value', () => {
    const y = readFileSync(join(ROOT, 'render.yaml'), 'utf8');
    expect(y).toMatch(new RegExp(`- key: ${ENV_NAME}\\r?\\n\\s+sync: false`));
    expect(y).not.toMatch(new RegExp(`${ENV_NAME}\\r?\\n\\s+value:`));
  });
  it('mapping.md has a Hosted Supabase note naming apikey and the variable', () => {
    const m = readFileSync(join(ROOT, 'services/api/src/modules/identity/gotrue/mapping.md'), 'utf8');
    expect(m).toMatch(/Hosted Supabase/);
    expect(m).toContain('apikey');
    expect(m).toContain(ENV_NAME);
  });
  it('a non-blocking CR to C2 records the apikey header and the optional variable', () => {
    const dir = join(ROOT, '.orchestra', 'cr');
    const files = existsSync(dir) ? readdirSync(dir).filter((n) => /\.md$/.test(n)).map((n) => readFileSync(join(dir, n), 'utf8')) : [];
    const cr = files.find((t) => t.includes(ENV_NAME) && /apikey/.test(t) && /C2/.test(t));
    expect(cr, 'no .orchestra/cr/*.md mentions C2, apikey and the variable').toBeTruthy();
    expect(cr!).toMatch(/non-?blocking/i);
  });
});
