// PLATFORM-WIRE-1 (LD-267, LD-241; CR-C2-004, CR-C2-T21; C2 02-TRD 5.10 + 7.2 step 3). The REAL identity platform handlers + services + repos
// behind the REAL pipeline of bootPipeline (fake `pg`, real identity manifest = the wiring of staging), run with platform session claims
// shaped like identity/claims/resolver.ts:107. The unit tests of the services pass because they use fake contexts; this file is the
// one that proves each platform operation guard is reached under a real-pipeline context.
// FACT (Render logs 2026-11-16 09:56 NPT): listTenants / listPlatformIrdAnnexes / listPlatformSupportSessions 401 auth.unauthenticated,
// listDeadLetters 500 common.internal. "Reaches its service" = the service's repo SQL ran (evidence independent of the HTTP status).
// Section "end to end status" pins what the console needs: a 2xx. NOTE for the lead (see notes): stage 9 (core/ports/authz-guard.ts) throws
// common.internal in every env but production for a 2xx of a non-public operation whose handler never called IdentityPort.assertRole, and
// no platform service calls it. That is the likely cause of the listDeadLetters 500 (the service ran). If the writer cannot reach 2xx inside
// the LD-267 scope, the right outcome is a CR and BLOCKED, not a weaker test.
// Errors are compared by `.code` (vi.resetModules() gives every test a fresh LimsError class). Synthetic ids only.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ACTOR = '0190a000-0000-7000-8000-00000000a5a5';
const SUB = '0190a000-0000-7000-8000-00000000a001';
const STAFF = '0190a000-0000-7000-8000-00000000c001';
const PSID = '0190a000-0000-7000-8000-00000000c0d1';
const EVIL = '0190a000-0000-7000-8000-00000000e711';
const T1 = '0190a000-0000-7000-8000-00000000b001';
const DL = '0190a000-0000-7000-8000-00000000d1d1';
const REQ_ID = '0190a000-0000-7000-8000-0000000000f1';

const h = vi.hoisted(() => ({
  stmts: [] as Array<{ text: string; values: unknown[] }>,
  script: [] as Array<{ match: RegExp; rows: any[] }>,
  logs: [] as Array<{ event?: string; operationId?: string }>,
}));

vi.mock('pg', () => {
  const handle = (text: string, values: unknown[] = []) => {
    h.stmts.push({ text: String(text), values });
    const t = String(text).trim();
    if (/g_system_actors/i.test(t)) return { rows: [{ module: 'identity', actor_id: '0190a000-0000-7000-8000-00000000a5a5' }] };
    if (/set_config\(\s*'request\.jwt\.claims'/i.test(t) && /tx_started_at/i.test(t)) return { rows: [{ tx_started_at: new Date() }] };
    if (/ratelimit_hit/i.test(t)) return { rows: [{ allowed: true, retry_after_seconds: 0 }] };
    const hit = h.script.find((s) => s.match.test(t));
    return { rows: hit ? hit.rows : [] };
  };
  class Pool {
    on() { return this; }
    async end() {}
    async query(text: string, values?: unknown[]) { return handle(text, values); }
    async connect() { return { async query(text: string, values?: unknown[]) { return handle(text, values); }, release() {} }; }
  }
  return { default: { Pool }, Pool };
});

let scratch: string;
let keyFile: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lims-platform-wire-ops-'));
  keyFile = join(scratch, 'ratelimit.key');
  writeFileSync(keyFile, 'a'.repeat(64), { mode: 0o600 }); // synthetic, not a secret
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
beforeEach(() => { h.script.length = 0; h.logs.length = 0; });

const logger = { debug() {}, info() {}, warn() {}, error(o: any) { h.logs.push(o); }, child() { return logger; } };
const metrics = { set() {}, inc() {}, observe() {} };

let booted: Promise<{ b: any; handlers: Record<string, any> }> | undefined;
const boot = () => (booted ??= bootOnce());   // one boot per file: every case reuses the same real pipeline (the identity actor is read once)
afterAll(async () => { if (booted) await (await booted).b.close(); });
async function bootOnce() {
  vi.resetModules();
  const { loadConfig } = await import('../../../core/config.js');
  const { bootPipeline } = await import('../../../core/pipeline/boot.js');
  const { manifest } = await import('../index.js');
  const config = loadConfig({
    ...process.env,
    LIMS_CORE_DATABASE_URL: 'postgres://lims_app:synthetic@db.lims-staging.invalid:5432/lims', LIMS_CORE_RATELIMIT_KEY_FILE: keyFile,
  } as Record<string, string>);
  const other = (name: string) => ({ manifest: { name, openapi: `contracts/openapi/${name}.yaml`, handlers: {}, produces: [], createServices: () => Object.freeze({}) }, spec: {} });
  const b = await bootPipeline({ config, modules: [{ manifest, spec: {} }, other('frontdesk')] as any, log: logger as any, metrics: metrics as any });
  return { b, handlers: (manifest as any).handlers as Record<string, any> };
}

const platform = (role = 'platform_superadmin', aal = 'aal2', over: Record<string, unknown> = {}) =>
  ({ sub: SUB, actor_type: 'user', scope: 'platform', platform_staff_id: STAFF, platform_role: role, aal, lims_session_id: PSID, ...over }) as any;
const SUPER = () => platform();
const SUPPORT = () => platform('platform_support');

interface Out { status?: number; code?: string; sql: string[]; stmts: Array<{ text: string; values: unknown[] }> }
const OPENING = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b|set_config|g_system_actors|ratelimit_hit/i;
async function go(operationId: string, claims: any, req: Partial<Record<'params' | 'query' | 'headers' | 'body', unknown>> = {}): Promise<Out> {
  const { b, handlers } = await boot();
  h.stmts.length = 0;
  const handler = handlers[operationId];
  if (typeof handler !== 'function') throw new Error(`manifest has no handler ${operationId}`);
  const o: Out = { sql: [], stmts: [] };
  try {
    const r = await b.pipelineFor('identity').run({
      op: { module: 'identity', operationId, method: 'GET', routeTemplate: `/v1/identity/platform/${operationId}`, public: false, context: 'platform', idempotency: 'none' },
      claims, requestId: REQ_ID, clientIp: '203.0.113.9', userAgent: 'vitest', log: logger,
      req: { params: {}, query: {}, headers: {}, body: {}, ...req }, handler,
    } as any);
    o.status = r.status;
  } catch (e: any) { o.code = e?.code ?? `thrown:${e?.name}`; }
  o.stmts = h.stmts.map((s) => ({ text: s.text.trim(), values: s.values }));
  o.sql = o.stmts.filter((s) => !OPENING.test(s.text)).map((s) => s.text);
  return o;
}
/** the service ran past its guard: no auth failure, and its SQL (or its input validation) happened */
const AUTH_FAILURES = ['auth.unauthenticated', 'auth.forbidden', 'auth.mfa_required'];
const reached = (o: Out, table: RegExp) => {
  expect(o.code === undefined || !AUTH_FAILURES.includes(o.code), `auth failure ${o.code}`).toBe(true);
  expect(o.sql.some((s) => table.test(s)), `service SQL for ${table}; got ${JSON.stringify(o.sql.map((s) => s.slice(0, 60)))}`).toBe(true);
};
const validated = (o: Out) => { expect(o.code).toBe('common.validation_failed'); expect(o.sql).toEqual([]); };
const refusedBeforeService = (o: Out, code: string) => { expect(o.code).toBe(code); expect(o.sql, 'the service SQL must not run').toEqual([]); };

const LISTS: Array<[string, RegExp, Record<string, unknown>?]> = [
  ['listTenants', /tenants/i],
  ['listPlatformIrdAnnexes', /ird_annex_records/i],
  ['listPlatformSupportSessions', /support_sessions/i],
  ['listDeadLetters', /dead_letters/i],
  ['listPlatformStaff', /platform_staff/i],
];
const WRITES: Array<[string, Record<string, unknown>?]> = [
  ['provisionTenant'], ['createPlatformIrdAnnex'], ['openSupportSession'], ['invitePlatformStaff'],
];

describe('platform_superadmin aal2 (the founder\'s session): every platform operation guard reaches its service under the real pipeline context', () => {
  it.each(LISTS)('%s reads through its repository', async (operationId, table) => {
    reached(await go(operationId, SUPER()), table);
  });
  it('getTenant reads core.tenants and answers common.not_found for an unknown tenant (the service, not the guard, decides)', async () => {
    const o = await go('getTenant', SUPER(), { params: { tenant_id: T1 } });
    expect(o.code).toBe('common.not_found');
    expect(o.sql.some((s) => /tenants/i.test(s))).toBe(true);
  });
  it.each(WRITES)('%s passes its guard (Provision tenant cannot work without this) and fails only on input validation of an empty body', async (operationId) => {
    validated(await go(operationId, SUPER(), { body: {} }));
  });
});

describe('platform_support aal2: reads it is granted reach the service, everything else is refused before any service SQL (PlatformAuthz unchanged)', () => {
  it.each(['listTenants', 'listPlatformIrdAnnexes', 'listPlatformSupportSessions'])('%s reaches the service', async (operationId) => {
    const t = LISTS.find((l) => l[0] === operationId)![1];
    reached(await go(operationId, SUPPORT()), t);
  });
  it('getTenant reaches the service', async () => {
    expect((await go('getTenant', SUPPORT(), { params: { tenant_id: T1 } })).code).toBe('common.not_found');
  });
  it.each(['listDeadLetters', 'listPlatformStaff'])('%s -> auth.forbidden, no service SQL', async (operationId) => {
    refusedBeforeService(await go(operationId, SUPPORT()), 'auth.forbidden');
  });
  it.each(['provisionTenant', 'createPlatformIrdAnnex', 'invitePlatformStaff'])('%s -> auth.forbidden, no service SQL', async (operationId) => {
    refusedBeforeService(await go(operationId, SUPPORT(), { body: {} }), 'auth.forbidden');
  });
});

describe('aal1 sessions (superadmin and support): the platform permissions are privileged, so auth.mfa_required before any service SQL, with or without the new fields', () => {
  it('platform_superadmin aal1: every operation -> auth.mfa_required', async () => {
    for (const [operationId] of [...LISTS, ['getTenant'], ...WRITES]) {
      refusedBeforeService(await go(operationId as string, platform('platform_superadmin', 'aal1'), { params: { tenant_id: T1 }, body: {} }), 'auth.mfa_required');
    }
  });
  it('platform_support aal1: the reads it is granted -> auth.mfa_required, the rest -> auth.forbidden (role is checked first, as today)', async () => {
    for (const operationId of ['listTenants', 'getTenant', 'listPlatformIrdAnnexes', 'listPlatformSupportSessions']) {
      refusedBeforeService(await go(operationId, platform('platform_support', 'aal1'), { params: { tenant_id: T1 } }), 'auth.mfa_required');
    }
    for (const operationId of ['listDeadLetters', 'listPlatformStaff', 'provisionTenant', 'invitePlatformStaff']) {
      refusedBeforeService(await go(operationId, platform('platform_support', 'aal1'), { body: {} }), 'auth.forbidden');
    }
  });
  it('a platform session without an aal claim is refused the same way (no aal is invented)', async () => {
    const { aal: _drop, ...noAal } = SUPER();
    refusedBeforeService(await go('listTenants', noAal), 'auth.mfa_required');
  });
});

describe('claims that are not a valid platform session keep failing closed exactly as today', () => {
  it('a tenant session with a stray platform_role (no platform scope) -> auth.forbidden, never reaches a service', async () => {
    const claims = { sub: SUB, tenant_id: T1, actor_type: 'user', aal: 'aal2', platform_role: 'platform_superadmin', platform_staff_id: STAFF, lims_session_id: PSID };
    for (const [operationId] of [...LISTS, ['getTenant'], ...WRITES]) {
      const o = await go(operationId as string, claims, { params: { tenant_id: T1 }, body: {} });
      expect(o.code, operationId as string).toBe('auth.forbidden');
      expect(o.sql, operationId as string).toEqual([]);
    }
  });
  it('a support-session actor (scope support, carries platform_staff_id) -> auth.forbidden', async () => {
    const claims = { sub: SUB, tenant_id: T1, actor_type: 'user', scope: 'support', support_session_id: PSID, support_scope: 'read', platform_staff_id: STAFF, aal: 'aal2', lims_session_id: PSID };
    for (const operationId of ['listTenants', 'listPlatformIrdAnnexes', 'listPlatformSupportSessions', 'listDeadLetters', 'listPlatformStaff']) {
      const o = await go(operationId, claims);
      expect(o.code, operationId).toBe('auth.forbidden');
      expect(o.sql, operationId).toEqual([]);
    }
  });
  it.each(['listPlatformIrdAnnexes', 'listPlatformStaff', 'listPlatformSupportSessions'])('%s without a platform_staff_id claim -> auth.unauthenticated, no service SQL', async (operationId) => {
    const { platform_staff_id: _drop, ...claims } = SUPER();
    refusedBeforeService(await go(operationId, claims), 'auth.unauthenticated');
  });
  it('listPlatformSupportSessions without a lims_session_id claim -> auth.unauthenticated, no service SQL (CR-C2-T21)', async () => {
    const { lims_session_id: _drop, ...claims } = SUPER();
    refusedBeforeService(await go('listPlatformSupportSessions', claims), 'auth.unauthenticated');
  });
  it('a malformed platform_staff_id claim is treated as missing (never forwarded to a service or to SQL)', async () => {
    const o = await go('listPlatformStaff', platform('platform_superadmin', 'aal2', { platform_staff_id: "x'; DROP TABLE identity.platform_staff;--" }));
    refusedBeforeService(o, 'auth.unauthenticated');
    expect(o.stmts.some((s) => /DROP TABLE/i.test(JSON.stringify(s)) && !/set_config/i.test(s.text))).toBe(false);
  });
});

describe('dead letters: the platform_events writer and the tenant window run with the session\'s own ids', () => {
  const row = (tenant: string | null) => ({
    id: DL, tenant_id: tenant, task_identifier: 'synthetic.task', last_error_code: 'x', last_error_message_redacted: 'redacted', attempts: 3,
    first_failed_at: new Date('2026-11-01T00:00:00Z'), dead_at: new Date('2026-11-02T00:00:00Z'), state: 'open', resolved_by: null, resolved_at: null, resolution_note: null, version: 1,
  });
  it('platform row (tenant_id NULL): identity.platform_events dead_letter_viewed is written with actor_platform_staff_id = the claim, not the request input', async () => {
    h.script.push({ match: /app\.dl_list_platform/i, rows: [row(null)] });
    const evil = { platform_staff_id: EVIL, platformStaffId: EVIL, 'x-platform-staff-id': EVIL };
    const o = await go('getDeadLetter', SUPER(), { params: { dead_letter_id: DL, ...evil }, query: evil, headers: evil, body: evil });
    const ev = o.stmts.find((s) => /INSERT INTO identity\.platform_events/i.test(s.text));
    expect(ev, 'a platform_events row for the view (no unlogged read)').toBeDefined();
    const flat = JSON.stringify(ev!.values);
    expect(flat).toContain('dead_letter_viewed');
    expect(flat).toContain(STAFF);
    expect(flat).not.toContain(EVIL);
  });
  it('tenant row: the dead_letter.view access-log entry is written INSIDE a tenant window for that tenant, then the platform claims are restored', async () => {
    h.script.push({ match: /FROM core\.dead_letters WHERE id = \$1/i, rows: [row(T1)] });
    const o = await go('getDeadLetter', SUPER(), { params: { dead_letter_id: DL } });
    const claims = o.stmts.map((s, i) => ({ i, s })).filter(({ s }) => /set_config\(\s*'request\.jwt\.claims'/i.test(s.text)).map(({ i, s }) => ({ i, c: JSON.parse(String(s.values[0])) }));
    const win = claims.find(({ c }) => c.tenant_id === T1);
    expect(win, 'a tenant window for the row\'s tenant').toBeDefined();
    expect(win!.c).toEqual({ sub: ACTOR, actor_type: 'system', tenant_id: T1 });
    const back = claims.find(({ i, c }) => i > win!.i && c.scope === 'platform');
    expect(back, 'platform claims restored after the window').toBeDefined();
    const log = o.stmts.findIndex((s) => /access_log/i.test(s.text) && /INSERT/i.test(s.text));
    expect(log).toBeGreaterThan(win!.i);
    expect(log).toBeLessThan(back!.i);
    expect(o.stmts.some((s) => /INSERT INTO identity\.platform_events/i.test(s.text)), 'a tenant row is logged in the tenant, not in platform_events').toBe(false);
  });
});

describe('support sessions use the claims\' ids: platform_staff_id and lims_session_id', () => {
  it('listPlatformSupportSessions with request input naming other ids still runs as the claims\' session (filters are only the contract query keys)', async () => {
    const evil = { platformStaffId: EVIL, platformSessionId: EVIL };
    const o = await go('listPlatformSupportSessions', SUPER(), { query: {}, headers: evil, body: evil, params: evil });
    reached(o, /support_sessions/i);
    expect(JSON.stringify(o.stmts.map((s) => s.values))).not.toContain(EVIL);
  });
});

describe('end to end status: what the console needs (2xx through the whole pipeline, stage 9 included)', () => {
  it.each(LISTS)('%s answers 200 for the founder\'s session (superadmin aal2)', async (operationId) => {
    const o = await go(operationId, SUPER());
    expect({ status: o.status, code: o.code }).toEqual({ status: 200, code: undefined });
    expect(h.logs.filter((l) => l.event === 'authz_not_asserted')).toEqual([]);
  });
  it.each(['listTenants', 'listPlatformIrdAnnexes', 'listPlatformSupportSessions'])('%s answers 200 for platform_support aal2', async (operationId) => {
    const o = await go(operationId, SUPPORT());
    expect({ status: o.status, code: o.code }).toEqual({ status: 200, code: undefined });
  });
});
